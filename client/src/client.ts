import { WebSocket } from 'ws';
import type {
  AuthFrame,
  SendFrame,
  ResponseFrame,
  PublishFrame,
  SubscribeFrame,
  UnsubscribeFrame,
  RequestFrame,
  RemindFrame,
  ListRemindersFrame,
  CancelReminderFrame,
  DeliverFrame,
  FileDeliverFrame,
  AckFrame,
  ErrorFrame,
  RemindersListFrame,
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
}

export type MeshClientEvent = 'connect' | 'disconnect' | 'error';

export interface SendOpts {
  correlationId?: string;
  kind?: 'direct' | 'response';
}

export interface RequestOpts {
  timeoutMs?: number;
  correlationId?: string;
}

/**
 * Normalized inbound message — the single shape `onMessage`/`request` hand back.
 * Wire snake_case is normalized to camelCase here.
 */
export interface Inbound {
  msgId: string;
  kind: 'direct' | 'topic' | 'request' | 'response' | 'file' | 'reminder';
  from: string;
  to?: string | null;
  topic?: string | null;
  correlationId?: string | null;
  text?: string | null; // = payload for non-file; null for file
  payload?: string | null; // raw payload (alias of text for non-file); null for file
  sentAt: number;
  // file fields (only set when kind === 'file')
  fileId?: string;
  filename?: string;
  contentType?: string; // = content_type
}

interface ResolvedConfig {
  serverUrl: string;
  agentId: string;
  agentToken: string;
}

type Settler<T> = { resolve: (v: T) => void; reject: (e: Error) => void };

