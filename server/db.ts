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
  namespace: string | null; // #41: first-class identity label; null = unnamespaced. No routing/ACL semantics.
  registered_at: number;   // unix ms
  last_seen: number;       // unix ms — last TRAFFIC (a message sent/received)
  /** Last proof-of-life (unix ms): stamped when the node answers the keepalive
      ping, so it advances for an idle-but-healthy node too. NULL = never seen
      alive (pre-migration rows, or a node that has not pinged yet).
      DELIBERATELY separate from last_seen: "when did it last act" and "when was
      it last alive" are different questions, and overloading last_seen would
      silently change its meaning for every existing consumer. */
  last_alive: number | null;
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
  kind: string;            // "direct" | "topic" | "file" | "reminder"
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
  group_id: string | null; // #60: multi-file grouping tag (null = ungrouped)
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

export interface Observer {
  agent_id: string;
  granted_at: number;   // unix ms
  granted_by: string;   // admin-supplied label or "system"
}

// ──────────────────────────────────────────────
// 5.1 Database initialization
// ──────────────────────────────────────────────

/**
 * F0a (§4): rebuild an UPGRADED acl table to the FK-less shape.
 *
 * CREATE TABLE IF NOT EXISTS does nothing to a table that already exists, so
 * databases created before this change keep their REFERENCES clauses and would
 * reject the first remote endpoint written to them.
 *
 * Extracted from openDb so the precondition below is REACHABLE FROM A TEST.
 * Documented preconditions are the weakest form there is — see the guard.
 */
