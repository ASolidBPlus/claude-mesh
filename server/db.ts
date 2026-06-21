import { Database } from 'bun:sqlite';

// ──────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────

export interface Agent {
  id: string;
  token_hash: string;
  hostname: string;
  capabilities: string;    // raw JSON string, e.g. '["file-transfer","broadcast"]'
  metadata: string;        // raw JSON string, e.g. '{"region":"eu-west"}'
  registered_at: number;   // unix ms
  last_seen: number;       // unix ms
  online: number;          // 0 | 1
}

export interface AclRow {
  from_agent: string;
  to_agent: string;
  granted_at: number;      // unix ms
  granted_by: string;      // agent id or "system"
}

export interface Message {
  id: string;
  kind: string;            // "direct" | "topic" | "request" | "response"
  from_agent: string;
  to_agent: string | null;
  topic: string | null;
  correlation_id: string | null;
  payload: string;
  content_type: string;
  sent_at: number;         // unix ms
  expires_at: number | null;
  delivered_at: number | null;
  acked_at: number | null;
}

export interface Topic {
  name: string;
  created_at: number;      // unix ms
  created_by: string;
  description: string;
  metadata: string;        // raw JSON string
}

export interface Subscription {
  agent_id: string;
  topic: string;
  subscribed_at: number;   // unix ms
}

export interface FileRecord {
  id: string;
  from_agent: string;
  to_agent: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  file_path: string;
  sent_at: number;        // unix ms
  expires_at: number | null;
  delivered_at: number | null;
  caption: string | null;
  reply_to_msg_id: string | null;
}

export interface Reminder {
  id: string;
  agent_id: string;
  due_at: number;
  schedule: string | null;
  payload: string;
  created_at: number;
  status: string;
  last_fired_at: number | null;
  tz: string | null;   // IANA tz; null = UTC
}

// ──────────────────────────────────────────────
// 5.1 Database initialization
// ──────────────────────────────────────────────

