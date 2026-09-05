import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  getAgentById,
  aclCheck,
  insertMessage,
  getMessage,
  markDelivered,
  getPendingMessages,
  getOrCreateTopic,
  getTopicSubscribers,
  subscribe as dbSubscribe,
  unsubscribe as dbUnsubscribe,
  Message,
  insertFile,
  getFile,
  markFileDelivered,
  FileRecord,
} from './db.ts';
import { incMsgStatus, incSent, incReceived, incAclDenied, incError, incBytes, incFile, observePayloadBytes } from './metrics.ts';
import { emitTap } from './tap.ts';

// Wire-frame types live in the shared client package (single source of truth).
// Import them for local type annotations AND re-export so existing importers of
// these names from './router.ts' (e.g. ws-server.ts) keep resolving unchanged.
import type {
  SendFrame, PublishFrame, SubscribeFrame, UnsubscribeFrame,
  FileSendFrame,
} from '../client/src/protocol.ts';
export type {
  SendFrame, PublishFrame, SubscribeFrame, UnsubscribeFrame,
  FileSendFrame,
};

export interface RouterResult {
  ok: boolean;
  msg_id?: string;
  error_code?: string;
  error_message?: string;
  fileId?: string; // #60: routeFile returns the stored file's id (absent if dropped)
}

export function buildDeliverFrame(msg: {
  id: string;
  kind: string;
  from_agent: string;
  to_agent: string | null;
  topic: string | null;
  correlation_id: string | null;
  payload: string;
  content_type: string;
  sent_at: number;
}): string {
  return JSON.stringify({
    type: 'deliver',
    msg_id: msg.id,
    kind: msg.kind,
    from: msg.from_agent,
    to: msg.to_agent,
    topic: msg.topic,
    correlation_id: msg.correlation_id,
    payload: msg.payload,
    content_type: msg.content_type,
    sent_at: msg.sent_at,
  });
}

/** One message's worth of delivery state, as deliverOrQueue needs it. */
export interface DeliverableMessage {
  id: string;
  from_agent: string;
  to_agent: string;
  payload: string;
  content_type: string;
  sent_at: number;
  expires_at: number | null;
  /** ttl_ms === 0: deliver live but persist nothing (and hence nothing to mark
   *  delivered). Offline + ephemeral is dropped, not queued. */
  ephemeral: boolean;
  payloadBytes: number;
}

/**
 * Deliver to a connected recipient, or queue for an offline one — the single
 * implementation shared by routeDirect and the relay handler (F1b, §5.2).
 *
 * SYNCHRONOUS, and that is load-bearing rather than incidental: routeDirect's
 * duplicate check and its insert must not be separated by an await, or two
 * frames interleave, both pass the check, and the second insert throws. Every
 * statement here is synchronous bun:sqlite or ws.send work.
 */
export function deliverOrQueue(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  msg: DeliverableMessage
): void {
  const recipientWs = agentIndex.get(msg.to_agent);
  if (recipientWs !== undefined) {
    if (!msg.ephemeral) {
      insertMessage(db, {
        id: msg.id, kind: 'direct', from_agent: msg.from_agent, to_agent: msg.to_agent,
        payload: msg.payload, content_type: msg.content_type,
        sent_at: msg.sent_at, expires_at: msg.expires_at,
      });
    }
    recipientWs.send(buildDeliverFrame({
      id: msg.id, kind: 'direct', from_agent: msg.from_agent, to_agent: msg.to_agent,
      topic: null, correlation_id: null, payload: msg.payload,
      content_type: msg.content_type, sent_at: msg.sent_at,
    }));
    if (!msg.ephemeral) markDelivered(db, msg.id);
    incMsgStatus('direct', 'delivered');
    incReceived(msg.to_agent);
    incBytes('out', msg.payloadBytes);
    return;
  }

  // Offline. ttl 0 is discarded rather than queued: an ephemeral message's
  // whole point is that it is worthless later.
  if (msg.ephemeral) {
    incMsgStatus('direct', 'dropped');
    return;
  }
  insertMessage(db, {
    id: msg.id, kind: 'direct', from_agent: msg.from_agent, to_agent: msg.to_agent,
    payload: msg.payload, content_type: msg.content_type,
    sent_at: msg.sent_at, expires_at: msg.expires_at,
  });
  incMsgStatus('direct', 'queued');
}

