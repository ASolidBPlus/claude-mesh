import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import {
  getAgentById,
  aclCheck,
  insertMessage,
  markDelivered,
  getPendingMessages,
  Message,
} from './db.ts';

export interface SendFrame {
  type: 'send';
  msg_id: string;
  to: string;
  payload: string;
  content_type?: string;
  ttl_ms?: number;
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