export function openDb(path: string): Database {
  const db = new Database(path);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id           TEXT PRIMARY KEY,
      token_hash   TEXT NOT NULL,
      hostname     TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '[]',
      metadata     TEXT NOT NULL DEFAULT '{}',
      registered_at INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL,
      online       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS acl (
      from_agent   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      to_agent     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      granted_at   INTEGER NOT NULL,
      granted_by   TEXT NOT NULL,
      PRIMARY KEY (from_agent, to_agent)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      kind           TEXT NOT NULL,
      from_agent     TEXT NOT NULL,
      to_agent       TEXT,
      topic          TEXT,
      correlation_id TEXT,
      payload        TEXT NOT NULL,
      content_type   TEXT NOT NULL DEFAULT 'text/plain',
      sent_at        INTEGER NOT NULL,
      expires_at     INTEGER,
      delivered_at   INTEGER,
      acked_at       INTEGER
    );

    CREATE TABLE IF NOT EXISTS topics (
      name        TEXT PRIMARY KEY,
      created_at  INTEGER NOT NULL,
      created_by  TEXT NOT NULL REFERENCES agents(id),
      description TEXT NOT NULL DEFAULT '',
      metadata    TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      agent_id     TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      topic        TEXT NOT NULL REFERENCES topics(name) ON DELETE CASCADE,
      subscribed_at INTEGER NOT NULL,
      PRIMARY KEY (agent_id, topic)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_to_agent ON messages(to_agent, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic, sent_at);
    CREATE INDEX IF NOT EXISTS idx_messages_correlation ON messages(correlation_id);
    CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen);

    CREATE TABLE IF NOT EXISTS files (
      id              TEXT PRIMARY KEY,
      from_agent      TEXT NOT NULL,
      to_agent        TEXT NOT NULL,
      filename        TEXT NOT NULL,
      content_type    TEXT NOT NULL DEFAULT 'application/octet-stream',
      size_bytes      INTEGER NOT NULL,
      file_path       TEXT NOT NULL,
      sent_at         INTEGER NOT NULL,
      expires_at      INTEGER,
      delivered_at    INTEGER,
      caption         TEXT,
      reply_to_msg_id TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_files_to_agent   ON files(to_agent, delivered_at);
    CREATE INDEX IF NOT EXISTS idx_files_expires    ON files(expires_at) WHERE expires_at IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_files_from_agent ON files(from_agent);

    CREATE TABLE IF NOT EXISTS reminders (
      id            TEXT PRIMARY KEY,
      agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      due_at        INTEGER NOT NULL,
      schedule      TEXT,
      payload       TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      last_fired_at INTEGER,
      tz            TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders(status, due_at) WHERE status = 'pending';
    CREATE INDEX IF NOT EXISTS idx_reminders_agent
      ON reminders(agent_id, status);
  `);

  // Migration for existing databases: add new columns if they don't exist yet
  try { db.exec('ALTER TABLE files ADD COLUMN caption TEXT'); } catch {}
  try { db.exec('ALTER TABLE files ADD COLUMN reply_to_msg_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE files ADD COLUMN file_path TEXT'); } catch {}

  // Sprint 15 migration: per-reminder IANA timezone (null = UTC). Existing rows
  // get tz=NULL and keep behaving exactly as before (UTC cron).
  try { db.exec('ALTER TABLE reminders ADD COLUMN tz TEXT'); } catch {}

  // Sprint 12 migration: drop the deprecated `data` column (base64 blob in
  // SQLite) if it still exists from pre-Sprint-12 databases. It was declared
  // NOT NULL, so insertFile would otherwise fail with a NOT NULL constraint
  // violation on every upload to an upgraded database.
  try {
    const cols = db.prepare('PRAGMA table_info(files)').all() as { name: string }[];
    if (cols.some((c) => c.name === 'data')) {
      db.exec('ALTER TABLE files DROP COLUMN data');
    }
  } catch {}

  return db;
}

// ──────────────────────────────────────────────
// 5.2 Agents
// ──────────────────────────────────────────────

export function registerAgent(
  db: Database,
  agent: {
    id: string;
    token_hash: string;
    hostname: string;
    capabilities?: string;
    metadata?: string;
  }
): Agent {
  const now = Date.now();
  const capabilities = agent.capabilities ?? '[]';
  const metadata = agent.metadata ?? '{}';

  db.prepare(`
    INSERT INTO agents (id, token_hash, hostname, capabilities, metadata, registered_at, last_seen, online)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).run(agent.id, agent.token_hash, agent.hostname, capabilities, metadata, now, now);

  return getAgentById(db, agent.id) as Agent;
}

export function getAgentById(db: Database, id: string): Agent | null {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | null;
}

export function getAgentByToken(db: Database, token: string): Agent | null {
  // Hash the raw token with SHA-256
  const hash = hashToken(token);
  const agents = db.prepare('SELECT * FROM agents').all() as Agent[];

  // Timing-safe comparison: compare all rows
  let found: Agent | null = null;
  for (const agent of agents) {
    if (timingSafeEqual(agent.token_hash, hash)) {
      found = agent;
    }
  }
  return found;
}

export function listAgents(db: Database, onlineOnly?: boolean): Agent[] {
  if (onlineOnly) {
    return db.prepare('SELECT * FROM agents WHERE online = 1').all() as Agent[];
  }
  return db.prepare('SELECT * FROM agents').all() as Agent[];
}

export function touchAgent(db: Database, id: string): void {
  db.prepare('UPDATE agents SET last_seen = ? WHERE id = ?').run(Date.now(), id);
}

export function setOnline(db: Database, id: string, online: boolean): void {
  db.prepare('UPDATE agents SET online = ?, last_seen = ? WHERE id = ?')
    .run(online ? 1 : 0, Date.now(), id);
}

export function updateAgent(
  db: Database,
  id: string,
  fields: {
    capabilities?: string;
    metadata?: string;
    hostname?: string;
  }
): Agent | null {
  const setClauses: string[] = [];
  const values: unknown[] = [];

  if (fields.capabilities !== undefined) {
    setClauses.push('capabilities = ?');
    values.push(fields.capabilities);
  }
  if (fields.metadata !== undefined) {
    setClauses.push('metadata = ?');
    values.push(fields.metadata);
  }
  if (fields.hostname !== undefined) {
    setClauses.push('hostname = ?');
    values.push(fields.hostname);
  }

  if (setClauses.length === 0) {
    return getAgentById(db, id);
  }

  values.push(id);
  db.prepare(`UPDATE agents SET ${setClauses.join(', ')} WHERE id = ?`).run(...values);

  return getAgentById(db, id);
}

export function deleteAgent(db: Database, id: string): void {
  db.prepare('DELETE FROM topics WHERE created_by = ?').run(id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

// ──────────────────────────────────────────────
// 5.3 ACL
// ──────────────────────────────────────────────

export function aclGrant(
  db: Database,
  from_agent: string,
  to_agent: string,
  granted_by: string
): AclRow {
  const now = Date.now();
  db.prepare(`
    INSERT INTO acl (from_agent, to_agent, granted_at, granted_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(from_agent, to_agent) DO UPDATE SET granted_at = excluded.granted_at, granted_by = excluded.granted_by
  `).run(from_agent, to_agent, now, granted_by);

  return db.prepare('SELECT * FROM acl WHERE from_agent = ? AND to_agent = ?')
    .get(from_agent, to_agent) as AclRow;
}

export function aclRevoke(db: Database, from_agent: string, to_agent: string): void {
  db.prepare('DELETE FROM acl WHERE from_agent = ? AND to_agent = ?').run(from_agent, to_agent);
}

export function aclCheck(db: Database, from_agent: string, to_agent: string): boolean {
  const row = db.prepare('SELECT 1 FROM acl WHERE from_agent = ? AND to_agent = ?')
    .get(from_agent, to_agent);
  return row !== null;
}

export function aclRelated(db: Database, agentA: string, agentB: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM acl WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)'
  ).get(agentA, agentB, agentB, agentA);
  return row !== null;
}

export function listInboundAcl(db: Database, id: string): AclRow[] {
  return db.prepare('SELECT * FROM acl WHERE to_agent = ?').all(id) as AclRow[];
}

export function listOutboundAcl(db: Database, id: string): AclRow[] {
  return db.prepare('SELECT * FROM acl WHERE from_agent = ?').all(id) as AclRow[];
}

// ──────────────────────────────────────────────
// 5.4 Messages
// ──────────────────────────────────────────────

export function insertMessage(
  db: Database,
  msg: {
    id: string;
    kind: string;
    from_agent: string;
    to_agent?: string | null;
    topic?: string | null;
    correlation_id?: string | null;
    payload: string;
    content_type?: string;
    sent_at: number;
    expires_at?: number | null;
  }
): Message {
  const content_type = msg.content_type ?? 'text/plain';
  const to_agent = msg.to_agent ?? null;
  const topic = msg.topic ?? null;
  const correlation_id = msg.correlation_id ?? null;
  const expires_at = msg.expires_at ?? null;

  db.prepare(`
    INSERT INTO messages (id, kind, from_agent, to_agent, topic, correlation_id, payload, content_type, sent_at, expires_at, delivered_at, acked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(msg.id, msg.kind, msg.from_agent, to_agent, topic, correlation_id, msg.payload, content_type, msg.sent_at, expires_at);

  return getMessage(db, msg.id) as Message;
}

export function markDelivered(db: Database, id: string): void {
  db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ?').run(Date.now(), id);
}

export function markAcked(db: Database, id: string): void {
  db.prepare('UPDATE messages SET acked_at = ? WHERE id = ?').run(Date.now(), id);
}

export function getPendingMessages(db: Database, agentId: string): Message[] {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM messages
    WHERE to_agent = ?
      AND delivered_at IS NULL
      AND (expires_at IS NULL OR expires_at >= ?)
    ORDER BY sent_at ASC
  `).all(agentId, now) as Message[];
}

export function getPendingTopicMessages(db: Database, topicName: string): Message[] {
  const now = Date.now();
  return db.prepare(`
    SELECT * FROM messages
    WHERE topic = ?
      AND delivered_at IS NULL
      AND (expires_at IS NULL OR expires_at >= ?)
    ORDER BY sent_at ASC
  `).all(topicName, now) as Message[];
}

export function getMessage(db: Database, id: string): Message | null {
  return db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as Message | null;
}

export function getMessageByCorrelationId(db: Database, correlationId: string): Message | null {
  return db.prepare(`
    SELECT * FROM messages WHERE correlation_id = ? ORDER BY sent_at ASC LIMIT 1
  `).get(correlationId) as Message | null;
}

export function queryMessages(
  db: Database,
  opts: {
    agent?: string;
    topic?: string;
    since?: number;
    limit?: number;
  }
): Message[] {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (opts.agent) {
    clauses.push('(from_agent = ? OR to_agent = ?)');
    params.push(opts.agent, opts.agent);
  }
  if (opts.topic) {
    clauses.push('topic = ?');
    params.push(opts.topic);
  }
  if (opts.since !== undefined) {
    clauses.push('sent_at >= ?');
    params.push(opts.since);
  }

  let limit = opts.limit ?? 100;
  if (limit > 1000) limit = 1000;

  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = `SELECT * FROM messages ${where} ORDER BY sent_at DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Message[];
}

export function expireMessages(db: Database): Record<string, number> {
  const now = Date.now();
  const rows = db.prepare(
    `SELECT kind, COUNT(*) AS c FROM messages
     WHERE expires_at IS NOT NULL AND expires_at < ? GROUP BY kind`
  ).all(now) as { kind: string; c: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = r.c;
  db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?').run(now);
  return counts;
}

export function countTopics(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM topics').get() as { c: number }).c;
}
export function countSubscriptions(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM subscriptions').get() as { c: number }).c;
}
export function countAgentsOnline(db: Database): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM agents WHERE online = 1').get() as { c: number }).c;
}
export function countPendingMessages(db: Database): number {
  const now = Date.now();
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM messages
     WHERE delivered_at IS NULL AND (expires_at IS NULL OR expires_at >= ?)`
  ).get(now) as { c: number }).c;
}

