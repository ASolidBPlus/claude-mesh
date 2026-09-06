import { WebSocketServer, WebSocket } from 'ws';
import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';
import { getAgentById, setOnline, clearAllOnline, getPeerByAlias, touchPeer, touchAgent, touchAlive, touchResponded, getPendingMessages, markAcked, listAclPeers, insertReminder, listAgentReminders, getReminder, cancelReminder as dbCancelReminder, listAgents, isObserver } from './db.ts';
import { validateToken } from './auth.ts';
import { PEER_PROTOCOL_VERSION } from './wire-version.ts';  // #131: via the tiny module, never cross-package from here
import { parseDuration } from './duration.ts';
import { cronValidate, cronNext, tzValidate, cronNextTz, isBareIso, bareIsoToUtc } from './cron.ts';
import {
  routeDirect, routeRelay, drainQueue, SendFrame,
  routePublish, routeSubscribe, routeUnsubscribe,
  routeFile, drainFileQueue, FileSendFrame,
  PublishFrame, SubscribeFrame, UnsubscribeFrame,
} from './router.ts';
import { incMsgStatus, incReceived, incBytes } from './metrics.ts';

/** F1a (§5.1): the only inbound peer protocol this mesh speaks. A version is a
 *  property of a LIVE CONNECTION, never of a stored row (D7) — which is why it
 *  is checked at auth and not persisted on `peers`.
 *
 *  F2b: re-exported, not redefined. The definition is in the wire module
 *  (client/src/protocol.ts) because all three readers must agree by
 *  construction; keeping a copy here is exactly what let registration advertise
 *  a version auth rejected. */
export { PEER_PROTOCOL_VERSION };

export interface WsServerHandle {
  wss: WebSocketServer;
  agentIndex: Map<string, WebSocket>;
  /** F1a: alias -> the peer mesh's live socket. Separate from agentIndex on
   *  purpose: a peer is not an agent, and merging them would let one lookup
   *  return something with the other's semantics. */
  peerIndex: Map<string, WebSocket>;
  observerIndex: Map<string, WebSocket>;
  shutdown(): Promise<void>;
}

interface ConnState {
  ws: WebSocket;
  agentId: string | null;
  /** F1a: set iff this socket authenticated as a PEER MESH. Mutually exclusive
   *  with agentId by construction — the credential decides which, and #98's
   *  collision gates guarantee an alias and an agent id cannot coincide. */
  peerAlias: string | null;
  authed: boolean;
}

interface PresenceState {
  pendingOfflineTimer: ReturnType<typeof setTimeout> | null; // armed offline-broadcast timer, or null
  onlineBroadcast: boolean; // true while peers currently believe this agent is online
}

// ──────────────────────────────────────────────────────────────────────────
// Post-auth frame dispatch
//
// Each post-auth frame type is a named handler taking a single FrameCtx; the
// POST_AUTH_HANDLERS map (frame type -> handler) replaces what was a 13-arm
// inline `if (frameType === 'x') {...}` chain, so static analysis sees the
// handlers as symbols and the dispatch as explicit map edges. Frame types are
// mutually-exclusive exact strings (no precedence/overlap), so an O(1) map is
// the natural structure. A non-string / unknown `type` falls through to the
// NOT_IMPLEMENTED error at the dispatch site, exactly as the if-chain did.
//
// Handlers run only post-auth, so `state.agentId` is non-null (the `!`
// assertions are preserved from the original inline blocks). All handlers are
// synchronous — there is no `await` in the dispatch path.
// ──────────────────────────────────────────────────────────────────────────

interface FrameCtx {
  ws: WebSocket;
  state: ConnState;
  db: Database;
  frame: Record<string, unknown>;
  parsed: unknown;
  agentIndex: Map<string, WebSocket>;
  observerIndex: Map<string, WebSocket>;
  maxFileBytes: number;
  filesDir: string;
}

/**
 * #143 — what the auth frame needs from the connection scope. Every field is a
 * LIVE reference (the maps are the server's own, not copies) and
 * `broadcastStatus` is the closure defined in startWsServer — passing a
 * snapshot of any of them would be the silent way to break this.
 */
interface AuthCtx {
  ws: WebSocket;
  state: ConnState;
  db: Database;
  frame: Record<string, unknown>;
  parsed: unknown;
  agentIndex: Map<string, WebSocket>;
  peerIndex: Map<string, WebSocket>;
  observerIndex: Map<string, WebSocket>;
  presenceState: Map<string, PresenceState>;
  broadcastStatus: (agentId: string, online: boolean, lastSeen: number, excludeWs: WebSocket | null) => void;
  /** The peer arm clears the auth timer a SECOND time. The call site already
   *  cleared it before dispatching here, so this is a no-op on an
   *  already-cleared timer — but it is in the code being moved, so it moves,
   *  and removing it is a behaviour question that does not belong in a
   *  mechanical commit. Passed as a callback rather than dropped, so the move
   *  stays verbatim and the redundancy stays VISIBLE instead of being quietly
   *  resolved by the refactor. Found by the characterisation tests on the first
   *  run of this extraction: `ReferenceError: authTimer is not defined`. */
  clearAuthTimer: () => void;
}

/**
 * #143 — THE AUTH FRAME, lifted out of the connection callback verbatim.
 *
 * It was 312 lines inside a 567-line closure, and the reasoning in it is
 * load-bearing (C9 refusal folding, D11 ordering, #92 displacement), so it
 * moves WITH its comments and without a word changed.
 *
 * WHAT THE MOVE CHANGES, and it is the point: the two `return`s that ended
 * the peer and agent arms used to mean "stop handling this message", and
 * each was the only thing standing between a completed auth and the
 * post-auth dispatch. They now mean "leave this function", and the ONE
 * `return` at the call site carries what both used to. One site instead of
 * two is the safer shape — but only because the characterisation tests
 * added before this cut pin what those returns do, from the outside.
 *
 * The pre-auth guard (`messageHandled`, `clearTimeout(authTimer)`) stays at
 * the call site DELIBERATELY: it is about the socket's message stream, not
 * about the auth frame, and moving it would put the timer's lifetime in a
 * function that has no other reason to know about it.
 */
