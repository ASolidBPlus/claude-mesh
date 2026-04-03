/**
 * SQLite schema and helpers for claude-mesh.
 * Uses bun:sqlite (zero native deps).
 */

import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'

export type Agent = {
  id: string
  name: string
  token_hash: string   // SHA-256(token) hex
  capabilities: string // JSON array
  registered_at: number
  last_seen: number | null
}

export type AclRow = {
  grantor_id: string  // agent who receives (allows grantee to send TO them)
  grantee_id: string  // agent who sends
  created_at: number
}

export type Message = {
  id: string
  from_id: string
  to_id: string | null    // null = broadcast/topic
  topic: string | null
  content: string
  created_at: number
  delivered_at: number | null
  expires_at: number | null
}

export type Topic = {
  id: string
  name: string
  created_at: number
}

export type Subscription = {
  agent_id: string
  topic_id: string
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  token_hash    TEXT NOT NULL UNIQUE,
  capabilities  TEXT NOT NULL DEFAULT '[]',
  registered_at INTEGER NOT NULL,
  last_seen     INTEGER
);

CREATE TABLE IF NOT EXISTS acl (
  grantor_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  grantee_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (grantor_id, grantee_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id           TEXT PRIMARY KEY,
  from_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  to_id        TEXT REFERENCES agents(id) ON DELETE CASCADE,
  topic        TEXT,
  content      TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  delivered_at INTEGER,
  expires_at   INTEGER
);

CREATE TABLE IF NOT EXISTS topics (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, topic_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_to_id ON messages(to_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(topic, delivered_at);
CREATE INDEX IF NOT EXISTS idx_messages_expires ON messages(expires_at) WHERE expires_at IS NOT NULL;
`

export function openDb(path: string): Database {
  const db = new Database(path, { create: true })
  db.exec(SCHEMA)
  return db
}

// --- Agents ---

export function registerAgent(
  db: Database,
  name: string,
  tokenHash: string,
  capabilities: string[] = [],
): Agent {
  const id = randomUUID()
  const now = Date.now()
  const caps = JSON.stringify(capabilities)
  db.prepare(`
    INSERT INTO agents (id, name, token_hash, capabilities, registered_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, name, tokenHash, caps, now)
  return { id, name, token_hash: tokenHash, capabilities: caps, registered_at: now, last_seen: null }
}

export function getAgentByToken(db: Database, tokenHash: string): Agent | null {
  return db.prepare<Agent, string>(
    `SELECT * FROM agents WHERE token_hash = ?`
  ).get(tokenHash) ?? null
}

export function getAgentByName(db: Database, name: string): Agent | null {
  return db.prepare<Agent, string>(
    `SELECT * FROM agents WHERE name = ?`
  ).get(name) ?? null
}

export function getAgentById(db: Database, id: string): Agent | null {
  return db.prepare<Agent, string>(
    `SELECT * FROM agents WHERE id = ?`
  ).get(id) ?? null
}

export function listAgents(db: Database): Agent[] {
  return db.prepare<Agent, []>(`SELECT * FROM agents ORDER BY name`).all()
}

export function touchAgent(db: Database, id: string): void {
  db.prepare(`UPDATE agents SET last_seen = ? WHERE id = ?`).run(Date.now(), id)
}

export function deleteAgent(db: Database, id: string): void {
  db.prepare(`DELETE FROM agents WHERE id = ?`).run(id)
}

// --- ACL ---

export function aclGrant(db: Database, grantorId: string, granteeId: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO acl (grantor_id, grantee_id, created_at)
    VALUES (?, ?, ?)
  `).run(grantorId, granteeId, Date.now())
}

export function aclRevoke(db: Database, grantorId: string, granteeId: string): void {
  db.prepare(`
    DELETE FROM acl WHERE grantor_id = ? AND grantee_id = ?
  `).run(grantorId, granteeId)
}

export function aclCheck(db: Database, grantorId: string, granteeId: string): boolean {
  const row = db.prepare<{ n: number }, [string, string]>(
    `SELECT COUNT(*) as n FROM acl WHERE grantor_id = ? AND grantee_id = ?`
  ).get(grantorId, granteeId)
  return (row?.n ?? 0) > 0
}

export function listGrantees(db: Database, grantorId: string): string[] {
  return db.prepare<{ grantee_id: string }, string>(
    `SELECT grantee_id FROM acl WHERE grantor_id = ?`
  ).all(grantorId).map(r => r.grantee_id)
}

export function listGrantors(db: Database, granteeId: string): string[] {
  return db.prepare<{ grantor_id: string }, string>(
    `SELECT grantor_id FROM acl WHERE grantee_id = ?`
  ).all(granteeId).map(r => r.grantor_id)
}

// --- Messages ---

export function insertMessage(
  db: Database,
  fromId: string,
  toId: string | null,
  topic: string | null,
  content: string,
  expiresAt?: number,
): Message {
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`
    INSERT INTO messages (id, from_id, to_id, topic, content, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, fromId, toId ?? null, topic ?? null, content, now, expiresAt ?? null)
  return { id, from_id: fromId, to_id: toId, topic: topic ?? null, content, created_at: now, delivered_at: null, expires_at: expiresAt ?? null }
}

export function markDelivered(db: Database, messageId: string): void {
  db.prepare(`UPDATE messages SET delivered_at = ? WHERE id = ?`).run(Date.now(), messageId)
}

export function getPendingMessages(db: Database, toId: string): Message[] {
  const now = Date.now()
  return db.prepare<Message, [string, number]>(`
    SELECT * FROM messages
    WHERE to_id = ?
      AND delivered_at IS NULL
      AND (expires_at IS NULL OR expires_at > ?)
    ORDER BY created_at ASC
  `).all(toId, now)
}

export function getMessage(db: Database, id: string): Message | null {
  return db.prepare<Message, string>(`SELECT * FROM messages WHERE id = ?`).get(id) ?? null
}

export function expireMessages(db: Database): number {
  const result = db.prepare(`
    DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?
  `).run(Date.now())
  return result.changes
}

// --- Topics ---

export function getOrCreateTopic(db: Database, name: string): Topic {
  const existing = db.prepare<Topic, string>(`SELECT * FROM topics WHERE name = ?`).get(name)
  if (existing) return existing
  const id = randomUUID()
  const now = Date.now()
  db.prepare(`INSERT INTO topics (id, name, created_at) VALUES (?, ?, ?)`).run(id, name, now)
  return { id, name, created_at: now }
}

export function listTopics(db: Database): Topic[] {
  return db.prepare<Topic, []>(`SELECT * FROM topics ORDER BY name`).all()
}

// --- Subscriptions ---

export function subscribe(db: Database, agentId: string, topicId: string): void {
  db.prepare(`INSERT OR IGNORE INTO subscriptions (agent_id, topic_id) VALUES (?, ?)`).run(agentId, topicId)
}

export function unsubscribe(db: Database, agentId: string, topicId: string): void {
  db.prepare(`DELETE FROM subscriptions WHERE agent_id = ? AND topic_id = ?`).run(agentId, topicId)
}

export function getTopicSubscribers(db: Database, topicId: string): string[] {
  return db.prepare<{ agent_id: string }, string>(
    `SELECT agent_id FROM subscriptions WHERE topic_id = ?`
  ).all(topicId).map(r => r.agent_id)
}

export function getAgentSubscriptions(db: Database, agentId: string): Topic[] {
  return db.prepare<Topic, string>(`
    SELECT t.* FROM topics t
    JOIN subscriptions s ON s.topic_id = t.id
    WHERE s.agent_id = ?
    ORDER BY t.name
  `).all(agentId)
}

export function getPendingTopicMessages(db: Database, agentId: string): Message[] {
  const now = Date.now()
  return db.prepare<Message, [string, number]>(`
    SELECT m.* FROM messages m
    JOIN subscriptions s ON s.topic_id = (
      SELECT id FROM topics WHERE name = m.topic
    )
    WHERE s.agent_id = ?
      AND m.to_id IS NULL
      AND m.delivered_at IS NULL
      AND (m.expires_at IS NULL OR m.expires_at > ?)
    ORDER BY m.created_at ASC
  `).all(agentId, now)
}