// ──────────────────────────────────────────────
// 5.5 Topics
// ──────────────────────────────────────────────

export function getOrCreateTopic(
  db: Database,
  name: string,
  created_by: string,
  description?: string,
  metadata?: string
): Topic {
  const existing = db.prepare('SELECT * FROM topics WHERE name = ?').get(name) as Topic | null;
  if (existing !== null) {
    return existing;
  }

  const now = Date.now();
  const desc = description ?? '';
  const meta = metadata ?? '{}';

  db.prepare(`
    INSERT INTO topics (name, created_at, created_by, description, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(name, now, created_by, desc, meta);

  return db.prepare('SELECT * FROM topics WHERE name = ?').get(name) as Topic;
}

export function listTopics(db: Database): Topic[] {
  return db.prepare('SELECT * FROM topics ORDER BY name ASC').all() as Topic[];
}

export function deleteTopic(db: Database, name: string): void {
  db.prepare('DELETE FROM topics WHERE name = ?').run(name);
}

// ──────────────────────────────────────────────
// 5.6 Subscriptions
// ──────────────────────────────────────────────

export function subscribe(db: Database, agent_id: string, topic: string): Subscription {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO subscriptions (agent_id, topic, subscribed_at)
    VALUES (?, ?, ?)
  `).run(agent_id, topic, now);

  return db.prepare('SELECT * FROM subscriptions WHERE agent_id = ? AND topic = ?')
    .get(agent_id, topic) as Subscription;
}