function handleAuthFrame(ctx: AuthCtx): void {
  const { ws, state, db, frame, parsed, agentIndex, peerIndex, observerIndex, presenceState, broadcastStatus, clearAuthTimer } = ctx;

  if (typeof parsed !== 'object' || parsed === null || frame.type !== 'auth') {
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'first frame must be auth' }));
    } catch (_) { /* ignore */ }
    ws.close(1008, 'auth required');
    return;
  }

  // Auth frame handling
  const agentId = frame.agent_id;
  const token = frame.token;

  if (typeof agentId !== 'string' || typeof token !== 'string') {
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'missing agent_id or token' }));
    } catch (_) { /* ignore */ }
    ws.close(1008, 'auth failed');
    return;
  }

  // ── F1a (§5.1): PEER AUTH ──────────────────────────────────
  //
  // THE DISCRIMINATOR IS THE CREDENTIAL, NEVER THE CLIENT'S FIELD.
  // A socket is a peer because its token authenticates against
  // peers.token_hash, and an agent because it authenticates against
  // agents.token_hash. `protocol` is validated only AFTER a peer
  // credential has matched, and is never consulted to decide which
  // table to try — otherwise a client could choose its own semantics
  // by setting a field, which is the whole class of bug that "trust
  // the credential, not the claim" exists to prevent.
  //
  // TABLES READ HERE: `peers` (this lookup) and `agents` (below).
  // The union is total for an authenticating id because #98's three
  // collision gates guarantee an alias and an agent id can never
  // coincide — so the alias-keyed lookup IS the credential lookup,
  // and there is no id for which both or neither could match.
  const peerRow = getPeerByAlias(db, agentId);
  if (peerRow !== null) {
    // ONE refusal for every peer-reachable failure, and it is
    // `unknown agent` — what a stranger already sees.
    //
    // Measured before choosing it. The three outcomes a prober can
    // reach are: nonexistent alias, real alias + wrong token, and
    // disabled alias + right token. Any message that differs between
    // them is an oracle:
    //   - a distinct DISABLED message tells a revoked peer that its
    //     key was revoked rather than mistyped (this was the bug —
    //     `invalid token` vs `unknown agent`, reproduced);
    //   - making all three `invalid token` would instead separate a
    //     real-alias-wrong-token from a nonexistent alias, trading a
    //     revocation oracle for an ALIAS-EXISTENCE one.
    // `unknown agent` is the only choice that adds no signal on
    // either axis, because it is already the answer to "who?".
    //
    // Handled INSIDE this branch rather than falling through to the
    // agent path. The fall-through produced the right string only
    // because #98's collision gates make an alias-shaped agent id
    // impossible — correct by a distant invariant is not the same as
    // correct, and this is a refusal path where that distinction is
    // the whole point.
    // FOLDED PER C9: disabled and wrong-token are one refusal.
    if (peerRow.disabled === 1 || !validateToken(token, peerRow.token_hash)) {
      try {
        ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'unknown agent' }));
      } catch (_) { /* ignore */ }
      ws.close(1008, 'auth failed');
      return;
    }

    // (b) protocol AFTER the credential matched — ORDERED PER C9.
    // Cheap-checks-first is faster and tidier and would leak: a
    // protocol answer before the credential tells an unauthenticated
    // caller that the alias exists.
    const claimed = (frame as { protocol?: unknown }).protocol;
    if (claimed !== PEER_PROTOCOL_VERSION) {
      console.warn(JSON.stringify({
        evt: 'peer.protocol_mismatch', alias: agentId,
        claimed: claimed ?? null, supported: PEER_PROTOCOL_VERSION, at: Date.now(),
      }));
      try {
        ws.send(JSON.stringify({
          type: 'error', code: 'PROTOCOL_MISMATCH',
          message: `unsupported protocol; this mesh speaks ${PEER_PROTOCOL_VERSION}`,
        }));
      } catch (_) { /* ignore */ }
      ws.close(1008, 'protocol mismatch');
      return;
    }

    // (c) peer connection state. agentId stays NULL — a peer is not
    // an agent, and every agent-shaped path keys off agentId.
    state.authed = true;
    state.peerAlias = agentId;
    clearAuthTimer();

    // NEWER WINS (D11). ORDER IS LOAD-BEARING: index the new socket
    // FIRST, then close the old one.
    //
    // Measured, because the obvious order is wrong: closing first
    // fires the old socket's close handler BEFORE the set, at which
    // point the old socket is still the indexed one — so the close
    // path's identity guard passes, deletes, and the set immediately
    // re-adds. The guard becomes INERT, and a mutant removing it
    // survives (it did). Indexing first means the guard is doing real
    // work on the common path: the old socket sees that it is no
    // longer indexed and leaves the new one alone.
    //
    // It is also the order that survives the case the guard exists
    // for — a peer reconnecting because its old socket died, where
    // the dead socket's close event can arrive AFTER the new one has
    // authenticated and indexed.
    //
    // #105: NO BEHAVIOURAL TEST DISTINGUISHES THE TWO ORDERS.
    // Measured — inverted order WITH the guard is 646/0, identical to
    // what ships. THIS COMMENT IS THE CONTROL. The verification
    // procedure is the 2x2 mutation, order x guard: only the cell
    // with close-then-index AND no guard misbehaves, so neither
    // single mutant catches a regression here. A refactor that
    // restores close-then-index silently RE-INERTS the guard, with
    // every test still green.
    const existing = peerIndex.get(agentId);
    peerIndex.set(agentId, ws);
    if (existing !== undefined && existing !== ws) {
      try {
        existing.send(JSON.stringify({
          type: 'error', code: 'PEER_REPLACED',
          message: 'another socket authenticated for this alias',
        }));
      } catch (_) { /* ignore */ }
      try { existing.close(1008, 'peer replaced'); } catch (_) { /* ignore */ }
    }
    touchPeer(db, agentId);

    console.log(JSON.stringify({ evt: 'peer.connected', alias: agentId, at: Date.now() }));

    // (e) peer auth_ok: no queue fields — a peer has no mailbox here.
    try {
      ws.send(JSON.stringify({ type: 'auth_ok', peer: agentId, protocol: PEER_PROTOCOL_VERSION }));
    } catch (_) { /* ignore */ }

    // EXPLICIT EARLY RETURN. The agent post-auth block below uses the
    // LOCAL agentId variable and is not guarded by state.agentId, so
    // falling through would run setOnline / agentIndex.set / pending
    // drains / broadcastStatus for an id that names no agent.
    return;
  }

  const agent = getAgentById(db, agentId);
  if (agent === null) {
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'unknown agent' }));
    } catch (_) { /* ignore */ }
    ws.close(1008, 'auth failed');
    return;
  }

  // FOLDED PER C9 (#116). This said `invalid token` while an unknown
  // id six lines above says `unknown agent` — two answers to ONE
  // question ("may this caller in?"), which let an UNAUTHENTICATED
  // network caller enumerate agent ids by reading the difference.
  //
  // #104 folded the PEER path for exactly this and the agent path was
  // never folded, because the comparison that finds it is refusals
  // side by side, and #104 only put the PEER refusals side by side.
  //
  // The frame's own-input refusal above ('missing agent_id or token')
  // stays distinct: it answers a different question — what the caller
  // SENT — and reveals nothing about what exists here.
  if (!validateToken(token, agent.token_hash)) {
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'unknown agent' }));
    } catch (_) { /* ignore */ }
    ws.close(1008, 'auth failed');
    return;
  }

  const connectTime = Date.now();
  setOnline(db, agentId, true);

  state.authed = true;
  state.agentId = agentId;

  // #92 — NEWER WINS. A second successful auth for the same agent id
  // DISPLACES the first socket.
  //
  // Before this, agentIndex.set silently overwrote the entry while
  // the per-socket registry still held the first connection, authed,
  // carrying the same agentId: two live sockets for one identity.
  // Direct deliveries went to the newest via agentIndex, while the
  // orphaned first socket stayed a presence-broadcast candidate and
  // kept its authed state until it dropped on its own. Anything
  // iterating the registry saw a ghost.
  //
  // Displacing rather than refusing the second auth is the friendlier
  // half of the choice and matches what agentIndex already implied:
  // an agent reconnecting over a half-open socket (#67) must be able
  // to get back in, and refusing it would leave it locked out until
  // the heartbeat reaped a connection it cannot see.
  //
  // ORDER: index first, then close. The close is what makes the old
  // socket's own close handler run, and that handler deletes from
  // agentIndex only if the entry is still ITS socket — so setting the
  // new entry first is what stops the displaced socket's teardown
  // evicting the live one. Same shape as the peer path's D11.
  const displaced = agentIndex.get(agentId);
  agentIndex.set(agentId, ws);
  if (displaced !== undefined && displaced !== ws) {
    try {
      displaced.send(JSON.stringify({
        type: 'error', code: 'DISPLACED',
        message: 'displaced by a newer connection',
      }));
    } catch (_) { /* the socket may already be gone; displacement still stands */ }
    // A stated code, so the old client knows it was replaced rather
    // than dropped, and does not reconnect into a fight with itself.
    try { displaced.close(1008, 'displaced by a newer connection'); } catch (_) { /* ignore */ }
  }

  const pending = getPendingMessages(db, agentId);
  const queued = pending.length;

  // Count pending files without delivering yet (for auth_ok payload)
  const now = Date.now();
  const pendingFileRows = db.prepare(`
    SELECT COUNT(*) as cnt FROM files
    WHERE to_agent = ?
      AND delivered_at IS NULL
      AND (expires_at IS NULL OR expires_at >= ?)
  `).get(agentId, now) as { cnt: number };
  const queued_files = pendingFileRows.cnt;

  try {
    ws.send(JSON.stringify({ type: 'auth_ok', agent_id: agentId, queued, queued_files }));
  } catch (_) { /* ignore */ }
  drainQueue(db, agentId, ws);
  drainFileQueue(db, agentId, ws);

  // Presence-debounce-aware online broadcast. Keys purely off
  // presenceState (NOT the ws object): `close` removes the old ws from
  // registry/agentIndex synchronously before any reconnect's auth runs
  // (single-threaded event loop), so a flap-back is detected here.
  const existing = presenceState.get(agentId);
  if (existing && existing.pendingOfflineTimer !== null) {
    // Flapped back inside the debounce window. Peers never saw offline
    // (timer hadn't fired). Cancel the pending offline AND suppress the
    // re-online broadcast — net zero churn. onlineBroadcast stays true.
    clearTimeout(existing.pendingOfflineTimer);
    existing.pendingOfflineTimer = null;
  } else if (existing && existing.onlineBroadcast) {
    // #152 — A DISPLACING AUTH IS NOT AN ARRIVAL.
    //
    // Reaching here means peers were told this agent is online and
    // have not been told otherwise: no offline was broadcast (that
    // deletes the state) and none is pending (that is the branch
    // above). The only way to auth into that is over a socket that
    // was already live for this id — a displacement — and the
    // displaced socket's own close correctly broadcasts nothing
    // (identity-guarded teardown, #92). Broadcasting online here put
    // an ARRIVAL WITH NO DEPARTURE on the presence stream.
    //
    // Direction was always safe: never an unpaired departure, no
    // reachable agent marked offline. The cost is to consumers that
    // count transitions or infer session boundaries from the stream
    // — mesh-chat's roster among them.
    //
    // KEYED ON PRESENCE, NOT ON THE SOCKET, and the reason needs no
    // prediction about future code. This branch suppresses a
    // broadcast because OBSERVERS ALREADY BELIEVE THIS AGENT IS
    // ONLINE — and `onlineBroadcast` IS that fact, the variable whose
    // meaning is the premise. The `displaced` local a few lines up is
    // EVIDENCE FOR the fact, not the fact. A branch should test its
    // own premise rather than a correlate; the day the two diverge,
    // code keyed on the correlate is wrong for a reason invisible at
    // the line.
    //
    // The two are equivalent today and that was checked rather than
    // assumed, structurally as well as by test: agentIndex.delete has
    // exactly one site, behind #92's identity guard, so no reachable
    // state separates them. A corollary of keying on the premise is
    // that a second path to a doubled socket is covered without being
    // remembered — a corollary, not the reason.
    //
    // PRE-EXISTING, NOT #145's. This block is byte-identical to
    // e3de095^ (verified). #145 changed how OFTEN it is reached, by
    // making displacement the deliberate reconnect path; it also
    // removed the spurious later departure that used to follow, which
    // was the dangerous half and a different defect.
  } else {
    // Genuinely fresh / long-offline connect: broadcast online as today.
    broadcastStatus(agentId, true, connectTime, ws);
    presenceState.set(agentId, { pendingOfflineTimer: null, onlineBroadcast: true });
  }

  // SAFETY INVARIANT: observerIndex is the SOLE set the tap fan-out writes
  // to. Membership is added here exactly once, ONLY iff isObserver(agentId)
  // (admin-granted), and removed on disconnect/revoke. There is no other
  // writer, so a non-observer connection can never receive a tap frame.
  // Wrapped so an observer-lookup failure can never break auth or delivery.
  try {
    if (isObserver(db, agentId)) {
      observerIndex.set(agentId, ws);
    }
  } catch (_) { /* tap must never affect auth or delivery */ }

  return;
}

