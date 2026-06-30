import { WebSocketServer, WebSocket } from 'ws';
import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';
import { getAgentById, setOnline, touchAgent, getPendingMessages, markAcked, aclRelated, insertReminder, listAgentReminders, getReminder, cancelReminder as dbCancelReminder, listAgents, isObserver } from './db.ts';
import { validateToken } from './auth.ts';
import { parseDuration } from './duration.ts';
import { cronValidate, cronNext, tzValidate, cronNextTz, isBareIso, bareIsoToUtc } from './cron.ts';
import {
  routeDirect, drainQueue, SendFrame,
  routePublish, routeSubscribe, routeUnsubscribe,
  routeRequest, routeResponse,
  routeFile, drainFileQueue, FileSendFrame,
  PublishFrame, SubscribeFrame, UnsubscribeFrame,
  RequestFrame, ResponseFrame, PendingRequest,
} from './router.ts';
import { incMsgStatus, incReceived, incBytes, observeRequestDuration } from './metrics.ts';

export interface WsServerHandle {
  wss: WebSocketServer;
  agentIndex: Map<string, WebSocket>;
  pendingRequests: Map<string, PendingRequest>;
  observerIndex: Map<string, WebSocket>;
  shutdown(): Promise<void>;
}

interface ConnState {
  ws: WebSocket;
  agentId: string | null;
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
  pendingRequests: Map<string, PendingRequest>;
  observerIndex: Map<string, WebSocket>;
  maxFileBytes: number;
  filesDir: string;
}

type FrameHandler = (ctx: FrameCtx) => void;

