import { WebSocket } from 'ws';
import type {
  AuthFrame,
  SendFrame,
  PublishFrame,
  SubscribeFrame,
  UnsubscribeFrame,
  RemindFrame,
  ListRemindersFrame,
  CancelReminderFrame,
  ListPresenceFrame,
  FileSendFrame,
  DeliverFrame,
  FileDeliverFrame,
  AckFrame,
  ErrorFrame,
  RemindersListFrame,
  AgentStatusFrame,
  PresenceListFrame,
  InboundFrame,
} from './protocol.ts';

/**
 * A pending reminder as returned by `listReminders()` — camelCase.
 */
export interface Reminder {
  id: string;
  dueAt: number;
  schedule: string | null;
  payload: string;
  createdAt: number;
  lastFiredAt: number | null;
}

export interface MeshClientConfig {
  serverUrl?: string; // default process.env.MESH_SERVER_URL
  agentId?: string; // default process.env.MESH_AGENT_ID
  agentToken?: string; // default process.env.MESH_AGENT_TOKEN
  // Admin HTTP base URL for fetchFile() (e.g. 'http://host:7385'). The admin
  // API is usually a DIFFERENT port than the WS serverUrl, so this can't be
  // derived reliably — set it (or MESH_HTTP_URL) to use fetchFile when the
  // admin port ≠ ws port (the default). If unset, fetchFile falls back to
  // serverUrl with ws→http (same host+port), which only works when they share
  // a port.
  httpUrl?: string; // default process.env.MESH_HTTP_URL

  // ── Keepalive tuning (optional) ──
  // Defaults are the production values and are what you want in almost every
  // case; they exist mainly so tests can drive the liveness path in
  // milliseconds instead of minutes.
  /** Keepalive ping period (default 25 000 ms). */
  pingIntervalMs?: number;
  /** How long without a pong before the socket is declared dead and terminated,
   *  forcing a reconnect (default 60 000 ms). */
  pongDeadlineMs?: number;
  /** How long an in-flight send/remind/list may wait for its server ack before
   *  rejecting with `code: 'ACK_TIMEOUT'` (default 10 000 ms). */
  ackTimeoutMs?: number;
}

export type MeshClientEvent = 'connect' | 'disconnect' | 'error' | 'presence';

export interface SendOpts {
  /** Delivery TTL in ms for a direct send. Omit for the server default (5 min);
   *  `0` = drop if the recipient is offline. Governs deliverability of the
   *  queued copy, not how long history is retained (see MESH_RETENTION_MS). */
  ttlMs?: number;
  /** MIME type for the payload (default `text/plain`). Surfaced to the
   *  recipient as `Inbound.contentType`. */
  contentType?: string;
}

export interface PublishOpts {
  /** MIME type for the payload (default `text/plain`). */
  contentType?: string;
  /** Delivery TTL in ms (default 5 min; `0` = drop for offline subscribers). */
  ttlMs?: number;
}

/** A presence snapshot entry (from `listPresence()`), or the payload of a
 *  `'presence'` event (emitted on each `agent_status` change). camelCase. */
export interface PresenceEntry {
  id: string;
  online: boolean;
  /** Last TRAFFIC (unix ms) — when this node last actually sent/received. */
  lastSeen: number;
  /** Last proof-of-life (unix ms): stamped when the node answers the keepalive
      ping, so it advances for an idle-but-healthy node too. `null` = never seen
      alive. Use this, not lastSeen, to tell "quiet" from "channel is dead".

      It does NOT mean the agent is working: the keepalive is answered by the
      mesh plugin, a separate process, which keeps ponging while the agent's
      loop is stuck. For that question use lastResponded. */
  lastAlive: number | null;
  /** #133. Last time the agent's LOOP emitted something only the loop can emit
      — the reading that answers "is this agent actually working", which
      lastAlive never claimed to.

      `null` until the emitter ships (spawner#346), and absent from a bus that
      predates the field; both mean "unknown", which is why it is optional. It
      is a CLAIM BY THE EMITTER, like turn_status: the server keeps it
      distinguishable from the transport's proof-of-life, it does not
      authenticate it. */
  lastResponded?: number | null;
}

/**
 * Normalized inbound message — the single shape `onMessage` hands back.
 * Wire snake_case is normalized to camelCase here.
 */
export interface Inbound {
  msgId: string;
  kind: 'direct' | 'topic' | 'file' | 'reminder';
  from: string;
  to?: string | null;
  topic?: string | null;
  text?: string | null; // = payload for non-file; null for file
  payload?: string | null; // raw payload (alias of text for non-file); null for file
  sentAt: number;
  // file fields (only set when kind === 'file')
  fileId?: string;
  filename?: string;
  contentType?: string; // = content_type
  fetchUrl?: string;    // = fetch_url (relative path; join against httpUrl to download — see fetchFile)
  size?: number;        // = size_bytes
  caption?: string | null;      // = caption
  replyToMsgId?: string | null; // = reply_to_msg_id
  groupId?: string | null;      // = group_id (multi-file grouping tag; null = ungrouped)
}