/**
 * #143 — what a socket teardown needs from the connection scope. Same rule as
 * AuthCtx: every field is a LIVE reference, never a snapshot.
 */
interface CloseCtx {
  ws: WebSocket;
  db: Database;
  registry: Map<WebSocket, ConnState>;
  connections: Set<WebSocket>;
  agentIndex: Map<string, WebSocket>;
  peerIndex: Map<string, WebSocket>;
  observerIndex: Map<string, WebSocket>;
  presenceState: Map<string, PresenceState>;
  presenceDebounceMs: number;
  broadcastStatus: (agentId: string, online: boolean, lastSeen: number, excludeWs: WebSocket | null) => void;
  clearAuthTimer: () => void;
}

/**
 * #143 — SOCKET TEARDOWN, lifted verbatim out of the connection callback.
 *
 * Both identity guards live here (#92 for agents, D11 for peers) and both are
 * the difference between a reconnect and an outage, so this moves with its
 * reasoning and nothing else.
 *
 * It has no early-return hazard of the kind the auth extraction had: every
 * `return` in it already meant "this teardown is done", and there is no code
 * after the handler to fall through to.
 */
function handleSocketClose(ctx: CloseCtx): void {
  const { ws, db, registry, connections, agentIndex, peerIndex, observerIndex,
          presenceState, presenceDebounceMs, broadcastStatus, clearAuthTimer } = ctx;
  clearAuthTimer();
  connections.delete(ws);
  const connState = registry.get(ws);
  registry.delete(ws);

  // F1a: a peer socket branches FIRST and never touches agentIndex or
  // setOnline — those are agent semantics and a peer has none.
  //
  // IDENTITY-GUARDED delete (#92's shape): evict only if the indexed
  // socket IS this one. Without the guard a replaced socket's late
  // close evicts the REPLACEMENT, leaving the alias unroutable while a
  // healthy socket sits connected — the map and the world disagreeing
  // with nothing reporting it.
  if (connState?.peerAlias != null) {
    const alias = connState.peerAlias;
    if (peerIndex.get(alias) === ws) peerIndex.delete(alias);
    console.log(JSON.stringify({ evt: 'peer.disconnected', alias, at: Date.now() }));
    return;
  }

  if (connState && connState.authed && connState.agentId !== null) {
    const agentId = connState.agentId;

    // #92 — IDENTITY-GUARDED TEARDOWN, the other half of newer-wins.
    //
    // When a second auth displaces this socket, THIS handler runs for
    // the displaced one while the agent is still very much online on
    // the newer socket. Unguarded, it would delete the agentIndex entry
    // that now points at the LIVE socket, mark the agent offline, and
    // broadcast a presence departure — turning a successful reconnect
    // into an outage. The peer path has carried this guard since D11;
    // the agent path did not, which is why displacement could not be
    // added without it.
    //
    // A late close from an already-replaced socket is the same case and
    // is handled by the same test.
    if (agentIndex.get(agentId) !== ws) {
      try { registry.delete(ws); } catch (_) { /* never throw on close */ }
      return;
    }

    setOnline(db, agentId, false);
    agentIndex.delete(agentId);
    try { observerIndex.delete(agentId); } catch (_) { /* never throw on close */ }

    const disconnectTime = Date.now();
    const ps = presenceState.get(agentId);
    // Only schedule/emit offline if peers currently believe this agent
    // is online. (ps undefined is not reachable in the normal flow, but
    // the guard is conservatively safe.)
    if (ps && ps.onlineBroadcast) {
      if (presenceDebounceMs === 0) {
        // Legacy / debounce-disabled: broadcast offline immediately.
        broadcastStatus(agentId, false, disconnectTime, null);
        presenceState.delete(agentId);
      } else {
        // Debounced: arm a timer. If the agent reconnects before it
        // fires, the connect handler cancels it. If it fires, the agent
        // is still gone → offline.
        if (ps.pendingOfflineTimer !== null) clearTimeout(ps.pendingOfflineTimer);
        ps.pendingOfflineTimer = setTimeout(() => {
          // Reaching here means the connect handler did NOT cancel us →
          // still offline.
          broadcastStatus(agentId, false, Date.now(), null);
          presenceState.delete(agentId);
        }, presenceDebounceMs);
      }
    }
  }
}

