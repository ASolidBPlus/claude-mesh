import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  getAgentById,
  aclCheck,
  insertMessage,
  markDelivered,
  getPendingMessages,
  getOrCreateTopic,
  getTopicSubscribers,
  subscribe as dbSubscribe,
  unsubscribe as dbUnsubscribe,
  getMessageByCorrelationId,
  Message,
  insertFile,
  getFile,
  markFileDelivered,
  FileRecord,
} from './db.ts';
import { incMsgStatus, incSent, incReceived, incAclDenied, incError, incBytes, incFile, observePayloadBytes } from './metrics.ts';

export interface SendFrame {
  type: 'send';
  msg_id: string;
  to: string;
  payload: string;
  content_type?: string;
  ttl_ms?: number;
}

export interface PublishFrame {
  type: 'publish';
  msg_id: string;
  topic: string;
  payload: string;
  content_type?: string;
  ttl_ms?: number;
}

export interface SubscribeFrame {
  type: 'subscribe';
  topic: string;
}

export interface UnsubscribeFrame {
  type: 'unsubscribe';
  topic: string;
}

export interface RouterResult {
  ok: boolean;
  msg_id?: string;
  error_code?: string;
  error_message?: string;
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

export function routeDirect(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: SendFrame
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

  // accepted+routed
  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  // 4. Compute expires_at
  const ttl = frame.ttl_ms === undefined ? 300_000 : frame.ttl_ms;
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'text/plain';
  const sent_at = Date.now();

  // 5. Recipient online
  const recipientWs = agentIndex.get(frame.to);
  if (recipientWs !== undefined) {
    insertMessage(db, {
      id: frame.msg_id,
      kind: 'direct',
      from_agent,
      to_agent: frame.to,
      payload: frame.payload,
      content_type,
      sent_at,
      expires_at,
    });
    const deliverFrame = buildDeliverFrame({
      id: frame.msg_id,
      kind: 'direct',
      from_agent,
      to_agent: frame.to,
      topic: null,
      correlation_id: null,
      payload: frame.payload,
      content_type,
      sent_at,
    });
    recipientWs.send(deliverFrame);
    markDelivered(db, frame.msg_id);
    incMsgStatus('direct', 'delivered');
    incReceived(frame.to);
    incBytes('out', payloadBytes);
  } else {
    // 6. Recipient offline
    if (ttl === 0) {
      // ttl_ms=0 and offline: discard
      incMsgStatus('direct', 'dropped');
      return { ok: true, msg_id: frame.msg_id };
    }
    insertMessage(db, {
      id: frame.msg_id,
      kind: 'direct',
      from_agent,
      to_agent: frame.to,
      payload: frame.payload,
      content_type,
      sent_at,
      expires_at,
    });
    incMsgStatus('direct', 'queued');
  }

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
  frame: PublishFrame
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
      markDelivered(db, msgId);
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
// Sprint 7: Request/Response types and routing
// ──────────────────────────────────────────────

export interface RequestFrame {
  type: 'request';
  msg_id: string;
  to: string;
  payload: string;
  content_type?: string;
  ttl_ms?: number;
  correlation_id: string;
}

export interface ResponseFrame {
  type: 'response';
  msg_id: string;
  correlation_id: string;
  payload: string;
  content_type?: string;
}

export interface PendingRequest {
  correlationId: string;
  fromAgent: string;
  expiresAt: number;
  msgId: string;
  timer: ReturnType<typeof setTimeout>;
  startTime?: number;          // NEW — set when the request is registered
  ws?: WebSocket;
  resolve?: (payload: string) => void;
  reject?: (err: Error) => void;
}

export function routeRequest(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: RequestFrame
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

  // accepted+routed
  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  // 4. Compute expires_at
  const ttl = frame.ttl_ms === undefined ? 300_000 : frame.ttl_ms;
  const expires_at = ttl === 0 ? null : Date.now() + ttl;

  const content_type = frame.content_type ?? 'text/plain';
  const sent_at = Date.now();

  // 5. Recipient online
  const recipientWs = agentIndex.get(frame.to);
  if (recipientWs !== undefined) {
    insertMessage(db, {
      id: frame.msg_id,
      kind: 'request',
      from_agent,
      to_agent: frame.to,
      correlation_id: frame.correlation_id,
      payload: frame.payload,
      content_type,
      sent_at,
      expires_at,
    });
    const deliverFrame = buildDeliverFrame({
      id: frame.msg_id,
      kind: 'request',
      from_agent,
      to_agent: frame.to,
      topic: null,
      correlation_id: frame.correlation_id,
      payload: frame.payload,
      content_type,
      sent_at,
    });
    recipientWs.send(deliverFrame);
    markDelivered(db, frame.msg_id);
    incMsgStatus('request', 'delivered');
    incReceived(frame.to);
    incBytes('out', payloadBytes);
  } else {
    // 6. Recipient offline
    if (ttl === 0) {
      incMsgStatus('request', 'dropped');
      return { ok: true, msg_id: frame.msg_id };
    }
    insertMessage(db, {
      id: frame.msg_id,
      kind: 'request',
      from_agent,
      to_agent: frame.to,
      correlation_id: frame.correlation_id,
      payload: frame.payload,
      content_type,
      sent_at,
      expires_at,
    });
    incMsgStatus('request', 'queued');
  }

  return { ok: true, msg_id: frame.msg_id };
}

// ──────────────────────────────────────────────
// Sprint 9: File Transfer
// ──────────────────────────────────────────────

export interface FileSendFrame {
  type: 'file_send';
  msg_id: string;
  to: string;
  filename: string;
  content_type?: string;
  data: string;       // base64
  ttl_ms?: number;
  caption?: string;
  reply_to_msg_id?: string;
}

export function routeFile(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: FileSendFrame,
  maxFileBytes: number,
  filesDir: string
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
    });
    recipientWs.send(deliverFrame);
    markFileDelivered(db, file_id);
    incMsgStatus('file', 'delivered');
    incReceived(frame.to);
  }
  if (recipientWs === undefined) {
    incMsgStatus('file', 'queued');
  }

  return { ok: true, msg_id: frame.msg_id };
}

