import { Database } from 'bun:sqlite';

/**
 * #187 — insert an agent row that the CURRENT rules would refuse.
 *
 * `registerAgent` now enforces the character grammar (no ':' among the rest),
 * so a legacy colon id cannot be minted through it any more. The tests that
 * need one are testing exactly that: a row which PREDATES the rule, and which
 * `isRemoteEndpoint` must still treat as local. Creating it through the door
 * that refuses it was never the faithful fixture — a legacy row exists in the
 * table, not in the door's history — so it is written directly here.
 *
 * ONE helper rather than three raw INSERTs, so the schema knowledge sits in a
 * single place and a column change breaks one file.
 */
export function insertLegacyAgent(
  db: Database,
  agent: { id: string; token_hash: string; hostname: string },
): void {
  const now = Date.now();
  db.prepare(`
    INSERT INTO agents (id, token_hash, hostname, capabilities, metadata, namespace, registered_at, last_seen, online)
    VALUES (?, ?, ?, '[]', '{}', NULL, ?, ?, 0)
  `).run(agent.id, agent.token_hash, agent.hostname, now, now);
}