// Handlers are synchronous TODAY. The return type admits a promise anyway so
// the dispatcher's guard is COLOUR-BLIND (#94): a guard whose coverage depends
// on handlers staying sync is one `async` keyword away from being disabled,
// with no line of the guard itself changing.
type FrameHandler = (ctx: FrameCtx) => void | Promise<void>;

function handlePing(ctx: FrameCtx): void {
  const { ws, state, db, frame } = ctx;
  const ts = frame.ts;
  const serverTs = Date.now();
  try {
    ws.send(JSON.stringify({ type: 'pong', ts, server_ts: serverTs }));
  } catch (_) { /* ignore */ }
  if (state.agentId !== null) {
    // A keepalive is proof of LIFE, not an act — so it stamps last_alive and
    // deliberately does NOT touch last_seen.
    //
    // This previously called touchAgent(). That was harmless while almost
    // nothing pinged, but now that the SDK heartbeats every 25s it would make
    // last_seen advance for every idle agent — silently converting a shipped
    // field from "last acted" into "last alive" for every consumer (the mesh
    // fleet views, orchestrator-MCP fleet_list/agent_detail, mesh-chat). Keeping
    // the two fields distinct is the whole point of last_alive.
    touchAlive(db, state.agentId);
  }
}

/**
 * #133 — the agent's LOOP reports that it is alive, as distinct from its
 * transport.
 *
 * WHY A SEPARATE FRAME rather than inferring it from traffic. Every existing
 * frame is sent by the plugin, and the plugin is a separate process that keeps
 * working while the agent's loop is stuck: an agent wedged for 55 minutes had a
 * last_alive fresh to the second. Advancing this on `send` or `publish` would
 * reproduce exactly that defect one field over, because the plugin emits those
 * on the agent's behalf too.
 *
 * SO THE SERVER SHIPS THIS INERT. Nothing sends `loop_alive` today; the emitter
 * is spawner#346, which must emit it from the turn loop rather than a timer.
 * Until then last_responded stays null everywhere, and null is the honest
 * answer — "we do not know whether the loop is alive" is what the roster could
 * truthfully say all along.
 *
 * WHAT THE SERVER CANNOT VERIFY, said here because the field is worth exactly
 * this much: it sees a socket and bytes, and cannot tell a loop-originated
 * frame from one a timer produced. last_responded is a CLAIM BY THE EMITTER,
 * like turn_status. The server's job is to keep that claim distinguishable from
 * the transport's, not to authenticate it — and the way it does that is by
 * having a frame nothing else sends.
 */
function handleLoopAlive(ctx: FrameCtx): void {
  const { state, db } = ctx;
  if (state.agentId !== null) touchResponded(db, state.agentId);
}

function handleSend(ctx: FrameCtx): void {
  const { ws, state, db, parsed, agentIndex, observerIndex } = ctx;
  const f = parsed as SendFrame;
  const result = routeDirect(db, agentIndex, state.agentId!, f, observerIndex);
  if (result.ok) {
    try {
      ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
    } catch (_) { /* ignore */ }
  } else {
    try {
      ws.send(JSON.stringify({
        type: 'error',
        ref: f.msg_id,
        code: result.error_code,
        message: result.error_message,
      }));
    } catch (_) { /* ignore */ }
  }
}

function handleAck(ctx: FrameCtx): void {
  const { db, parsed } = ctx;
  const msgId = (parsed as Record<string, unknown>).msg_id;
  if (typeof msgId === 'string') {
    markAcked(db, msgId);
  }
}

function handlePublish(ctx: FrameCtx): void {
  const { ws, state, db, parsed, agentIndex, observerIndex } = ctx;
  const f = parsed as PublishFrame;
  const result = routePublish(db, agentIndex, state.agentId!, f, observerIndex);
  if (result.ok) {
    try {
      ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
    } catch (_) { /* ignore */ }
  } else {
    try {
      ws.send(JSON.stringify({
        type: 'error',
        ref: f.msg_id,
        code: result.error_code,
        message: result.error_message,
      }));
    } catch (_) { /* ignore */ }
  }
}

