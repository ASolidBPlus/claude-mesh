import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  openDb, registerAgent, getPeerByAlias, getPeerKeyBySecret, insertPeerKey,
  listPeers, revokePeerKey, upsertPeer, findPeerAliasCollisions, getLivePeerKeyForAlias,
} from '../db.ts';
import { hashToken, generateToken } from '../auth.ts';
import { startHttpAdmin, HttpAdminHandle, resolveRouteAuth, fileAccessAuthorized, type AuthResult } from '../http-admin.ts';
import * as net from 'net';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// F0b — peer keys, peer registration, and the local-id rules (§3, §4, §6, D9).
//
// Everything here is INERT with zero peers rows: a mesh that never mints a peer
// key sees no behaviour change, which the "no peers, nothing changes" tests at
// the bottom pin.

const ADMIN = 'admin-secret';

describe('F0b: peer keys', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f0b-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const post = (path: string, body: unknown, token = ADMIN) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('mints a key, returns the secret ONCE, and defaults kinds and rate', async () => {
    const res = await post('/peer-keys', { alias: 'othermesh' });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.alias).toBe('othermesh');
    expect(body.kinds).toEqual(['direct']);
    expect(body.rate_per_min).toBe(600);
    expect(typeof body.key).toBe('string');
    expect((body.key as string).length).toBeGreaterThan(16);
  });

  it('the mint response is the ONLY place the secret appears — the listing has neither key nor hash', async () => {
    const minted = await (await post('/peer-keys', { alias: 'othermesh' })).json() as { key: string };

    const raw = await (await fetch(`${base}/peer-keys`, { headers: { Authorization: `Bearer ${ADMIN}` } })).text();

    // Asserted on the SERIALISED response, not on a parsed field list: a hash
    // leaking through an unexpected key name would pass a field-by-field check
    // and fail this one. A listing that leaked the hash would make every stored
    // key offline-crackable from an admin read alone.
    expect(raw).not.toContain(minted.key);
    expect(raw).not.toContain(hashToken(minted.key));
    expect(raw).not.toContain('key_hash');
    // Positive control: the listing is not empty, so "does not contain" is not
    // satisfied by there being nothing to contain.
    expect(raw).toContain('othermesh');
  });

  it('the MINT response carries the secret but not the stored hash', async () => {
    // Shape hygiene rather than a security boundary — stated plainly: the
    // caller already holds the secret, so it could compute the hash itself.
    // Asserted anyway because the mint response is the one place a stored-hash
    // field would look natural, and a mutant adding it survived the listing
    // test above (which is correctly scoped to the LISTING and cannot see it).
    const raw = await (await post('/peer-keys', { alias: 'shapecheck' })).text();
    expect(raw).not.toContain('key_hash');
    expect(raw).toContain('"key"');
  });

  it('refuses a bad alias grammar, the reserved alias, and a live duplicate', async () => {
    expect((await post('/peer-keys', { alias: 'Bad Alias' })).status).toBe(400);
    expect((await post('/peer-keys', { alias: '-leading' })).status).toBe(400);
    expect((await post('/peer-keys', { alias: 'mesh' })).status).toBe(400);

    expect((await post('/peer-keys', { alias: 'dupe' })).status).toBe(201);
    // One live key per alias: two would mean two secrets register the same
    // peer, so revoking one leaves a door the operator believes they closed.
    expect((await post('/peer-keys', { alias: 'dupe' })).status).toBe(409);
  });

  it('an EXPIRED key does not block a new mint for the same alias (#103)', async () => {
    // The GATE side of the shared live-key definition. Paired with the report
    // test so that dropping expiry from the shared fragment reds BOTH — which
    // is what demonstrates they really share it rather than happening to agree.
    insertPeerKey(db, {
      id: 'old-expired', key_hash: hashToken('oldsecret'), alias: 'recycled',
      kinds: '["direct"]', rate_per_min: 600,
      expires_at: Date.now() - 1000, created_at: Date.now() - 5000,
    });
    // An expired key is not live, so the alias is free again.
    expect((await post('/peer-keys', { alias: 'recycled' })).status).toBe(201);
  });

  it('refuses an alias that collides with an existing local agent id', async () => {
    registerAgent(db, { id: 'localagent', token_hash: 'a'.repeat(64), hostname: 'h' });
    expect((await post('/peer-keys', { alias: 'localagent' })).status).toBe(409);
  });

  it('a revoked key disables its peer in the SAME transaction', async () => {
    const minted = await (await post('/peer-keys', { alias: 'othermesh' })).json() as { id: string; key: string };
    await post('/peers/register', { key: minted.key });
    expect(getPeerByAlias(db, 'othermesh')?.disabled).toBe(0);

    const del = await fetch(`${base}/peer-keys/${minted.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` },
    });
    expect(del.status).toBe(200);
    // A key marked dead while its peer stays enabled is the half-applied state
    // the single transaction exists to prevent.
    expect(getPeerByAlias(db, 'othermesh')?.disabled).toBe(1);
    expect((await post('/peers/register', { key: minted.key })).status).toBe(403);
  });
});

