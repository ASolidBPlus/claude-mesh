import { WebSocketServer, WebSocket } from 'ws';
import { Database } from 'bun:sqlite';
import * as http from 'http';
import * as net from 'net';
import { getAgentById, setOnline, touchAgent, getPendingMessages, markAcked, aclRelated, insertReminder, listAgentReminders, getReminder, cancelReminder as dbCancelReminder } from './db.ts';
import { validateToken } from './auth.ts';
import { parseDuration } from './duration.ts';
import { cronValidate, cronNext } from './cron.ts';
import {
  routeDirect, drainQueue, SendFrame,
  routePublish, routeSubscribe, routeUnsubscribe,
  routeRequest, routeResponse,
  routeFile, drainFileQueue, FileSendFrame,
  PublishFrame, SubscribeFrame, UnsubscribeFrame,
  RequestFrame, ResponseFrame, PendingRequest,
} from './router.ts';

export interface WsServerHandle {
  wss: WebSocketServer;
  agentIndex: Map<string, WebSocket>;
  pendingRequests: Map<string, PendingRequest>;
  shutdown(): Promise<void>;
}

interface ConnState {
  ws: WebSocket;
  agentId: string | null;
  authed: boolean;
}

export function startWsServer(port: number, db: Database, maxFileBytes: number = 10_485_760, filesDir: string = '/data/files'): Promise<WsServerHandle> {
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
    let shutdownStarted = false;

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

            // Broadcast agent_status to ACL-related agents only
            const statusMsg = JSON.stringify({
              type: 'agent_status',
              agent_id: agentId,
              online: true,
              last_seen: connectTime,
            });
            for (const [otherWs, otherState] of registry) {
              if (otherWs !== ws && otherState.authed && otherState.agentId !== null && aclRelated(db, agentId, otherState.agentId)) {
                try {
                  otherWs.send(statusMsg);
                } catch (_) { /* ignore */ }
              }
            }

            return;
          }

          // Post-auth frame dispatch
          const frameType = frame.type;

          if (frameType === 'ping') {
            const ts = frame.ts;
            const serverTs = Date.now();
            try {
              ws.send(JSON.stringify({ type: 'pong', ts, server_ts: serverTs }));
            } catch (_) { /* ignore */ }
            if (state.agentId !== null) {
              touchAgent(db, state.agentId);
            }
            return;
          }

          if (frameType === 'send') {
            const f = parsed as SendFrame;
            const result = routeDirect(db, agentIndex, state.agentId!, f);
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
            return;
          }

          if (frameType === 'ack') {
            const msgId = (parsed as Record<string, unknown>).msg_id;
            if (typeof msgId === 'string') {
              markAcked(db, msgId);
            }
            return;
          }

          if (frameType === 'publish') {
            const f = parsed as PublishFrame;
            const result = routePublish(db, agentIndex, state.agentId!, f);
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
            return;
          }

          if (frameType === 'subscribe') {
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
            return;
          }

          if (frameType === 'unsubscribe') {
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
            return;
          }

          if (frameType === 'request') {
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
            const result = routeRequest(db, agentIndex, state.agentId!, { ...f, ttl_ms });
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
              ws,
            });
            try {
              ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
            } catch (_) { /* ignore */ }
            return;
          }

          if (frameType === 'response') {
            const f = parsed as ResponseFrame;
            // Validate required fields
            if (typeof f.msg_id !== 'string' || typeof f.correlation_id !== 'string' || typeof f.payload !== 'string') {
              try {
                ws.send(JSON.stringify({ type: 'error', ref: (f as Record<string, unknown>).msg_id, code: 'INVALID_REQUEST', message: 'msg_id, correlation_id, and payload are required strings' }));
              } catch (_) { /* ignore */ }
              return;
            }
            const result = routeResponse(db, agentIndex, state.agentId!, f, pendingRequests);
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
            }
            if (pending.resolve) {
              pending.resolve(JSON.parse(result.deliverFrame!).payload);
            }
            try {
              ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
            } catch (_) { /* ignore */ }
            return;
          }

          if (frameType === 'file_send') {
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
            const result = routeFile(db, agentIndex, state.agentId!, f, maxFileBytes, filesDir);
            if (result.ok) {
              ws.send(JSON.stringify({ type: 'ack', ref: f.msg_id, ok: true }));
            } else {
              ws.send(JSON.stringify({
                type: 'error', ref: f.msg_id,
                code: result.error_code,
                message: result.error_message,
              }));
            }
            return;
          }

          if (frameType === 'remind') {
            const text = frame.text;
            const when = frame.when;
            const recurring = frame.recurring === true;

            if (typeof text !== 'string' || text.length === 0) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'INVALID_WHEN', message: 'text is required' }));
              } catch (_) { /* ignore */ }
              return;
            }
            if (Buffer.byteLength(text, 'utf8') > 4096) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'PAYLOAD_TOO_LARGE', message: 'text exceeds 4096 bytes' }));
              } catch (_) { /* ignore */ }
              return;
            }
            if (typeof when !== 'string' || when.length === 0) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'INVALID_WHEN', message: 'when is required' }));
              } catch (_) { /* ignore */ }
              return;
            }

            let due_at: number;
            let schedule: string | null;

            if (recurring) {
              if (!cronValidate(when)) {
                try {
                  ws.send(JSON.stringify({ type: 'error', code: 'INVALID_CRON', message: 'invalid cron expression' }));
                } catch (_) { /* ignore */ }
                return;
              }
              const next = cronNext(when, Date.now());
              if (next === null) {
                try {
                  ws.send(JSON.stringify({ type: 'error', code: 'INVALID_CRON', message: 'no future occurrence found' }));
                } catch (_) { /* ignore */ }
                return;
              }
              due_at = next;
              schedule = when;
            } else {
              const dur = parseDuration(when);
              if (dur !== null) {
                due_at = Date.now() + dur;
                schedule = null;
              } else {
                const parsedTime = new Date(when).getTime();
                if (Number.isFinite(parsedTime)) {
                  if (parsedTime <= Date.now()) {
                    try {
                      ws.send(JSON.stringify({ type: 'error', code: 'INVALID_WHEN', message: 'due time is in the past' }));
                    } catch (_) { /* ignore */ }
                    return;
                  }
                  due_at = parsedTime;
                  schedule = null;
                } else {
                  try {
                    ws.send(JSON.stringify({ type: 'error', code: 'INVALID_WHEN', message: 'when must be a duration (e.g. "90s"), ISO datetime, or cron expression with recurring=true' }));
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
            });
            try {
              ws.send(JSON.stringify({ type: 'ack', ref: rem.id, ok: true, reminder_id: rem.id, due_at: rem.due_at }));
            } catch (_) { /* ignore */ }
            return;
          }

          if (frameType === 'list_reminders') {
            const reminders = listAgentReminders(db, state.agentId!);
            try {
              ws.send(JSON.stringify({
                type: 'reminders_list',
                reminders: reminders.map(r => ({
                  id: r.id,
                  due_at: r.due_at,
                  schedule: r.schedule,
                  payload: r.payload,
                  created_at: r.created_at,
                  last_fired_at: r.last_fired_at,
                })),
              }));
            } catch (_) { /* ignore */ }
            return;
          }

          if (frameType === 'cancel_reminder') {
            const id = frame.id;
            if (typeof id !== 'string' || id.length === 0) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'REMINDER_NOT_FOUND', message: 'reminder not found' }));
              } catch (_) { /* ignore */ }
              return;
            }
            const rem = getReminder(db, id);
            if (rem === null || rem.agent_id !== state.agentId!) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'REMINDER_NOT_FOUND', message: 'reminder not found' }));
              } catch (_) { /* ignore */ }
              return;
            }
            const cancelled = dbCancelReminder(db, id);
            if (!cancelled) {
              try {
                ws.send(JSON.stringify({ type: 'error', code: 'REMINDER_NOT_FOUND', message: 'reminder not found or already cancelled' }));
              } catch (_) { /* ignore */ }
              return;
            }
            try {
              ws.send(JSON.stringify({ type: 'ack', ref: id, ok: true }));
            } catch (_) { /* ignore */ }
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

            const disconnectTime = Date.now();
            const statusMsg = JSON.stringify({
              type: 'agent_status',
              agent_id: agentId,
              online: false,
              last_seen: disconnectTime,
            });
            for (const [otherWs, otherState] of registry) {
              if (otherState.authed && otherState.agentId !== null && aclRelated(db, agentId, otherState.agentId)) {
                try {
                  otherWs.send(statusMsg);
                } catch (_) { /* ignore */ }
              }
            }
          }
        });
      });

      const handle: WsServerHandle = {
        wss,
        agentIndex,
        pendingRequests,
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