function handleSubscribe(ctx: FrameCtx): void {
  const { ws, state, db, parsed } = ctx;
  const f = parsed as SubscribeFrame;
  const result = routeSubscribe(db, state.agentId!, f);
  if (result.ok) {
    try {
      ws.send(JSON.stringify({ type: 'ack', ref: f.topic, ok: true }));
    } catch (_) { /* ignore */ }
  } else {
    try {
      ws.send(JSON.stringify({
        type: 'error',
        ref: f.topic,
        code: result.error_code,
        message: result.error_message,
      }));
    } catch (_) { /* ignore */ }
  }
}

function handleUnsubscribe(ctx: FrameCtx): void {
  const { ws, state, db, parsed } = ctx;
  const f = parsed as UnsubscribeFrame;
  const result = routeUnsubscribe(db, state.agentId!, f);
  if (result.ok) {
    try {
      ws.send(JSON.stringify({ type: 'ack', ref: f.topic, ok: true }));
    } catch (_) { /* ignore */ }
  } else {
    try {
      ws.send(JSON.stringify({
        type: 'error',
        ref: f.topic,
        code: result.error_code,
        message: result.error_message,
      }));
    } catch (_) { /* ignore */ }
  }
}


function handleFileSend(ctx: FrameCtx): void {
  const { ws, state, db, parsed, agentIndex, maxFileBytes, filesDir, observerIndex } = ctx;
  const f = parsed as FileSendFrame;
  // Validate required string fields: msg_id, to, filename, data
  if (typeof f.msg_id !== 'string' || typeof f.to !== 'string' ||
      typeof f.filename !== 'string' || typeof f.data !== 'string') {
    ws.send(JSON.stringify({
      type: 'error', ref: f.msg_id,
      code: 'INVALID_REQUEST',
      message: 'msg_id, to, filename, and data are required strings',
    }));
    return;
  }
  const result = routeFile(db, agentIndex, state.agentId!, f, maxFileBytes, filesDir, observerIndex);
  if (result.ok) {
    // #60: echo the stored file's id so the sender learns it (absent if dropped).
    ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true, file_id: result.fileId }));
  } else {
    ws.send(JSON.stringify({
      type: 'error', ref: f.msg_id,
      code: result.error_code,
      message: result.error_message,
    }));
  }
}

function handleRemind(ctx: FrameCtx): void {
  const { ws, state, db, frame } = ctx;
  const text = frame.text;
  const when = frame.when;
  const recurring = frame.recurring === true;
  // ref-correlation: echo the REQUEST's msg_id on every reply when present.
  const reqMsgId = (typeof frame.msg_id === 'string' && frame.msg_id.length > 0) ? frame.msg_id : undefined;
  const refPart = reqMsgId ? { ref: reqMsgId } : {};

  if (typeof text !== 'string' || text.length === 0) {
    try {
      ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'INVALID_WHEN', message: 'text is required' }));
    } catch (_) { /* ignore */ }
    return;
  }
  if (Buffer.byteLength(text, 'utf8') > 4096) {
    try {
      ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'PAYLOAD_TOO_LARGE', message: 'text exceeds 4096 bytes' }));
    } catch (_) { /* ignore */ }
    return;
  }
  if (typeof when !== 'string' || when.length === 0) {
    try {
      ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'INVALID_WHEN', message: 'when is required' }));
    } catch (_) { /* ignore */ }
    return;
  }

  // Optional per-reminder IANA timezone. When present, cron fields and
  // bare offset-less ISO one-shots are interpreted as wall-clock in tz.
  const tzRaw = frame.tz;
  if (tzRaw !== undefined) {
    if (typeof tzRaw !== 'string' || !tzValidate(tzRaw)) {
      try {
        ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'INVALID_TZ', message: 'invalid IANA timezone' }));
      } catch (_) { /* ignore */ }
      return;
    }
  }
  const tz = (typeof tzRaw === 'string') ? tzRaw : null;

  let due_at: number;
  let schedule: string | null;

  if (recurring) {
    if (!cronValidate(when)) {
      try {
        ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'INVALID_CRON', message: 'invalid cron expression' }));
      } catch (_) { /* ignore */ }
      return;
    }
    const next = tz !== null ? cronNextTz(when, Date.now(), tz) : cronNext(when, Date.now());
    if (next === null) {
      try {
        ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'INVALID_CRON', message: 'no future occurrence found' }));
      } catch (_) { /* ignore */ }
      return;
    }
    due_at = next;
    schedule = when;
  } else {
    const dur = parseDuration(when);
    if (dur !== null) {
      // Duration → absolute (tz is a no-op, still recorded).
      due_at = Date.now() + dur;
      schedule = null;
    } else if (tz !== null && isBareIso(when)) {
      // Bare offset-less ISO + tz → interpret as wall-clock in tz.
      due_at = bareIsoToUtc(when, tz);
      schedule = null;
    } else {
      const parsedTime = new Date(when).getTime();
      if (Number.isFinite(parsedTime)) {
        if (parsedTime <= Date.now()) {
          try {
            ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'INVALID_WHEN', message: 'due time is in the past' }));
          } catch (_) { /* ignore */ }
          return;
        }
        due_at = parsedTime;
        schedule = null;
      } else {
        try {
          ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'INVALID_WHEN', message: 'when must be a duration (e.g. "90s"), ISO datetime, or cron expression with recurring=true' }));
        } catch (_) { /* ignore */ }
        return;
      }
    }
  }

  const rem = insertReminder(db, {
    id: crypto.randomUUID(),
    agent_id: state.agentId!,
    due_at,
    schedule,
    payload: text,
    created_at: Date.now(),
    tz,
  });
  try {
    ws.send(JSON.stringify({ type: 'ack', ...refPart, ok: true, reminder_id: rem.id, due_at: rem.due_at }));
  } catch (_) { /* ignore */ }
}

function handleListReminders(ctx: FrameCtx): void {
  const { ws, state, db, frame } = ctx;
  const reminders = listAgentReminders(db, state.agentId!);
  const resp: { type: string; ref?: string; reminders: unknown[] } = {
    type: 'reminders_list',
    reminders: reminders.map(r => ({
      id: r.id,
      due_at: r.due_at,
      schedule: r.schedule,
      payload: r.payload,
      created_at: r.created_at,
      last_fired_at: r.last_fired_at,
    })),
  };
  if (typeof frame.msg_id === 'string' && frame.msg_id.length > 0) resp.ref = frame.msg_id;
  try {
    ws.send(JSON.stringify(resp));
  } catch (_) { /* ignore */ }
}