export function rebuildAclFkLess(db: Database): void {
  // MUST run outside any transaction: `PRAGMA foreign_keys = OFF` is a silent
  // NO-OP inside one. Measured, not assumed —
  //   outside, after ON:        { foreign_keys: 1 }
  //     inside txn, after OFF:  { foreign_keys: 1 }   <-- ignored, no error
  //   outside, after OFF:       { foreign_keys: 0 }
  //
  // This THROWS rather than merely saying so in a comment. A future tidy-up
  // that wrapped the migration section in a transaction would otherwise make
  // the pragma no-op silently, and the DROP/RENAME below would then run under
  // FK enforcement — producing a server that will not start, on every boot,
  // which is the exact failure this file's migration tests exist to prevent.
  // Eliminating the precondition beats documenting it.
  if (db.inTransaction) {
    throw new Error('acl rebuild must run outside a transaction: PRAGMA foreign_keys is ignored inside one');
  }

  try {
    const fks = db.prepare('PRAGMA foreign_key_list(acl)').all() as unknown[];
    if (fks.length === 0) return; // already FK-less: a second boot is a no-op

    // Secondary indexes are dropped along with the table, so capture their DDL
    // first and re-execute it after the rename — this is what preserves
    // idx_acl_reverse (#11). The PK's autoindex has a NULL sql and is recreated
    // by the CREATE TABLE itself, so it is filtered out rather than replayed.
    const indexDdl = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='acl' AND sql IS NOT NULL"
    ).all() as { sql: string }[]).map((r) => r.sql);

    // The pragma is set OUTSIDE the transaction (it is ignored inside one, see
    // the guard above) and the four DDL statements run INSIDE one.
    //
    // Un-transactioned, a process death between DROP and RENAME was TOTAL,
    // SILENT ACL LOSS — measured, not theorised:
    //   grants before: 2
    //   crashed as intended: simulated process death after DROP
    //   grants after crash + reboot: 0
    //   acl_new orphan present: true (2 rows stranded)
    // The next boot's `CREATE TABLE IF NOT EXISTS acl` recreates acl EMPTY
    // before this function runs, the zero-FK early return then no-ops, and the
    // server starts clean with every grant gone and the real rows sitting in a
    // table nothing reads. Fail-closed in the worst way: it looks like success.
    //
    // SQLite DDL is transactional, so BEGIN/COMMIT makes the four statements
    // atomic and a crash anywhere inside leaves the ORIGINAL FK-ful table with
    // every row. Index replay is inside too — a crash between RENAME and the
    // index DDL would otherwise silently drop idx_acl_reverse (#11).
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE acl_new (
            from_agent   TEXT NOT NULL,
            to_agent     TEXT NOT NULL,
            granted_at   INTEGER NOT NULL,
            granted_by   TEXT NOT NULL,
            PRIMARY KEY (from_agent, to_agent)
          );
        `);
        db.exec('INSERT INTO acl_new SELECT from_agent, to_agent, granted_at, granted_by FROM acl');
        db.exec('DROP TABLE acl');
        db.exec('ALTER TABLE acl_new RENAME TO acl');
        for (const ddl of indexDdl) db.exec(ddl);
      })();
    } finally {
      // Restored on BOTH paths: leaving foreign_keys OFF after a failed rebuild
      // would silently disable FK enforcement for every other table for the
      // life of the process.
      db.exec('PRAGMA foreign_keys = ON');
    }

    console.log(JSON.stringify({ evt: 'db.acl_rebuilt_fkless', indexes_restored: indexDdl.length, at: Date.now() }));
  } catch (err) {
    // Loud, and fatal to the boot: an acl table left half-rebuilt is worse than
    // one never touched, and this runs before the server accepts anything.
    process.stderr.write(`FATAL: acl FK-less rebuild failed: ${err}\n`);
    throw err;
  }
}

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
      namespace    TEXT,
      registered_at INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL,
      online       INTEGER NOT NULL DEFAULT 0
    );

    -- F0b (§3, §4): PEER MESHES. A peer is another claude-mesh, not an agent.
    -- No FKs anywhere in these tables for the same reason acl lost its own: the
    -- ids they carry are remote by construction.
    CREATE TABLE IF NOT EXISTS peer_keys (
      id            TEXT PRIMARY KEY,
      key_hash      TEXT NOT NULL,
      alias         TEXT NOT NULL,
      -- Message kinds this peer may relay INBOUND. The border is per-peer and
      -- each admin controls their own (§3): this column is that control.
      kinds         TEXT NOT NULL DEFAULT '["direct"]',
      rate_per_min  INTEGER NOT NULL DEFAULT 600,
      -- D10: expires_at bounds the window in which this key may be used to
      -- REGISTER; it does not bound the resulting peering (the peer holds its
      -- own token, is never re-checked against the key, and is ended by
      -- revokePeerKey — why minted_by_key exists). There is no time-bounded
      -- peering; if you want one, this field is not it (#114).
      expires_at    INTEGER,
      revoked_at    INTEGER,
      note          TEXT,
      created_at    INTEGER NOT NULL
    );

    -- Same treatment as agents.token_hash (#45/#13) and for the same reason:
    -- key_hash is the lookup key on every /peers/register call. NOT UNIQUE —
    -- a unique index cannot be created over a pre-existing duplicate, and this
    -- DDL runs on the LIVE database at boot, so it would turn a latent data
    -- condition into a server that will not start. The invariant is enforced
    -- at lookup instead: ambiguity authenticates NOBODY.
    CREATE INDEX IF NOT EXISTS idx_peer_keys_key_hash ON peer_keys(key_hash);

    -- D7: NO version column. A protocol version is a property of a live
    -- connection, not of a stored row — persisting it would let a peers row
    -- assert a version no current socket has agreed to.
    CREATE TABLE IF NOT EXISTS peers (
      alias         TEXT PRIMARY KEY,
      token_hash    TEXT NOT NULL,
      minted_by_key TEXT NOT NULL,
      kinds         TEXT NOT NULL,
      rate_per_min  INTEGER NOT NULL,
      registered_at INTEGER NOT NULL,
      last_seen     INTEGER,
      disabled      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_peers_token_hash ON peers(token_hash);

    -- Relay dedupe ledger: a remote msg_id seen from a peer, so a redelivered
    -- relay is refused rather than duplicated. Swept by the cleanup tick after
    -- RELAY_DEDUPE_MS.
    CREATE TABLE IF NOT EXISTS relays (
      peer_alias    TEXT NOT NULL,
      remote_msg_id TEXT NOT NULL,
      seen_at       INTEGER NOT NULL,
      PRIMARY KEY (peer_alias, remote_msg_id)
    );
    CREATE INDEX IF NOT EXISTS idx_relays_seen_at ON relays(seen_at);

    -- F0a (§4, §5.4): DELIBERATELY FK-LESS. An acl endpoint will soon be able
    -- to name a REMOTE id, which by definition has no agents(id) row — a
    -- foreign key would make the mesh unable to express the thing it exists to
    -- express. The referential guarantee is not dropped, it MOVES: aclGrant
    -- rejects a bare endpoint that is not an existing local agent, so the check
    -- lives where it can tell a typo from a remote id. A cascade could not.
    -- The cascade's other job (cleanup on delete) is now explicit in
    -- deleteAgent, because a cascade deletes silently in DDL where nobody
    -- reviewing a deletion policy would look.
    CREATE TABLE IF NOT EXISTS acl (
      from_agent   TEXT NOT NULL,
      to_agent     TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_messages_sent_at ON messages(sent_at);
    CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen);
    -- #45/#13: token_hash is the auth path's lookup key on EVERY agentOrAdmin
    -- HTTP request and every WS auth. Federation multiplies identity count
    -- (DESIGN_FEDERATION §5.5), which is why this stopped being a someday-perf
    -- ticket.
    --
    -- NOT UNIQUE, deliberately. A UNIQUE index is the tempting stronger
    -- statement — two agents sharing a token_hash is nonsense the token model
    -- already forbids — but creating a UNIQUE index FAILS on an existing table
    -- that already contains a duplicate, and this runs inside openDb() on the
    -- live database. That converts an unlikely data condition into a server
    -- that will not start, i.e. a self-inflicted mesh outage, to enforce an
    -- invariant we can enforce in the lookup instead — where an ambiguous
    -- hash refuses to authenticate anyone (see getAgentByToken).
    CREATE INDEX IF NOT EXISTS idx_agents_token_hash ON agents(token_hash);

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
      reply_to_msg_id TEXT,
      group_id        TEXT
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

    CREATE TABLE IF NOT EXISTS observers (
      agent_id   TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      granted_at INTEGER NOT NULL,
      granted_by TEXT NOT NULL
    );
  `);

  // Migration for existing databases: add new columns if they don't exist yet
  try { db.exec('ALTER TABLE files ADD COLUMN caption TEXT'); } catch {}
  try { db.exec('ALTER TABLE files ADD COLUMN reply_to_msg_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE files ADD COLUMN file_path TEXT'); } catch {}

  // Sprint 15 migration: per-reminder IANA timezone (null = UTC). Existing rows
  // get tz=NULL and keep behaving exactly as before (UTC cron).
  try { db.exec('ALTER TABLE reminders ADD COLUMN tz TEXT'); } catch {}

  // #41 migration: first-class nullable `namespace` on agents (identity label;
  // no routing/ACL/enforcement — inert data). Existing rows get namespace=NULL.
  try { db.exec('ALTER TABLE agents ADD COLUMN namespace TEXT'); } catch {}

  // #60 migration: optional `group_id` on files — a passthrough grouping tag for
  // multi-file sends (Telegram media-group model). Existing rows get NULL.
  try { db.exec('ALTER TABLE files ADD COLUMN group_id TEXT'); } catch {}

  // Channel-drop migration: `last_alive` on agents — proof-of-life stamped on
  // the keepalive ping, so an idle-healthy node is distinguishable from a node
  // whose channel died (last_seen only advances on TRAFFIC, so the two were
  // indistinguishable). ADDITIVE: existing rows get NULL and last_seen keeps its
  // exact current meaning for every consumer.
  try { db.exec('ALTER TABLE agents ADD COLUMN last_alive INTEGER'); } catch {}

  // #113 migration: DECLARED LINEAGE on a peer key. A rotation NAMES the key
  // it replaces; a rebind names nothing. Additive, existing rows get NULL —
  // which is the safe default by construction (no declared lineage means
  // rebind means the alias's inbound edges are dropped).
  try { db.exec('ALTER TABLE peer_keys ADD COLUMN rotates TEXT'); } catch {}

  // #11 migration: reverse ACL index. The acl PK is (from_agent, to_agent), so
  // every from_agent-leading lookup is already served — INCLUDING both arms of
  // aclRelated, whose second arm swaps the ARGUMENTS, not the columns, and so
  // is not the unindexed case it looks like. What genuinely scanned without
  // this index is the to_agent-leading direction: listInboundAcl (a bare
  // `SCAN acl` on main) and the inbound half of the presence peer-set UNION
  // below. Verified by EXPLAIN QUERY PLAN both ways, because an index added on
  // an assumed-unindexed query is an index whose benefit nobody can show.
  // ADDITIVE and idempotent: pure acceleration, no behaviour depends on it.
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_acl_reverse ON acl(to_agent, from_agent)'); } catch {}

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

  rebuildAclFkLess(db);

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
    namespace?: string | null;
  }
): Agent {
  const now = Date.now();
  const capabilities = agent.capabilities ?? '[]';
  const metadata = agent.metadata ?? '{}';
  const namespace = agent.namespace ?? null;

  db.prepare(`
    INSERT INTO agents (id, token_hash, hostname, capabilities, metadata, namespace, registered_at, last_seen, online)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(agent.id, agent.token_hash, agent.hostname, capabilities, metadata, namespace, now, now);

  return getAgentById(db, agent.id) as Agent;
}

export function getAgentById(db: Database, id: string): Agent | null {
  return db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as Agent | null;
}

export function getAgentByToken(db: Database, token: string): Agent | null {
  // #45/#13. The scan this replaces read EVERY agent row and ran a timing-safe
  // compare per row, on every agentOrAdmin HTTP request and every WS auth —
  // O(agents) per authentication, which federation multiplies (R1/R6,
  // DESIGN_FEDERATION §5.5).
  //
  // WHAT THE INDEX DOES AND DOES NOT BUY, because the distinction is the whole
  // security question here:
  //
  //   The SECRET is the raw token; `hash` is SHA-256 of it. An attacker who
  //   could measure our lookup time learns, at most, something about which
  //   HASH row was probed — and to exploit that they would need to choose a
  //   raw token whose hash lands where they want it, i.e. invert or collide
  //   SHA-256. So indexing on the hash does not leak the secret.
  //
  //   The timing-safe compare is therefore NOT what protects the index lookup.
  //   It is the final equality check on the candidate row, and it is
  //   LOAD-BEARING rather than ceremonial: SQLite's `=` honours the column's
  //   COLLATION, so a single `COLLATE NOCASE` on token_hash — a schema edit
  //   nobody would connect to authentication — would make the SQL layer hand
  //   back a row whose hash differs from the probe's in case. Only this
  //   compare stops that becoming a successful auth as the wrong agent.
  //   (Verified in SQLite, and pinned by a test that builds exactly that
  //   column; deleting this line fails it.)
  //
  //   AMBIGUITY FAILS CLOSED. The index is deliberately not UNIQUE (a unique
  //   index cannot be created over pre-existing duplicates, and openDb runs on
  //   the live DB — see the DDL comment). So the lookup asks for TWO rows: one
  //   match authenticates, zero is "no such token", and two or more means the
  //   table cannot say who this token belongs to — which must authenticate
  //   NOBODY rather than pick the first row and hand an attacker whichever
  //   identity SQLite happened to return. That state is impossible by
  //   construction today; it is refused loudly rather than assumed away.
  const hash = hashToken(token);
  const rows = db
    .prepare('SELECT * FROM agents WHERE token_hash = ? LIMIT 2')
    .all(hash) as Agent[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.error(
      `[db] AMBIGUOUS token_hash — ${rows.length}+ agents share one token hash (${rows
        .map((r) => r.id)
        .join(', ')}); refusing to authenticate any of them`,
    );
    return null;
  }
  const candidate = rows[0]!;
  return timingSafeEqual(candidate.token_hash, hash) ? candidate : null;
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

/** Stamp proof-of-life. Called when a node answers the keepalive ping — it does
    NOT touch last_seen, so "last acted" stays untouched by mere liveness. */
export function touchAlive(db: Database, id: string): void {
  db.prepare('UPDATE agents SET last_alive = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * #87 — clear every agent's `online` flag. Returns the number of rows changed.
 *
 * `online` is a claim about a LIVE SOCKET, but it lives in a durable table, so
 * it outlives the process that could vouch for it. Only the connect and
 * disconnect handlers ever wrote it, and a disconnect handler cannot run for a
 * socket that died with the server — so after a restart every agent that was
 * connected and does not reconnect reads as online FOREVER. Reproduced
 * directly: set online, close the db, reopen it, and the flag is still 1.
 *
 * That is worse than staleness: it is confidently wrong output. A roster that
 * says "offline" about a live agent is a lag; one that says "online" about an
 * agent that has been gone for a week is a lie the reader cannot detect.
 *
 * Called once at WS-server startup, BEFORE the listener accepts — at that
 * instant no socket exists, so "nobody is online" is not a guess, it is the
 * only true statement about the world. Reconnects re-assert it immediately.
 */
export function clearAllOnline(db: Database): number {
  return db.prepare('UPDATE agents SET online = 0 WHERE online = 1').run().changes;
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
    namespace?: string | null;
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
  // namespace: explicit null clears it, so distinguish "provided" (incl. null)
  // from "omitted" — an omitted namespace leaves the column untouched.
  if (fields.namespace !== undefined) {
    setClauses.push('namespace = ?');
    values.push(fields.namespace);
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
  // F0a: was an ON DELETE CASCADE on acl's foreign keys. Now explicit, because
  // the table is FK-less (see the acl DDL) — and because a cascade performed
  // this deletion invisibly, in DDL, where nobody reviewing what deleting an
  // agent destroys would think to look.
  db.prepare('DELETE FROM acl WHERE from_agent = ? OR to_agent = ?').run(id, id);
  db.prepare('DELETE FROM agents WHERE id = ?').run(id);
}

// ──────────────────────────────────────────────
// 5.3 ACL
// ──────────────────────────────────────────────

/**
 * F0a (§5.4) — the referential guarantee the dropped foreign key used to give,
 * moved to where it can still tell right from wrong.
 *
 * A BARE endpoint (no ':') names a LOCAL agent and must exist: that is the typo
 * the FK used to catch. An endpoint CONTAINING ':' is a remote id, which by
 * definition has no agents(id) row — the case the FK made impossible to express
 * and the reason it had to go. Remote ids are not validated here in F0; they
 * are simply not subjected to a local-existence test that could only ever
 * reject them.
 *
 * Throws rather than returning null: every caller today treats a grant as
 * having happened, so a silent no-op would produce an ACL the operator believes
 * exists and the router does not honour.
 */
function assertLocalEndpointExists(db: Database, endpoint: string): void {
  if (endpoint.includes(':')) return; // remote id — see above
  if (getAgentById(db, endpoint) !== null) return;
  const err = new Error(`unknown agent: ${endpoint}`) as Error & { code?: string };
  err.code = 'AGENT_NOT_FOUND';
  throw err;
}

/**
 * F1b (§5.4) — the PEERING rule, in the chokepoint so no handler branches on it.
 *
 * An endpoint is REMOTE iff it contains ':' AND is not an existing local
 * agent. The second clause is not belt-and-braces — it is the whole
 * difference between a rule that works and one that breaks live agents.
 *
 * Grammar alone is true for ids created from F0b onward (POST /agents refuses
 * ':') and FALSE for the population F0b deliberately preserved: legacy colon
 * ids are REPORTED at boot and never rejected, precisely because they exist.
 * Treating ':' as decisive made aclGrant refuse NO_PEERING for two ordinary
 * local agents — reproduced:
 *   local-a -> legacy:node   NO_PEERING (no outbound peering for legacy)
 *   legacy:node -> local-a   NO_PEERING (no inbound peering for legacy)
 *
 * BOUNDED TO GRANT. aclCheck is a SELECT and aclRevoke a bare DELETE, neither
 * consulting this rule, so existing legacy edges kept working and remained
 * revocable throughout — the defect was creation only.
 *
 * TABLES READ: `peers` only (via hasInboundPeer). That is total for the inbound
 * direction because a peer can relay to us only if it has registered, and
 * registration is the only thing that writes `peers`. The outbound direction
 * reads nothing yet — `outbound_peers` is F2's — so it refuses, which is the
 * honest answer rather than a permissive default.
 */
function assertPeeringAllowed(db: Database, from_agent: string, to_agent: string): void {
  const fail = (msg: string): never => {
    const err = new Error(msg) as Error & { code?: string };
    err.code = 'NO_PEERING';
    throw err;
  };
  // The lookup is what distinguishes a remote id from a legacy local one.
  const isRemote = (endpoint: string) => endpoint.includes(':') && getAgentById(db, endpoint) === null;
  const fromRemote = isRemote(from_agent);
  const toRemote = isRemote(to_agent);

  if (fromRemote) {
    const alias = from_agent.slice(0, from_agent.indexOf(':'));
    if (!hasInboundPeer(db, alias)) fail(`no inbound peering for ${alias}`);
  }
  if (toRemote) {
    const alias = to_agent.slice(0, to_agent.indexOf(':'));
    if (!hasOutboundPeer(db, alias)) fail(`no outbound peering for ${alias}`);
  }
}

export function aclGrant(
  db: Database,
  from_agent: string,
  to_agent: string,
  granted_by: string
): AclRow {
  assertLocalEndpointExists(db, from_agent);
  assertLocalEndpointExists(db, to_agent);
  assertPeeringAllowed(db, from_agent, to_agent);
  const now = Date.now();
  db.prepare(`
    INSERT INTO acl (from_agent, to_agent, granted_at, granted_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(from_agent, to_agent) DO UPDATE SET granted_at = excluded.granted_at, granted_by = excluded.granted_by
  `).run(from_agent, to_agent, now, granted_by);

  return db.prepare('SELECT * FROM acl WHERE from_agent = ? AND to_agent = ?')
    .get(from_agent, to_agent) as AclRow;
}

/**
 * Revoke one edge. Returns the number of rows removed (0 or 1).
 *
 * F0a: the count is now RETURNED rather than discarded, because the rule for
 * revoke is EDGE existence, not endpoint existence. The HTTP door used to
 * pre-check that both endpoints were local agents — which under F0 makes an
 * edge granted to a remote id unrevokable OVER HTTP, since the gate refuses
 * before the DELETE ever runs (the MCP door has no such gate, so the edge was
 * always withdrawable there — the defect was the gap between the doors).
 *
 * An endpoint check cannot express "this edge is not here", and that is the
 * only thing revoke actually needs to know.
 */
export function aclRevoke(db: Database, from_agent: string, to_agent: string): number {
  return db.prepare('DELETE FROM acl WHERE from_agent = ? AND to_agent = ?')
    .run(from_agent, to_agent).changes;
}

export function aclCheck(db: Database, from_agent: string, to_agent: string): boolean {
  const row = db.prepare('SELECT 1 FROM acl WHERE from_agent = ? AND to_agent = ?')
    .get(from_agent, to_agent);
  return row !== null;
}

/**
 * DELIBERATELY RETAINED as the test oracle for listAclPeers
 * (presence-acl-queries.test.ts). DO NOT REMOVE AS UNUSED.
 *
 * Since #11 this has ZERO production callers — presence was the last one. A
 * dead-code sweep would delete it, the differential test that compares the
 * UNION against this pairwise predicate would go with it, and the UNION would
 * lose its only independent cross-check WITHOUT ANYTHING GOING RED.
 *
 * That compounds with the schema-contingency note on listAclPeers: if this is
 * tidied away first, both the oracle and the cross-check are gone before the
 * day that note was written for. Its value is precisely that it computes the
 * same answer a different way.
 */
export function aclRelated(db: Database, agentA: string, agentB: string): boolean {
  const row = db.prepare(
    'SELECT 1 FROM acl WHERE (from_agent = ? AND to_agent = ?) OR (from_agent = ? AND to_agent = ?)'
  ).get(agentA, agentB, agentB, agentA);
  return row !== null;
}

/**
 * Every agent ACL-related to `agentId`, in ONE query — the union of its
 * outbound edges (from_agent = id) and its inbound edges (to_agent = id).
 *
 * Replaces the per-peer aclRelated() loop in presence (#11): broadcastStatus
 * ran one query per connected peer per presence event, and list_presence ran
 * one per registered agent per call, so a presence change on an N-agent mesh
 * cost N queries to answer a question that is one query wide.
 *
 * CORRECTNESS IS CONTINGENT ON A SCHEMA FACT, stated because the next schema
 * change is where it breaks. This set is exactly what per-peer aclRelated()
 * returned ONLY because `acl` has no expiry, no revoked flag and no status
 * column: a row's EXISTENCE is the whole relationship, so a UNION over rows
 * cannot return an edge the predicate would have filtered out.
 *
 * The day someone adds `revoked_at` (or `expires_at`, or a status), this
 * function silently starts reporting revoked relationships as live — no test
 * here fails, because every test builds edges that are live by construction.
 * Whoever adds that column must add the same condition HERE, not only to
 * aclCheck. It is the kind of break that looks like a presence bug months
 * later rather than an ACL bug on the day.
 *
 * SELF IS EXCLUDED. Call sites that need the subject add it back explicitly:
 * handleListPresence does (its roster includes the caller), broadcastStatus
 * deliberately does not (you do not need your own presence event).
 *
 * That exclusion is a real behaviour delta, not a tidy-up — see the note in
 * ws-server's broadcastStatus. Replacing a pairwise predicate with set
 * membership is exact only OFF the diagonal, and the diagonal is where a
 * self-referential acl row lives.
 */
export function listAclPeers(db: Database, agentId: string): Set<string> {
  const rows = db.prepare(
    `SELECT to_agent AS peer FROM acl WHERE from_agent = ?
     UNION
     SELECT from_agent AS peer FROM acl WHERE to_agent = ?`
  ).all(agentId, agentId) as { peer: string }[];
  const peers = new Set<string>();
  for (const r of rows) if (r.peer !== agentId) peers.add(r.peer);
  return peers;
}

// ──────────────────────────────────────────────
// 5.9 Peers (F0b — §3, §4, §6)
// ──────────────────────────────────────────────

export interface PeerKey {
  id: string;
  key_hash: string;
  alias: string;
  kinds: string;
  rate_per_min: number;
  expires_at: number | null;
  revoked_at: number | null;
  note: string | null;
  created_at: number;
  /** #113: the key_id this key REPLACES, when the operator declared a rotation.
   *  NULL means no lineage was declared — treated as a rebind. */
  rotates: string | null;
}

export interface Peer {
  alias: string;
  token_hash: string;
  minted_by_key: string;
  kinds: string;
  rate_per_min: number;
  registered_at: number;
  last_seen: number | null;
  disabled: number;
}

/** A peer alias must be usable as an id prefix, so the grammar is the same
    shape as an agent id and is deliberately NOT a general string. */
export const PEER_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Reserved: 'mesh' names THIS mesh in every remote id, so a peer claiming it
    would make its own traffic indistinguishable from local traffic. */
export const RESERVED_ALIAS = 'mesh';

export function insertPeerKey(
  db: Database,
  key: {
    id: string;
    key_hash: string;
    alias: string;
    kinds: string;
    rate_per_min: number;
    expires_at?: number | null;
    note?: string | null;
    created_at: number;
    rotates?: string | null;
  }
): PeerKey {
  db.prepare(`
    INSERT INTO peer_keys (id, key_hash, alias, kinds, rate_per_min, expires_at, note, created_at, rotates)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(key.id, key.key_hash, key.alias, key.kinds, key.rate_per_min,
         key.expires_at ?? null, key.note ?? null, key.created_at, key.rotates ?? null);
  return db.prepare('SELECT * FROM peer_keys WHERE id = ?').get(key.id) as PeerKey;
}

export function getPeerKeyById(db: Database, id: string): PeerKey | null {
  return db.prepare('SELECT * FROM peer_keys WHERE id = ?').get(id) as PeerKey | null;
}

export function listPeerKeys(db: Database): PeerKey[] {
  return db.prepare('SELECT * FROM peer_keys ORDER BY created_at DESC').all() as PeerKey[];
}

/** A key is LIVE if it has not been revoked and has not expired. "A live key
    already exists for this alias" is the 409 condition on mint. */
/**
 * ONE definition of a LIVE peer key, as a SQL fragment shared by every query
 * that asks the question (#103).
 *
 * It was two: the mint gate required not-revoked AND not-expired, while the
 * boot report required only not-revoked. So an expired-but-unrevoked key was
 * invisible to the gate (correct — it cannot register) and named by the report
 * as a collision (wrong). Reproduced before fixing:
 *   gate sees a live key?  false
 *   boot report names it?  [ "expired-alias" ]
 *
 * Over-reporting is the direction a detection query dies in: an operator who
 * learns the collision report cries wolf stops reading it, and then it is
 * worth nothing on the day it is right. Sharing the fragment means the two
 * cannot drift again — a third caller inherits the definition rather than
 * restating it.
 *
 * `?` binds the comparison time. Callers pass `now`.
 */
const LIVE_PEER_KEY_SQL = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)';

export function getLivePeerKeyForAlias(db: Database, alias: string, now: number): PeerKey | null {
  return db.prepare(
    `SELECT * FROM peer_keys
     WHERE alias = ? AND ${LIVE_PEER_KEY_SQL}
     ORDER BY created_at DESC LIMIT 1`
  ).get(alias, now) as PeerKey | null;
}

/**
 * Look a peer key up BY ITS SECRET, the same construction as #75's
 * getAgentByToken and for the same three reasons:
 *
 *   - indexed on the hash, because this runs on every /peers/register call;
 *   - AMBIGUITY AUTHENTICATES NOBODY — two rows sharing a hash is a data
 *     condition no caller should be able to resolve in their favour, so it
 *     fails closed and logs loudly rather than taking the first row;
 *   - a final timing-safe compare, which is NOT redundant: SQLite's `=` honours
 *     COLLATION, so a column declared NOCASE would return a row whose stored
 *     hash differs from the computed one in case. That compare is the only
 *     thing standing between a case-variant hash and an authenticated peer.
 *     There is a test that builds exactly that world.
 */
export function getPeerKeyBySecret(db: Database, secret: string, now: number = Date.now()): PeerKey | null {
  const hash = hashToken(secret);
  // Liveness is COMPUTED BY THE SHARED FRAGMENT, not re-derived in TypeScript
  // (#103, extended): registration was a THIRD authority on "live" — it read
  // revoked_at and expires_at itself and agreed with the gate by coincidence.
  // It is now the same sentence, evaluated by SQLite.
  //
  // Selected as a column rather than moved into the WHERE deliberately: the
  // AMBIGUITY check must still see EVERY row sharing this hash, live or not.
  // Two keys with one hash is an alarming data condition whichever of them is
  // revoked, and filtering first would hide half of it.
  const rows = db.prepare(
    `SELECT *, (${LIVE_PEER_KEY_SQL}) AS is_live FROM peer_keys WHERE key_hash = ? LIMIT 2`
  ).all(now, hash) as (PeerKey & { is_live: number })[];
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.error(JSON.stringify({
      evt: 'peer_key.ambiguous_hash',
      keys: rows.map(r => r.id),
      msg: 'two or more peer keys share one hash; refusing to authenticate any of them',
      at: Date.now(),
    }));
    return null;
  }
  const candidate = rows[0]!;
  if (!timingSafeEqual(candidate.key_hash, hash)) return null;
  // The single liveness decision, from the single definition.
  return candidate.is_live ? candidate : null;
}

