import { Database } from 'bun:sqlite';
import { safeFilename, safeContentType } from './file-hygiene.ts';
import { hashToken, timingSafeEqual } from './auth.ts';

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
  last_responded: number | null;
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
  /** F2a: why this row can never be delivered — set with expires_at on a
   *  PERMANENT remote refusal. A row carrying it is not pending and was not
   *  delivered; it records the outcome rather than pretending either. */
  failed_code: string | null;
  /** F4: which mesh and agent a federated topic post came from, as a string to
   *  SHOW. Never routed on, never an ACL principal, never a metric label — it
   *  arrives from another mesh and is therefore attacker-supplied. null on
   *  every path that did not cross a border. */
  origin: string | null;
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
  cross_border: number; // F3: 1 = also sees frames crossing a border; 0 = local only
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

/**
 * F4 — the SAME migration one table over, and for the same reason.
 *
 * `subscriptions.agent_id` carried `REFERENCES agents(id) ON DELETE CASCADE`.
 * A remote subscriber is `pod1:alice`, which names no local agent, so the
 * foreign key would reject exactly the row federation exists to write. Every
 * database on disk still has that clause, and `CREATE TABLE IF NOT EXISTS`
 * does nothing to a table that already exists.
 *
 * DROPS ONE FOREIGN KEY, KEEPS THE OTHER. `topic REFERENCES topics(name) ON
 * DELETE CASCADE` stays: a subscription to a topic that no longer exists is
 * unusable by anybody, and nothing about federation changes that. The early
 * return is what makes the second boot a no-op, and it is written as "only the
 * topic FK remains" rather than "no FKs remain" — the acl version's
 * `length === 0` would loop forever here, rebuilding a table that is already
 * correct on every single boot.
 *
 * Everything else is rebuildAclFkLess, deliberately: the transaction guard, the
 * index capture and replay, the pragma outside / DDL inside split, the
 * restore-on-both-paths finally, and the fatal-on-error. Those choices were
 * each paid for once (see that function's comments for the measurements) and a
 * second, subtly different copy is how the pair drifts.
 */