export function unsubscribe(db: Database, agent_id: string, topic: string): void {
  db.prepare('DELETE FROM subscriptions WHERE agent_id = ? AND topic = ?').run(agent_id, topic);
}

export function getTopicSubscribers(db: Database, topic: string): string[] {
  const rows = db.prepare('SELECT agent_id FROM subscriptions WHERE topic = ?').all(topic) as { agent_id: string }[];
  return rows.map(r => r.agent_id);
}

export function getAgentSubscriptions(db: Database, agent_id: string): string[] {
  const rows = db.prepare('SELECT topic FROM subscriptions WHERE agent_id = ?').all(agent_id) as { topic: string }[];
  return rows.map(r => r.topic);
}

// ──────────────────────────────────────────────
// 5.7 Files
// ──────────────────────────────────────────────

export function insertFile(
  db: Database,
  file: {
    id: string;
    from_agent: string;
    to_agent: string;
    filename: string;
    content_type: string;
    size_bytes: number;
    file_path: string;
    sent_at: number;
    expires_at: number | null;
    caption?: string | null;
    reply_to_msg_id?: string | null;
  }
): FileRecord {
  const caption = file.caption ?? null;
  const reply_to_msg_id = file.reply_to_msg_id ?? null;

  db.prepare(`
    INSERT INTO files (id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
  `).run(file.id, file.from_agent, file.to_agent, file.filename, file.content_type, file.size_bytes, file.file_path, file.sent_at, file.expires_at, caption, reply_to_msg_id);

  return getFile(db, file.id) as FileRecord;
}