describe('F0b: POST /peers/register', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f0b-r-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const register = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}/peers/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
    });

  async function mint(alias: string): Promise<{ id: string; key: string }> {
    const res = await fetch(`${base}/peer-keys`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias }),
    });
    return await res.json() as { id: string; key: string };
  }

  it('registers with a valid key and returns the token once, with protocol 1', async () => {
    const { key } = await mint('othermesh');
    const res = await register({ key });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.alias).toBe('othermesh');
    expect(body.protocol).toBe(1);
    expect(body.kinds).toEqual(['direct']);
    expect(typeof body.token).toBe('string');
    // The stored row holds only the HASH.
    expect(getPeerByAlias(db, 'othermesh')?.token_hash).toBe(hashToken(body.token as string));
  });

  it('needs NO admin token — and presenting one grants nothing extra', async () => {
    const { key } = await mint('othermesh');
    // handler-authenticated: the dispatcher checks nothing, so this must work
    // with no Authorization header at all.
    expect((await register({ key })).status).toBe(201);
    // And a valid admin token does not substitute for a valid key.
    expect((await register({}, { Authorization: `Bearer ${ADMIN}` })).status).toBe(403);
  });

  it('refuses unknown, revoked, and expired keys with a BYTE-IDENTICAL body', async () => {
    const { id, key: revokedKey } = await mint('willrevoke');
    revokePeerKey(db, id);

    const expiredKey = generateToken();
    insertPeerKey(db, {
      id: 'expired-key', key_hash: hashToken(expiredKey), alias: 'expiredmesh',
      kinds: '["direct"]', rate_per_min: 600, expires_at: Date.now() - 1000, created_at: Date.now() - 2000,
    });

    const bodies: string[] = [];
    for (const body of [{ key: 'no-such-key' }, { key: revokedKey }, { key: expiredKey }, {}]) {
      const res = await register(body);
      expect(res.status).toBe(403);
      bodies.push(await res.text());
    }
    // Distinguishable refusals would make this endpoint an oracle for which
    // keys exist, are revoked, or have expired. Every refusal is one body.
    expect(new Set(bodies).size).toBe(1);
  });

  it('re-registration ROTATES the token rather than creating a second peer', async () => {
    const { key } = await mint('othermesh');
    const first = await (await register({ key })).json() as { token: string };
    const second = await (await register({ key })).json() as { token: string };

    expect(second.token).not.toBe(first.token);
    expect(listPeers(db).length).toBe(1);
    expect(getPeerByAlias(db, 'othermesh')?.token_hash).toBe(hashToken(second.token));
  });
});

