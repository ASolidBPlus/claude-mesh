import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, writeFileSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import * as net from 'net';
import {
  openDb, registerAgent, deleteAgent, insertMessage, markDelivered,
  insertFile, markFileDelivered, getFile, queryMessages,
  aclGrant, aclCheck, getOrCreateTopic,
} from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';

// #91 — deleting an agent removes the IDENTITY, not the HISTORY.
//
// messages and files carry no REFERENCES on their agent columns, so every row
// naming a deleted agent survived as an orphan — files rows included, with
// their bytes on disk forever, since no sweep reaches a delivered file.
//
// The decision (issue #91): purge only what can never be used — rows addressed
// TO the deleted id and never delivered. Everything else is also the OTHER
// party's history, and destroying it here takes it out from under
// MESH_RETENTION_MS, which is what is supposed to govern how long history
// lives.

const ADMIN = 'admin-secret';

describe('#91 deleteAgent purges the unusable, keeps the history', () => {
  let db: Database;
  let filesDir: string;
  let handle: HttpAdminHandle;
  let base: string;

  const now = () => Date.now();

  /** A real file on disk plus its row, so "the bytes are gone" is a filesystem
   *  fact rather than a row property. */
  const seedFile = (id: string, from: string, to: string, delivered: boolean): string => {
    const path = join(filesDir, `${id}.bin`);
    writeFileSync(path, 'bytes');
    insertFile(db, {
      id, from_agent: from, to_agent: to, filename: `${id}.bin`,
      content_type: 'application/octet-stream', size_bytes: 5, file_path: path,
      sent_at: now(), expires_at: null,
    });
    if (delivered) markFileDelivered(db, id);
    return path;
  };

  beforeEach(async () => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-91-'));
    for (const id of ['doomed', 'other', 'bystander']) {
      registerAgent(db, { id, token_hash: hashToken(`tok-${id}`), hostname: 'h' });
    }
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, filesDir, new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const ids = (rows: { id: string }[]) => rows.map(r => r.id).sort();
  const aclRowsNaming = (id: string) =>
    (db.prepare('SELECT COUNT(*) c FROM acl WHERE from_agent = ? OR to_agent = ?').get(id, id) as { c: number }).c;
  const topicCount = () => (db.prepare('SELECT COUNT(*) c FROM topics').get() as { c: number }).c;
  const subsFor = (id: string) =>
    (db.prepare('SELECT COUNT(*) c FROM subscriptions WHERE agent_id = ?').get(id) as { c: number }).c;
  const allMessageIds = () => ids(db.prepare('SELECT id FROM messages').all() as { id: string }[]);

  // ── messages ───────────────────────────────────────────────────────────────

  it('purges undelivered mail addressed TO the deleted agent, and nothing else', () => {
    insertMessage(db, { id: 'm-undelivered-to', kind: 'direct', from_agent: 'other', to_agent: 'doomed', payload: 'never arrives', sent_at: now() });
    insertMessage(db, { id: 'm-delivered-to', kind: 'direct', from_agent: 'other', to_agent: 'doomed', payload: 'arrived', sent_at: now() });
    markDelivered(db, 'm-delivered-to');
    insertMessage(db, { id: 'm-from-delivered', kind: 'direct', from_agent: 'doomed', to_agent: 'other', payload: 'sent and read', sent_at: now() });
    markDelivered(db, 'm-from-delivered');
    // Undelivered but addressed to a LIVE agent: still deliverable, and the
    // sender being gone does not change that.
    insertMessage(db, { id: 'm-from-undelivered', kind: 'direct', from_agent: 'doomed', to_agent: 'other', payload: 'still deliverable', sent_at: now() });
    insertMessage(db, { id: 'm-unrelated', kind: 'direct', from_agent: 'other', to_agent: 'bystander', payload: 'nothing to do with it', sent_at: now() });

    // POSITIVE CONTROL: all five exist before the delete, so "gone" below is a
    // deletion and not a fixture that never landed.
    expect(allMessageIds()).toEqual([
      'm-delivered-to', 'm-from-delivered', 'm-from-undelivered', 'm-undelivered-to', 'm-unrelated',
    ]);

    deleteAgent(db, 'doomed');

    // Exactly one row gone. Asserted as the whole set rather than row by row,
    // so over-purging is as loud as under-purging — this change's realistic
    // failure is destroying too much, and a per-row check cannot see it.
    expect(allMessageIds()).toEqual([
      'm-delivered-to', 'm-from-delivered', 'm-from-undelivered', 'm-unrelated',
    ]);
  });

  it('the other party can still read the conversation afterwards', async () => {
    insertMessage(db, { id: 'm1', kind: 'direct', from_agent: 'doomed', to_agent: 'other', payload: 'hello', sent_at: now() });
    markDelivered(db, 'm1');
    insertMessage(db, { id: 'm2', kind: 'direct', from_agent: 'other', to_agent: 'doomed', payload: 'hi back', sent_at: now() });
    markDelivered(db, 'm2');

    deleteAgent(db, 'doomed');

    // The whole point of "identity, not history": 'other' still has both sides
    // of the conversation, and they age out under retention like everything
    // else rather than being destroyed by an unrelated admin action.
    const res = await fetch(`${base}/messages?agent=other`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    // A BARE ARRAY, not {messages:[…]} — read off handleMessagesGet, after a
    // first version assumed the envelope and threw rather than failing an
    // assertion.
    expect(ids(await res.json() as { id: string }[])).toEqual(['m1', 'm2']);
  });

  // RANGE: does any reader of these tables now assume the agent row exists?
  // GET /messages does not — it filters on from_agent/to_agent and never joins
  // agents — so an admin auditing a deleted id still gets the surviving rows.
  // Pinned, because "the history survives" would be hollow if the only route
  // that reads it started 404ing.
  it('an admin can still query the DELETED id and see the surviving history', async () => {
    insertMessage(db, { id: 'kept', kind: 'direct', from_agent: 'doomed', to_agent: 'other', payload: 'x', sent_at: now() });
    markDelivered(db, 'kept');
    deleteAgent(db, 'doomed');

    const res = await fetch(`${base}/messages?agent=doomed`, { headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);
    expect(ids(await res.json() as { id: string }[])).toEqual(['kept']);
  });

  // ── topic copies ───────────────────────────────────────────────────────────

  // A CONSEQUENCE THE ISSUE DOES NOT MENTION, pinned rather than left to ride
  // in silently. routePublish persists PER-SUBSCRIBER copies with
  // `to_agent = subscriber_id` (router.ts, both the online and offline paths),
  // so an undelivered topic copy for the deleted agent is caught by the same
  // predicate — correctly: a copy addressed to an identity that no longer
  // exists can never be delivered.
  it('an undelivered TOPIC copy addressed to the deleted agent is purged', () => {
    insertMessage(db, { id: 't-doomed', kind: 'topic', from_agent: 'other', to_agent: 'doomed', topic: 'beat', payload: 'tick', sent_at: now() });
    expect(allMessageIds()).toEqual(['t-doomed']);
    deleteAgent(db, 'doomed');
    expect(allMessageIds()).toEqual([]);
  });

  // The issue's truth-table test. IT PASSES FOR A DIFFERENT REASON THAN THE
  // ISSUE GIVES, and saying so here is the point of the comment: the note says
  // stored topic rows have a NULL `to_agent` and that equality is what spares
  // them. Measured against the tree, no writer produces a NULL — this row is
  // spared because it belongs to ANOTHER SUBSCRIBER. The predicate is right
  // either way; a test that passes for a reason other than its comment is the
  // next person's trap.
  it('an undelivered topic copy for an UNRELATED subscriber is untouched', () => {
    insertMessage(db, { id: 't-bystander', kind: 'topic', from_agent: 'other', to_agent: 'bystander', topic: 'beat', payload: 'tick', sent_at: now() });
    deleteAgent(db, 'doomed');
    expect(allMessageIds()).toEqual(['t-bystander']);
  });

  // ...and the NULL case itself, which no writer produces today but which the
  // schema still permits — the schema is what a future writer is bounded by,
  // not today's call sites.
  //
  // WHAT KILLS THIS TEST IS AN EXPLICIT `OR to_agent IS NULL`, not a negated
  // predicate — measured, because the issue's note claims the opposite and the
  // mutant built from it passed. Three-valued logic makes the negated forms
  // NULL-safe in the SAME direction as equality: `NOT (to_agent != ?)` and
  // `to_agent NOT IN (…)` both leave a NULL row alone, exactly as `=` does.
  it('a NULL to_agent row is excluded by construction', () => {
    db.prepare(`INSERT INTO messages (id, kind, from_agent, to_agent, payload, sent_at)
                VALUES ('m-null', 'topic', 'other', NULL, 'p', ?)`).run(now());
    deleteAgent(db, 'doomed');
    expect(allMessageIds()).toEqual(['m-null']);
  });

  // ── files ──────────────────────────────────────────────────────────────────

  it('purges the row AND the bytes of an unfetched file, keeps a delivered one', async () => {
    const unfetched = seedFile('f-unfetched', 'other', 'doomed', false);
    const delivered = seedFile('f-delivered', 'other', 'doomed', true);
    const fromDoomed = seedFile('f-from-doomed', 'doomed', 'other', false);
    expect([existsSync(unfetched), existsSync(delivered), existsSync(fromDoomed)]).toEqual([true, true, true]);

    // Through the ROUTE, not the db function: the unlink lives in the caller by
    // design, so a test that called deleteAgent directly would report leaked
    // bytes as a pass.
    const res = await fetch(`${base}/agents/doomed`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } });
    expect(res.status).toBe(200);

    expect(getFile(db, 'f-unfetched')).toBe(null);
    expect(existsSync(unfetched)).toBe(false);

    // The delivered file is history — the recipient fetched it, and the SENDER
    // still has a record of having sent it.
    expect(getFile(db, 'f-delivered')).not.toBe(null);
    expect(existsSync(delivered)).toBe(true);
    // A file the deleted agent SENT is the other party's incoming mail and is
    // still deliverable.
    expect(getFile(db, 'f-from-doomed')).not.toBe(null);
    expect(existsSync(fromDoomed)).toBe(true);
  });

  // THE ORDERING, #85's rule, tested at the point where it is observable.
  //
  // "Unlink after delete" only differs from "unlink before delete" IF the
  // process stops between the two — so the assertion is exactly that state:
  // deleteAgent returns, nothing has unlinked yet, and what is left is an
  // ORPHAN FILE (recoverable), never a row pointing at missing bytes (reads as
  // corruption). Any unlink inside deleteAgent reds this, in either order,
  // which is what makes the wrong order unrepresentable rather than avoided.
  it('deleteAgent itself unlinks NOTHING — it returns paths for the caller', () => {
    const path = seedFile('f-orphan', 'other', 'doomed', false);

    const purged = deleteAgent(db, 'doomed');

    expect(purged).toEqual([path]);
    expect(getFile(db, 'f-orphan')).toBe(null);   // the row is gone…
    expect(existsSync(path)).toBe(true);          // …and the bytes are still here
  });

  // ── the two statements that were already here ──────────────────────────────
  //
  // SEAT 1's FINDING ON #159, and the diagnosis is the part worth keeping. My
  // mutant set was drawn around what was NEW, not around the function: the acl
  // and topics deletions appear in that diff as `+` lines (moved into the
  // transaction and re-indented), so they were IN the diff and still invisible
  // — the boundary was novelty. A moved line is a new line for coverage
  // purposes. Both were unpinned: removing either left the file 11/0 green.

  // The consequence is measured, not asserted from the comment. With the acl
  // deletion removed: 2 rows naming the agent before, 2 after, and a
  // re-registered id answers TRUE to aclCheck in both directions — it inherits
  // its predecessor's grants, which is exactly what that line's own comment
  // says it exists to prevent.
  it('deletes every acl edge naming the agent, in both directions', () => {
    aclGrant(db, 'doomed', 'other', 'system');      // doomed may send to other
    aclGrant(db, 'other', 'doomed', 'system');      // and other to doomed
    expect(aclRowsNaming('doomed')).toBe(2);        // POSITIVE CONTROL

    deleteAgent(db, 'doomed');

    expect(aclRowsNaming('doomed')).toBe(0);
  });

  // THE CONTROL FOR THE ABOVE, and the reason the edges must go rather than
  // merely look untidy: an id can be registered again. Without this, "the rows
  // are gone" is a housekeeping claim; with it, it is an access-control one.
  it('CONTROL: an id registered again inherits none of its predecessor\'s grants', () => {
    aclGrant(db, 'doomed', 'other', 'system');
    aclGrant(db, 'other', 'doomed', 'system');
    deleteAgent(db, 'doomed');

    registerAgent(db, { id: 'doomed', token_hash: hashToken('a-new-holder'), hostname: 'h2' });

    expect(aclCheck(db, 'doomed', 'other')).toBe(false);
    expect(aclCheck(db, 'other', 'doomed')).toBe(false);
    // ...and the grants are genuinely grantable, so `false` above is the
    // absence of an edge and not a broken aclCheck.
    aclGrant(db, 'doomed', 'other', 'system');
    expect(aclCheck(db, 'doomed', 'other')).toBe(true);
  });

  // WHAT THE TOPICS DELETION ACTUALLY DOES, which is not what "cleanup"
  // suggests. `topics.created_by REFERENCES agents(id)` carries NO ON DELETE
  // clause, so the default is NO ACTION: with that line removed, deleting an
  // agent that ever created a topic does not leave an orphan — it FAILS with
  // SQLITE_CONSTRAINT_FOREIGNKEY (measured). The line is what makes the delete
  // possible at all, so the property pinned here is that it SUCCEEDS.
  it('an agent that created a topic can be deleted, and its topics go with it', () => {
    getOrCreateTopic(db, 'doomed-topic', 'doomed');
    expect(topicCount()).toBe(1);                   // POSITIVE CONTROL

    expect(() => deleteAgent(db, 'doomed')).not.toThrow();

    expect(topicCount()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) c FROM agents WHERE id = 'doomed'").get()).toEqual({ c: 0 });
  });

  // A DELIBERATE COST, ON RECORD (seat 1). `subscriptions.topic REFERENCES
  // topics(name) ON DELETE CASCADE`, so removing the agent's created topics
  // takes every OTHER agent's subscriptions to those topics with them. That is
  // pre-existing and unchanged, and it is the one place where "purge only what
  // can never be used" overstates: a bystander's subscription was usable.
  //
  // Pinned rather than fixed, so the behaviour is a choice on the record
  // instead of a surprise. The wider question — whether a topic should outlive
  // its creator — is noted for the owner, not decided here.
  it('a bystander\'s subscription to the agent\'s topic goes with the topic', () => {
    getOrCreateTopic(db, 'doomed-topic', 'doomed');
    db.prepare('INSERT INTO subscriptions (topic, agent_id, subscribed_at) VALUES (?, ?, ?)')
      .run('doomed-topic', 'bystander', Date.now());
    expect(subsFor('bystander')).toBe(1);           // POSITIVE CONTROL

    deleteAgent(db, 'doomed');

    // Gone — via the topics cascade, not via any statement in deleteAgent.
    expect(subsFor('bystander')).toBe(0);
    // The bystander itself is untouched: it is the SUBSCRIPTION that went, not
    // the agent.
    expect(db.prepare("SELECT COUNT(*) c FROM agents WHERE id = 'bystander'").get()).toEqual({ c: 1 });
  });

  // A subscription to somebody ELSE'S topic survives, which is what makes the
  // test above a statement about the cascade rather than about deletion in
  // general.
  it('a subscription to an unrelated topic survives', () => {
    getOrCreateTopic(db, 'other-topic', 'other');
    db.prepare('INSERT INTO subscriptions (topic, agent_id, subscribed_at) VALUES (?, ?, ?)')
      .run('other-topic', 'bystander', Date.now());

    deleteAgent(db, 'doomed');

    expect(subsFor('bystander')).toBe(1);
    expect(topicCount()).toBe(1);
  });

  // F4 commit 1 — the subscriptions cascade is being REPLACED, not removed. The
  // agent_id foreign key has to go so a remote subscriber id can be stored, and
  // deleting an agent must still take its subscriptions with it. Explicit, for
  // the same reason as the acl line above: a deletion policy belongs where
  // somebody reviewing deletions will read it.
  it('deleting an agent removes its subscriptions', () => {
    getOrCreateTopic(db, 'news', 'other');
    db.prepare('INSERT INTO subscriptions (topic, agent_id, subscribed_at) VALUES (?, ?, ?)')
      .run('news', 'doomed', Date.now());
    db.prepare('INSERT INTO subscriptions (topic, agent_id, subscribed_at) VALUES (?, ?, ?)')
      .run('news', 'bystander', Date.now());
    expect(subsFor('doomed')).toBe(1);            // POSITIVE CONTROL

    deleteAgent(db, 'doomed');

    expect(subsFor('doomed')).toBe(0);
    // ...and only its own: the bystander's subscription to the SAME topic is
    // untouched, so this is the agent_id predicate and not the topic cascade.
    expect(subsFor('bystander')).toBe(1);
  });

  // ── the decision stays in code ─────────────────────────────────────────────

  // NO FK CASCADE. Read from the LIVE schema rather than from the source text,
  // so it is the database's own answer. A cascade would take the
  // purge-everything branch of this decision silently, in DDL — and it would
  // also delete the delivered history the tests above exist to protect, while
  // every one of them still passed, because they call deleteAgent.
  it('messages and files still carry NO foreign key to agents', () => {
    for (const table of ['messages', 'files']) {
      const ddl = (db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
        .get('table', table) as { sql: string }).sql;
      expect(ddl).not.toContain('REFERENCES');
    }
    // POSITIVE CONTROL for the scan: a table that DOES cascade, so "no
    // REFERENCES found" is known to be a real reading of the schema and not a
    // query that returns nothing useful.
    const observers = (db.prepare('SELECT sql FROM sqlite_master WHERE type = ? AND name = ?')
      .get('table', 'observers') as { sql: string }).sql;
    expect(observers).toContain('REFERENCES agents(id) ON DELETE CASCADE');
  });

  // The cascades that DO exist are the range answer for the neighbouring
  // tables: reminders and observers clean themselves up, so a deleted id
  // cannot leave a firing reminder or — the one that would matter — an
  // observer grant that a re-registered agent of the same name inherits.
  it('reminders and observer grants go with the identity, via their cascades', () => {
    db.prepare(`INSERT INTO reminders (id, agent_id, due_at, payload, created_at)
                VALUES ('r1', 'doomed', ?, 'p', ?)`).run(now() + 1000, now());
    db.prepare(`INSERT INTO observers (agent_id, granted_at, granted_by)
                VALUES ('doomed', ?, 'admin')`).run(now());

    deleteAgent(db, 'doomed');

    expect(db.prepare("SELECT COUNT(*) c FROM reminders WHERE agent_id = 'doomed'").get()).toEqual({ c: 0 });
    expect(db.prepare("SELECT COUNT(*) c FROM observers WHERE agent_id = 'doomed'").get()).toEqual({ c: 0 });
  });

  // Atomicity: the purge and the identity removal are one unit, so no failure
  // leaves an agent still live with its pending mail destroyed.
  it('a failed delete leaves the agent AND its mail intact', () => {
    insertMessage(db, { id: 'm-pending', kind: 'direct', from_agent: 'other', to_agent: 'doomed', payload: 'p', sent_at: now() });
    // A grant FROM a nonexistent agent cannot be created through aclGrant, so
    // the failure is forced at the last statement instead: a trigger that
    // rejects the agents delete.
    db.prepare(`CREATE TRIGGER refuse_delete BEFORE DELETE ON agents
                BEGIN SELECT RAISE(ABORT, 'refused'); END`).run();
    try {
      expect(() => deleteAgent(db, 'doomed')).toThrow();
      expect(queryMessages(db, { agent: 'doomed' }).map(m => m.id)).toEqual(['m-pending']);
      expect(db.prepare("SELECT COUNT(*) c FROM agents WHERE id = 'doomed'").get()).toEqual({ c: 1 });
    } finally {
      db.prepare('DROP TRIGGER refuse_delete').run();
    }
  });
});