function handleCancelReminder(ctx: FrameCtx): void {
  const { ws, state, db, frame } = ctx;
  const id = frame.id;
  // ref-correlation: echo the REQUEST's msg_id when present.
  const reqMsgId = (typeof frame.msg_id === 'string' && frame.msg_id.length > 0) ? frame.msg_id : undefined;
  const refPart = reqMsgId ? { ref: reqMsgId } : {};
  if (typeof id !== 'string' || id.length === 0) {
    try {
      ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'REMINDER_NOT_FOUND', message: 'reminder not found' }));
    } catch (_) { /* ignore */ }
    return;
  }
  const rem = getReminder(db, id);
  if (rem === null || rem.agent_id !== state.agentId!) {
    try {
      ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'REMINDER_NOT_FOUND', message: 'reminder not found' }));
    } catch (_) { /* ignore */ }
    return;
  }
  const cancelled = dbCancelReminder(db, id);
  if (!cancelled) {
    try {
      ws.send(JSON.stringify({ type: 'error', ...refPart, code: 'REMINDER_NOT_FOUND', message: 'reminder not found or already cancelled' }));
    } catch (_) { /* ignore */ }
    return;
  }
  try {
    ws.send(JSON.stringify({ type: 'ack', ...refPart, ok: true }));
  } catch (_) { /* ignore */ }
}

function handleListPresence(ctx: FrameCtx): void {
  const { ws, state, db, frame } = ctx;
  // Self-authed: post-auth dispatch only runs after authed===true, so
  // state.agentId is non-null here (the first-frame gate rejects an
  // unauthed list_presence with AUTH_REQUIRED + close 1008).
  const caller = state.agentId!;
  const all = listAgents(db);
  // ACL-filtered roster: agents the caller is ACL-related to, plus self.
  // #11: one ACL query for the whole roster rather than one per agent.
  const peers = listAclPeers(db, caller);
  const result = all
    .filter(a => a.id === caller || peers.has(a.id))
    .map(a => ({ id: a.id, online: a.online === 1, last_seen: a.last_seen, last_alive: a.last_alive ?? null, last_responded: a.last_responded ?? null }));
  const resp: { type: string; ref?: string; agents: typeof result } = { type: 'presence_list', agents: result };
  if (typeof frame.msg_id === 'string' && frame.msg_id.length > 0) resp.ref = frame.msg_id;
  try {
    ws.send(JSON.stringify(resp));
  } catch (_) { /* ignore */ }
}

// Frame type -> handler. Exact-string keys, mutually exclusive (no precedence),
// so map order is behavior-irrelevant. A type absent from this map (or a
// non-string type) falls through to NOT_IMPLEMENTED at the dispatch site.
// Exported as a TEST SEAM, matching http-admin's ROUTES: the dispatcher's
// crash guard (#94) can only be proven by making a handler throw, and a guard
// that is never made to fail is not a guard. Production code must not mutate
// this map.
export const POST_AUTH_HANDLERS: Record<string, FrameHandler> = {
  ping: handlePing,
  loop_alive: handleLoopAlive,   // #133
  send: handleSend,
  ack: handleAck,
  publish: handlePublish,
  subscribe: handleSubscribe,
  unsubscribe: handleUnsubscribe,
  file_send: handleFileSend,
  remind: handleRemind,
  list_reminders: handleListReminders,
  cancel_reminder: handleCancelReminder,
  list_presence: handleListPresence,
};