function handlePing(ctx: FrameCtx): void {
  const { ws, state, db, frame } = ctx;
  const ts = frame.ts;
  const serverTs = Date.now();
  try {
    ws.send(JSON.stringify({ type: 'pong', ts, server_ts: serverTs }));
  } catch (_) { /* ignore */ }
  if (state.agentId !== null) {
    touchAgent(db, state.agentId);
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

function handleRequest(ctx: FrameCtx): void {
  const { ws, state, db, parsed, agentIndex, pendingRequests, observerIndex } = ctx;
  const f = parsed as RequestFrame;
  // Validate required fields
  if (typeof f.msg_id !== 'string' || typeof f.to !== 'string' || typeof f.payload !== 'string' || typeof f.correlation_id !== 'string') {
    try {
      ws.send(JSON.stringify({ type: 'error', ref: f.msg_id, code: 'INVALID_REQUEST', message: 'msg_id, to, payload, and correlation_id are required strings' }));
    } catch (_) { /* ignore */ }
    return;
  }
  // Validate ttl_ms
  const ttl_ms = f.ttl_ms === undefined ? 30_000 : f.ttl_ms;
  if (ttl_ms === 0 || ttl_ms > 300_000) {
    try {
      ws.send(JSON.stringify({ type: 'error', ref: f.msg_id, code: 'INVALID_REQUEST', message: 'ttl_ms must be between 1 and 300000' }));
    } catch (_) { /* ignore */ }
    return;
  }
  // Check for duplicate correlation_id
  if (pendingRequests.has(f.correlation_id)) {
    try {
      ws.send(JSON.stringify({ type: 'error', ref: f.msg_id, code: 'INVALID_REQUEST', message: `duplicate correlation_id: ${f.correlation_id}` }));
    } catch (_) { /* ignore */ }
    return;
  }
  const result = routeRequest(db, agentIndex, state.agentId!, { ...f, ttl_ms }, observerIndex);
  if (!result.ok) {
    try {
      ws.send(JSON.stringify({ type: 'error', ref: f.msg_id, code: result.error_code, message: result.error_message }));
    } catch (_) { /* ignore */ }
    return;
  }
  // Register pending request
  const correlationId = f.correlation_id;
  const timer = setTimeout(() => {
    pendingRequests.delete(correlationId);
    try {
      ws.send(JSON.stringify({
        type: 'error',
        ref: correlationId,
        code: 'REQUEST_TIMEOUT',
        message: `no response received within ${ttl_ms}ms`,
      }));
    } catch (_) { /* ignore: socket may be closed */ }
  }, ttl_ms);
  pendingRequests.set(correlationId, {
    correlationId,
    fromAgent: state.agentId!,
    expiresAt: Date.now() + ttl_ms,
    msgId: f.msg_id,
    timer,
    startTime: Date.now(),
    ws,
  });
  try {
    ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
  } catch (_) { /* ignore */ }
}

function handleResponse(ctx: FrameCtx): void {
  const { ws, state, db, parsed, agentIndex, pendingRequests, observerIndex } = ctx;
  const f = parsed as ResponseFrame;
  // Validate required fields
  if (typeof f.msg_id !== 'string' || typeof f.correlation_id !== 'string' || typeof f.payload !== 'string') {
    try {
      ws.send(JSON.stringify({ type: 'error', ref: (f as Record<string, unknown>).msg_id, code: 'INVALID_REQUEST', message: 'msg_id, correlation_id, and payload are required strings' }));
    } catch (_) { /* ignore */ }
    return;
  }
  const result = routeResponse(db, agentIndex, state.agentId!, f, pendingRequests, observerIndex);
  if (!result.ok) {
    try {
      ws.send(JSON.stringify({ type: 'error', ref: f.msg_id, code: result.error_code, message: result.error_message }));
    } catch (_) { /* ignore */ }
    return;
  }
  // Retrieve pending entry
  const pending = pendingRequests.get(f.correlation_id)!;
  clearTimeout(pending.timer);
  pendingRequests.delete(f.correlation_id);
  if (pending.ws) {
    try { pending.ws.send(result.deliverFrame!); } catch (_) { /* ignore */ }
    incMsgStatus('response', 'delivered');
    incReceived(pending.fromAgent);
    incBytes('out', Buffer.byteLength(f.payload, 'utf8'));
    if (typeof pending.startTime === 'number') observeRequestDuration((Date.now() - pending.startTime) / 1000);
  }
  if (pending.resolve) {
    pending.resolve(JSON.parse(result.deliverFrame!).payload);
  }
  try {
    ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
  } catch (_) { /* ignore */ }
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
    ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
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
  const result = all
    .filter(a => a.id === caller || aclRelated(db, caller, a.id))
    .map(a => ({ id: a.id, online: a.online === 1, last_seen: a.last_seen }));
  const resp: { type: string; ref?: string; agents: typeof result } = { type: 'presence_list', agents: result };
  if (typeof frame.msg_id === 'string' && frame.msg_id.length > 0) resp.ref = frame.msg_id;
  try {
    ws.send(JSON.stringify(resp));
  } catch (_) { /* ignore */ }
}

// Frame type -> handler. Exact-string keys, mutually exclusive (no precedence),
// so map order is behavior-irrelevant. A type absent from this map (or a
// non-string type) falls through to NOT_IMPLEMENTED at the dispatch site.
const POST_AUTH_HANDLERS: Record<string, FrameHandler> = {
  ping: handlePing,
  send: handleSend,
  ack: handleAck,
  publish: handlePublish,
  subscribe: handleSubscribe,
  unsubscribe: handleUnsubscribe,
  request: handleRequest,
  response: handleResponse,
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
    // Create an HTTP server explicitly so we can track and destroy its sockets
    const httpServer = http.createServer();
    const wss = new WebSocketServer({ server: httpServer });
    const connections = new Set<WebSocket>();
    const sockets = new Set<net.Socket>();
    // Connection registry: ws -> state
    const registry = new Map<WebSocket, ConnState>();
    // Reverse index: agentId -> ws
    const agentIndex = new Map<string, WebSocket>();
    const pendingRequests = new Map<string, PendingRequest>();
    // Per-agent presence debounce state (Sprint 15). Keyed by agentId.
    const presenceState = new Map<string, PresenceState>();
    let shutdownStarted = false;

    // Broadcast an agent_status frame to all currently-connected, authed peers
    // that are ACL-related to `agentId`. ACL is re-checked LIVE at fire time.
    // Pass the connecting ws as `excludeWs` on connect; null on disconnect (the
    // disconnecting ws is already removed from `registry`).
    function broadcastStatus(agentId: string, online: boolean, lastSeen: number, excludeWs: WebSocket | null) {
      const statusMsg = JSON.stringify({ type: 'agent_status', agent_id: agentId, online, last_seen: lastSeen });
      for (const [otherWs, otherState] of registry) {
        if (otherWs === excludeWs) continue;
        if (otherState.authed && otherState.agentId !== null && aclRelated(db, agentId, otherState.agentId)) {
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

        const state: ConnState = { ws, agentId: null, authed: false };
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
          const handler = typeof frameType === 'string' ? POST_AUTH_HANDLERS[frameType] : undefined;
          if (handler !== undefined) {
            handler({ ws, state, db, frame, parsed, agentIndex, pendingRequests, observerIndex, maxFileBytes, filesDir });
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
        pendingRequests,
        observerIndex,
        shutdown(): Promise<void> {
          if (shutdownStarted) {
            return Promise.resolve();
          }
          shutdownStarted = true;

          // Clear all pending request timers and reject MCP waiters
          for (const [, pending] of pendingRequests) {
            clearTimeout(pending.timer);
            if (pending.reject) {
              pending.reject(new Error('SERVER_SHUTDOWN'));
            }
          }
          pendingRequests.clear();

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