export function rebuildSubscriptionsFkLess(db: Database): void {
  // Same reason as the acl rebuild: `PRAGMA foreign_keys = OFF` is a silent
  // no-op inside a transaction, so a future tidy-up that wrapped the migration
  // section would make the DROP/RENAME run under FK enforcement.
  if (db.inTransaction) {
    throw new Error('subscriptions rebuild must run outside a transaction: PRAGMA foreign_keys is ignored inside one');
  }

  try {
    const fks = db.prepare('PRAGMA foreign_key_list(subscriptions)').all() as { table: string }[];
    // Already in the target shape: exactly the topics FK and nothing else.
    if (fks.length === 1 && fks[0]!.table === 'topics') return;

    const indexDdl = (db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='subscriptions' AND sql IS NOT NULL"
    ).all() as { sql: string }[]).map((r) => r.sql);

    db.exec('PRAGMA foreign_keys = OFF');
    try {
      db.transaction(() => {
        db.exec(`
          CREATE TABLE subscriptions_new (
            agent_id      TEXT NOT NULL,
            topic         TEXT NOT NULL REFERENCES topics(name) ON DELETE CASCADE,
            subscribed_at INTEGER NOT NULL,
            PRIMARY KEY (agent_id, topic)
          );
        `);
        db.exec('INSERT INTO subscriptions_new SELECT agent_id, topic, subscribed_at FROM subscriptions');
        db.exec('DROP TABLE subscriptions');
        db.exec('ALTER TABLE subscriptions_new RENAME TO subscriptions');
        for (const ddl of indexDdl) db.exec(ddl);
      })();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }

    console.log(JSON.stringify({
      evt: 'db.subscriptions_rebuilt_fkless', indexes_restored: indexDdl.length, at: Date.now(),
    }));
  } catch (err) {
    process.stderr.write(`FATAL: subscriptions FK-less rebuild failed: ${err}\n`);
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

    -- F2a (SS4): OUTBOUND peerings -- the meshes WE relay to. A separate table
    -- from peers (who may relay to us) because the two directions are
    -- independent decisions by different admins; one row cannot mean both.
    --
    -- C7: token is a LIVE CREDENTIAL at rest. It is the only such value in this
    -- database -- every other secret is stored hashed -- so backups, dumps and
    -- exports of this file now carry something that grants access to a remote
    -- mesh. Never returned by a read API, never logged, never a metric label;
    -- exactly one production site reads it (the forwarder's auth).
    CREATE TABLE IF NOT EXISTS outbound_peers (
      alias          TEXT PRIMARY KEY,
      url            TEXT NOT NULL,
      token          TEXT NOT NULL, /* C7 — live credential, see above */
      assigned_alias TEXT NOT NULL,
      kinds          TEXT NOT NULL DEFAULT '["direct"]',
      rate_per_min   INTEGER NOT NULL DEFAULT 600,
      enabled        INTEGER NOT NULL DEFAULT 1,
      created_at     INTEGER NOT NULL,
      last_alive     INTEGER,
      last_responded INTEGER
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

    -- F4: agent_id is FK-LESS, for the same reason acl is (see the acl DDL
    -- above): a subscriber may be a REMOTE id like 'pod1:alice', which by
    -- definition has no agents(id) row, and a foreign key would make the table
    -- unable to express the thing F4 exists to express.
    --
    -- The referential guarantee MOVES rather than disappearing: deleteAgent
    -- deletes an agent's subscriptions explicitly, where a reviewer of deletion
    -- policy will find it, instead of a cascade doing it invisibly in DDL.
    --
    -- The TOPIC foreign key STAYS, with its cascade: a subscription to a topic
    -- that no longer exists is unusable by anyone, local or remote, and nothing
    -- about federation changes that. Written into the BASE table rather than
    -- left to the rebuild (§16 B) — otherwise every fresh database would be
    -- created FK-ful and immediately rebuilt on its first open.
    CREATE TABLE IF NOT EXISTS subscriptions (
      agent_id     TEXT NOT NULL,
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
      agent_id     TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      granted_at   INTEGER NOT NULL,
      granted_by   TEXT NOT NULL,
      -- F3: a SECOND grant, not a property of the first. An observer grant is
      -- category-phrased ("observers see everything"), so its scope is settled
      -- by what the system CONTAINS — federation widened it without anyone
      -- editing the grant. cross_border=0 means the observer sees local traffic
      -- only; frames crossing a border need this explicitly. Default 0, so an
      -- existing grant does NOT silently acquire the wider scope.
      cross_border INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Migration for existing databases: add new columns if they don't exist yet
  try { db.exec('ALTER TABLE files ADD COLUMN caption TEXT'); } catch {}
  try { db.exec('ALTER TABLE files ADD COLUMN reply_to_msg_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE files ADD COLUMN file_path TEXT'); } catch {}

  // Sprint 15 migration: per-reminder IANA timezone (null = UTC). Existing rows
  // get tz=NULL and keep behaving exactly as before (UTC cron).
  try { db.exec('ALTER TABLE reminders ADD COLUMN tz TEXT'); } catch {}

  // F4 migration: `origin` on messages — the display-only string naming which
  // mesh and agent a federated topic post came from. Existing rows get NULL,
  // which is the honest answer for every message that did not cross a border.
  try { db.exec('ALTER TABLE messages ADD COLUMN origin TEXT'); } catch {}

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

  // #133 migration: `last_responded` — proof the agent's LOOP is alive, as
  // distinct from its transport. Existing rows get NULL and stay NULL until
  // something writes it, which is the honest answer: the server half ships
  // before the emitter (spawner#346), and a roster showing `null` is better
  // than one showing a number that means something else.
  try { db.exec('ALTER TABLE agents ADD COLUMN last_responded INTEGER'); } catch {}

  // F3 migration: observer grants made before federation existed are LOCAL-ONLY.
  // The default is 0 rather than 1 on purpose — an operator who granted "see
  // everything" in a mesh with no borders did not consent to cross-border
  // traffic, and a migration that widened them would be the same silent
  // widening this column exists to stop.
  try { db.exec('ALTER TABLE observers ADD COLUMN cross_border INTEGER NOT NULL DEFAULT 0'); } catch {}

  // F2a migration: why a queued message can never be delivered. Set together
  // with expires_at = now on a PERMANENT remote refusal, so the row stops being
  // pending without pretending it was delivered.
  //
  // The house pattern — try/catch around ALTER — is not decoration: a bare
  // exec passes a migrate-once test and throws on the SECOND boot, which is
  // why the migration test opens the database twice.
  try { db.exec('ALTER TABLE messages ADD COLUMN failed_code TEXT'); } catch {}

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
  rebuildSubscriptionsFkLess(db);

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
 * #133 — stamp proof that the agent's LOOP responded, not its transport.
 *
 * WHY A THIRD FIELD RATHER THAN FIXING last_alive. The keepalive that advances
 * last_alive is answered by the mesh PLUGIN, which is a separate process with
 * its own WebSocket client. It keeps ponging while the agent's loop is stuck:
 * measured on 2026-09-06, an agent wedged for 55 minutes had a last_alive fresh
 * to the second. last_alive is not wrong — it truthfully reports that the
 * transport is alive. It is read as something it never claimed.
 *
 * So last_alive keeps its name and its meaning and nothing is renamed to hide
 * the difference; a fourth reading is added instead. `online` = has a socket,
 * `last_seen` = last acted, `last_alive` = transport answered,
 * `last_responded` = the loop emitted something only the loop can emit.
 *
 * THIS IS THE CANONICAL DEFINITION. README's presence section expands it for
 * operators — deliberately an expansion, not a copy, because prose for a reader
 * mid-incident needs more than a four-clause sentence. If the model changes,
 * change it here first; the README then follows.
 *
 * WHAT THE SERVER CAN AND CANNOT VERIFY, stated because the field is only worth
 * what this sentence says. The server cannot tell a loop-originated frame from
 * one the transport synthesised — it sees a socket and bytes. `last_responded`
 * is therefore a CLAIM BY THE EMITTER, exactly like turn_status: it is only as
 * true as the plugin's discipline in emitting it from the turn loop rather than
 * from a timer. The server's job is to keep the claim distinguishable from the
 * transport's, not to authenticate it.
 */
export function touchResponded(db: Database, id: string): void {
  db.prepare('UPDATE agents SET last_responded = ? WHERE id = ?').run(Date.now(), id);
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

/**
 * #91 — DELETING AN AGENT REMOVES THE IDENTITY, NOT THE HISTORY.
 *
 * `messages` and `files` carry no REFERENCES on their agent columns, so every
 * row naming a deleted agent used to survive as an orphan — including `files`
 * rows whose bytes stayed on disk forever, since no sweep reaches them once
 * they are delivered.
 *
 * That is a semantics question before it is a fix, and the answer for MESSAGES
 * AND FILES is: purge only what CAN NEVER BE USED. Rows addressed to the
 * deleted id and never delivered can never be delivered now — pure waste, and
 * for files, leaked bytes. Everything else is also THE OTHER PARTY'S history of
 * that conversation, and destroying it here would take it out from under
 * MESH_RETENTION_MS, which is the thing that is supposed to govern how long
 * history lives.
 *
 * WHAT ELSE THIS DELETES, stated exactly, because the rule above does not cover
 * it and reading it as if it did would be wrong (seat 1 on #159):
 *
 *   - Every acl edge naming the id, in both directions. Not tidiness: an id can
 *     be registered again, and without this the new holder INHERITS its
 *     predecessor's grants. Measured with the line removed — 2 rows before, 2
 *     after, and aclCheck true both ways for a re-registered id.
 *   - Every topic the agent CREATED — and, through
 *     `subscriptions.topic REFERENCES topics(name) ON DELETE CASCADE`, every
 *     other agent's subscriptions to those topics. Those subscriptions WERE
 *     usable, so this is the one place the rule above overstates. Pre-existing
 *     and kept deliberately; pinned by a test so it is a choice on record
 *     rather than a surprise.
 *
 * The topics line is also not optional cleanup: `topics.created_by REFERENCES
 * agents(id)` has no ON DELETE clause, so with it removed, deleting an agent
 * that ever created a topic FAILS with SQLITE_CONSTRAINT_FOREIGNKEY rather than
 * leaving an orphan (measured). It is what makes the delete possible at all.
 *
 * NO FOREIGN-KEY CASCADE, deliberately, and it is the same argument the acl
 * deletion below already carries: a cascade would take the purge-EVERYTHING
 * branch of this decision silently, in DDL, where nobody reviewing what
 * deleting an agent destroys would think to look. A schema constraint must not
 * decide a semantics question.
 *
 * PREDICATE: `to_agent = ? AND delivered_at IS NULL`. Equality excludes NULL by
 * construction, which matters because the schema permits a NULL `to_agent`
 * even though no writer produces one today.
 *
 * THE FORM TO AVOID IS AN EXPLICIT `OR to_agent IS NULL`, not a negated one —
 * measured, because the issue's note says the opposite and I nearly wrote it
 * down as fact. Against a table holding a NULL row, a `doomed` row and a
 * `bystander` row:
 *
 *     to_agent = 'doomed'            -> [match]
 *     NOT (to_agent != 'doomed')     -> [match]        <- same, not a hazard
 *     to_agent NOT IN ('bystander')  -> [match]        <- same, not a hazard
 *     (to_agent = 'doomed' OR to_agent IS NULL) -> [null-row, match]  <- HAZARD
 *
 * Three-valued logic makes the negated forms NULL-safe in the SAME direction
 * as equality: `to_agent != x` is NULL for a NULL row, and `NOT NULL` is NULL,
 * which is not true, so the row is not matched. The way a NULL row gets swept
 * in is by someone adding the OR deliberately, which is what the test pins.
 *
 * (The issue's note says stored TOPIC rows have a NULL `to_agent` and that the
 * equality form is what protects them. Measured against the tree: they do not
 * — routePublish persists per-subscriber copies with `to_agent = subscriber_id`
 * on both the online and offline paths, and no writer in the tree produces a
 * NULL. The note's premise appears to come from `buildDeliverFrame`, the WIRE
 * frame, which does carry `to_agent: null` twelve lines from the insert that
 * does not. The predicate is right regardless; what changes is that an
 * undelivered topic COPY addressed to the deleted agent IS purged, which is
 * correct — a per-subscriber copy for an identity that no longer exists can
 * never be delivered. Pinned as its own test rather than left implicit.)
 *
 * RETURNS THE PURGED FILE PATHS so the caller unlinks AFTER the rows are gone
 * (#85's ordering, same as deleteExpiredFiles): a crash between the two leaves
 * an orphan file, which is recoverable, never a row pointing at missing bytes,
 * which reads as corruption. This function touches no filesystem — that is
 * what makes the wrong order unrepresentable here rather than merely avoided.
 *
 * ATOMIC, which the multi-statement version was not. BEYOND THE BRIEF and
 * called out as such: it mattered less when this deleted only acl and topics,
 * but a partial failure now leaves an agent still live with its pending mail
 * destroyed. The unlink stays outside, after the commit.
 */
export function deleteAgent(db: Database, id: string): string[] {
  const tx = db.transaction(() => {
    // Files first, so the paths are captured inside the same transaction that
    // removes the rows.
    const purged = db.prepare(
      `DELETE FROM files
       WHERE to_agent = ? AND delivered_at IS NULL
       RETURNING file_path`
    ).all(id) as { file_path: string }[];

    db.prepare('DELETE FROM messages WHERE to_agent = ? AND delivered_at IS NULL').run(id);

    // F4: the subscriptions cascade on agent_id is GONE (the column is FK-less
    // so a remote id can be stored), so the deletion is explicit here — the
    // same argument as the acl line below, one table over. Before the topics
    // delete, because that one cascades to subscriptions by TOPIC and the two
    // are different predicates: this removes what the agent subscribed TO, that
    // removes who subscribed to what the agent CREATED.
    db.prepare('DELETE FROM subscriptions WHERE agent_id = ?').run(id);

    db.prepare('DELETE FROM topics WHERE created_by = ?').run(id);
    // F0a: was an ON DELETE CASCADE on acl's foreign keys. Now explicit, because
    // the table is FK-less (see the acl DDL) — and because a cascade performed
    // this deletion invisibly, in DDL, where nobody reviewing what deleting an
    // agent destroys would think to look.
    db.prepare('DELETE FROM acl WHERE from_agent = ? OR to_agent = ?').run(id, id);
    db.prepare('DELETE FROM agents WHERE id = ?').run(id);

    return purged.map(r => r.file_path);
  });
  return tx() as string[];
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
/**
 * F4 — the LOCAL TOPIC PRINCIPAL prefix.
 *
 * `topic:trollbox` names a topic as an ACL principal, so a hub can express
 * "this topic may be heard by pod1:sub" and "pod1:publisher may post to this
 * topic" as ordinary acl edges rather than as a second grammar.
 *
 * It is deliberately in the SAME namespace shape as a remote id — one colon,
 * a reserved prefix — which is why the alias `topic` is refused at both peering
 * doors (`http-admin.ts` `handlePeerKeyPost`, `handleOutboundPeerPost`). The
 * exemption below and that reservation are two halves of one decision: with the
 * exemption alone, a peering called `topic` would make every topic principal
 * read as remote and a revocation's prefix-range DELETE would take them all.
 */
export const TOPIC_PRINCIPAL_PREFIX = 'topic:';

/**
 * F4 — the ONE definition of "this endpoint names another mesh".
 *
 * Was a closure inside assertPeeringAllowed. Exported and named because F4 adds
 * a second caller (the topic fan-out must skip remote subscribers) and two
 * copies of a routing predicate is one predicate and one hole waiting to open —
 * #79's argument, applied to a rule instead of to a credential compare.
 *
 * The AGENT LOOKUP is what distinguishes a remote id from a legacy local one:
 * a colon alone is not decisive, because legacy colon ids are a preserved
 * population (reported at boot, never rejected).
 *
 * A TOPIC PRINCIPAL IS NEITHER remote nor an agent. It is local by
 * construction, and returning true for it would demand a peering aliased
 * `topic`, which can never exist.
 */
export function isRemoteEndpoint(db: Database, endpoint: string): boolean {
  if (endpoint.startsWith(TOPIC_PRINCIPAL_PREFIX)) return false;
  return endpoint.includes(':') && getAgentById(db, endpoint) === null;
}

function assertPeeringAllowed(db: Database, from_agent: string, to_agent: string): void {
  const fail = (msg: string): never => {
    const err = new Error(msg) as Error & { code?: string };
    err.code = 'NO_PEERING';
    throw err;
  };
  const fromRemote = isRemoteEndpoint(db, from_agent);
  const toRemote = isRemoteEndpoint(db, to_agent);

  if (fromRemote) {
    const alias = from_agent.slice(0, from_agent.indexOf(':'));
    if (!hasInboundPeer(db, alias)) fail(`no inbound peering for ${alias}`);
  }
  if (toRemote) {
    const alias = to_agent.slice(0, to_agent.indexOf(':'));
    if (!hasOutboundPeer(db, alias)) fail(`no outbound peering for ${alias}`);
  }
}

/**
 * Grant an ACL edge.
 *
 * ENDPOINTS ARE NOT VALIDATED AGAINST THE REMOTE-ID GRAMMAR, BY DESIGN.
 * `POST /acl {to_agent:"b:legacy:node"}` succeeds while routeDirect refuses to
 * send there — untidy, and deliberately left that way.
 *
 * The reason is directly below: `assertLocalEndpointExists` returns early on
 * ANY ':' because legacy colon ids are a PRESERVED POPULATION, reported at boot
 * and never rejected, and `assertPeeringAllowed` records the reproduced case
 * where treating ':' as decisive refused two ordinary local agents. Nothing
 * bounds a legacy id to one colon — only NEW ids are refused a ':' at
 * POST /agents — so a grammar check here could refuse a grant for a legitimate
 * local agent. That is the defect these comments exist to prevent, traded for
 * tidiness.
 *
 * THE SEND PATH IS THE DOOR. routeDirect answers a malformed remote id with the
 * same uniform AGENT_NOT_FOUND as any other unroutable target, so nothing is
 * reachable that would not be reachable anyway; the only cost is an operator
 * who typed it wrong finding out later. docs/FEDERATION.md's troubleshooting
 * list tells them to check that a remote id has exactly one ':'.
 */
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
  // Selected as a column rather than moved into the WHERE deliberately (#109):
  // the AMBIGUITY check must still see EVERY row sharing this hash, live or not.
  //
  // With liveness in the WHERE, one live + one revoked key sharing a hash
  // returns ONE row, the ambiguity branch never fires, and THE LIVE KEY
  // AUTHENTICATES — the refusal and the only signal of the collision are both
  // destroyed. Not "half hidden": a fail-closed check silently narrowed by a
  // change that looks like applying the rule.
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
    // F4: and their subscriptions go too. Disabling the peer stops traffic;
    // it does not stop a re-mint for the same alias inheriting the rows.
    // Edge deletion on revoke is deliberately NOT moved here by F4 — that is a
    // separate decision with its own history (#113).
    for (const { alias } of db.prepare('SELECT alias FROM peers WHERE minted_by_key = ?')
      .all(id) as { alias: string }[]) {
      deleteRemoteSubscriptions(db, alias);
    }
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
export function hasOutboundPeer(db: Database, alias: string): boolean {
  // TABLE READ: outbound_peers. Total for the outbound question because a
  // peering we relay TO exists iff an admin created a row here — there is no
  // other writer, and an inbound `peers` row says nothing about whether we may
  // send. Enabled-only: a PATCH-disabled peering is paused, not deleted, and a
  // paused peering must not accept new edges.
  const row = db.prepare('SELECT 1 FROM outbound_peers WHERE alias = ? AND enabled = 1').get(alias);
  return row !== null;
}

export interface OutboundPeer {
  alias: string;
  url: string;
  /** C7 — LIVE CREDENTIAL. Never returned by a read API, never logged, never a
   *  metric label. Exactly one production site reads it: the forwarder's auth. */
  token: string;
  assigned_alias: string;
  kinds: string;
  rate_per_min: number;
  enabled: number;
  created_at: number;
  last_alive: number | null;
}

export function insertOutboundPeer(
  db: Database,
  row: {
    alias: string; url: string; token: string; assigned_alias: string;
    kinds: string; rate_per_min: number; created_at: number;
  }
): OutboundPeer {
  db.prepare(`
    INSERT INTO outbound_peers (alias, url, token, assigned_alias, kinds, rate_per_min, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(row.alias, row.url, row.token, row.assigned_alias, row.kinds, row.rate_per_min, row.created_at);
  return getOutboundPeer(db, row.alias)!;
}

export function getOutboundPeer(db: Database, alias: string): OutboundPeer | null {
  return db.prepare('SELECT * FROM outbound_peers WHERE alias = ?').get(alias) as OutboundPeer | null;
}

export function listOutboundPeers(db: Database): OutboundPeer[] {
  return db.prepare('SELECT * FROM outbound_peers ORDER BY alias').all() as OutboundPeer[];
}

/** Enabled outbound peerings, for the forwarder set at boot. */
/**
 * F2b: the forwarder's DRAIN query — rows queued for one outbound peering.
 *
 * RANGE, not LIKE. `to_agent >= 'alias:' AND to_agent < 'alias;'` (';' is ':'
 * plus one) is served by idx_messages_to_agent; a LIKE pattern full-scans, and
 * an alias containing % or _ would also change what it matches. A test asserts
 * the plan SEARCHes that index and contains no SCAN — the ORDER BY's temp
 * b-tree is expected and is not a failure.
 *
 * `sent_at >= now - RELAY_DEDUPE_MS` because the RECEIVER forgets a remote
 * msg_id after that window: re-sending an older row would be delivered twice,
 * once now and once by whatever already arrived. The two bounds are the same
 * constant on purpose, and a row past it is expired rather than sent.
 */
/**
 * The drain SQL, EXPORTED so the EXPLAIN test can analyse THE QUERY THAT RUNS.
 *
 * It was a copy: the test EXPLAINed an inline duplicate while drainOutbound
 * held the real one. Mutating drainOutbound alone to a LIKE pattern turned the
 * index seek into a full SCAN of `messages` on every enqueue and every backstop
 * tick — and the test stayed green, because it was pinning a string that never
 * executes.
 *
 * This is (g)'s own argument turned on the test that asserts it: two copies of
 * a query is one query and one hole, and here the hole was the one under test.
 */
export const DRAIN_OUTBOUND_SQL =
  `SELECT * FROM messages
   WHERE to_agent >= ? AND to_agent < ?
     AND delivered_at IS NULL
     AND failed_code IS NULL
     AND (expires_at IS NULL OR expires_at >= ?)
     AND sent_at >= ?
   ORDER BY sent_at LIMIT ?`;

export function drainOutbound(
  db: Database,
  alias: string,
  now: number,
  dedupeMs: number,
  limit: number
): Message[] {
  return db.prepare(DRAIN_OUTBOUND_SQL)
    .all(`${alias}:`, `${alias};`, now, now - dedupeMs, limit) as Message[];
}

/** Rows past the receiver's dedupe window: undeliverable, so expired rather
 *  than sent. Same now-1 reason as endOutboundPeering — the pending predicate
 *  is `expires_at >= now`, so exactly `now` would still read as deliverable. */
export function expireStaleOutbound(db: Database, alias: string, now: number, dedupeMs: number): number {
  return db.prepare(
    `UPDATE messages SET expires_at = ?
     WHERE to_agent >= ? AND to_agent < ?
       AND delivered_at IS NULL AND failed_code IS NULL
       AND sent_at < ?
       AND (expires_at IS NULL OR expires_at >= ?)`
  ).run(now - 1, `${alias}:`, `${alias};`, now - dedupeMs, now).changes;
}

/** A permanent remote refusal: the row can never be delivered, and says why. */
export function markMessageFailed(db: Database, id: string, code: string, now: number): void {
  db.prepare('UPDATE messages SET failed_code = ?, expires_at = ? WHERE id = ?').run(code, now - 1, id);
}

export function listEnabledOutboundPeers(db: Database): OutboundPeer[] {
  return db.prepare('SELECT * FROM outbound_peers WHERE enabled = 1 ORDER BY alias').all() as OutboundPeer[];
}

export function updateOutboundPeer(
  db: Database,
  alias: string,
  patch: { enabled?: boolean; token?: string; url?: string; rate_per_min?: number }
): boolean {
  const sets: string[] = [];
  const args: (string | number)[] = [];
  if (patch.enabled !== undefined) { sets.push('enabled = ?'); args.push(patch.enabled ? 1 : 0); }
  if (patch.token !== undefined) { sets.push('token = ?'); args.push(patch.token); }
  if (patch.url !== undefined) { sets.push('url = ?'); args.push(patch.url); }
  if (patch.rate_per_min !== undefined) { sets.push('rate_per_min = ?'); args.push(patch.rate_per_min); }
  if (sets.length === 0) return getOutboundPeer(db, alias) !== null;
  args.push(alias);
  return db.prepare(`UPDATE outbound_peers SET ${sets.join(', ')} WHERE alias = ?`).run(...args).changes > 0;
}

/**
 * END an outbound peering — §5.6, and the ONLY place that decides what "ended"
 * means. ONE transaction, three effects that must not be separable:
 *
 *   1. the peering stops (row deleted, or enabled = 0 for a non-DELETE caller);
 *   2. every UNDELIVERED row addressed to alias:* is expired (expires_at = now);
 *   3. the alias's OUTBOUND acl edges are removed (#113's helper, other direction).
 *
 * (2) is the one that is easy to miss and expensive to omit. This is the ONLY
 * moment anyone knows those rows are undeliverable: the sender was acked (D8),
 * the row is pending, and a ttl-less row would otherwise sit in the queue
 * forever waiting for a forwarder that is never coming back. A DOWN peering is
 * a different thing — it is expected to return, and its rows must survive.
 *
 * Called by DELETE /outbound-peers (an operator ending it) and, in F2b, by the
 * forwarder on a FATAL AUTH_FAILED — receiver-side revocation, the door where
 * nobody typed a command and the less observable of the two.
 *
 * PATCH {enabled:false} deliberately does NOT call this: pausing is reversible
 * and keeps both rows and edges. Ending and pausing are different operations,
 * not two spellings of one.
 */
export function endOutboundPeering(
  db: Database,
  alias: string,
  reason: string,
  opts: { delete?: boolean } = {}
): { expired: number; edges: number } {
  const tx = db.transaction(() => {
    const now = Date.now();
    if (opts.delete === true) {
      db.prepare('DELETE FROM outbound_peers WHERE alias = ?').run(alias);
    } else {
      db.prepare('UPDATE outbound_peers SET enabled = 0 WHERE alias = ?').run(alias);
    }
    // Prefix range, not LIKE — index-servable and immune to % or _ in an alias.
    //
    // `now - 1`, not `now`, and the off-by-one is deliberate. Every "still
    // deliverable" predicate in this file is `expires_at >= now` (pending
    // counts, the retention sweep's exclusion), while every "has expired" one
    // is `expires_at < now`. A row stamped with exactly `now` is therefore
    // still PENDING until the clock moves — a brief but real lie about a row
    // nobody can deliver, and one that made the deterministic test for this
    // function fail. Strictly-before is what "undeliverable from this instant"
    // actually requires.
    const expired = db.prepare(
      `UPDATE messages SET expires_at = ?
       WHERE to_agent >= ? AND to_agent < ?
         AND delivered_at IS NULL
         AND (expires_at IS NULL OR expires_at >= ?)`
    ).run(now - 1, `${alias}:`, `${alias};`, now).changes;
    const edges = deletePeeringEdges(db, alias, 'outbound');
    return { expired, edges };
  });
  const result = tx() as { expired: number; edges: number };
  console.log(JSON.stringify({
    evt: 'outbound_peering.ended', alias, reason,
    expired_rows: result.expired, removed_edges: result.edges, at: Date.now(),
  }));
  return result;
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
      // F4: subscriptions end with the peering for the same reason the edges
      // do — a new key may be minted for the same alias, and a subscription
      // that outlived its peering would silently belong to whoever next holds
      // the name.
      const removedSubscriptions = deleteRemoteSubscriptions(db, peer.alias);
      console.log(JSON.stringify({
        evt: 'peer.edges_ended_with_peering', alias: peer.alias, removed,
        removed_subscriptions: removedSubscriptions,
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
    /** F4: display-only provenance. Defaults to null, so every existing caller
     *  writes exactly what it wrote before. */
    origin?: string | null;
  }
): Message {
  const content_type = msg.content_type ?? 'text/plain';
  const to_agent = msg.to_agent ?? null;
  const topic = msg.topic ?? null;
  const correlation_id = msg.correlation_id ?? null;
  const expires_at = msg.expires_at ?? null;
  const origin = msg.origin ?? null;

  db.prepare(`
    INSERT INTO messages (id, kind, from_agent, to_agent, topic, correlation_id, payload, content_type, sent_at, expires_at, delivered_at, acked_at, origin)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `).run(msg.id, msg.kind, msg.from_agent, to_agent, topic, correlation_id, msg.payload, content_type, msg.sent_at, expires_at, origin);

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
       AND NOT (delivered_at IS NULL AND failed_code IS NULL AND (expires_at IS NULL OR expires_at >= ?))`
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
  // F2a: a row with failed_code is NOT pending. A permanent remote refusal set
  // it together with expires_at = now, so the expiry clause alone would already
  // exclude it — the explicit condition is here because "not pending" must not
  // depend on two writes having stayed in step. If a future path sets
  // failed_code without expiring the row, this query is still right.
  return (db.prepare(
    `SELECT COUNT(*) AS c FROM messages
     WHERE delivered_at IS NULL AND failed_code IS NULL
       AND (expires_at IS NULL OR expires_at >= ?)`
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

/**
 * F4 §7 — DID THIS CREATE A ROW? The single writer, and the boolean is the
 * point.
 *
 * The SDK replays every subscription on reconnect (client.ts, the replay loop
 * after auth), so without a "was anything created" answer a remote subscribe
 * would enqueue a border row on every reconnect — telling the hub something it
 * already knows and burning a token from the peering's rate bucket, which a
 * flapping spoke would turn into rate-limited direct traffic.
 */
export function subscribeCreated(db: Database, agent_id: string, topic: string): boolean {
  return db.prepare('INSERT OR IGNORE INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?, ?, ?)')
    .run(agent_id, topic, Date.now()).changes === 1;
}

/** F4 §7 — the twin of subscribeCreated: did this REMOVE a row? Teardown rows
 *  are enqueued only when there was something to tear down. */
export function unsubscribeRemoved(db: Database, agent_id: string, topic: string): boolean {
  return db.prepare('DELETE FROM subscriptions WHERE agent_id = ? AND topic = ?')
    .run(agent_id, topic).changes === 1;
}

export function subscribe(db: Database, agent_id: string, topic: string): Subscription {
  subscribeCreated(db, agent_id, topic);
  return db.prepare('SELECT * FROM subscriptions WHERE agent_id = ? AND topic = ?')
    .get(agent_id, topic) as Subscription;
}

export function unsubscribe(db: Database, agent_id: string, topic: string): void {
  unsubscribeRemoved(db, agent_id, topic);
}

/**
 * F4 §7 — is this an existing topic on THIS mesh's `topics` table?
 *
 * Row existence only. Whether it is a HOME topic (ours to fan out) or a remote
 * one we merely mirror is a different question, answered by the prefix test in
 * `isHomeTopic` — a spoke really does hold a local `topics` row named
 * `orch:trollbox`, so row existence cannot decide ownership.
 */
export function topicExists(db: Database, name: string): boolean {
  return db.prepare('SELECT 1 FROM topics WHERE name = ?').get(name) !== null;
}

/**
 * F4 §7 — may a NEW topic take this name?
 *
 * Returns a reason, or null to permit. Two rules, both about NEW names only:
 *
 *   ':' — the mesh/agent separator. A local topic `a:b` is indistinguishable
 *         from a remote topic on a mesh aliased `a`, and the moment an outbound
 *         peering `a` exists, `isHomeTopic` calls it foreign and stops fanning
 *         it out locally. The topic would go quiet with nothing reporting why.
 *   256 bytes — the same bound the wire applies to every other identifier, so a
 *         name that cannot cross a border cannot be created either. Measured in
 *         BYTES, not characters: a 200-character name of 2-byte codepoints is
 *         400 bytes on the wire.
 *
 * PRE-EXISTING NAMES ARE NEVER REJECTED — the F0b rule that spared legacy colon
 * agent ids, for the same reason: a live topic that can no longer be published
 * to is a worse outcome than an ambiguous name, and only the operator can
 * decide to rename it. They are surfaced by `findInvalidTopicNames` at boot.
 */
export function topicNameRefusal(db: Database, name: string): string | null {
  if (topicExists(db, name)) return null;
  if (name.includes(':')) return "topic name must not contain ':'";
  if (Buffer.byteLength(name, 'utf8') > 256) return 'topic name must be at most 256 bytes';
  return null;
}

/**
 * F4 §7, §16 M — boot report: topic names that predate the rules above.
 *
 * A colon name is only ambiguous if its prefix names NO outbound peering; when
 * it does, `orch:trollbox` is exactly what a mirrored remote topic is called
 * and reporting it would be noise.
 *
 * The peering lookup deliberately has NO `enabled` filter (§16 M): pausing a
 * peering is an operator action that must not turn that mesh's topics into boot
 * warnings. A paused link is still a configured one.
 */
export function findInvalidTopicNames(db: Database): string[] {
  return (db.prepare(`
    SELECT name FROM topics
    WHERE (name LIKE '%:%' AND substr(name, 1, instr(name, ':') - 1) NOT IN (SELECT alias FROM outbound_peers))
       OR length(CAST(name AS BLOB)) > 256
  `).all() as { name: string }[]).map(r => r.name);
}

/**
 * F4 §7 — boot report: agent ids inside the reserved `topic:` range.
 *
 * `POST /agents` has refused any ':' since F0b, so such an id can only predate
 * that rule — which is why this reports rather than guards. A prefix RANGE, not
 * `LIKE 'topic%'`: the latter would also catch `topics-team`, an ordinary id
 * that is none of this rule's business. (';' is ':' + 1.)
 */
export function findTopicPrefixAgents(db: Database): string[] {
  return (db.prepare("SELECT id FROM agents WHERE id >= 'topic:' AND id < 'topic;' ORDER BY id")
    .all() as { id: string }[]).map(r => r.id);
}

export function getTopicSubscribers(db: Database, topic: string): string[] {
  const rows = db.prepare('SELECT agent_id FROM subscriptions WHERE topic = ?').all(topic) as { agent_id: string }[];
  return rows.map(r => r.agent_id);
}

/**
 * F4 §7 — the subscribers on ONE peered mesh for one topic.
 *
 * A PREFIX RANGE, not `LIKE 'alias:%'`: index-servable, and it cannot be
 * confused by a '%' or '_' inside an alias. (';' is ':' + 1 — the same idiom as
 * `deletePeeringEdges`.)
 */
export function listRemoteSubscribers(db: Database, alias: string, topic: string): string[] {
  return (db.prepare(
    'SELECT agent_id FROM subscriptions WHERE topic = ? AND agent_id >= ? AND agent_id < ? ORDER BY agent_id'
  ).all(topic, `${alias}:`, `${alias};`) as { agent_id: string }[]).map(r => r.agent_id);
}

/**
 * F4 §7 — every subscription a peered mesh holds here, for `GET
 * /peers/:alias/subscriptions`. The operator-facing answer to "why is this pod
 * not receiving?", which is otherwise only visible in the database.
 */
export function listPeerSubscriptions(
  db: Database, alias: string,
): { agent_id: string; topic: string; subscribed_at: number }[] {
  return db.prepare(
    `SELECT agent_id, topic, subscribed_at FROM subscriptions
     WHERE agent_id >= ? AND agent_id < ? ORDER BY topic, agent_id`
  ).all(`${alias}:`, `${alias};`) as { agent_id: string; topic: string; subscribed_at: number }[];
}

/**
 * F4 §7 — remove every subscription a peered mesh holds here.
 *
 * Called where a peering ENDS, for the same reason `deletePeeringEdges` is: a
 * new key may be minted for the same alias, and a subscription that outlived
 * its peering would silently belong to whoever next holds the name.
 */
export function deleteRemoteSubscriptions(db: Database, alias: string): number {
  return db.prepare('DELETE FROM subscriptions WHERE agent_id >= ? AND agent_id < ?')
    .run(`${alias}:`, `${alias};`).changes;
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
  // #70: normalise at the CHOKEPOINT, not at each caller. Every path that
  // stores a file goes through here — including the ones that do not exist
  // yet, which is the whole reason ingest-safety is worth having on top of
  // #68's serving-safety. See server/file-hygiene.ts for what is stripped and
  // what is deliberately kept.
  const filename = safeFilename(file.filename);
  const content_type = safeContentType(file.content_type);
  const caption = file.caption ?? null;
  const reply_to_msg_id = file.reply_to_msg_id ?? null;
  const group_id = file.group_id ?? null;

  db.prepare(`
    INSERT INTO files (id, from_agent, to_agent, filename, content_type, size_bytes, file_path, sent_at, expires_at, delivered_at, caption, reply_to_msg_id, group_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
  `).run(file.id, file.from_agent, file.to_agent, filename, content_type, file.size_bytes, file.file_path, file.sent_at, file.expires_at, caption, reply_to_msg_id, group_id);

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

export function grantObserver(
  db: Database,
  agent_id: string,
  granted_by: string,
  cross_border = false,
): Observer {
  const now = Date.now();
  // A re-grant OVERWRITES cross_border with what this call asked for, rather
  // than OR-ing it in: a grant is a statement of the intended scope, so a
  // caller that omits the wider scope is asking for the narrower one. Silently
  // keeping a previously-granted cross_border would make the scope a ratchet
  // that no re-grant can tighten.
  db.prepare(`
    INSERT INTO observers (agent_id, granted_at, granted_by, cross_border)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      granted_at = excluded.granted_at,
      granted_by = excluded.granted_by,
      cross_border = excluded.cross_border
  `).run(agent_id, now, granted_by, cross_border ? 1 : 0);
  return db.prepare('SELECT * FROM observers WHERE agent_id = ?').get(agent_id) as Observer;
}

/**
 * The set of observers permitted to see frames that cross a border.
 *
 * TABLE READ: `observers` — total for this question, because the cross-border
 * grant has exactly one home. It is deliberately NOT joined against `agents`
 * or the live index: an id here that is not currently connected simply never
 * matches during fan-out, and membership must not depend on connectivity.
 */
export function listCrossBorderObservers(db: Database): Set<string> {
  const rows = db.prepare('SELECT agent_id FROM observers WHERE cross_border = 1').all() as { agent_id: string }[];
  return new Set(rows.map(r => r.agent_id));
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

// #79: the private hashToken/timingSafeEqual copies that lived here are gone.
//
// They were BYTE-IDENTICAL to the exported pair in auth.ts, which is the whole
// problem: a security primitive with two homes means a fix applied to one leaves
// the other silently unchanged, and the copy nobody remembers is the one that
// stays weak. This file's callers — getAgentByToken and getPeerKeyBySecret —
// now use the same helper as every other door.
