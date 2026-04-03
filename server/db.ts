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
  `);

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

export function expireMessages(db: Database): number {
  const now = Date.now();
  const result = db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?')
    .run(now);
  return result.changes;
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