export function getFile(db: Database, id: string): FileRecord | null {
  return db.prepare('SELECT id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id FROM files WHERE id = ?').get(id) as FileRecord | null;
}

export function markFileDelivered(db: Database, id: string): void {
  db.prepare('UPDATE files SET delivered_at = ? WHERE id = ?').run(Date.now(), id);
}

export function deleteExpiredFiles(db: Database): string[] {
  const rows = db.prepare(`
    DELETE FROM files
    WHERE expires_at IS NOT NULL AND expires_at < ?
    RETURNING file_path
  `).all(Date.now()) as { file_path: string }[];
  return rows.map(r => r.file_path);
}

// ──────────────────────────────────────────────
// 5.8 Reminders
// ──────────────────────────────────────────────

export function insertReminder(
  db: Database,
  reminder: {
    id: string;
    agent_id: string;
    due_at: number;
    schedule?: string | null;
    payload: string;
    created_at: number;
    tz?: string | null;
  }
): Reminder {
  const schedule = reminder.schedule ?? null;
  const tz = reminder.tz ?? null;
  db.prepare(`
    INSERT INTO reminders (id, agent_id, due_at, schedule, payload, created_at, status, last_fired_at, tz)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, ?)
  `).run(reminder.id, reminder.agent_id, reminder.due_at, schedule, reminder.payload, reminder.created_at, tz);

  return getReminder(db, reminder.id) as Reminder;
}

export function getReminder(db: Database, id: string): Reminder | null {
  return db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as Reminder | null;
}

export function getDueReminders(db: Database, now: number): Reminder[] {
  return db.prepare(`
    SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at ASC
  `).all(now) as Reminder[];
}

export function listAgentReminders(db: Database, agentId: string): Reminder[] {
  return db.prepare(`
    SELECT * FROM reminders WHERE agent_id = ? AND status = 'pending' ORDER BY due_at ASC
  `).all(agentId) as Reminder[];
}

export function listAllReminders(db: Database): Reminder[] {
  return db.prepare(`
    SELECT * FROM reminders WHERE status = 'pending' ORDER BY due_at ASC
  `).all() as Reminder[];
}

export function updateReminder(
  db: Database,
  id: string,
  fields: { payload: string; schedule: string | null; due_at: number; tz: string | null }
): Reminder | null {
  db.prepare(`
    UPDATE reminders SET payload = ?, schedule = ?, due_at = ?, tz = ? WHERE id = ?
  `).run(fields.payload, fields.schedule, fields.due_at, fields.tz, id);
  return getReminder(db, id);
}

export function cancelReminder(db: Database, id: string): boolean {
  const result = db.prepare(`
    UPDATE reminders SET status = 'cancelled' WHERE id = ? AND status = 'pending'
  `).run(id);
  return result.changes > 0;
}

export function markReminderDelivered(db: Database, id: string, firedAt: number): void {
  db.prepare(`
    UPDATE reminders SET status = 'delivered', last_fired_at = ? WHERE id = ?
  `).run(firedAt, id);
}

export function updateReminderDueAt(db: Database, id: string, nextDue: number, firedAt: number): void {
  db.prepare(`
    UPDATE reminders SET due_at = ?, last_fired_at = ? WHERE id = ?
  `).run(nextDue, firedAt, id);
}

export function deleteDeliveredOneShots(db: Database, olderThanMs: number): number {
  const result = db.prepare(`
    DELETE FROM reminders WHERE status = 'delivered' AND schedule IS NULL AND last_fired_at < ?
  `).run(olderThanMs);
  return result.changes;
}

// ──────────────────────────────────────────────
// Internal helpers
// ──────────────────────────────────────────────

function hashToken(token: string): string {
  const hasher = new Bun.CryptoHasher('sha256');
  hasher.update(token);
  return hasher.digest('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