export interface SendFileOpts {
  data: Uint8Array | ArrayBuffer; // raw bytes; base64-encoded internally
  filename: string;
  contentType?: string; // default 'application/octet-stream' (server-side)
  caption?: string;
  ttlMs?: number;       // delivery TTL; omit for the 5-min server default
  replyToMsgId?: string;
  groupId?: string;     // group N files from one send under a shared tag (passthrough)
}

interface ResolvedConfig {
  serverUrl: string;
  agentId: string;
  agentToken: string;
}

type Settler<T> = {
  resolve: (v: T) => void;
  reject: (e: Error) => void;
  /** Ack-timeout timer (see armWaiter) — cleared whenever the waiter settles. */
  timer?: ReturnType<typeof setTimeout>;
};

const CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

// ── Liveness (channel-drop class) ────────────────────────────────────────────
// A severed TCP path (e.g. a container's network namespace churning on
// recreate) delivers no FIN/RST, so `ws.readyState` stays OPEN forever and the
// 'close' event — the ONLY trigger for scheduleReconnect() — never fires. The
// client would sit wedged indefinitely: sends buffer into a dead socket without
// throwing, and inbound never arrives.
//
// So we prove liveness ourselves: ping on an interval, require a pong inside a
// deadline, and on a miss TERMINATE the socket (never close(): a closing
// handshake waits for a peer frame that a severed path will never send). The
// terminate synthesises 'close', which re-arms the existing, already-correct
// failAllPending → 'disconnect' → scheduleReconnect path.
//
// App-level {type:'ping'} rather than a protocol-level ws.ping() on purpose: a
// protocol pong is answered by the peer's *library*, so it can succeed while the
// server's event loop is wedged. An app-level pong is produced by the server's
// frame handler, so it proves end-to-end application liveness.
//
// Constants match claude-spawner's backend MeshWs, which has run these guards in
// production against this same server.
const PING_INTERVAL_MS = 25_000;
const PONG_DEADLINE_MS = 60_000;
const LIVENESS_CHECK_MS = 5_000;

/** How long a waiter may sit unanswered before it rejects with ACK_TIMEOUT.
    Bounds every in-flight promise so a send can never silently vanish. */
const ACK_TIMEOUT_MS = 10_000;

export class MeshClient {
  private config: MeshClientConfig;
  private ws: WebSocket | null = null;

  private messageHandler: ((m: Inbound) => void) | null = null;
  private listeners: {
    connect: ((...args: any[]) => void)[];
    disconnect: ((...args: any[]) => void)[];
    error: ((...args: any[]) => void)[];
    presence: ((...args: any[]) => void)[];
  } = { connect: [], disconnect: [], error: [], presence: [] };

  private subscribedTopics = new Set<string>();

  // ack waiters keyed by ref (= msg_id for send/publish, = topic for sub/unsub)
  private pendingAcks = new Map<string, Settler<void>>();
  // remind() ack waiters keyed by ref (= msg_id); ack carries reminder_id + due_at
  private pendingReminds = new Map<
    string,
    Settler<{ reminderId: string; dueAt: number }>
  >();
  // listReminders() waiters keyed by ref (= msg_id); resolved by reminders_list frame
  private pendingReminderLists = new Map<string, Settler<Reminder[]>>();
  // listPresence() waiters keyed by ref (= msg_id); resolved by presence_list frame
  private pendingPresenceLists = new Map<string, Settler<PresenceEntry[]>>();
  // sendFile() waiters keyed by ref (= msg_id); ack carries the stored file_id
  private pendingFileSends = new Map<string, Settler<{ fileId: string | null }>>();

  // reconnect / connect-handshake state
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private connectSettler: Settler<void> | null = null;
  private firstAuthDone = false;

  // liveness state (see the PING_INTERVAL_MS block above)
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private livenessTimer: ReturnType<typeof setInterval> | null = null;
  private lastPongAt = 0;

  constructor(config: MeshClientConfig = {}) {
    MeshClient.assertKnownKeys(config);
    this.config = config;
    // Fail at CONSTRUCTION, not at connect: see assertKnownKeys for why the
    // silent version of this was dangerous. Only serverUrl is checked here —
    // it is the one whose fallback reaches the network. agentId/agentToken are
    // still validated in resolveConfig, where a missing value cannot send you
    // somewhere unintended.
    const serverUrl = config.serverUrl ?? process.env.MESH_SERVER_URL;
    if (serverUrl === undefined || serverUrl === '') {
      throw new Error('MeshClient: serverUrl is required (config or MESH_SERVER_URL)');
    }
  }