const CONNECT_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class MeshClient {
  private config: MeshClientConfig;
  private ws: WebSocket | null = null;

  private messageHandler: ((m: Inbound) => void) | null = null;
  private listeners: {
    connect: ((...args: any[]) => void)[];
    disconnect: ((...args: any[]) => void)[];
    error: ((...args: any[]) => void)[];
  } = { connect: [], disconnect: [], error: [] };

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
  // request waiters keyed by correlation_id; also indexed by msg_id for fast-fail
  private pendingRequests = new Map<
    string,
    {
      resolve: (m: Inbound) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
      msgId: string;
    }
  >();

  // reconnect / connect-handshake state
  private shouldReconnect = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private connectSettler: Settler<void> | null = null;
  private firstAuthDone = false;

  constructor(config: MeshClientConfig = {}) {
    this.config = config;
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
    const kind = opts.kind ?? 'direct';
    if (kind === 'response') {
      if (opts.correlationId === undefined) {
        return Promise.reject(
          new Error('send(kind:"response") requires opts.correlationId')
        );
      }
      const msgId = this.id();
      const frame: ResponseFrame = {
        type: 'response',
        msg_id: msgId,
        correlation_id: opts.correlationId,
        payload: text,
      };
      return this.sendWithAck(msgId, frame);
    }
    const msgId = this.id();
    const frame: SendFrame = { type: 'send', msg_id: msgId, to, payload: text };
    return this.sendWithAck(msgId, frame);
  }

  publish(topic: string, text: string): Promise<void> {
    const msgId = this.id();
    const frame: PublishFrame = {
      type: 'publish',
      msg_id: msgId,
      topic,
      payload: text,
    };
    return this.sendWithAck(msgId, frame);
  }

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

  request(to: string, text: string, opts: RequestOpts = {}): Promise<Inbound> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('not connected'));
    }
    const correlationId = opts.correlationId ?? this.id();
    const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    const msgId = this.id();

    return new Promise<Inbound>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(correlationId);
        reject(new Error('request timeout'));
      }, timeoutMs);
      this.pendingRequests.set(correlationId, {
        resolve,
        reject,
        timer,
        msgId,
      });
      const frame: RequestFrame = {
        type: 'request',
        msg_id: msgId,
        to,
        payload: text,
        correlation_id: correlationId,
        ttl_ms: timeoutMs,
      };
      this.rawSend(frame);
    });
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
      this.pendingReminds.set(msgId, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.pendingReminds.delete(msgId);
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
      this.pendingReminderLists.set(msgId, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.pendingReminderLists.delete(msgId);
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

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearConnectTimeout();

    const closedErr = new Error('client closed');
    for (const [, p] of this.pendingRequests) {
      clearTimeout(p.timer);
      p.reject(closedErr);
    }
    this.pendingRequests.clear();
    for (const [, a] of this.pendingAcks) {
      a.reject(closedErr);
    }
    this.pendingAcks.clear();
    for (const [, r] of this.pendingReminds) {
      r.reject(closedErr);
    }
    this.pendingReminds.clear();
    for (const [, l] of this.pendingReminderLists) {
      l.reject(closedErr);
    }
    this.pendingReminderLists.clear();

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

  private id(): string {
    return crypto.randomUUID();
  }

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private rawSend(frame: object): void {
    if (!this.isOpen()) {
      throw new Error('not connected');
    }
    this.ws!.send(JSON.stringify(frame));
  }

  private sendWithAck(ref: string, frame: object): Promise<void> {
    if (!this.isOpen()) {
      return Promise.reject(new Error('not connected'));
    }
    return new Promise<void>((resolve, reject) => {
      this.pendingAcks.set(ref, { resolve, reject });
      try {
        this.ws!.send(JSON.stringify(frame));
      } catch (err) {
        this.pendingAcks.delete(ref);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
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
      }
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
      case 'pong':
      case 'agent_status':
      case 'presence_list':
        return; // ignored (out of scope for SDK v0.1)
      default:
        return;
    }
  }

  private onAuthOk(_config: ResolvedConfig): void {
    this.clearConnectTimeout();
    this.reconnectAttempt = 0;

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
    if (frame.kind === 'response') {
      const pending = this.pendingRequests.get(frame.correlation_id ?? '');
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(frame.correlation_id ?? '');
        pending.resolve(this.normalizeDeliver(frame));
        return;
      }
      // no matching request → fall through to onMessage
    }
    this.messageHandler?.(this.normalizeDeliver(frame));
  }

  private onFileDeliver(frame: FileDeliverFrame): void {
    this.messageHandler?.(this.normalizeFileDeliver(frame));
  }

  private onAck(frame: AckFrame): void {
    const ref = frame.ref;
    if (ref === undefined) return;
    const remindWaiter = this.pendingReminds.get(ref);
    if (remindWaiter !== undefined) {
      this.pendingReminds.delete(ref);
      remindWaiter.resolve({
        reminderId: frame.reminder_id ?? '',
        dueAt: frame.due_at ?? 0,
      });
      return;
    }
    const waiter = this.pendingAcks.get(ref);
    if (waiter !== undefined) {
      this.pendingAcks.delete(ref);
      waiter.resolve();
    }
  }

  private onRemindersList(frame: RemindersListFrame): void {
    const ref = frame.ref;
    if (ref === undefined) return;
    const waiter = this.pendingReminderLists.get(ref);
    if (waiter === undefined) return;
    this.pendingReminderLists.delete(ref);
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

  private onError(frame: ErrorFrame): void {
    const ref = frame.ref;

    // Pre-auth fatal auth failure → reject the in-flight connect() and stop.
    if (frame.code === 'AUTH_FAILED' && !this.firstAuthDone) {
      this.shouldReconnect = false;
      this.clearConnectTimeout();
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

    // A request error may carry ref === correlation_id (REQUEST_TIMEOUT) OR
    // ref === request msg_id (validation / ACL_DENIED on the request frame).
    const byCorrelation = this.pendingRequests.get(ref);
    if (byCorrelation !== undefined) {
      clearTimeout(byCorrelation.timer);
      this.pendingRequests.delete(ref);
      byCorrelation.reject(this.makeError(frame));
      return;
    }
    for (const [cid, p] of this.pendingRequests) {
      if (p.msgId === ref) {
        clearTimeout(p.timer);
        this.pendingRequests.delete(cid);
        p.reject(this.makeError(frame));
        return;
      }
    }

    const remindWaiter = this.pendingReminds.get(ref);
    if (remindWaiter !== undefined) {
      this.pendingReminds.delete(ref);
      remindWaiter.reject(this.makeError(frame));
      return;
    }

    const listWaiter = this.pendingReminderLists.get(ref);
    if (listWaiter !== undefined) {
      this.pendingReminderLists.delete(ref);
      listWaiter.reject(this.makeError(frame));
      return;
    }

    const ackWaiter = this.pendingAcks.get(ref);
    if (ackWaiter !== undefined) {
      this.pendingAcks.delete(ref);
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
      correlationId: f.correlation_id,
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
    };
  }
}