/** Revocation is ONE transaction: a key marked dead while its peer row stays
    enabled is precisely the half-applied state this exists to prevent, and it
    is what two separate statements produce on a crash between them. */
export function revokePeerKey(db: Database, id: string): boolean {
  const tx = db.transaction(() => {
    const changed = db.prepare('UPDATE peer_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(Date.now(), id).changes;
    if (changed === 0) return false;
    db.prepare('UPDATE peers SET disabled = 1 WHERE minted_by_key = ?').run(id);
    return true;
  });
  return tx() as boolean;
}

export function getPeerByAlias(db: Database, alias: string): Peer | null {
  return db.prepare('SELECT * FROM peers WHERE alias = ?').get(alias) as Peer | null;
}

/**
 * Ids that name BOTH a local agent and a peer (registered, or holding a live
 * key). Backs the boot report — the gates prevent NEW collisions and can do
 * nothing about one already on disk.
 *
 * Extracted so the query is testable. NOTE the limit: this pins WHAT the report
 * finds, not that main() calls it. Same coverage as the legacy ':' report
 * beside it, and stated rather than implied.
 */
export function findPeerAliasCollisions(db: Database): string[] {
  // Uses the SAME live-key definition as the gate (#103), so the report can
  // only ever name a collision the gate would actually have refused.
  return (db.prepare(
    `SELECT a.id FROM agents a
     WHERE a.id IN (SELECT alias FROM peers)
        OR a.id IN (SELECT alias FROM peer_keys WHERE ${LIVE_PEER_KEY_SQL})`
  ).all(Date.now()) as { id: string }[]).map(r => r.id);
}

/** Stamp a peer's proof-of-life. F1a: a peer's `ping` stamps this and nothing
    else — `peers` has no `online` column, and after #87 a durable liveness
    CLAIM is exactly what must not be invented. `peerIndex` is the online
    truth, and it lives in memory where a restart clears it. */
export function touchPeer(db: Database, alias: string): void {
  db.prepare('UPDATE peers SET last_seen = ? WHERE alias = ?').run(Date.now(), alias);
}

/** Aliases of every peer whose row is disabled — for the sweep that closes a
    revoked peer's socket. Cheap: the revoked set is expected to be near-empty. */
export function listDisabledPeerAliases(db: Database): string[] {
  return (db.prepare('SELECT alias FROM peers WHERE disabled = 1').all() as { alias: string }[])
    .map(r => r.alias);
}

/**
 * F1b (§5.4): may `alias` relay INBOUND to us? True iff a non-disabled peers
 * row exists. This is the peering half of the acl rule for `alias:x -> local`.
 */
export function hasInboundPeer(db: Database, alias: string): boolean {
  const row = db.prepare('SELECT 1 FROM peers WHERE alias = ? AND disabled = 0').get(alias);
  return row !== null;
}

/**
 * F1b (§5.4): may we relay OUTBOUND to `alias`? Always false today — the
 * `outbound_peers` table is F2's, and until it exists there is no such thing as
 * an outbound peering to check.
 *
 * Written NOW, returning false, rather than inlining `false` at the call site:
 * F2 fills this in instead of re-plumbing the rule through aclGrant, and the
 * refusal reads as "no outbound peering" rather than as a hardcoded no.
 */
export function hasOutboundPeer(_db: Database, _alias: string): boolean {
  return false;
}

/**
 * AN ALIAS'S EDGES END WITH THE PEERING THAT CREATED THEM.
 *
 * Revocation used to park grants rather than revoke them: revokePeerKey
 * disables the `peers` row and never touches `acl`, a new key may be minted for
 * the same alias once the old is revoked, and registration's upsertPeer sets
 * `disabled = 0` — so every surviving `alias:*` edge came back to life for
 * WHOEVER NOW HOLDS THE NAME. Reproduced end to end:
 *
 *   mesh ONE edge honoured:       true
 *   after revoke, peer disabled:  true
 *     edge still in acl:          true
 *   after re-register, disabled:  false
 *     MESH TWO inherits it:       true
 *
 * Not an escalation — every step is an admin action — but it is operator
 * SURPRISE of the worst kind: the operator revoked a peering and believes the
 * grants went with it. This codebase already argues that principle for keys at
 * http-admin.ts:1297 ("revoking one would leave a door open the operator
 * believes they closed"); edges are the same argument one level out.
 *
 * DIRECTION IS EXPLICIT, never inferred: 'inbound' edges are the ones the alias
 * GRANTS FROM (`from_agent` prefixed `alias:`), 'outbound' the ones it is
 * granted TO. A helper that guessed from context would eventually guess wrong
 * in the direction that leaves a door open.
 *
 * Returns the number of edges removed, so callers can log what a revocation
 * actually destroyed rather than asserting it destroyed something.
 */
export function deletePeeringEdges(db: Database, alias: string, direction: 'inbound' | 'outbound'): number {
  const column = direction === 'inbound' ? 'from_agent' : 'to_agent';
  // Prefix range, not LIKE: `alias:` .. `alias;` is index-servable and cannot
  // be confused by a '%' or '_' inside an alias. (';' is ':' + 1.)
  return db.prepare(`DELETE FROM acl WHERE ${column} >= ? AND ${column} < ?`)
    .run(`${alias}:`, `${alias};`).changes;
}

export function listPeers(db: Database): Peer[] {
  return db.prepare('SELECT * FROM peers ORDER BY alias').all() as Peer[];
}

/** Registration is an UPSERT: re-registering an existing peer ROTATES its token
    rather than creating a second row, so a peer that reconnects with a fresh
    key never ends up with two identities. Re-registration also clears
    `disabled` — the key was checked live immediately above. */
export function upsertPeer(
  db: Database,
  peer: {
    alias: string; token_hash: string; minted_by_key: string;
    kinds: string; rate_per_min: number;
    /** #113: the key_id this registration's key declares it replaces. */
    rotates?: string | null;
  }
): Peer {
  const now = Date.now();
  // AN ALIAS'S EDGES END WITH THE PEERING THAT CREATED THEM (#113).
  //
  // The decision is DECLARED LINEAGE, not an inferred one. The obvious signal —
  // "the row was disabled, so this is a rebind" — CANNOT WORK, verified at the
  // tree:
  //   - minting refuses while a live key exists (http-admin, 409), so a
  //     receiver-side ROTATION must also go revoke -> mint -> register. At the
  //     DB layer that is BYTE-IDENTICAL to a rebind.
  //   - key EXPIRY never disables the row (only revokePeerKey does), so
  //     expired -> mint -> register re-arms an ENABLED row and any
  //     disabled-based hook never fires at all.
  // Two operations, one state transition: the intent lives with the operator
  // and is simply not present in the data.
  //
  // So the operator declares it. A rotation key NAMES the key it replaces, and
  // edges survive only if that lineage matches the row's CURRENT key.
  //
  // THE FAIL DIRECTION IS SAFE BY CONSTRUCTION: absent lineage, or lineage
  // naming some other key, means rebind means drop. The cost of forgetting to
  // say "rotation" is a re-grant; the cost of the opposite default is a live
  // edge pointing at whoever now holds the name.
  //
  // THE LIMIT OF DECLARED LINEAGE, stated so nobody reads it as more than it
  // is: `rotates` verifies that this key SUCCEEDS a specific prior key (checked
  // against the row's minted_by_key). It does NOT verify that the same
  // COUNTERPARTY holds it. An admin who mints with `rotates` and hands the
  // secret to a different mesh transfers the edges — truthfully declared, and
  // wrong.
  //
  // The declarer is the ADMIN AT MINT TIME, not the peer at registration, and
  // that is the security-critical property: the peer presenting the key cannot
  // choose whether its arrival counts as a rotation. Failure therefore requires
  // an ACTIVE INCORRECT DECLARATION by the trust root, never an omission —
  // absent means rebind means drop.
  const existing = getPeerByAlias(db, peer.alias);
  if (existing !== null) {
    const declared = peer.rotates ?? null;
    const isRotation = declared !== null && declared === existing.minted_by_key;
    if (!isRotation) {
      const removed = deletePeeringEdges(db, peer.alias, 'inbound');
      console.log(JSON.stringify({
        evt: 'peer.edges_ended_with_peering', alias: peer.alias, removed,
        declared_rotates: declared, previous_key: existing.minted_by_key, at: now,
      }));
    }
  }
  db.prepare(`
    INSERT INTO peers (alias, token_hash, minted_by_key, kinds, rate_per_min, registered_at, disabled)
    VALUES (?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(alias) DO UPDATE SET
      token_hash = excluded.token_hash,
      minted_by_key = excluded.minted_by_key,
      kinds = excluded.kinds,
      rate_per_min = excluded.rate_per_min,
      registered_at = excluded.registered_at,
      disabled = 0
  `).run(peer.alias, peer.token_hash, peer.minted_by_key, peer.kinds, peer.rate_per_min, now);
  return getPeerByAlias(db, peer.alias)!;
}

/** Sweep the relay dedupe ledger. Same delete-old-rows shape as sweepRetention;
    nothing here is deliverable, so there is no still-in-flight exclusion. */
export function sweepRelays(db: Database, dedupeMs: number): number {
  return db.prepare('DELETE FROM relays WHERE seen_at < ?').run(Date.now() - dedupeMs).changes;
}

export function listInboundAcl(db: Database, id: string): AclRow[] {
  return db.prepare('SELECT * FROM acl WHERE to_agent = ?').all(id) as AclRow[];
}

export function listOutboundAcl(db: Database, id: string): AclRow[] {
  return db.prepare('SELECT * FROM acl WHERE from_agent = ?').all(id) as AclRow[];
}

// #38: global ACL provenance queries — every edge stamped by a given writer
// (exact) or writer-namespace (prefix), across the whole table, for reconcilers
// diffing desired-vs-actual. Rows carry from_agent/to_agent/granted_by/granted_at.
export function listAclByGrantedBy(db: Database, grantedBy: string): AclRow[] {
  return db.prepare('SELECT * FROM acl WHERE granted_by = ? ORDER BY granted_at ASC').all(grantedBy) as AclRow[];
}

export function listAclByGrantedByPrefix(db: Database, prefix: string): AclRow[] {
  // Escape LIKE metacharacters in the prefix so %/_/\ in a granted_by namespace
  // are matched literally; only the trailing % is a wildcard.
  const escaped = prefix.replace(/[\\%_]/g, (c) => '\\' + c);
  return db.prepare(
    "SELECT * FROM acl WHERE granted_by LIKE ? ESCAPE '\\' ORDER BY granted_at ASC"
  ).all(escaped + '%') as AclRow[];
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


export function queryMessages(
  db: Database,
  opts: {
    agent?: string;
    topic?: string;
    since?: number;
    limit?: number;
    // Backward-pagination cursor (#36): return only rows strictly OLDER than
    // (sentAt, id) under the `sent_at DESC, id DESC` order. The (sent_at, id)
    // composite gives a stable tie-break across rows sharing one sent_at.
    before?: { sentAt: number; id: string };
    // Restrict to these message kinds (e.g. ['direct','file']) so a DM/
    // scrollback scan can skip high-volume 'topic' beat rows and not exhaust
    // its row budget on them. Empty/undefined = all kinds.
    kinds?: string[];
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
  if (opts.kinds && opts.kinds.length > 0) {
    clauses.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
    params.push(...opts.kinds);
  }
  if (opts.since !== undefined) {
    clauses.push('sent_at >= ?');
    params.push(opts.since);
  }
  if (opts.before !== undefined) {
    clauses.push('(sent_at < ? OR (sent_at = ? AND id < ?))');
    params.push(opts.before.sentAt, opts.before.sentAt, opts.before.id);
  }

  let limit = opts.limit ?? 100;
  if (limit > 1000) limit = 1000;

  const where = clauses.length > 0 ? 'WHERE ' + clauses.join(' AND ') : '';
  const sql = `SELECT * FROM messages ${where} ORDER BY sent_at DESC, id DESC LIMIT ?`;
  params.push(limit);

  return db.prepare(sql).all(...params) as Message[];
}

// Delivery TTL and retention are DIFFERENT lifecycles (#34):
//   - expires_at governs DELIVERABILITY only (the drain gate in
//     getPendingMessages/getPendingTopicMessages/countPendingMessages already
//     enforces it — an undelivered message past its TTL is never delivered).
//   - retention governs how long rows stay in the store; see sweepRetention.
// Neither deletes delivered history at TTL anymore.

// Count, by kind, the undelivered messages that crossed their TTL in the
// window [since, now) — i.e. newly "expired undelivered" since the last sweep.
// Deletes nothing. Windowed so each row is counted exactly once as it expires
// (undelivered-past-TTL rows are stable — the drain gate means they never
// become delivered). Backs the process-lived expired-undelivered counter.
export function countExpiredUndeliveredSince(
  db: Database,
  since: number,
  now: number
): Record<string, number> {
  const rows = db.prepare(
    `SELECT kind, COUNT(*) AS c FROM messages
     WHERE delivered_at IS NULL
       AND expires_at IS NOT NULL
       AND expires_at >= ? AND expires_at < ?
     GROUP BY kind`
  ).all(since, now) as { kind: string; c: number }[];
  const counts: Record<string, number> = {};
  for (const r of rows) counts[r.kind] = r.c;
  return counts;
}

// Retention sweep: delete rows older than the retention window, EXCEPT those
// still deliverable (undelivered AND not-yet-expired) — retention must never
// destroy durable pending mail (e.g. a ttl:null message to a long-offline
// agent). Only ever called when a retention window is configured
// (MESH_RETENTION_MS); unset ⇒ never called ⇒ keep everything forever.
// Returns the number of rows removed. Reusable shape for the files table (#39).
export function sweepRetention(db: Database, retentionMs: number): number {
  const now = Date.now();
  const cutoff = now - retentionMs;
  const result = db.prepare(
    `DELETE FROM messages
     WHERE sent_at < ?
       AND NOT (delivered_at IS NULL AND (expires_at IS NULL OR expires_at >= ?))`
  ).run(cutoff, now);
  return result.changes;
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
    group_id?: string | null;
  }
): FileRecord {
  const caption = file.caption ?? null;
  const reply_to_msg_id = file.reply_to_msg_id ?? null;
  const group_id = file.group_id ?? null;

  db.prepare(`
    INSERT INTO files (id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(file.id, file.from_agent, file.to_agent, file.filename, file.content_type, file.size_bytes, file.file_path, file.sent_at, file.expires_at, caption, reply_to_msg_id, group_id);

  return getFile(db, file.id) as FileRecord;
}

export function getFile(db: Database, id: string): FileRecord | null {
  return db.prepare('SELECT id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id, group_id FROM files WHERE id = ?').get(id) as FileRecord | null;
}

export function markFileDelivered(db: Database, id: string): void {
  db.prepare('UPDATE files SET delivered_at = ? WHERE id = ?').run(Date.now(), id);
}

/**
 * #39 — the files twin of #34, fixed for messages in #40.
 *
 * This deleted on `expires_at < now` with NO delivered_at condition, so a
 * DELIVERED file's row and bytes vanished ~5 minutes after acceptance:
 * delivery TTL was destroying history, exactly as it had for messages.
 *
 * The split, mirroring #40: `expires_at` governs DELIVERABILITY of undelivered
 * files only. Delivered files persist and are removed by the retention sweep
 * (sweepFileRetention) if a window is configured — never by the delivery TTL.
 *
 * ORDER IS LOAD-BEARING and was already right here: DELETE ... RETURNING, then
 * the caller unlinks. Verified before changing anything rather than "fixed" on
 * suspicion — unlinking first would leave rows pointing at missing bytes on a
 * crash between the two, which reads as corruption rather than as cleanup.
 */
export function deleteExpiredFiles(db: Database): string[] {
  const rows = db.prepare(`
    DELETE FROM files
    WHERE delivered_at IS NULL
      AND expires_at IS NOT NULL AND expires_at < ?
    RETURNING file_path
  `).all(Date.now()) as { file_path: string }[];
  return rows.map(r => r.file_path);
}

/**
 * Retention sweep for files (#39), the same shape as sweepRetention for
 * messages — including its still-deliverable exclusion, so retention never
 * destroys durable pending mail: an undelivered, not-yet-expired file survives
 * regardless of age.
 *
 * Returns the paths of removed rows so the caller can unlink AFTER the delete,
 * for the same reason as above.
 */
export function sweepFileRetention(db: Database, retentionMs: number): string[] {
  const now = Date.now();
  const cutoff = now - retentionMs;
  const rows = db.prepare(
    `DELETE FROM files
     WHERE sent_at < ?
       AND NOT (delivered_at IS NULL AND (expires_at IS NULL OR expires_at >= ?))
     RETURNING file_path`
  ).all(cutoff, now) as { file_path: string }[];
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
// 5.9 Observers
// ──────────────────────────────────────────────

export function grantObserver(db: Database, agent_id: string, granted_by: string): Observer {
  const now = Date.now();
  db.prepare(`
    INSERT INTO observers (agent_id, granted_at, granted_by)
    VALUES (?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET granted_at = excluded.granted_at, granted_by = excluded.granted_by
  `).run(agent_id, now, granted_by);
  return db.prepare('SELECT * FROM observers WHERE agent_id = ?').get(agent_id) as Observer;
}

export function revokeObserver(db: Database, agent_id: string): boolean {
  const result = db.prepare('DELETE FROM observers WHERE agent_id = ?').run(agent_id);
  return result.changes > 0;
}

export function isObserver(db: Database, agent_id: string): boolean {
  const row = db.prepare('SELECT 1 FROM observers WHERE agent_id = ?').get(agent_id);
  return row !== null;
}

export function listObservers(db: Database): Observer[] {
  return db.prepare('SELECT * FROM observers ORDER BY granted_at ASC').all() as Observer[];
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