// The falsifiability test for the key lookup, per #75. SQLite's `=` honours
// COLLATION, so a NOCASE column returns a row whose stored hash differs from
// the computed one in case — and the final timing-safe compare is the ONLY
// thing that then refuses it. Without building that world the compare is
// unkillable: every mutant of it passes, which means it is untested, not safe.
describe('F0b: getPeerKeyBySecret under a NOCASE collation', () => {
  function nocaseDb(): Database {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE peer_keys (
        id TEXT PRIMARY KEY, key_hash TEXT NOT NULL COLLATE NOCASE, alias TEXT NOT NULL,
        kinds TEXT NOT NULL, rate_per_min INTEGER NOT NULL,
        expires_at INTEGER, revoked_at INTEGER, note TEXT, created_at INTEGER NOT NULL
      );
    `);
    return db;
  }

  it('refuses a case-variant hash that the collation happily matches', () => {
    const db = nocaseDb();
    const secret = 'peer-secret-value';
    // Stored uppercase; hashToken produces lowercase hex. Under NOCASE the
    // SELECT MATCHES this row — only the byte-exact compare rejects it.
    db.prepare('INSERT INTO peer_keys VALUES (?,?,?,?,?,?,?,?,?)')
      .run('upper', hashToken(secret).toUpperCase(), 'a', '["direct"]', 600, null, null, null, 1);

    expect(db.prepare('SELECT COUNT(*) AS n FROM peer_keys WHERE key_hash = ?')
      .get(hashToken(secret)) as { n: number }).toEqual({ n: 1 }); // the collation DID match

    expect(getPeerKeyBySecret(db, secret)).toBeNull();
    db.close();
  });

  it('positive control: an exact-case row in the SAME table still authenticates', () => {
    // Without this, the test above passes just as well if the lookup were
    // broken outright.
    const db = nocaseDb();
    const secret = 'peer-secret-value';
    db.prepare('INSERT INTO peer_keys VALUES (?,?,?,?,?,?,?,?,?)')
      .run('exact', hashToken(secret), 'b', '["direct"]', 600, null, null, null, 1);
    expect(getPeerKeyBySecret(db, secret)?.id).toBe('exact');
    db.close();
  });

  it('AMBIGUITY authenticates nobody — two rows sharing a hash refuse both', () => {
    const db = nocaseDb();
    const secret = 'peer-secret-value';
    for (const id of ['one', 'two']) {
      db.prepare('INSERT INTO peer_keys VALUES (?,?,?,?,?,?,?,?,?)')
        .run(id, hashToken(secret), id, '["direct"]', 600, null, null, null, 1);
    }
    // Taking the first row would let a data condition be resolved in the
    // caller's favour. It fails closed instead.
    expect(getPeerKeyBySecret(db, secret)).toBeNull();
    db.close();
  });
});

describe('F0b: the dispatcher never hands a handler-mode route a grant', () => {
  const fakeRes = () => {
    const rec = { code: null as number | null };
    return {
      writeHead(c: number) { rec.code = c; return this; },
      end() { return this; },
      get written() { return rec.code; },
    } as unknown as import('http').ServerResponse & { written: number | null };
  };
  const req = (auth?: string) =>
    ({ headers: auth === undefined ? {} : { authorization: auth } }) as import('http').IncomingMessage;

  it("auth:'handler' yields unauthenticated, even when the ADMIN token is presented", () => {
    const db = openDb(':memory:');
    expect(resolveRouteAuth(req(), fakeRes(), db, ADMIN, 'handler')).toEqual({ mode: 'unauthenticated' });
    // Presenting a good credential must not upgrade a ctx the route never
    // consulted.
    expect(resolveRouteAuth(req(`Bearer ${ADMIN}`), fakeRes(), db, ADMIN, 'handler'))
      .toEqual({ mode: 'unauthenticated' });
    db.close();
  });

  it('unauthenticated is never a file-access grant, and the other modes still are', () => {
    const file = { from_agent: 'A', to_agent: 'B' };
    expect(fileAccessAuthorized({ mode: 'unauthenticated' } as AuthResult, file)).toBe(false);
    expect(fileAccessAuthorized({ mode: 'admin' }, file)).toBe(true);
    expect(fileAccessAuthorized({ mode: 'agent', agentId: 'A' }, file)).toBe(true);
    expect(fileAccessAuthorized({ mode: 'agent', agentId: 'C' }, file)).toBe(false);
  });
});

describe('F0b: local id rules bind NEW agents only (§6)', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f0b-i-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const postAgent = (id: string) =>
    fetch(`${base}/agents`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, hostname: 'h' }),
    });

  // Split one condition per test: this gate now has four, and a single unit
  // covering all of them goes red without saying WHICH rule broke.
  it("refuses an id containing ':'", async () => {
    expect((await postAgent('remote:agent')).status).toBe(400);
  });

  it('refuses the reserved id', async () => {
    expect((await postAgent('mesh')).status).toBe(400);
  });

  it('refuses an id colliding with a REGISTERED peer', async () => {
    upsertPeer(db, { alias: 'peermesh', token_hash: 'x'.repeat(64), minted_by_key: 'k', kinds: '["direct"]', rate_per_min: 600 });
    expect((await postAgent('peermesh')).status).toBe(409);
  });

  it('refuses an id colliding with a LIVE PEER KEY that has not registered yet', async () => {
    // The state the original gate could not see: peer_keys populated, peers empty.
    insertPeerKey(db, {
      id: 'k-unreg', key_hash: hashToken('unreg'), alias: 'not-yet',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    expect(getPeerByAlias(db, 'not-yet')).toBeNull();
    expect((await postAgent('not-yet')).status).toBe(409);
  });

  it('positive control: an ordinary id is still accepted', async () => {
    // Without this, the four refusals above are satisfied by a route that
    // rejects everything.
    expect((await postAgent('ordinary-agent')).status).toBe(201);
  });

  it('an EXISTING legacy id containing ":" keeps working — the rule is not retroactive', () => {
    // A validation change that made a live agent unable to re-register would be
    // worse than the ambiguity it fixes. Legacy ids are reported at boot, not
    // rejected.
    registerAgent(db, { id: 'legacy:agent', token_hash: 'b'.repeat(64), hostname: 'h' });
    const found = db.prepare("SELECT id FROM agents WHERE id LIKE '%:%'").all() as { id: string }[];
    expect(found.map(r => r.id)).toEqual(['legacy:agent']);
  });
});

describe('F0b: one id cannot name two identities', () => {
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f0b-c-')), new Map());
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  const adminPost = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  // THE SEQUENCE. A minted-but-unregistered key lives only in peer_keys, which
  // the agent gate did not consult — so this ran end to end with no error at
  // any step and produced one id with two identities:
  //   mint "shared" -> register agent "shared" -> peer registers -> both exist.
  it('a minted key blocks an agent registration for the same id', async () => {
    const minted = await (await adminPost('/peer-keys', { alias: 'shared-name' })).json() as { key: string };
    // The peer has NOT registered yet: peers is empty, only peer_keys has it.
    expect(getPeerByAlias(db, 'shared-name')).toBeNull();

    const res = await adminPost('/agents', { id: 'shared-name', hostname: 'h' });
    expect(res.status).toBe(409);

    // And the peer can still complete, holding the id alone.
    expect((await adminPost('/peers/register', { key: minted.key })).status).toBe(201);
    expect(getPeerByAlias(db, 'shared-name')).not.toBeNull();
  });

  it('the reverse order is still refused — agent first, then the mint', async () => {
    expect((await adminPost('/agents', { id: 'taken', hostname: 'h' })).status).toBe(201);
    expect((await adminPost('/peer-keys', { alias: 'taken' })).status).toBe(409);
  });

  it('registration itself refuses an alias that already names a local agent', async () => {
    // Defence in depth: the gates above should make this unreachable, so the
    // collision is constructed directly to prove the last line holds.
    const secret = 'direct-seeded-secret';
    insertPeerKey(db, {
      id: 'seeded', key_hash: hashToken(secret), alias: 'collider',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    registerAgent(db, { id: 'collider', token_hash: 'c'.repeat(64), hostname: 'h' });

    const res = await adminPost('/peers/register', { key: secret });
    expect(res.status).toBe(409);
    expect(getPeerByAlias(db, 'collider')).toBeNull();
  });

  it('the boot report names a pre-seeded collision', () => {
    // A collision already on disk cannot be gated away — it predates the
    // gates. It must be visible instead. Pins WHAT the report finds; that
    // main() calls it is not covered here (same as the legacy ':' report).
    insertPeerKey(db, {
      id: 'seed2', key_hash: hashToken('s2'), alias: 'both-things',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    registerAgent(db, { id: 'both-things', token_hash: 'd'.repeat(64), hostname: 'h' });
    registerAgent(db, { id: 'innocent', token_hash: 'e'.repeat(64), hostname: 'h' });

    expect(findPeerAliasCollisions(db)).toEqual(['both-things']);
  });

  it('an EXPIRED but unrevoked key is NOT reported (#103)', () => {
    // The two definitions had drifted: the gate required not-revoked AND
    // not-expired; the report required only not-revoked. So a key the gate
    // would refuse to honour was named as a live collision.
    //
    // Over-reporting is the direction a detection query dies in — an operator
    // who learns the report cries wolf stops reading it, and then it is worth
    // nothing on the day it is right.
    insertPeerKey(db, {
      id: 'seed-exp', key_hash: hashToken('sx'), alias: 'expired-name',
      kinds: '["direct"]', rate_per_min: 600,
      expires_at: Date.now() - 1000, created_at: Date.now() - 5000,
    });
    registerAgent(db, { id: 'expired-name', token_hash: 'g'.repeat(64), hostname: 'h' });

    // The gate agrees it is not live — the two must give the same answer.
    expect(getLivePeerKeyForAlias(db, 'expired-name', Date.now())).toBeNull();
    expect(findPeerAliasCollisions(db)).toEqual([]);
  });

  it('a REVOKED key is not reported as a collision', () => {
    // Revoked keys cannot be used to register, so an agent may legitimately
    // take that id back. Reporting it would train operators to ignore the log.
    insertPeerKey(db, {
      id: 'seed3', key_hash: hashToken('s3'), alias: 'freed-name',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    revokePeerKey(db, 'seed3');
    registerAgent(db, { id: 'freed-name', token_hash: 'f'.repeat(64), hostname: 'h' });

    expect(findPeerAliasCollisions(db)).toEqual([]);
  });

  it('positive control: an uncolliding mint and agent both still succeed', async () => {
    // Without this, the three refusals above are satisfied by gates that refuse
    // everything.
    expect((await adminPost('/peer-keys', { alias: 'peer-one' })).status).toBe(201);
    expect((await adminPost('/agents', { id: 'agent-one', hostname: 'h' })).status).toBe(201);
  });
});

describe('F1a: revocation and re-registration close the live socket', () => {
  // The ACTION half. The cleanup sweep is the STATE half and runs regardless —
  // neither replaces the other: an action can be missed by a crash, and a 15 s
  // window is not a substitute for closing it now.
  let db: Database;
  let handle: HttpAdminHandle;
  let base: string;
  let peerIndex: Map<string, { sent: string[]; closed: boolean }>;

  beforeEach(async () => {
    db = openDb(':memory:');
    peerIndex = new Map();
    handle = await startHttpAdmin(
      0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f1a-r-')),
      new Map(), new Map(), peerIndex as never,
    );
    base = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
  });
  afterEach(async () => {
    await handle.shutdown().catch(() => {});
    db.close();
  });

  function fakeSocket(alias: string) {
    const rec = { sent: [] as string[], closed: false };
    (peerIndex as Map<string, unknown>).set(alias, {
      send(d: string) { rec.sent.push(d); },
      close() { rec.closed = true; },
    });
    return rec;
  }

  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('revoking a key closes that peer\'s socket immediately', async () => {
    const minted = await (await post('/peer-keys', { alias: 'othermesh' })).json() as { id: string; key: string };
    await post('/peers/register', { key: minted.key });
    const sock = fakeSocket('othermesh');

    await fetch(`${base}/peer-keys/${minted.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } });

    expect(sock.closed).toBe(true);
    // Same refusal text as a bad token: revocation is not an oracle.
    expect(sock.sent.some(m => JSON.parse(m).message === 'invalid token')).toBe(true);
  });

  it('re-registration closes the socket holding the ROTATED-AWAY token', async () => {
    const minted = await (await post('/peer-keys', { alias: 'othermesh' })).json() as { key: string };
    await post('/peers/register', { key: minted.key });
    const sock = fakeSocket('othermesh');

    await post('/peers/register', { key: minted.key }); // rotates token_hash

    // That socket authenticated with a credential that no longer exists.
    expect(sock.closed).toBe(true);
  });

  it('positive control: an UNRELATED peer\'s socket is untouched', async () => {
    const a = await (await post('/peer-keys', { alias: 'mesh-a' })).json() as { id: string; key: string };
    const b = await (await post('/peer-keys', { alias: 'mesh-b' })).json() as { key: string };
    await post('/peers/register', { key: a.key });
    await post('/peers/register', { key: b.key });
    const sockA = fakeSocket('mesh-a');
    const sockB = fakeSocket('mesh-b');

    await fetch(`${base}/peer-keys/${a.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${ADMIN}` } });

    expect(sockA.closed).toBe(true);
    expect(sockB.closed).toBe(false);
  });
});

describe('F0b: inert with zero peers', () => {
  it('a mesh that never mints a key has no peers, and agent registration is unchanged', async () => {
    const db = openDb(':memory:');
    const handle = await startHttpAdmin(0, db, ADMIN, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f0b-z-')), new Map());
    const b = `http://localhost:${(handle.server.address() as net.AddressInfo).port}`;
    try {
      expect(listPeers(db).length).toBe(0);
      const res = await fetch(`${b}/agents`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'plain-agent', hostname: 'h' }),
      });
      expect(res.status).toBe(201);
      const body = await res.json() as Record<string, unknown>;
      expect(body.id).toBe('plain-agent');
      expect(typeof body.token).toBe('string');
    } finally {
      await handle.shutdown().catch(() => {});
      db.close();
    }
  });
});
