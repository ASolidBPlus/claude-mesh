// @claude-mesh/client — shared wire-frame types.
//
// This module is the SINGLE SOURCE OF TRUTH for the JSON shapes that travel
// over the mesh WebSocket. It is PURE TYPES: zero runtime code, zero imports
// (no `ws`, no `bun:sqlite`). The server imports the inbound-to-server frames
// from here via a relative path; the client uses the full set for its typed
// parser. External consumers get them re-exported from the package root.

// ──────────────────────────────────────────────
// Client → server frames (the server accepts these)
// ──────────────────────────────────────────────

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

export interface FileSendFrame {
  type: 'file_send';
  msg_id: string;
  to: string;
  filename: string;
  content_type?: string;
  data: string; // base64
  ttl_ms?: number;
  caption?: string;
  reply_to_msg_id?: string;
  group_id?: string; // #60: optional grouping tag for a multi-file send (passthrough)
}

export interface RemindFrame {
  type: 'remind';
  msg_id?: string;
  text: string;
  when: string; // duration | ISO | cron (when recurring)
  recurring?: boolean;
  tz?: string; // IANA timezone
}

export interface ListRemindersFrame {
  type: 'list_reminders';
  msg_id?: string;
}

export interface CancelReminderFrame {
  type: 'cancel_reminder';
  id: string;
  msg_id?: string;
}

export interface ListPresenceFrame {
  type: 'list_presence';
  msg_id?: string;
}

export interface AuthFrame {
  type: 'auth';
  agent_id: string;
  token: string;
}

// ──────────────────────────────────────────────
// Server → client frames (the client parses these)
// ──────────────────────────────────────────────

export type MeshKind = 'direct' | 'topic' | 'request' | 'response' | 'file';

export interface AuthOkFrame {
  type: 'auth_ok';
  agent_id: string;
  queued: number;
  queued_files: number;
}

export interface DeliverFrame {
  type: 'deliver';
  msg_id: string;
  kind: 'direct' | 'topic' | 'request' | 'response' | 'reminder';
  from: string;
  to: string | null;
  topic: string | null;
  correlation_id: string | null;
  payload: string;
  content_type: string;
  sent_at: number;
}

export interface AckFrame {
  type: 'ack';
  ref?: string;
  ok?: boolean;
  msg_id?: string;
  reminder_id?: string;
  due_at?: number;
  file_id?: string; // #60: on a file_send ack, the stored file's id (so the sender learns it)
}

export interface ErrorFrame {
  type: 'error';
  ref?: string;
  code: string;
  message: string;
}

export interface PongFrame {
  type: 'pong';
  ts: number;
  server_ts: number;
}

export interface AgentStatusFrame {
  type: 'agent_status';
  agent_id: string;
  online: boolean;
  last_seen: number;
}

export interface PresenceListFrame {
  type: 'presence_list';
  ref?: string;
  agents: { id: string; online: boolean; last_seen: number }[];
}

export interface RemindersListFrame {
  type: 'reminders_list';
  ref?: string;
  reminders: Record<string, unknown>[];
}

export interface FileDeliverFrame {
  type: 'file_deliver';
  file_id: string;
  from: string;
  to: string | null;
  filename: string;
  content_type: string;
  size_bytes: number;
  sent_at: number;
  fetch_url: string;
  caption: string | null;
  reply_to_msg_id: string | null;
  group_id: string | null; // #60: grouping tag echoed from the send (null = ungrouped)
}

// ──────────────────────────────────────────────
// Unions for the client's parser (NOT imported by the server)
// ──────────────────────────────────────────────

export type OutboundFrame =
  | SendFrame
  | PublishFrame
  | SubscribeFrame
  | UnsubscribeFrame
  | RequestFrame
  | ResponseFrame
  | FileSendFrame
  | RemindFrame
  | ListRemindersFrame
  | CancelReminderFrame
  | ListPresenceFrame
  | AuthFrame;

export type InboundFrame =
  | AuthOkFrame
  | DeliverFrame
  | AckFrame
  | ErrorFrame
  | PongFrame
  | AgentStatusFrame
  | PresenceListFrame
  | RemindersListFrame
  | FileDeliverFrame;