  /**
   * Reject any config key this client does not implement.
   *
   * WHY THIS IS A THROW AND NOT A WARNING. Every field here has an environment
   * fallback, so a MISSPELLED key is not inert — it is silently replaced by the
   * environment. `new MeshClient({ url: 'ws://localhost:7400' })` ignores `url`,
   * finds `serverUrl` undefined, falls back to `process.env.MESH_SERVER_URL`,
   * and connects to whatever that names. In a container whose environment
   * points at production, a throwaway script aimed at localhost reaches
   * PRODUCTION instead, and nothing in the config, the logs, or the type system
   * says so — `url` is not a type error on an object literal widened to
   * MeshClientConfig at a call boundary.
   *
   * That is not hypothetical: a draft test connected to production exactly this
   * way, and it is why an incident review had to ask every agent whether one of
   * their scripts had done it. Silently ignoring an unknown key converts a typo
   * into a connection to the wrong mesh.
   *
   * The environment fallback itself is KEPT — production plugins depend on it.
   * What changes is that the fallback can no longer be reached by accident.
   */
  private static assertKnownKeys(config: MeshClientConfig): void {
    // DERIVED FROM THE TYPE, not maintained beside it. As a bare string[] the
    // seven keys were written three times — the interface, this list, and the
    // control test — with nothing tying them together, so adding a config field
    // and forgetting this line would make the new field a THROWN ERROR at
    // construction. Typing the object as Record<keyof MeshClientConfig, true>
    // makes the typecheck job enforce both directions: a key here that is not
    // on the interface is an error, and a key on the interface missing here is
    // an error too.
    //
    // It fails safe either way — a forgotten key throws loudly rather than
    // being silently ignored, which is the behaviour this guard exists to
    // provide — but "the compiler checks it" beats "someone remembers".
    const KNOWN_KEYS: Record<keyof MeshClientConfig, true> = {
      serverUrl: true, agentId: true, agentToken: true, httpUrl: true,
      pingIntervalMs: true, pongDeadlineMs: true, ackTimeoutMs: true,
    };
    const KNOWN = Object.keys(KNOWN_KEYS);
    const unknown = Object.keys(config).filter(k => !KNOWN.includes(k));
    if (unknown.length > 0) {
      throw new Error(
        `MeshClient: unknown config key${unknown.length > 1 ? 's' : ''} ${unknown.map(k => `'${k}'`).join(', ')}. ` +
        `Known keys: ${KNOWN.join(', ')}. ` +
        `An unknown key is refused rather than ignored because every field falls back to the environment, ` +
        `so a typo would silently connect to whatever MESH_SERVER_URL names.`,
      );
    }
  }

  // ──────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────

  connect(): Promise<void> {
    let resolved: ResolvedConfig;
    try {
      resolved = this.resolveConfig();
    } catch (err) {
      return Promise.reject(err);
    }
    this.shouldReconnect = true;
    return new Promise<void>((resolve, reject) => {
      this.connectSettler = { resolve, reject };
      this.openSocket(resolved);
    });
  }

  onMessage(handler: (m: Inbound) => void): void {
    this.messageHandler = handler;
  }

  on(event: MeshClientEvent, handler: (...args: any[]) => void): void {
    this.listeners[event].push(handler);
  }

  send(to: string, text: string, opts: SendOpts = {}): Promise<void> {
    const msgId = this.id();
    const frame: SendFrame = { type: 'send', msg_id: msgId, to, payload: text };
    if (opts.ttlMs !== undefined) frame.ttl_ms = opts.ttlMs;
    if (opts.contentType !== undefined) frame.content_type = opts.contentType;
    return this.sendWithAck(msgId, frame);
  }

  publish(topic: string, text: string, opts: PublishOpts = {}): Promise<void> {
    const msgId = this.id();
    const frame: PublishFrame = {
      type: 'publish',
      msg_id: msgId,
      topic,
      payload: text,
    };
    if (opts.contentType !== undefined) frame.content_type = opts.contentType;
    if (opts.ttlMs !== undefined) frame.ttl_ms = opts.ttlMs;
    return this.sendWithAck(msgId, frame);
  }

