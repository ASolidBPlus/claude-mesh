// @claude-mesh/client — shared wire-frame types.
//
// This module is the SINGLE SOURCE OF TRUTH for the WIRE: the JSON shapes that
// travel over the mesh WebSocket, AND the protocol version constant below.
// Types plus that one runtime value; still zero imports (no `ws`, no
// `bun:sqlite`).
//
// The header used to say PURE TYPES: zero runtime code. Changed in the SAME
// commit that added the constant — otherwise the fix for a false claim ABOUT
// this file would have left a false claim IN it. The server imports the inbound-to-server frames
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
  /** F0c (§7): protocol version, sent only by a peer connection. Absent on an
   *  ordinary agent auth frame, which must stay byte-identical to today's —
   *  an added field would change what every existing client sends. */
  protocol?: number;
}

// ──────────────────────────────────────────────
// Server → client frames (the client parses these)
// ──────────────────────────────────────────────

export type MeshKind = 'direct' | 'topic' | 'file';

export interface AuthOkFrame {
  type: 'auth_ok';
  agent_id: string;
  queued: number;
  queued_files: number;
}

export interface DeliverFrame {
  type: 'deliver';
  msg_id: string;
  kind: 'direct' | 'topic' | 'reminder';
  from: string;
  to: string | null;
  topic: string | null;
  // Inert since the request/response strip: only req/resp frames ever set this;
  // always null for surviving kinds. Kept as a nullable wire field to avoid a
  // deliver-frame contract change across parsers (backend mesh-ws, mesh-chat).
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
  /** Last TRAFFIC (unix ms). */
  last_seen: number;
  /** Last proof-of-life (unix ms), stamped on keepalive pong. null = never.
      Distinct from last_seen on purpose — an idle-healthy node advances
      last_alive but not last_seen. */
  last_alive?: number | null;
  /** #133: the LOOP's proof-of-life, optional exactly as last_alive is. */
  last_responded?: number | null;
}

/**
 * #133 — the agent's LOOP reporting that it is alive, as distinct from the
 * transport's keepalive `ping`. Fire-and-forget: the server stamps
 * last_responded and sends nothing back, so this frame has no reply shape.
 */
export interface LoopAliveFrame {
  type: 'loop_alive';
}

export interface PresenceListFrame {
  type: 'presence_list';
  ref?: string;
  // #133: `last_responded` is optional exactly as `last_alive` is — the server
  // widened the wire first and the emitter ships separately (spawner#346), so a
  // client built against an older bus sees the key absent and one built against
  // a newer bus sees it null until something writes it. Both are the same
  // "unknown", which is why one optional field covers both.
  agents: { id: string; online: boolean; last_seen: number; last_alive?: number | null; last_responded?: number | null }[];
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

// ──────────────────────────────────────────────
// Protocol version — ONE authority (#F2b item 7)
// ──────────────────────────────────────────────

/**
 * The mesh-to-mesh peer protocol version.
 *
 * THIS IS THE ONLY DEFINITION. Three sites read it, and they answer three
 * different questions that must give the same number:
 *
 *   - `server/ws-server.ts` — what this mesh ACCEPTS on a peer auth frame;
 *   - `client/src/peer-client.ts` — what a peer ANNOUNCES when connecting;
 *   - `server/http-admin.ts` — what REGISTRATION TELLS a new peer to send, in
 *     the 201 body.
 *
 * The third is the consequential one and was the last to be found: bump the
 * version with a literal left there and registration keeps advertising the old
 * number, so every NEW peer is told to speak a version auth then rejects.
 * Registration succeeds, authentication always fails, and the far mesh sees
 * PROTOCOL_MISMATCH on its own fresh credential — the fault is entirely ours
 * and every piece of evidence points at them.
 *
 * A MUTANT RE-INTRODUCING A LITERAL AT ANY OF THE THREE IS WHAT THIS EXISTS TO
 * PREVENT. The enumeration test is scoped BY VALUE across server/ and client/,
 * not by the sites anyone happened to name — grepping the identifier finds only
 * the sites already doing the right thing, so it cannot find the ones that
 * aren't. That is how the third site was missed the first time.
 *
 * It lives here rather than in either package because it is a property of the
 * WIRE. This file is already the seam both sides read across:
 * `peer-client.ts` imports it, and `server/router.ts` imports it by relative
 * path — that predates this change.
 */
export const PEER_PROTOCOL_VERSION = 1;