export function startWsServer(
  port: number,
  db: Database,
  maxFileBytes: number = 10_485_760,
  filesDir: string = '/data/files',
  presenceDebounceMs: number = 0,   // 0 = immediate (legacy). Production passes config value.
  observerIndex: Map<string, WebSocket> = new Map(),   // NEW — defaulted
): Promise<WsServerHandle> {
  return new Promise((resolve, reject) => {
    // #87: reconcile the durable `online` flag with reality BEFORE binding the
    // listener. Nothing can be connected yet — agentIndex is created empty a
    // few lines below and no socket has been accepted — so this is exact, not
    // an approximation. Any agent that survived the restart re-asserts online
    // on its reconnect, which the client does automatically.
    const staleOnline = clearAllOnline(db);
    if (staleOnline > 0) {
      console.log(JSON.stringify({
        evt: 'presence.stale_online_cleared', count: staleOnline, at: Date.now(),
      }));
    }

    // Create an HTTP server explicitly so we can track and destroy its sockets
    // #22 — unauthenticated liveness, on the WS listener rather than the admin
    // port. THE CHOICE OF LISTENER IS THE DESIGN DECISION, so it is written
    // down: #127 exists so an operator CAN restrict the admin port
    // (MESH_ADMIN_BIND), and a liveness endpoint that disappears when someone
    // takes that option is worse than none — the orchestrator would report the
    // bus dead exactly when it was hardened. The WS port must be reachable by
    // every agent and peering, so it is the one an orchestrator can always
    // reach. (spawner-v2 reads the boot log and admin API today; this does not
    // remove that path, it adds one that survives a restricted admin bind.)
    //
    // Before this, a plain GET here HUNG: http.createServer() had no request
    // handler, so Node never answered and the caller timed out. Nothing can
    // have depended on that, which is why adding a handler is safe.
    //
    // NO READINESS VARIANT. /readyz would have to mean "ready to take traffic",
    // which is only a distinct question once there is a second instance to
    // shift traffic to (#23, parked). A /readyz that always agreed with
    // /healthz would be a promise the system cannot keep.
    const httpServer = http.createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/healthz/')) {
        // db_ok is a real query, not a flag: an open handle to a corrupt or
        // closed database would answer `true` to anything cheaper, and the
        // failure this endpoint exists to catch is exactly "the process is up
        // and the store is not".
        let db_ok = false;
        try { db.prepare('SELECT 1').get(); db_ok = true; } catch (_) { db_ok = false; }
        // NOTHING THAT VARIES PER PROCESS. An earlier version returned
        // uptime_ms, which is a restart fingerprint: any peer that can reach
        // this port learns when the bus last restarted, and unlike the ACL or
        // the tap there is no reachability argument for it — this endpoint is
        // unauthenticated by design. Liveness needs the store check and nothing
        // else, so the store check is all it returns.
        const body = JSON.stringify({ db_ok });
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
        res.end(body);
        return;
      }
      // Everything else keeps the previous shape as closely as anything can:
      // a plain 404 rather than a hang. An unroutable request now gets an
      // answer, which is strictly better for a caller and reveals nothing.
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });
    // (c) Drop oversize frames at the CONNECTION level, before JSON.parse.
    //
    // The 1 MiB payload check in the router runs AFTER parsing, so a 100 MiB
    // frame was already fully buffered and parsed before anything refused it —
    // the cost is paid before the guard speaks. maxPayload makes the ws library
    // fail the frame and close, so a hostile size never reaches the parser.
    //
    // Headroom above the payload cap because the frame carries envelope too
    // (type, ids, content_type); the ROUTER's 1 MiB check is still the payload
    // authority and is unchanged.
    const wss = new WebSocketServer({ server: httpServer, maxPayload: 1_100_000 });
    const connections = new Set<WebSocket>();
    const sockets = new Set<net.Socket>();
    // Connection registry: ws -> state
    const registry = new Map<WebSocket, ConnState>();
    // Reverse index: agentId -> ws
    const agentIndex = new Map<string, WebSocket>();
    // F1a: alias -> peer socket. In memory ONLY, and deliberately so: it is the
    // online truth for peers, and after #87 a durable liveness claim that
    // outlives the process is exactly what must not exist. A restart clears it,
    // which is correct — no peer is connected to a process that just started.
    const peerIndex = new Map<string, WebSocket>();
    // Per-agent presence debounce state (Sprint 15). Keyed by agentId.
    const presenceState = new Map<string, PresenceState>();
    let shutdownStarted = false;

    // Broadcast an agent_status frame to all currently-connected, authed peers
    // that are ACL-related to `agentId`. ACL is re-checked LIVE at fire time.
    // Pass the connecting ws as `excludeWs` on connect; null on disconnect (the
    // disconnecting ws is already removed from `registry`).
    //
    // #11: ONE ACL query per presence event, not one per connected peer. The
    // recipient set is computed up front and the registry is filtered in
    // memory; "live at fire time" is unchanged, since the single query runs at
    // fire time too. Previously an N-peer mesh cost N queries per event.
    //
    // ONE INTENDED BEHAVIOUR DELTA, stated because it hides inside a change
    // advertised as pure performance. registry is keyed by SOCKET, so an agent
    // holding a second live connection appears in it twice. Previously, if that
    // agent also had a self-edge row in acl, aclRelated(A, A) was true and its
    // own status frame went to its other socket. listAclPeers excludes self, so
    // it no longer does. Intended — an agent does not need its own presence
    // event — and the only reachable case requires both a second socket AND a
    // self-edge, but it is a behaviour change and is pinned by a test.
    function broadcastStatus(agentId: string, online: boolean, lastSeen: number, excludeWs: WebSocket | null) {
      const subject = getAgentById(db, agentId);
      const statusMsg = JSON.stringify({ type: 'agent_status', agent_id: agentId, online, last_seen: lastSeen, last_alive: subject?.last_alive ?? null, last_responded: subject?.last_responded ?? null });
      const peers = listAclPeers(db, agentId);
      for (const [otherWs, otherState] of registry) {
        if (otherWs === excludeWs) continue;
        if (otherState.authed && otherState.agentId !== null && peers.has(otherState.agentId)) {
          try { otherWs.send(statusMsg); } catch (_) { /* ignore */ }
        }
      }
    }

    // Track all raw TCP sockets so we can destroy them on shutdown
    httpServer.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });

    httpServer.on('error', reject);
    wss.on('error', reject);

    // #127, symmetry: MESH_WS_BIND for the agent/peer listener. Same default —
    // absent means every interface, unchanged (`host: undefined` binds `::`
    // exactly as listen(port) does, verified, so the default is unchanged by
    // construction rather than by a branch).
    //
    // Named separately from MESH_ADMIN_BIND on purpose: the two ports have
    // DIFFERENT audiences. The WS port must be reachable by every agent and
    // every peering; the admin port need only be reachable by operators and the
    // spawner stack. One variable for both would force the more permissive.
    const wsBindHost = process.env.MESH_WS_BIND;
    httpServer.listen({ port, host: wsBindHost }, () => {
      // #139 shipped MESH_WS_BIND without this line, which made the two ports
      // asymmetric in exactly the way that matters: the admin port announces
      // where it bound and what is unauthenticated on it, while the port every
      // agent and peering must reach announced nothing. A deployer restricting
      // one and not the other had no way to see it. Same shape as the admin
      // line, and it fires when nothing is set — the case that needs telling.
      const addr = httpServer.address();
      const bound = typeof addr === 'object' && addr !== null ? `${addr.address}:${addr.port}` : String(addr);
      console.log(JSON.stringify({
        evt: 'ws.listening',
        bind: wsBindHost ?? '(all interfaces)',
        bound,
        note: wsBindHost === undefined
          ? 'agent/peer port bound to ALL interfaces — every agent and peering must reach it, so restricting it is a deployment decision with reachability consequences'
          : 'agent/peer port restricted; every agent and peering must be able to reach this address',
        at: Date.now(),
      }));
      wss.on('connection', (ws: WebSocket) => {
        connections.add(ws);

        const state: ConnState = { ws, agentId: null, peerAlias: null, authed: false };
        registry.set(ws, state);

        // #143: NO local `authed` mirror. It used to sit here beside
        // `state.authed`, set at both assignment sites together and read by
        // different consumers — the pre-auth guard and the auth timer read the
        // local, the presence fan-out and the close handler read the field.
        // One fact with two homes is the shape this repo keeps finding drift
        // in; here it also blocked the extraction below, because a captured
        // mutable local cannot move into a named function without becoming a
        // return value or a holder.
        //
        // Safe by CONSTRUCTION (exactly two assignment sites, both setting
        // both) and confirmed by MEASUREMENT (instrumented at all three read
        // sites, the two never diverged across 805 tests). The construction is
        // the argument; the measurement only says nothing contradicted it.
        let messageHandled = false;

        const authTimer = setTimeout(() => {
          if (!state.authed) {
            try {
              ws.send(JSON.stringify({ type: 'error', code: 'AUTH_TIMEOUT', message: 'no auth frame received within 5 seconds' }));
            } catch (_) { /* ignore */ }
            ws.close(1008, 'auth timeout');
          }
        }, 5000);

        ws.on('message', (data) => {
          let parsed: unknown;
          try {
            parsed = JSON.parse(data.toString());
          } catch (_) {
            if (!state.authed) {
              if (messageHandled) return;
              messageHandled = true;
              clearTimeout(authTimer);
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED', message: 'first frame must be auth' }));
              } catch (_) { /* ignore */ }
              ws.close(1008, 'auth required');
            }
            return;
          }

          const frame = parsed as Record<string, unknown>;

          if (!state.authed) {
            // Pre-auth: only process first frame
            if (messageHandled) return;
            messageHandled = true;
            clearTimeout(authTimer);

            // #143: the auth frame itself is handled by a named function. The
            // `return` below is the one both arms used to carry individually —
            // without it a completed auth falls through to the post-auth
            // dispatch below, which is what auth-seam.test.ts pins.
            handleAuthFrame({
              ws, state, db, frame, parsed,
              agentIndex, peerIndex, observerIndex, presenceState, broadcastStatus,
              clearAuthTimer: () => clearTimeout(authTimer),
            });
            return;
          }

          // Post-auth frame dispatch — handlers are named module-level functions
          // keyed by frame type in POST_AUTH_HANDLERS. A non-string or unknown
          // type falls through to NOT_IMPLEMENTED, exactly as the prior if-chain.
          const frameType = frame.type;

          // ── F1a (§5.1): the peer frame ALLOWLIST ────────────────────────
          //
          // A peer socket may send `relay` and `ping`, nothing else. Written as
          // an ALLOWLIST, not a denylist of agent frames: a denylist silently
          // admits every frame type added later, and the failure mode there is
          // a peer reaching an agent-only path with peer credentials.
          //
          // The reverse is guarded too — `relay` from an AGENT socket. Without
          // it, an agent could relay as though it were a mesh, which is the
          // forge #98's collision gates make impossible at the identity level
          // and this makes impossible at the frame level.
          if (state.peerAlias !== null) {
            if (frameType === 'ping') {
              // A peer's proof of life. Stamps last_seen and nothing else: no
              // `online` column exists on `peers`, and after #87 a durable
              // liveness claim is precisely what must not be invented.
              touchPeer(db, state.peerAlias);
              try { ws.send(JSON.stringify({ type: 'pong' })); } catch (_) { /* ignore */ }
              return;
            }
            if (frameType !== 'relay') {
              try {
                ws.send(JSON.stringify({
                  type: 'error', code: 'NOT_ALLOWED',
                  message: 'peer sockets may send relay or ping only',
                  ...(typeof frame.msg_id === 'string' ? { ref: frame.msg_id } : {}),
                }));
              } catch (_) { /* ignore */ }
              return;
            }
            // F1b: the relay itself. Handled here rather than through
            // POST_AUTH_HANDLERS because those receive an agent ctx and this
            // needs the peer row — routing it through the agent map would mean
            // reconstructing peer identity from a structure that does not hold
            // it.
            const peerRow = getPeerByAlias(db, state.peerAlias);
            if (peerRow === null) {
              // The row vanished under a live socket (deleted between auth and
              // now). Fail closed; the sweep will close the socket.
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'RELAY_REFUSED', message: 'relay refused' }));
              } catch (_) { /* ignore */ }
              return;
            }
            const relayResult = routeRelay(db, agentIndex, peerRow, frame as never, observerIndex);
            try {
              if (relayResult.ok) {
                ws.send(JSON.stringify({
                  type: 'ack', ok: true,
                  ...(typeof frame.msg_id === 'string' ? { ref: frame.msg_id } : {}),
                }));
              } else {
                ws.send(JSON.stringify({
                  type: 'error', code: relayResult.code, message: 'relay refused',
                  ...(relayResult.ref !== undefined ? { ref: relayResult.ref } : {}),
                }));
              }
            } catch (_) { /* ignore */ }
            return;
          } else if (frameType === 'relay') {
            try {
              ws.send(JSON.stringify({
                type: 'error', code: 'NOT_ALLOWED',
                message: 'relay is a peer frame',
                ...(typeof frame.msg_id === 'string' ? { ref: frame.msg_id } : {}),
              }));
            } catch (_) { /* ignore */ }
            return;
          }

          const handler = typeof frameType === 'string' ? POST_AUTH_HANDLERS[frameType] : undefined;
          if (handler !== undefined) {
            // #94 CLASS FIX, the same guard #68 gave the HTTP dispatcher. A
            // handler throw here used to reach the process with no
            // uncaughtException handler installed anywhere in server/ — so ANY
            // unexpected throw on ANY frame killed the mesh and flapped every
            // channel until a restart. A duplicate msg_id was merely the
            // reachable instance; the defect is that one client's bad frame
            // could stop the bus for everyone.
            //
            // The refusal is per-SOCKET, not per-process: the sender learns its
            // frame failed, every other connection is untouched, and the
            // process stays up. Logged because a caught crash that says nothing
            // is a crash nobody fixes.
            // COLOUR-BLIND by construction: a synchronous throw and a rejected
            // promise are the same event to this dispatcher. Today every
            // handler is sync and the try/catch alone would do — but the ws
            // 'message' listener does not await, so the moment any handler
            // becomes async its rejection becomes an unhandled rejection and
            // kills the process again, with no line of THIS code changing.
            // The HTTP plane already paid for exactly that (#68).
            const report = (err: unknown) => {
              console.error(JSON.stringify({
                evt: 'ws.handler_threw',
                frame_type: frameType,
                agent: state.agentId,
                error: (err as Error)?.message ?? String(err),
                at: Date.now(),
              }));
              try {
                ws.send(JSON.stringify({
                  type: 'error',
                  code: 'INTERNAL',
                  message: 'internal error handling frame',
                  ...(typeof frame.msg_id === 'string' ? { ref: frame.msg_id } : {}),
                }));
              } catch (_) { /* socket already gone; nothing further to do */ }
            };
            try {
              const maybe = handler({ ws, state, db, frame, parsed, agentIndex, observerIndex, maxFileBytes, filesDir });
              // Thenable check rather than `instanceof Promise`: a handler may
              // return a promise from another realm or a non-native thenable,
              // and this guard must not care which.
              if (maybe !== undefined && maybe !== null && typeof (maybe as PromiseLike<void>).then === 'function') {
                (maybe as PromiseLike<void>).then(undefined, report);
              }
            } catch (err) {
              report(err);
            }
            return;
          }

          // Unknown frame type after auth
          try {
            ws.send(JSON.stringify({ type: 'error', code: 'NOT_IMPLEMENTED', message: 'frame type not implemented' }));
          } catch (_) { /* ignore */ }
        });

        ws.on('close', () => {
          handleSocketClose({
            ws, db, registry, connections, agentIndex, peerIndex, observerIndex,
            presenceState, presenceDebounceMs, broadcastStatus,
            clearAuthTimer: () => clearTimeout(authTimer),
          });
        });
      });

      const handle: WsServerHandle = {
        wss,
        agentIndex,
        peerIndex,
        observerIndex,
        shutdown(): Promise<void> {
          if (shutdownStarted) {
            return Promise.resolve();
          }
          shutdownStarted = true;

          // Clear all pending offline-broadcast timers so they don't leak or
          // fire post-shutdown.
          for (const [, ps] of presenceState) {
            if (ps.pendingOfflineTimer !== null) {
              clearTimeout(ps.pendingOfflineTimer);
              ps.pendingOfflineTimer = null;
            }
          }
          presenceState.clear();

          // Mark all authenticated agents offline before closing
          for (const [, state] of registry) {
            if (state.authed && state.agentId !== null) {
              try {
                setOnline(db, state.agentId, false);
              } catch (_) { /* ignore */ }
            }
          }

          return new Promise((res) => {
            // Send close code 1001 to all connected WebSocket clients
            for (const ws of connections) {
              try {
                ws.close(1001, 'Going Away');
              } catch (_) { /* ignore */ }
            }

            // After 5-second window: force-terminate any remaining
            const forceTimeout = setTimeout(() => {
              for (const ws of connections) {
                try { ws.terminate(); } catch (_) { /* ignore */ }
              }
              for (const sock of sockets) {
                try { sock.destroy(); } catch (_) { /* ignore */ }
              }
            }, 5000);

            // Stop accepting new connections, then destroy all underlying TCP sockets
            // so httpServer.close() resolves promptly
            wss.close(() => {
              // wss (http server) closed
            });

            // Give 100ms for close frames to flush, then destroy TCP sockets
            // so the HTTP server can close
            setTimeout(() => {
              clearTimeout(forceTimeout);
              for (const ws of connections) {
                try { ws.terminate(); } catch (_) { /* ignore */ }
              }
              for (const sock of sockets) {
                try { sock.destroy(); } catch (_) { /* ignore */ }
              }
              httpServer.close(() => res());
              // Safety: resolve even if httpServer.close hangs
              setTimeout(res, 500);
            }, 100);
          });
        },
      };

      resolve(handle);
    });
  });
}