  /**
   * Send a file to an agent. `opts.data` is raw bytes (Uint8Array/Buffer or
   * ArrayBuffer); it's base64-encoded internally into the `file_send` frame.
   * Resolves on the server ack with `{ fileId }` — the stored file's id (which
   * the sender can index / later fetch via `fetchFile`). `fileId` is `null` if
   * the file was dropped (ttlMs:0 to an offline recipient — nothing stored).
   * `opts.groupId` tags a multi-file send so the recipient can reassemble it.
   * The recipient receives an `Inbound{ kind:'file' }` with the metadata +
   * `fetchUrl`/`groupId`.
   */
  sendFile(to: string, opts: SendFileOpts): Promise<{ fileId: string | null }> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('not connected'));
    }
    const bytes = opts.data instanceof Uint8Array ? opts.data : new Uint8Array(opts.data);
    const data = Buffer.from(bytes).toString('base64');
    const msgId = this.id();
    const frame: FileSendFrame = {
      type: 'file_send',
      msg_id: msgId,
      to,
      filename: opts.filename,
      data,
    };
    if (opts.contentType !== undefined) frame.content_type = opts.contentType;
    if (opts.ttlMs !== undefined) frame.ttl_ms = opts.ttlMs;
    if (opts.caption !== undefined) frame.caption = opts.caption;
    if (opts.replyToMsgId !== undefined) frame.reply_to_msg_id = opts.replyToMsgId;
    if (opts.groupId !== undefined) frame.group_id = opts.groupId;
    return new Promise<{ fileId: string | null }>((resolve, reject) => {
      this.armWaiter(this.pendingFileSends, msgId, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.takeWaiter(this.pendingFileSends, msgId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Subscribe to a topic. The topic is tracked and auto-replayed on every
   * reconnect, so a subscription survives connection drops. If the connection
   * drops while this call's ack is in flight, the promise rejects with
   * `code: 'CONNECTION_RESET'` — but the subscription is still replayed on the
   * next reconnect, so it takes effect regardless; treat such a reject as
   * transient (re-subscribing is safe).
   */
  subscribe(topic: string): Promise<void> {
    this.subscribedTopics.add(topic);
    const frame: SubscribeFrame = { type: 'subscribe', topic };
    return this.sendWithAck(topic, frame);
  }

  unsubscribe(topic: string): Promise<void> {
    this.subscribedTopics.delete(topic);
    const frame: UnsubscribeFrame = { type: 'unsubscribe', topic };
    return this.sendWithAck(topic, frame);
  }

  remind(opts: {
    text: string;
    when: string;
    recurring?: boolean;
    tz?: string;
  }): Promise<{ reminderId: string; dueAt: number }> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('not connected'));
    }
    const msgId = this.id();
    const frame: RemindFrame = {
      type: 'remind',
      msg_id: msgId,
      text: opts.text,
      when: opts.when,
    };
    if (opts.recurring !== undefined) frame.recurring = opts.recurring;
    if (opts.tz !== undefined) frame.tz = opts.tz;
    return new Promise<{ reminderId: string; dueAt: number }>((resolve, reject) => {
      this.armWaiter(this.pendingReminds, msgId, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.takeWaiter(this.pendingReminds, msgId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  listReminders(): Promise<Reminder[]> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('not connected'));
    }
    const msgId = this.id();
    const frame: ListRemindersFrame = { type: 'list_reminders', msg_id: msgId };
    return new Promise<Reminder[]>((resolve, reject) => {
      this.armWaiter(this.pendingReminderLists, msgId, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.takeWaiter(this.pendingReminderLists, msgId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  cancelReminder(id: string): Promise<void> {
    const msgId = this.id();
    const frame: CancelReminderFrame = {
      type: 'cancel_reminder',
      id,
      msg_id: msgId,
    };
    return this.sendWithAck(msgId, frame);
  }

  /**
   * Fetch the current presence roster: this node plus every registered peer it
   * shares a DIRECT ACL edge with (either direction), each with `online` and
   * `lastSeen`. Scope notes:
   *  - It's registry-based, not session-based — a peer appears (as
   *    `online:false`) before it has ever connected.
   *  - Only DIRECT ACL peers are included; a peer reachable only via a shared
   *    topic/group is NOT here — build that roster from `GET /acl` + your own
   *    group model and overlay presence.
   * For live updates, listen for the `'presence'` event (emitted on every
   * `agent_status` change).
   */
  listPresence(): Promise<PresenceEntry[]> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('not connected'));
    }
    const msgId = this.id();
    const frame: ListPresenceFrame = { type: 'list_presence', msg_id: msgId };
    return new Promise<PresenceEntry[]>((resolve, reject) => {
      this.armWaiter(this.pendingPresenceLists, msgId, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.takeWaiter(this.pendingPresenceLists, msgId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /**
   * Download a file's bytes over HTTP using this node's agent token. Node-scoped
   * server-side (#57): resolves only if this node is the file's sender or
   * recipient (or admin), else rejects — a non-party / unknown id both surface
   * as an HTTP 404 (no existence oracle).
   *
   * Uses the admin HTTP base from `httpUrl` / `MESH_HTTP_URL` (see MeshClientConfig);
   * the admin port usually differs from the ws port, so set it. Does NOT require
   * an open WS connection.
   */
  async fetchFile(fileId: string): Promise<Uint8Array> {
    const cfg = this.resolveConfig();
    const httpBase = this.resolveHttpUrl(cfg.serverUrl);
    const url = new URL(`/files/${encodeURIComponent(fileId)}`, httpBase);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.agentToken}` },
    });
    if (!res.ok) {
      throw Object.assign(new Error(`fetchFile ${fileId} failed: HTTP ${res.status}`), {
        code: `HTTP_${res.status}`,
        status: res.status,
      });
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * #133 — report that the agent's LOOP is alive. Fire-and-forget: one frame on
   * the EXISTING socket, no ack awaited, and a no-op when not connected.
   *
   * WHY THIS METHOD HAS TO EXIST. #147 added the `loop_alive` frame server-side
   * and the emitter (spawner#346) had no door to send it through: every public
   * method on this client awaits an ack, and the socket is private. The obvious
   * workaround is actively harmful — opening a second socket to emit the frame
   * would, under #145's newer-wins, DISPLACE the plugin's primary socket. A
   * feature reachable only by breaking the connection it reports on is not
   * reachable.
   *
   * A NO-OP WHEN DISCONNECTED, not a throw. This is a liveness beat: the caller
   * is a turn loop, not error-handling code, and making it wrap every call in a
   * try/catch invites the catch that swallows everything. A missed beat is
   * already indistinguishable from a stale one — both leave last_responded
   * behind — so failing loudly here buys nothing and costs a crash in a hot
   * path.
   *
   * WHOSE DISCIPLINE IS WHOSE. The client cannot know who called this; it sees a
   * method call. That only the turn loop calls it is the EMITTER's discipline,
   * enforced in spawner's plugin, and #147's rule that "nothing emitting on the
   * agent's behalf may advance the field" is about the transport's keepalive —
   * which the plugin answers while the loop is stuck — not about the loop's own
   * tool for saying it is running. Calling this from a timer would make
   * last_responded exactly as untrue as last_alive, and nothing here can stop
   * that; the server likewise treats it as a claim, not a proof.
   */
  loopAlive(): void {
    const ws = this.ws;
    if (ws === null || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'loop_alive' }));
    } catch (_) {
      // Fire-and-forget: a send that fails is a missed beat, which the staleness
      // of last_responded already expresses.
    }
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectTimeout();
    this.stopHeartbeat();

    this.failAllPending(new Error('client closed'));

    if (this.ws !== null) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  // ──────────────────────────────────────────────
  // Internals
  // ──────────────────────────────────────────────

  private resolveConfig(): ResolvedConfig {
    const serverUrl = this.config.serverUrl ?? process.env.MESH_SERVER_URL;
    const agentId = this.config.agentId ?? process.env.MESH_AGENT_ID;
    const agentToken = this.config.agentToken ?? process.env.MESH_AGENT_TOKEN;
    if (serverUrl === undefined || serverUrl === '') {
      throw new Error('MeshClient: serverUrl is required (config or MESH_SERVER_URL)');
    }
    if (agentId === undefined || agentId === '') {
      throw new Error('MeshClient: agentId is required (config or MESH_AGENT_ID)');
    }
    if (agentToken === undefined || agentToken === '') {
      throw new Error('MeshClient: agentToken is required (config or MESH_AGENT_TOKEN)');
    }
    return { serverUrl, agentId, agentToken };
  }

  // Resolve the admin HTTP base for fetchFile(): explicit httpUrl / MESH_HTTP_URL,
  // else derive from serverUrl by swapping ws→http / wss→https (same host+port —
  // only correct when the admin API shares the ws port, which is NOT the default).
  private resolveHttpUrl(serverUrl: string): string {
    const explicit = this.config.httpUrl ?? process.env.MESH_HTTP_URL;
    if (explicit !== undefined && explicit !== '') return explicit;
    return serverUrl.replace(/^ws(s?):\/\//i, 'http$1://');
  }

  private id(): string {
    return crypto.randomUUID();
  }

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** F0c (§7): protected, not private, so a subclass can send frames the base
   *  class knows nothing about (a peer relay). Widened deliberately — the
   *  alternative is a subclass reaching into private state, which is the same
   *  coupling with none of the visibility. */
  protected rawSend(frame: object): void {
    if (!this.isOpen()) {
      throw new Error('not connected');
    }
    this.ws!.send(JSON.stringify(frame));
  }

  /**
   * Register a waiter WITH a bounded timeout. Without this, a waiter parked on a
   * socket that stopped transmitting never settles — the caller hangs forever and
   * the send is reported to nobody. On expiry the waiter rejects with
   * `code: 'ACK_TIMEOUT'`, symmetrical with the 'CONNECTION_RESET' rejection a
   * detected drop produces.
   */
  private armWaiter<T>(map: Map<string, Settler<T>>, ref: string, settler: Settler<T>): void {
    const ackTimeoutMs = this.config.ackTimeoutMs ?? ACK_TIMEOUT_MS;
    const timer = setTimeout(() => {
      // only settle if THIS waiter is still the registered one
      if (map.get(ref) !== settler) return;
      map.delete(ref);
      settler.reject(
        Object.assign(new Error(`timed out after ${ackTimeoutMs}ms waiting for server ack`), {
          code: 'ACK_TIMEOUT',
        })
      );
    }, ackTimeoutMs);
    (timer as unknown as { unref?: () => void }).unref?.();
    settler.timer = timer;
    map.set(ref, settler);
  }

  /** Remove a waiter and clear its ack-timeout timer. Returns it, if present. */
  private takeWaiter<T>(map: Map<string, Settler<T>>, ref: string): Settler<T> | undefined {
    const settler = map.get(ref);
    if (settler === undefined) return undefined;
    if (settler.timer !== undefined) clearTimeout(settler.timer);
    map.delete(ref);
    return settler;
  }

  /** F0c (§7): protected for the same reason as rawSend — PeerClient.relay()
   *  needs the ack/timeout machinery, and reimplementing it in the subclass
   *  would be a second place for ACK_TIMEOUT semantics to drift. */
  protected sendWithAck(ref: string, frame: object): Promise<void> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('not connected'));
    }
    return new Promise<void>((resolve, reject) => {
      this.armWaiter(this.pendingAcks, ref, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.takeWaiter(this.pendingAcks, ref);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // ── liveness: heartbeat + dead-man switch ──────────────────────────────────

  /**
   * Start pinging on `ws` and force a reconnect if pongs stop.
   *
   * The socket is captured and identity-checked on every tick: a timer left over
   * from a previous socket must NEVER terminate the current one — that would be
   * a self-inflicted version of the very bug this fixes. (Same guard shape as
   * the `this.ws === ws` check in the 'close' handler.)
   */
  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.lastPongAt = Date.now(); // seed: no pong is "overdue" the instant we auth

    const pingIntervalMs = this.config.pingIntervalMs ?? PING_INTERVAL_MS;
    const pongDeadlineMs = this.config.pongDeadlineMs ?? PONG_DEADLINE_MS;
    // Check often enough to react promptly, but never slower than the deadline
    // it is policing (auto-scales when the deadline is tuned down for tests).
    const checkMs = Math.max(20, Math.min(LIVENESS_CHECK_MS, Math.floor(pongDeadlineMs / 4)));

    const ping = setInterval(() => {
      if (this.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        // a throw here means the socket is already gone; the checker/close handles it
      }
    }, pingIntervalMs);
    (ping as unknown as { unref?: () => void }).unref?.();
    this.pingTimer = ping;

    const check = setInterval(() => {
      if (this.ws !== ws) return; // stale timer for a replaced socket — never act
      if (Date.now() - this.lastPongAt <= pongDeadlineMs) return;
      // Pongs stopped: the path is dead even though readyState still says OPEN.
      // terminate() (not close()) — a severed path never answers a close
      // handshake. This synthesises 'close', which drives the reconnect.
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }, checkMs);
    (check as unknown as { unref?: () => void }).unref?.();
    this.livenessTimer = check;
  }

  private stopHeartbeat(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.livenessTimer !== null) {
      clearInterval(this.livenessTimer);
      this.livenessTimer = null;
    }
  }

  /**
   * Reject and clear EVERY in-flight waiter — acks, reminds, reminder-lists,
   * presence-lists, and file-sends — with `err`.
   *
   * Called from two places:
   *  - close(): err = `client closed`.
   *  - the socket 'close' handler on an unexpected drop: err = `connection
   *    reset` (code CONNECTION_RESET). A drop orphans every in-flight waiter —
   *    a reconnect can't recover it. Failing fast lets callers retry instead of
   *    the ack/remind/list waiters (which have NO timeout) hanging until close().
   */
  private failAllPending(err: Error): void {
    // Clearing each waiter's ack-timeout timer matters: without it a rejected
    // waiter's timer would still be pending, and on a busy client the timers
    // accumulate across every reconnect.
    const failMap = <T>(map: Map<string, Settler<T>>): void => {
      for (const [, s] of map) {
        if (s.timer !== undefined) clearTimeout(s.timer);
        s.reject(err);
      }
      map.clear();
    };
    failMap(this.pendingAcks);
    failMap(this.pendingReminds);
    failMap(this.pendingReminderLists);
    failMap(this.pendingPresenceLists);
    failMap(this.pendingFileSends);
  }

  private emit(event: MeshClientEvent, ...args: any[]): void {
    for (const fn of this.listeners[event]) {
      try {
        fn(...args);
      } catch {
        // a listener throwing must not break the client
      }
    }
  }

  private settleConnect(ok: true): void;
  private settleConnect(ok: false, err: Error): void;
  private settleConnect(ok: boolean, err?: Error): void {
    const settler = this.connectSettler;
    if (settler === null) return;
    this.connectSettler = null; // settle at most once
    if (ok) {
      settler.resolve();
    } else {
      settler.reject(err ?? new Error('connect failed'));
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimeoutTimer !== null) {
      clearTimeout(this.connectTimeoutTimer);
      this.connectTimeoutTimer = null;
    }
  }

  private openSocket(config: ResolvedConfig): void {
    const ws = new WebSocket(config.serverUrl);
    this.ws = ws;

    this.clearConnectTimeout();
    this.connectTimeoutTimer = setTimeout(() => {
      // no auth_ok in time → fail this attempt and let close drive reconnect
      try {
        ws.terminate();
      } catch {
        // ignore
      }
    }, CONNECT_TIMEOUT_MS);

    ws.on('open', () => {
      const authFrame: AuthFrame = {
        type: 'auth',
        agent_id: config.agentId,
        token: config.agentToken, // RAW token; server hashes it
        ...this.authExtras(),
      };
      try {
        ws.send(JSON.stringify(authFrame));
      } catch {
        // ignore; close handler will reconnect
      }
    });

    ws.on('message', (data: unknown) => {
      let frame: InboundFrame;
      try {
        frame = JSON.parse(data!.toString()) as InboundFrame;
      } catch {
        return; // ignore unparseable frames
      }
      this.dispatch(frame, config);
    });

    ws.on('error', (err: Error) => {
      this.emit('error', err);
    });

    ws.on('close', () => {
      this.clearConnectTimeout();
      if (this.ws === ws) {
        this.ws = null;
        this.stopHeartbeat(); // only tear down timers that belong to THIS socket
      }
      // Fail every in-flight waiter fast on the drop. The server has already
      // (or will) route any response to this now-dead socket, so a reconnect
      // cannot recover them — without this, request() would wait out its full
      // timeoutMs and the ack/remind/list waiters (no timeout) would hang
      // until close(). After an explicit close() the maps are already cleared,
      // so this is a no-op.
      //
      // NOTE: a subscribe() in flight at the drop also rejects here with
      // CONNECTION_RESET, but onAuthOk auto-replays subscribedTopics on
      // reconnect — the subscription still takes effect, so treat the reject
      // as transient (re-subscribing is safe / it is already live).
      this.failAllPending(
        Object.assign(new Error('connection reset'), { code: 'CONNECTION_RESET' })
      );
      this.emit('disconnect');
      if (this.shouldReconnect) {
        this.scheduleReconnect(config);
      }
    });
  }

  private scheduleReconnect(config: ResolvedConfig): void {
    if (!this.shouldReconnect) return;
    const attempt = this.reconnectAttempt;
    const base = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
    const jitter = Math.floor(Math.random() * 250);
    const delay = base + jitter;
    this.reconnectAttempt = attempt + 1;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.shouldReconnect) {
        this.openSocket(config);
      }
    }, delay);
  }

  private dispatch(frame: InboundFrame, config: ResolvedConfig): void {
    switch (frame.type) {
      case 'auth_ok':
        this.onAuthOk(config);
        return;
      case 'deliver':
        this.onDeliver(frame);
        return;
      case 'file_deliver':
        this.onFileDeliver(frame);
        return;
      case 'ack':
        this.onAck(frame);
        return;
      case 'error':
        this.onError(frame);
        return;
      case 'reminders_list':
        this.onRemindersList(frame);
        return;
      case 'agent_status':
        this.onAgentStatus(frame);
        return;
      case 'presence_list':
        this.onPresenceList(frame);
        return;
      case 'pong':
        // Liveness proof: the server's frame handler produced this, so the path
        // AND the server's event loop are alive. Rolls the dead-man deadline.
        this.lastPongAt = Date.now();
        return;
      default:
        return;
    }
  }

  private onAuthOk(_config: ResolvedConfig): void {
    this.clearConnectTimeout();
    this.reconnectAttempt = 0;

    // Start the heartbeat only now: pre-auth frames are rejected, and the
    // connect timeout already guards the handshake window.
    if (this.ws !== null) this.startHeartbeat(this.ws);

    // replay subscriptions (fire-and-forget; no acks awaited here)
    for (const topic of this.subscribedTopics) {
      const frame: SubscribeFrame = { type: 'subscribe', topic };
      try {
        this.ws?.send(JSON.stringify(frame));
      } catch {
        // ignore
      }
    }

    this.emit('connect');

    if (!this.firstAuthDone) {
      this.firstAuthDone = true;
      this.settleConnect(true);
    }
  }

  private onDeliver(frame: DeliverFrame): void {
    this.messageHandler?.(this.normalizeDeliver(frame));
  }

  private onFileDeliver(frame: FileDeliverFrame): void {
    this.messageHandler?.(this.normalizeFileDeliver(frame));
  }

  private onAck(frame: AckFrame): void {
    const ref = frame.ref;
    if (ref === undefined) return;
    const remindWaiter = this.takeWaiter(this.pendingReminds, ref);
    if (remindWaiter !== undefined) {
      remindWaiter.resolve({
        reminderId: frame.reminder_id ?? '',
        dueAt: frame.due_at ?? 0,
      });
      return;
    }
    const fileSendWaiter = this.takeWaiter(this.pendingFileSends, ref);
    if (fileSendWaiter !== undefined) {
      fileSendWaiter.resolve({ fileId: frame.file_id ?? null });
      return;
    }
    const waiter = this.takeWaiter(this.pendingAcks, ref);
    if (waiter !== undefined) {
      waiter.resolve();
    }
  }

  private onRemindersList(frame: RemindersListFrame): void {
    const ref = frame.ref;
    if (ref === undefined) return;
    const waiter = this.takeWaiter(this.pendingReminderLists, ref);
    if (waiter === undefined) return;
    const reminders: Reminder[] = frame.reminders.map((r) => ({
      id: r.id as string,
      dueAt: r.due_at as number,
      schedule: (r.schedule ?? null) as string | null,
      payload: r.payload as string,
      createdAt: r.created_at as number,
      lastFiredAt: (r.last_fired_at ?? null) as number | null,
    }));
    waiter.resolve(reminders);
  }

  private onAgentStatus(frame: AgentStatusFrame): void {
    this.emit('presence', {
      id: frame.agent_id,
      online: frame.online,
      lastSeen: frame.last_seen,
      lastAlive: frame.last_alive ?? null,
      lastResponded: frame.last_responded ?? null,
    } as PresenceEntry);
  }

  private onPresenceList(frame: PresenceListFrame): void {
    const ref = frame.ref;
    if (ref === undefined) return;
    const waiter = this.takeWaiter(this.pendingPresenceLists, ref);
    if (waiter === undefined) return;
    waiter.resolve(
      frame.agents.map((a) => ({
        id: a.id,
        online: a.online,
        lastSeen: a.last_seen,
        lastAlive: a.last_alive ?? null,
        lastResponded: a.last_responded ?? null,
      }))
    );
  }

  /** F0c (§7): extra fields merged into the auth frame. Default {} so an
   *  ordinary MeshClient's auth frame is byte-identical to today's — pinned by
   *  a test, because a silently widened auth frame would change what every
   *  existing agent sends to every existing server. */
  protected authExtras(): Record<string, unknown> {
    return {};
  }

  /** F0c (§7): which error frames stop the client for good. Default is today's
   *  behaviour exactly — a pre-first-auth AUTH_FAILED, or a PROTOCOL_MISMATCH
   *  at any time. An AUTH_FAILED AFTER a successful first auth stays
   *  reconnectable for an agent: it is usually a restarted server, and giving
   *  up would be worse than retrying. A peer overrides this, because for a peer
   *  the same frame means the far side revoked it. */
  protected isFatalError(frame: ErrorFrame): boolean {
    return (frame.code === 'AUTH_FAILED' && !this.firstAuthDone)
      || frame.code === 'PROTOCOL_MISMATCH';
  }

  private onError(frame: ErrorFrame): void {
    const ref = frame.ref;

    // Fatal-error branch. WHICH errors are fatal is a subclass decision
    // (isFatalError); the HANDLING is not, so there is one branch rather than
    // two implementations that could drift.
    if (this.isFatalError(frame)) {
      this.shouldReconnect = false;
      this.clearConnectTimeout();
      // F0c: emit before closing. A fatal error that only rejects the in-flight
      // connect() is invisible to a caller that already connected once — which
      // is exactly the post-first-auth case a peer must stop on.
      this.emit('error', this.makeError(frame));
      this.settleConnect(false, this.makeError(frame));
      if (this.ws !== null) {
        try {
          this.ws.close();
        } catch {
          // ignore
        }
      }
      return;
    }

    if (ref === undefined) {
      this.emit('error', this.makeError(frame));
      return;
    }

    const remindWaiter = this.takeWaiter(this.pendingReminds, ref);
    if (remindWaiter !== undefined) {
      remindWaiter.reject(this.makeError(frame));
      return;
    }

    const listWaiter = this.takeWaiter(this.pendingReminderLists, ref);
    if (listWaiter !== undefined) {
      listWaiter.reject(this.makeError(frame));
      return;
    }

    const fileSendWaiter = this.takeWaiter(this.pendingFileSends, ref);
    if (fileSendWaiter !== undefined) {
      fileSendWaiter.reject(this.makeError(frame));
      return;
    }

    const ackWaiter = this.takeWaiter(this.pendingAcks, ref);
    if (ackWaiter !== undefined) {
      ackWaiter.reject(this.makeError(frame));
      return;
    }

    this.emit('error', this.makeError(frame));
  }

  private makeError(frame: ErrorFrame): Error {
    return Object.assign(new Error(frame.message), { code: frame.code });
  }

  private normalizeDeliver(f: DeliverFrame): Inbound {
    return {
      msgId: f.msg_id,
      kind: f.kind,
      from: f.from,
      to: f.to,
      topic: f.topic,
      text: f.payload,
      payload: f.payload,
      contentType: f.content_type,
      sentAt: f.sent_at,
    };
  }

  private normalizeFileDeliver(f: FileDeliverFrame): Inbound {
    return {
      msgId: f.file_id,
      kind: 'file',
      from: f.from,
      to: f.to,
      text: null,
      payload: null,
      sentAt: f.sent_at,
      fileId: f.file_id,
      filename: f.filename,
      contentType: f.content_type,
      fetchUrl: f.fetch_url,
      size: f.size_bytes,
      caption: f.caption,
      replyToMsgId: f.reply_to_msg_id,
      groupId: f.group_id,
    };
  }
}
