import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
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
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

  // 2. Recipient exists check
  if (getAgentById(db, frame.to) === null) {
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
  }

  // 3. ACL check
  if (!aclCheck(db, from_agent, frame.to)) {
    return { ok: false, error_code: 'ACL_DENIED', error_message: `${from_agent} is not permitted to send to ${frame.to}` };
  }

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
  } else {
    // 6. Recipient offline
    if (ttl === 0) {
      // ttl_ms=0 and offline: discard
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
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

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
    } else {
      // 5d. Offline
      if (ttl === 0) {
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
    return { ok: false, error_code: 'MESSAGE_TOO_LARGE', error_message: 'payload exceeds 1 MB limit' };
  }

  // 2. Recipient exists check
  if (getAgentById(db, frame.to) === null) {
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
  }

  // 3. ACL check
  if (!aclCheck(db, from_agent, frame.to)) {
    return { ok: false, error_code: 'ACL_DENIED', error_message: `${from_agent} is not permitted to send to ${frame.to}` };
  }

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
  } else {
    // 6. Recipient offline
    if (ttl === 0) {
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
}

export function routeFile(
  db: Database,
  agentIndex: Map<string, WebSocket>,
  from_agent: string,
  frame: FileSendFrame,
  maxFileBytes: number
): RouterResult {
  // 1. Validate base64 — attempt decode and check round-trip
  let decoded: Buffer;
  try {
    decoded = Buffer.from(frame.data, 'base64');
    // Round-trip check: re-encoding must match original (no garbage accepted)
    if (decoded.toString('base64') !== frame.data) {
      return { ok: false, error_code: 'INVALID_BASE64', error_message: 'data is not valid base64' };
    }
  } catch {
    return { ok: false, error_code: 'INVALID_BASE64', error_message: 'data is not valid base64' };
  }

  // 2. Check decoded byte count
  if (decoded.byteLength > maxFileBytes) {
    return { ok: false, error_code: 'FILE_TOO_LARGE', error_message: `file exceeds ${maxFileBytes} byte limit` };
  }

  // 3. Recipient exists check
  if (getAgentById(db, frame.to) === null) {
    return { ok: false, error_code: 'AGENT_NOT_FOUND', error_message: `unknown agent: ${frame.to}` };
  }

  // 4. ACL check
  if (!aclCheck(db, from_agent, frame.to)) {
    return { ok: false, error_code: 'ACL_DENIED', error_message: `${from_agent} is not permitted to send to ${frame.to}` };
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
    return { ok: true, msg_id: frame.msg_id };
  }

  // 8. Store the file
  insertFile(db, {
    id: file_id,
    from_agent,
    to_agent: frame.to,
    filename: frame.filename,
    content_type,
    size_bytes,
    data: frame.data,
    sent_at,
    expires_at,
  });

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
    });
    recipientWs.send(deliverFrame);
    markFileDelivered(db, file_id);
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
    SELECT * FROM files
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
    return { ok: false, error_code: 'CORRELATION_NOT_FOUND', error_message: `no pending request for correlation_id: ${frame.correlation_id}` };
  }

  // 2. Validate responder identity
  const originalMsg = getMessageByCorrelationId(db, frame.correlation_id);
  if (originalMsg === null || originalMsg.to_agent !== from_agent) {
    return { ok: false, error_code: 'ACL_DENIED', error_message: 'only the original recipient may respond' };
  }

  // 3. Payload size check
  const payloadBytes = Buffer.byteLength(frame.payload, 'utf8');
  if (payloadBytes > 1_048_576) {
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

  return { ok: true, deliverFrame };
}
