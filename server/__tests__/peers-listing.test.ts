import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, insertPeerKey, upsertPeer, listPeers, registerAgent } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle } from '../http-admin.ts';

// #153 — GET /peers: the inbound counterpart to GET /outbound-peers.
//
// `listPeers` existed in db.ts from F0b with no HTTP consumer, so an operator
// could mint and revoke keys but could not enumerate who had registered. The
// operator guide had listed `GET /peers` in its read-API table since 6db50f9
// and it 404'd — the route is now real, and `the guide's row is now true`
// below is what keeps it that way.

const ADMIN = 'admin-secret';
const PEER_TOKEN = 'peer-secret-token';

describe('#153 GET /peers', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    insertPeerKey(db, {
      id: 'key-one', key_hash: hashToken('mint-secret'), alias: 'partner',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    upsertPeer(db, {
      alias: 'partner', token_hash: hashToken(PEER_TOKEN), minted_by_key: 'key-one',
      kinds: '["direct","topic"]', rate_per_min: 300,
    });
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-153-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const get = (path: string, token: string | null = ADMIN) =>
    fetch(`${base}${path}`, { headers: token === null ? {} : { Authorization: `Bearer ${token}` } });

  it('lists a registered peer with the fields the revocation procedure needs', async () => {
    const res = await get('/peers');
    expect(res.status).toBe(200);
    const body = await res.json() as { peers: Record<string, unknown>[] };
    expect(body.peers).toHaveLength(1);
    const p = body.peers[0]!;
    expect(p.alias).toBe('partner');
    // The key id, so an operator reading this listing can go straight to the
    // DELETE /peer-keys/:id that ends this peering rather than joining two
    // listings by hand.
    expect(p.minted_by_key).toBe('key-one');
    expect(p.kinds).toEqual(['direct', 'topic']);
    expect(p.rate_per_min).toBe(300);
    expect(typeof p.registered_at).toBe('number');
    expect(p.disabled).toBe(false);
  });

  // THE TEST THE ISSUE ASKED FOR, and the one the route exists under.
  //
  // Asserted on the SERIALISED response, not on a parsed field list: a hash
  // reaching the wire under an unexpected key name — `hash`, `verifier`, a
  // spread of the whole row — passes a field-by-field check and fails this
  // one. Same discipline as peer-keys.test.ts's listing test for `key_hash`.
  it('the response carries no token_hash, by name OR by value', async () => {
    const raw = await (await get('/peers')).text();

    const stored = hashToken(PEER_TOKEN);
    expect(raw).not.toContain(stored);
    expect(raw).not.toContain('token_hash');
    expect(raw).not.toContain(PEER_TOKEN);

    // POSITIVE CONTROL, and it is doing real work here rather than being
    // ceremony: without it every assertion above is satisfied by an empty
    // listing, by a 404, or by a fixture whose peer has no stored hash at all.
    // This pins that the bytes the response must not contain DO exist, in the
    // row the response is serialising.
    expect(raw).toContain('partner');
    expect(listPeers(db)[0]!.token_hash).toBe(stored);
  });

  // The whole-row spread is the realistic regression: `{...row}` is one
  // character shorter than the explicit shape and reads as harmless. Pinned as
  // a set, so a field DROPPED is as loud as a field added — an operator
  // procedure that reads `disabled` breaks silently otherwise.
  it('the shape is exactly the public field set', async () => {
    const body = await (await get('/peers')).json() as { peers: Record<string, unknown>[] };
    expect(Object.keys(body.peers[0]!).sort()).toEqual([
      'alias', 'disabled', 'kinds', 'last_seen', 'minted_by_key', 'rate_per_min', 'registered_at',
    ]);
  });

  it('a disabled peer is listed, and says so', async () => {
    // Revocation disables the row rather than deleting it, so a listing that
    // filtered disabled peers would go blank at exactly the moment an operator
    // is checking whether their revocation landed.
    db.prepare('UPDATE peers SET disabled = 1 WHERE alias = ?').run('partner');
    const body = await (await get('/peers')).json() as { peers: { alias: string; disabled: boolean }[] };
    expect(body.peers.map(p => [p.alias, p.disabled])).toEqual([['partner', true]]);
  });

  it('empty when nothing has registered — and NOT a 404', async () => {
    db.prepare('DELETE FROM peers').run();
    const res = await get('/peers');
    // The distinction the operator needs: "nobody has registered" and "this
    // route does not exist" were the same answer before this change, and the
    // guide said the route existed.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ peers: [] });
  });

  it('requires the admin token', async () => {
    expect((await get('/peers', null)).status).toBe(401);
    expect((await get('/peers', 'wrong-token')).status).toBe(401);
    // An agent token is not an admin token: this route is not in the
    // agentOrAdmin set, and a peer listing is an operator surface.
    registerAgent(db, { id: 'a-one', token_hash: hashToken('tok-a'), hostname: 'h' });
    expect((await get('/peers', 'tok-a')).status).toBe(401);
  });

  // The guide is an authority a human reads under pressure, and it is the one
  // that drifted: §4 promised this route while it 404'd. This walks the row
  // back to the ROUTES table rather than trusting either.
  //
  // THE CITATION HALF HAS MOVED, and this is what is left of it. The version
  // that shipped compared the row against the literal 'handlePeerGet', so
  // renaming the handler left the guide citing a symbol that no longer existed
  // with this test still green — the citation could go stale silently, inside
  // the test written to stop the guide going stale silently (seat 1). It now
  // lives in guide-citations.test.ts, which reads the symbol OUT OF the guide
  // and asks the source, for every row and every citation in the document.
  //
  // What stays here is the part that belongs to THIS route: the row exists and
  // the route it names answers.
  it('the guide\'s GET /peers row names a route that exists', async () => {
    const guide = await Bun.file(join(import.meta.dir, '../../docs/FEDERATION.md')).text();
    const row = guide.split('\n').find(l => l.includes('`GET /peers`'));
    expect(row).toBeDefined();
    // Derived, not asserted from memory: the route answers, right now.
    expect((await get('/peers')).status).toBe(200);
  });
});

// F4 §5 — GET /peers/:alias/subscriptions.
//
// The operator-facing answer to "why is this pod not receiving?", which was
// otherwise only visible by opening the database. It is the diagnostic the
// subscribe path's uniform refusal deliberately withholds from the PEER: the
// peer learns nothing about why, and the operator of THIS mesh learns
// everything, which is the correct split.
describe('#153 + F4 GET /peers/:alias/subscriptions', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'owner', token_hash: hashToken('o'), hostname: 'h' });
    for (const alias of ['partner', 'other']) {
      insertPeerKey(db, {
        id: `key-${alias}`, key_hash: hashToken(alias), alias,
        kinds: '["topic-subscribe"]', rate_per_min: 600, created_at: Date.now(),
      });
      upsertPeer(db, {
        alias, token_hash: hashToken(`${alias}-tok`), minted_by_key: `key-${alias}`,
        kinds: '["topic-subscribe"]', rate_per_min: 600,
      });
    }
    for (const t of ['trollbox', 'analytics']) db.prepare(
      'INSERT INTO topics (name, created_at, created_by) VALUES (?,?,?)').run(t, 1, 'owner');
    const sub = db.prepare('INSERT INTO subscriptions (agent_id, topic, subscribed_at) VALUES (?,?,?)');
    sub.run('partner:alice', 'trollbox', 1000);
    sub.run('partner:bob', 'analytics', 2000);
    sub.run('other:carol', 'trollbox', 3000);
    sub.run('owner', 'trollbox', 4000);              // a LOCAL subscriber
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f4-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => { await handle.shutdown().catch(() => {}); db.close(); });

  const get = (path: string, token: string | null = ADMIN) =>
    fetch(`${base}${path}`, { headers: token === null ? {} : { Authorization: `Bearer ${token}` } });

  it('lists that peer\'s subscriptions, ordered, and NOBODY else\'s', async () => {
    const res = await get('/peers/partner/subscriptions');
    expect(res.status).toBe(200);
    const body = await res.json() as { alias: string; subscriptions: { agent_id: string; topic: string }[] };
    expect(body.alias).toBe('partner');
    expect(body.subscriptions.map(s => [s.topic, s.agent_id])).toEqual([
      ['analytics', 'partner:bob'],
      ['trollbox', 'partner:alice'],
    ]);
  });

  // PREFIX ISOLATION is the property, and it is why the query uses a range
  // rather than a LIKE: `other:carol` and the local `owner` must not appear
  // under `partner`, and a peer named `part` must not collect `partner`'s rows.
  it('a second alias sees only its own', async () => {
    const body = await (await get('/peers/other/subscriptions')).json() as
      { subscriptions: { agent_id: string }[] };
    expect(body.subscriptions.map(s => s.agent_id)).toEqual(['other:carol']);
  });

  it('CONTROL: a prefix that is a prefix of another alias collects nothing of its own', async () => {
    upsertPeer(db, {
      alias: 'part', token_hash: hashToken('part'), minted_by_key: 'key-partner',
      kinds: '["topic-subscribe"]', rate_per_min: 600,
    });
    const body = await (await get('/peers/part/subscriptions')).json() as { subscriptions: unknown[] };
    // `partner:alice` starts with "part" but is not in the `part:`..`part;`
    // range. A LIKE 'part%' would have returned both of partner's rows.
    expect(body.subscriptions).toEqual([]);
  });

  it('404 for an alias that is not a registered peer', async () => {
    const res = await get('/peers/nosuchpeer/subscriptions');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'no such peer' });
  });

  it('requires the admin token', async () => {
    expect((await get('/peers/partner/subscriptions', null)).status).toBe(401);
    expect((await get('/peers/partner/subscriptions', 'wrong')).status).toBe(401);
  });

  it('carries no token bytes, by name or by value', async () => {
    const raw = await (await get('/peers/partner/subscriptions')).text();
    expect(raw).not.toContain(hashToken('partner-tok'));
    expect(raw).not.toContain('token_hash');
    expect(raw).toContain('partner:alice');          // POSITIVE CONTROL
  });
});