export function drainFileQueue(
  db: Database,
  agentId: string,
  ws: WebSocket
): number {
  const now = Date.now();
  const pendingFiles = db.prepare(`
    SELECT id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id FROM files
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
    });
    ws.send(deliverFrame);
    markFileDelivered(db, file.id);
  }

  return pendingFiles.length;
}

export function routeResponse(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: ResponseFrame,
  pendingRequests: Map<string, PendingRequest>
): RouterResult & { deliverFrame?: string } {
  // 1. Look up pending request
  const pending = pendingRequests.get(frame.correlation_id);
  if (pending === undefined) {
    incError('CORRELATION_NOT_FOUND');
    return { ok: false, error_code: 'CORRELATION_NOT_FOUND', error_message: `no pending request for correlation_id: ${frame.correlation_id}` };
  }

  // 2. Validate responder identity
  const originalMsg = getMessageByCorrelationId(db, frame.correlation_id);
  if (originalMsg === null || originalMsg.to_agent !== from_agent) {
    incError('ACL_DENIED');
    incAclDenied(from_agent);
    return { ok: false, error_code: 'ACL_DENIED', error_message: 'only the original recipient may respond' };
  }

  // 3. Payload size check
  const payloadBytes = Buffer.byteLength(frame.payload, 'utf8');
  if (payloadBytes > 1_048_576) {
    incError('MESSAGE_TOO_LARGE');
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

  const content_type = frame.content_type ?? 'text/plain';
  const sent_at = Date.now();

  // 4. Store the response
  const responseMsg = insertMessage(db, {
    id: frame.msg_id,
    kind: 'response',
    from_agent,
    to_agent: pending.fromAgent,
    correlation_id: frame.correlation_id,
    payload: frame.payload,
    content_type,
    sent_at,
  });

  // 5. Mark response delivered immediately
  markDelivered(db, frame.msg_id);

  // 6. Build the deliver frame for the requester
  const deliverFrame = buildDeliverFrame({
    id: frame.msg_id,
    kind: 'response',
    from_agent,
    to_agent: pending.fromAgent,
    topic: null,
    correlation_id: frame.correlation_id,
    payload: frame.payload,
    content_type,
    sent_at,
  });

  // Emit ONLY sent / in-bytes / payload-histogram here. delivered / received /
  // out-bytes / duration are emitted exactly once in ws-server's response handler.
  incSent(from_agent);
  incBytes('in', payloadBytes);
  observePayloadBytes(payloadBytes);

  return { ok: true, deliverFrame };
}
