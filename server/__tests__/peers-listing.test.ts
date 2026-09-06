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
  it('the guide\'s GET /peers row names a route that exists', async () => {
    const guide = await Bun.file(join(import.meta.dir, '../../docs/FEDERATION.md')).text();
    const row = guide.split('\n').find(l => l.includes('`GET /peers`'));
    expect(row).toBeDefined();
    // Derived, not asserted from memory: the route answers, right now.
    expect((await get('/peers')).status).toBe(200);
    // ...and the row cites the handler, which is what the rows that stayed
    // true have and the row that drifted did not.
    expect(row).toContain('handlePeerGet');
  });
});
