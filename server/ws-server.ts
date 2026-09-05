import { WebSocketServer, WebSocket } from 'ws';
import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';
import { getAgentById, setOnline, clearAllOnline, getPeerByAlias, touchPeer, touchAgent, touchAlive, getPendingMessages, markAcked, listAclPeers, insertReminder, listAgentReminders, getReminder, cancelReminder as dbCancelReminder, listAgents, isObserver } from './db.ts';
import { validateToken } from './auth.ts';
import { parseDuration } from './duration.ts';
import { cronValidate, cronNext, tzValidate, cronNextTz, isBareIso, bareIsoToUtc } from './cron.ts';
import {
  routeDirect, drainQueue, SendFrame,
  routePublish, routeSubscribe, routeUnsubscribe,
  routeFile, drainFileQueue, FileSendFrame,
  PublishFrame, SubscribeFrame, UnsubscribeFrame,
} from './router.ts';
import { incMsgStatus, incReceived, incBytes } from './metrics.ts';

/** F1a (§5.1): the only inbound peer protocol this mesh speaks. A version is a
 *  property of a LIVE CONNECTION, never of a stored row (D7) — which is why it
 *  is checked at auth and not persisted on `peers`. */
export const PEER_PROTOCOL_VERSION = 1;

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
    .map(a => ({ id: a.id, online: a.online === 1, last_seen: a.last_seen, last_alive: a.last_alive ?? null }));
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
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
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
      const statusMsg = JSON.stringify({ type: 'agent_status', agent_id: agentId, online, last_seen: lastSeen, last_alive: getAgentById(db, agentId)?.last_alive ?? null });
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

    httpServer.listen(port, () => {
      wss.on('connection', (ws: WebSocket) => {
        connections.add(ws);

        const state: ConnState = { ws, agentId: null, peerAlias: null, authed: false };
        registry.set(ws, state);

        let authed = false;
        let messageHandled = false;

        const authTimer = setTimeout(() => {
          if (!authed) {
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
            if (!authed) {
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

          if (!authed) {
            // Pre-auth: only process first frame
            if (messageHandled) return;
            messageHandled = true;
            clearTimeout(authTimer);

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
            if (peerRow !== null && validateToken(token, peerRow.token_hash)) {
              // (a) disabled first, and with the EXACT message of the
              // invalid-token path: a revoked peer must not be able to tell
              // "my key was revoked" from "my token is wrong".
              if (peerRow.disabled === 1) {
                try {
                  ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'invalid token' }));
                } catch (_) { /* ignore */ }
                ws.close(1008, 'auth failed');
                return;
              }

              // (b) protocol AFTER the credential matched.
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
              authed = true;
              state.authed = true;
              state.peerAlias = agentId;
              clearTimeout(authTimer);

              // NEWER WINS (D11): close the older socket BEFORE the index is
              // overwritten, so the close handler's identity guard sees that it
              // is no longer the indexed socket and leaves the new one alone.
              const existing = peerIndex.get(agentId);
              if (existing !== undefined && existing !== ws) {
                try {
                  existing.send(JSON.stringify({
                    type: 'error', code: 'PEER_REPLACED',
                    message: 'another socket authenticated for this alias',
                  }));
                } catch (_) { /* ignore */ }
                try { existing.close(1008, 'peer replaced'); } catch (_) { /* ignore */ }
              }
              peerIndex.set(agentId, ws);
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

            if (!validateToken(token, agent.token_hash)) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'AUTH_FAILED', message: 'invalid token' }));
              } catch (_) { /* ignore */ }
              ws.close(1008, 'auth failed');
              return;
            }

            const connectTime = Date.now();
            setOnline(db, agentId, true);

            authed = true;
            state.authed = true;
            state.agentId = agentId;
            agentIndex.set(agentId, ws);

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
            // `relay` itself lands in F1b; until then it is not implemented,
            // and says so rather than being silently accepted.
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
          clearTimeout(authTimer);
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