export function routeDirect(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: SendFrame,
  observerIndex: Map<string, WebSocket> = new Map()
): RouterResult {
  // 1. Payload size check
  const payloadBytes = Buffer.byteLength(frame.payload, 'utf8');
  if (payloadBytes > 1_048_576) {
    incError('MESSAGE_TOO_LARGE');
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

  // 2. Recipient exists check
  if (getAgentById(db, frame.to) === null) {
    incError('AGENT_NOT_FOUND');
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
  }

  // 3. ACL check
  if (!aclCheck(db, from_agent, frame.to)) {
    incError('ACL_DENIED');
    incAclDenied(from_agent);
    return { ok: false, error_code: 'ACL_DENIED', error_message: `${from_agent} is not permitted to send to ${frame.to}` };
  }

  // 3b. Duplicate msg_id (#94). frame.msg_id becomes messages.id, the PRIMARY
  // KEY, so a repeat raises UNIQUE constraint failed — which, before the
  // dispatcher guard, escaped as an uncaught exception and killed the process.
  // An honest SDK retry after a lost ack is enough to do it.
  //
  // Checked HERE rather than by catching the UNIQUE constraint at the insert,
  // for two reasons — neither of which is "the recipient would already have
  // been handed the frame". An earlier version of this comment claimed that,
  // and it was WRONG: insertMessage runs BEFORE recipientWs.send on the online
  // path, so a catch-based fix would in fact refuse before any delivery. The
  // real reasons:
  //
  //   1. A caught constraint has to be identified by matching SQLite's error
  //      text, which would also swallow a UNIQUE violation from any OTHER
  //      column or index and misreport it as a duplicate msg_id. Refusing on an
  //      explicit lookup says exactly what was wrong and nothing else.
  //   2. It refuses before the accepted-and-routed metrics below (incSent,
  //      incBytes, observePayloadBytes), so a rejected duplicate is not counted
  //      as traffic the bus carried.
  //
  // Checked against the stored row, so ttl_ms=0 is unaffected: an ephemeral
  // send persists nothing, has no id to collide with, and stays repeatable.
  // Reusing an id that DOES identify a stored message is refused, since that
  // is precisely the ambiguity the primary key exists to prevent.
  if (getMessage(db, frame.msg_id) !== null) {
    incError('DUPLICATE_MSG_ID');
    return {
      ok: false,
      error_code: 'DUPLICATE_MSG_ID',
      error_message: `msg_id already used: ${frame.msg_id}`,
    };
  }

  // accepted+routed
  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  // 4. Compute expires_at
  const ttl = frame.ttl_ms === undefined ? 300_000 : frame.ttl_ms;
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'text/plain';
  const sent_at = Date.now();

  // 5/6. Deliver or queue. Extracted (F1b) so the relay handler reuses this
  // EXACT path rather than a second copy of it — two implementations of
  // "deliver if online, queue if not, honour ttl 0" would drift, and the drift
  // would be invisible until a federated message behaved differently from a
  // local one.
  deliverOrQueue(db, agentIndex, {
    id: frame.msg_id,
    from_agent,
    to_agent: frame.to,
    payload: frame.payload,
    content_type,
    sent_at,
    expires_at,
    ephemeral: ttl === 0,
    payloadBytes,
  });

  emitTap(observerIndex, {
    type: 'tap', msg_id: frame.msg_id, kind: 'direct',
    from: from_agent, to: frame.to, topic: null, correlation_id: null,
    sent_at, size: payloadBytes, payload: frame.payload,
  });

  return { ok: true, msg_id: frame.msg_id };
}

export function drainQueue(
  db: Database,
  agentId: string,
  ws: WebSocket
): number {
  const pending = getPendingMessages(db, agentId);
  for (const msg of pending) {
    ws.send(buildDeliverFrame(msg));
    markDelivered(db, msg.id);
    incMsgStatus(msg.kind, 'delivered');
    incReceived(agentId);
    incBytes('out', Buffer.byteLength(msg.payload, 'utf8'));
  }
  return pending.length;
}

export function routePublish(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: PublishFrame,
  observerIndex: Map<string, WebSocket> = new Map()
): RouterResult {
  // 1. Payload size check
  const payloadBytes = Buffer.byteLength(frame.payload, 'utf8');
  if (payloadBytes > 1_048_576) {
    incError('MESSAGE_TOO_LARGE');
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  // 2. Ensure topic exists
  getOrCreateTopic(db, frame.topic, from_agent);

  // 3. Get subscribers, remove publisher
  const subscribers = getTopicSubscribers(db, frame.topic).filter(id => id !== from_agent);

  // 4. Compute expires_at
  let ttl: number;
  if (frame.ttl_ms === 0) {
    ttl = 0;
  } else {
    ttl = frame.ttl_ms ?? 300_000;
  }
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'text/plain';
  const sent_at = Date.now();

  // 5. Fan out to each subscriber
  for (const subscriber_id of subscribers) {
    // 5a. ACL check
    if (!aclCheck(db, from_agent, subscriber_id)) {
      incError('ACL_DENIED');
      incAclDenied(from_agent);
      continue;
    }

    // 5b. Unique msg_id per subscriber copy
    const msgId = crypto.randomUUID();

    // 5c. Online
    const recipientWs = agentIndex.get(subscriber_id);
    if (recipientWs !== undefined) {
      // ttl_ms=0 = EPHEMERAL: deliver live, persist nothing (see routeDirect).
      // Beat/heartbeat topics (e.g. turn-status) use this so they never
      // accumulate as scrollback history and starve real-message reads.
      const ephemeral = ttl === 0;
      if (!ephemeral) {
        insertMessage(db, {
          id: msgId,
          kind: 'topic',
          from_agent,
          to_agent: subscriber_id,
          topic: frame.topic,
          payload: frame.payload,
          content_type,
          sent_at,
          expires_at,
        });
      }
      recipientWs.send(buildDeliverFrame({
        id: msgId,
        kind: 'topic',
        from_agent,
        to_agent: null,
        topic: frame.topic,
        correlation_id: null,
        payload: frame.payload,
        content_type,
        sent_at,
      }));
      if (!ephemeral) markDelivered(db, msgId);
      incMsgStatus('topic', 'delivered');
      incReceived(subscriber_id);
      incBytes('out', payloadBytes);
    } else {
      // 5d. Offline
      if (ttl === 0) {
        incMsgStatus('topic', 'dropped');
        continue;
      }
      insertMessage(db, {
        id: msgId,
        kind: 'topic',
        from_agent,
        to_agent: subscriber_id,
        topic: frame.topic,
        payload: frame.payload,
        content_type,
        sent_at,
        expires_at,
      });
      incMsgStatus('topic', 'queued');
    }
  }

  emitTap(observerIndex, {
    type: 'tap', msg_id: frame.msg_id, kind: 'topic',
    from: from_agent, to: null, topic: frame.topic, correlation_id: null,
    sent_at, size: payloadBytes, payload: frame.payload,
  });

  return { ok: true, msg_id: frame.msg_id };
}

export function routeSubscribe(
  db: Database,
  agent_id: string,
  frame: SubscribeFrame
): RouterResult {
  getOrCreateTopic(db, frame.topic, agent_id);
  dbSubscribe(db, agent_id, frame.topic);
  return { ok: true };
}

export function routeUnsubscribe(
  db: Database,
  agent_id: string,
  frame: UnsubscribeFrame
): RouterResult {
  const existing = db.prepare('SELECT 1 FROM topics WHERE name = ?').get(frame.topic);
  if (existing === null) {
    return { ok: false, error_code: 'TOPIC_NOT_FOUND', error_message: `topic ${frame.topic} does not exist` };
  }
  dbUnsubscribe(db, agent_id, frame.topic);
  return { ok: true };
}

// ──────────────────────────────────────────────
// Sprint 9: File Transfer
// (FileSendFrame wire type is imported from the shared client protocol module above.)
// ──────────────────────────────────────────────

export function routeFile(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: FileSendFrame,
  maxFileBytes: number,
  filesDir: string,
  observerIndex: Map<string, WebSocket> = new Map()
): RouterResult {
  // 1. Validate base64 — attempt decode and check round-trip
  let decoded: Buffer;
  try {
    decoded = Buffer.from(frame.data, 'base64');
    // Round-trip check: re-encoding must match original (no garbage accepted)
    if (decoded.toString('base64') !== frame.data) {
      incError('INVALID_BASE64');
      return { ok: false, error_code: 'INVALID_BASE64', error_message: 'data is not valid base64' };
    }
  } catch {
    incError('INVALID_BASE64');
    return { ok: false, error_code: 'INVALID_BASE64', error_message: 'data is not valid base64' };
  }

  // 2. Check decoded byte count
  if (decoded.byteLength > maxFileBytes) {
    incError('FILE_TOO_LARGE');
    return { ok: false, error_code: 'FILE_TOO_LARGE', error_message: `file exceeds ${maxFileBytes} byte limit` };
  }

  // 3. Recipient exists check
  if (getAgentById(db, frame.to) === null) {
    incError('AGENT_NOT_FOUND');
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
  }

  // 4. ACL check
  if (!aclCheck(db, from_agent, frame.to)) {
    incError('ACL_DENIED');
    incAclDenied(from_agent);
    return { ok: false, error_code: 'ACL_DENIED', error_message: `${from_agent} is not permitted to send to ${frame.to}` };
  }

  // 4b. Caption size validation
  if (frame.caption !== undefined && Buffer.byteLength(frame.caption, 'utf8') > 4096) {
    incError('CAPTION_TOO_LARGE');
    return { ok: false, error_code: 'CAPTION_TOO_LARGE', error_message: 'caption exceeds 4096 byte limit' };
  }

  // 5. Generate file_id
  const file_id = crypto.randomUUID();

  // 6. Compute expires_at (same logic as routeDirect: 0 -> null, default 300_000)
  const ttl = frame.ttl_ms === undefined ? 300_000 : frame.ttl_ms;
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'application/octet-stream';
  const size_bytes = decoded.byteLength;
  const sent_at = Date.now();

  // 7. If recipient offline and ttl_ms === 0: discard entirely
  const recipientWs = agentIndex.get(frame.to);
  if (recipientWs === undefined && ttl === 0) {
    incMsgStatus('file', 'dropped');
    return { ok: true, msg_id: frame.msg_id };
  }

  // 8. Write file to disk
  const filePath = join(filesDir, file_id);
  writeFileSync(filePath, decoded);

  // 9. Store metadata in DB
  insertFile(db, {
    id: file_id,
    from_agent,
    to_agent: frame.to,
    filename: frame.filename,
    content_type,
    size_bytes,
    file_path: filePath,
    sent_at,
    expires_at,
    caption: frame.caption ?? null,
    reply_to_msg_id: frame.reply_to_msg_id ?? null,
    group_id: frame.group_id ?? null,
  });
  incFile();
  incSent(from_agent);

  // 9. Deliver if recipient online
  if (recipientWs !== undefined) {
    const deliverFrame = JSON.stringify({
      type: 'file_deliver',
      file_id,
      from: from_agent,
      to: frame.to,
      filename: frame.filename,
      content_type,
      size_bytes,
      sent_at,
      fetch_url: `/files/${file_id}`,
      caption: frame.caption ?? null,
      reply_to_msg_id: frame.reply_to_msg_id ?? null,
      group_id: frame.group_id ?? null,
    });
    recipientWs.send(deliverFrame);
    markFileDelivered(db, file_id);
    incMsgStatus('file', 'delivered');
    incReceived(frame.to);
  }
  if (recipientWs === undefined) {
    incMsgStatus('file', 'queued');
  }

  emitTap(observerIndex, {
    type: 'tap', msg_id: frame.msg_id, kind: 'file',
    from: from_agent, to: frame.to, topic: null, correlation_id: null,
    sent_at, size: size_bytes, payload: null,
    file_id, filename: frame.filename, content_type,
  });

  return { ok: true, msg_id: frame.msg_id, fileId: file_id };
}

export function drainFileQueue(
  db: Database,
  agentId: string,
  ws: WebSocket
): number {
  const now = Date.now();
  const pendingFiles = db.prepare(`
    SELECT id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id, group_id FROM files
    WHERE to_agent = ?
      AND delivered_at IS NULL
      AND (expires_at IS NULL OR expires_at >= ?)
    ORDER BY sent_at ASC
  `).all(agentId, now) as FileRecord[];

  for (const file of pendingFiles) {
    const deliverFrame = JSON.stringify({
      type: 'file_deliver',
      file_id: file.id,
      from: file.from_agent,
      to: file.to_agent,
      filename: file.filename,
      content_type: file.content_type,
      size_bytes: file.size_bytes,
      sent_at: file.sent_at,
      fetch_url: `/files/${file.id}`,
      caption: file.caption,
      reply_to_msg_id: file.reply_to_msg_id,
      group_id: file.group_id,
    });
    ws.send(deliverFrame);
    markFileDelivered(db, file.id);
  }

  return pendingFiles.length;
}
