import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  openDb, registerAgent, getAgentById, insertMessage, insertPeerKey, upsertPeer, aclGrant,
} from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle, PEER_PROTOCOL_VERSION } from '../ws-server.ts';

// #143 — CHARACTERISATION TESTS FOR THE AUTH SEAM. Written BEFORE the cut, and
// this is the whole reason they exist: a mechanical split is judged by "every
// existing test still passes", which is only as strong as what those tests
// happen to pin. These pin the properties the CUT could break and that nothing
// else asserts — chosen by reading the block for what it captures, not by
// guessing.
//
// The 314-line `if (!authed)` block will become named functions. Extraction has
// one characteristic failure: inside the block, `return` means "stop handling
// this message"; after extraction it means "leave this function", and a caller
// that does not also return FALLS THROUGH to the post-auth dispatch. Both arms
// end in such a return and the peer arm's is commented as load-bearing. Neither
// was asserted anywhere.

let portCounter = 20800;
const nextPort = () => portCounter++;
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

// A PEER AUTHENTICATES THROUGH `agent_id`, not through a `peer` field, and
// `protocol` is required — but only checked AFTER the credential matches. Both
// facts are read off the arm rather than assumed: a first draft of this file
// sent `{peer: 'partner'}` and every peer test failed, which is the frame shape
// telling the truth about the discriminator.
const PEER_AUTH = { type: 'auth', agent_id: 'partner', token: 'peer-tok', protocol: PEER_PROTOCOL_VERSION };

describe('#143 auth seam, characterised before the cut', () => {
  let db: Database;
  let filesDir: string;
  let handle: WsServerHandle | undefined;

  beforeEach(() => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-143-'));
    registerAgent(db, { id: 'a-one', token_hash: hashToken('tok-a'), hostname: 'h' });
    registerAgent(db, { id: 'watcher', token_hash: hashToken('tok-w'), hostname: 'h' });
    aclGrant(db, 'a-one', 'watcher', 'system');
    insertPeerKey(db, {
      id: 'k1', key_hash: hashToken('mint'), alias: 'partner',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    upsertPeer(db, {
      alias: 'partner', token_hash: hashToken('peer-tok'), minted_by_key: 'k1',
      kinds: '["direct"]', rate_per_min: 600,
    });
  });
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    handle = undefined;
    db.close();
  });

  /** Connect, record EVERY frame in order, and send an auth frame. Recording
   *  rather than waiting: the defects here are extra frames and wrong order,
   *  and a test that waits for what it expects can see neither. */
  const open = async (port: number, auth: Record<string, unknown>) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const seen: Record<string, unknown>[] = [];
    await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
    ws.on('message', (d) => { seen.push(JSON.parse(d.toString()) as Record<string, unknown>); });
    ws.send(JSON.stringify(auth));
    return { ws, seen, types: () => seen.map(f => f.type) };
  };

  // THE RETURN AT THE END OF THE AGENT ARM. Without it the auth frame falls
  // through to POST_AUTH_HANDLERS, where `auth` is not a key, and the client
  // gets a NOT_IMPLEMENTED error immediately after its auth_ok.
  it('a successful AGENT auth produces auth_ok and no trailing error', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const c = await open(port, { type: 'auth', agent_id: 'a-one', token: 'tok-a' });
    await delay(150);

    expect(c.types()).toEqual(['auth_ok']);
    expect(c.seen.every(f => f.type !== 'error')).toBe(true);
    c.ws.close();
  }, 20_000);

  // THE SAME RETURN IN THE PEER ARM, whose comment says exactly what falling
  // through would do: "setOnline / agentIndex.set / pending drains /
  // broadcastStatus for an id that names no agent". Asserted as the ABSENCE of
  // each of those effects, not merely as the absence of an error frame — an
  // extraction that kept the error quiet but ran the agent path would pass a
  // frame-only check.
  it('a successful PEER auth runs none of the agent path', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const c = await open(port, PEER_AUTH);
    await delay(150);

    expect(c.types()).toEqual(['auth_ok']);
    expect(c.seen[0]!.peer).toBe('partner');

    // The alias is a PEER, not an agent: it must be in neither the agent index
    // nor the agents table, and no agent row may have been touched for it.
    expect(handle.peerIndex.get('partner')).toBeDefined();
    expect(handle.agentIndex.get('partner')).toBeUndefined();
    expect(getAgentById(db, 'partner')).toBe(null);
    c.ws.close();
  }, 20_000);

  // ORDER, on one socket, which is where it is observable: auth_ok carries the
  // queued COUNT, so it must reach the client before the queue is drained —
  // otherwise a client learns "you have 1 waiting" after the one has arrived.
  it('auth_ok precedes the drained queue, and reports its size', async () => {
    const port = nextPort();
    insertMessage(db, {
      id: 'queued-1', kind: 'direct', from_agent: 'watcher', to_agent: 'a-one',
      payload: 'waiting', sent_at: Date.now(),
    });
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const c = await open(port, { type: 'auth', agent_id: 'a-one', token: 'tok-a' });
    await delay(200);

    expect(c.types()).toEqual(['auth_ok', 'deliver']);
    expect(c.seen[0]!.queued).toBe(1);
    // `msg_id`, read off buildDeliverFrame — a first draft asserted `id`,
    // which is the column name, not the wire name.
    expect(c.seen[1]!.msg_id).toBe('queued-1');
    c.ws.close();
  }, 20_000);

  // An authenticated socket must survive the 5s AUTH_TIMEOUT. The wait is real,
  // because a fast test cannot see this at all.
  //
  // WHAT THIS TEST CAN AND CANNOT DISCRIMINATE, measured rather than claimed.
  // I first wrote it as "the timer is disarmed" and it is not that test: the
  // property is defended TWICE — `clearTimeout(authTimer)` runs on the first
  // frame whatever the outcome, and the timer callback itself is guarded by
  // `if (!authed)`. Removing either one alone leaves this GREEN (both mutants
  // run: 9/0 each). Only removing BOTH reds it.
  //
  // That redundancy is worth knowing before the cut rather than after: an
  // extraction that moves the clearTimeout into the extracted function does not
  // break the property, because the guard still holds it. So this pins the
  // OUTCOME an operator cares about and does not pretend to pin a mechanism.
  it('an authenticated socket survives the auth timeout', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const c = await open(port, { type: 'auth', agent_id: 'a-one', token: 'tok-a' });
    await delay(200);
    expect(c.types()).toEqual(['auth_ok']);

    // Past the 5s AUTH_TIMEOUT. The socket must still be open and must not have
    // been sent a timeout error.
    await delay(5200);
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
    expect(c.types()).toEqual(['auth_ok']);
    c.ws.close();
  }, 30_000);

  // Only the FIRST frame is processed pre-auth. A second auth attempt on the
  // same unauthenticated socket must be ignored entirely — not answered, not
  // refused twice.
  it('a refused auth answers exactly once and processes nothing after', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const c = await open(port, { type: 'auth', agent_id: 'a-one', token: 'WRONG' });
    await delay(60);
    // A second frame arrives on a socket the server is closing.
    try { c.ws.send(JSON.stringify({ type: 'auth', agent_id: 'a-one', token: 'tok-a' })); } catch { /* closing */ }
    await delay(200);

    expect(c.types()).toEqual(['error']);
    expect(c.seen[0]!.code).toBe('AUTH_FAILED');
    // C9: the refusal is the SAME for a wrong token and an unknown id, and the
    // seam must keep it that way when the two arms move into separate
    // functions — the moment they are separate functions is the moment they
    // can drift apart.
    expect(c.seen[0]!.message).toBe('unknown agent');
    expect(getAgentById(db, 'a-one')!.online).toBe(0);
  }, 20_000);

  it('an unknown agent id is refused identically to a wrong token', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);

    const unknown = await open(port, { type: 'auth', agent_id: 'no-such-agent', token: 'tok-a' });
    const wrong = await open(port, { type: 'auth', agent_id: 'a-one', token: 'WRONG' });
    await delay(200);

    // Byte-for-byte, not field-by-field: an added field would be a new
    // distinction and is exactly what C9 forbids here.
    expect(JSON.stringify(unknown.seen)).toBe(JSON.stringify(wrong.seen));
    unknown.ws.close(); wrong.ws.close();
  }, 20_000);

  // The two arms are mutually exclusive by construction — the credential
  // decides which — and after the cut they are two functions that could both
  // run. Pinned from the outside: a peer credential must not produce an agent
  // identity, and an agent credential must not produce a peer one.
  it('the arms stay mutually exclusive', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);

    const agent = await open(port, { type: 'auth', agent_id: 'a-one', token: 'tok-a' });
    const peer = await open(port, PEER_AUTH);
    await delay(200);

    expect(handle.agentIndex.has('a-one')).toBe(true);
    expect(handle.peerIndex.has('a-one')).toBe(false);
    expect(handle.peerIndex.has('partner')).toBe(true);
    expect(handle.agentIndex.has('partner')).toBe(false);
    agent.ws.close(); peer.ws.close();
  }, 20_000);

  // THE DISCRIMINATOR IS THE CREDENTIAL, NEVER THE CLIENT'S FIELD — the arm's
  // own words, and the property most at risk from this cut: two named functions
  // invite a dispatcher above them, and the obvious dispatcher reads a field.
  // A frame that CLAIMS to be a peer while presenting an agent credential must
  // authenticate as the agent.
  it('a claimed peer field does not choose the arm — the credential does', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const c = await open(port, {
      type: 'auth', agent_id: 'a-one', token: 'tok-a',
      peer: 'partner', protocol: PEER_PROTOCOL_VERSION,   // both ignored
    });
    await delay(200);

    expect(c.types()).toEqual(['auth_ok']);
    expect(c.seen[0]!.agent_id).toBe('a-one');
    expect(c.seen[0]!.peer).toBeUndefined();
    expect(handle.agentIndex.has('a-one')).toBe(true);
    expect(handle.peerIndex.has('partner')).toBe(false);
    c.ws.close();
  }, 20_000);

  // THE CALL-SITE CLEAR IS THE WHOLE DEFENCE, so the thing to pin is that there
  // is only one call site and that it clears.
  //
  // The peer arm used to clear the auth timer a second time. It was a no-op —
  // measured: the black-box test above passes identically with and without it,
  // because the property is defended twice (this clear AND the timer callback's
  // own `!state.authed` guard). It is deleted rather than frozen by a test that
  // cannot discriminate it. What replaces it is this: read the source, find
  // every call of handleAuthFrame, and require that the block making the call
  // clears the timer first.
  //
  // WHAT THIS CANNOT SEE, said because it is a source scan and those overstate:
  // it reads call sites by name, so a call reached through an alias or a
  // dynamic dispatch is invisible to it. That is acceptable while the function
  // is module-private with one caller — which is exactly what the first
  // assertion pins, and the assertion fails the moment it stops being true.
  it('handleAuthFrame has ONE call site, and that site clears the auth timer', async () => {
    const src = await Bun.file(join(import.meta.dir, '../ws-server.ts')).text();
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // The definition is `function handleAuthFrame(`; a call is any other
    // occurrence followed by `(`.
    const occurrences = [...code.matchAll(/\bhandleAuthFrame\s*\(/g)];
    const definitions = [...code.matchAll(/function\s+handleAuthFrame\s*\(/g)];
    expect(definitions.length).toBe(1);
    expect(occurrences.length - definitions.length).toBe(1);

    // ...and the call is preceded, in the same block, by the clear. Sliced
    // backwards from the call to the enclosing `if (!state.authed) {`, so this
    // is about the path INTO the function rather than about the whole file
    // happening to contain a clearTimeout somewhere.
    const callIdx = code.lastIndexOf('handleAuthFrame(');
    const blockIdx = code.lastIndexOf('if (!state.authed) {', callIdx);
    expect(blockIdx).toBeGreaterThan(-1);
    expect(code.slice(blockIdx, callIdx)).toContain('clearTimeout(authTimer)');
  });

  // `authed` (a captured local) and `state.authed` (on the registry row) are
  // set together at both assignment sites and read by different consumers: the
  // local by the pre-auth guard and the auth timer, the field by the presence
  // fan-out and the close handler. The cut removes the local, so this pins that
  // the two consumers agree — which is the property that made the removal safe.
  it('the pre-auth guard and the presence fan-out agree about who is authed', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);

    // The watcher is authed and may see a-one's presence.
    const watcher = await open(port, { type: 'auth', agent_id: 'watcher', token: 'tok-w' });
    await delay(120);
    const agent = await open(port, { type: 'auth', agent_id: 'a-one', token: 'tok-a' });
    await delay(200);

    // The fan-out reached the watcher (it reads state.authed), and the agent's
    // own socket was past the pre-auth guard (it reads the local) — the same
    // fact, observed through both consumers in one run.
    const statuses = watcher.seen.filter(f => f.type === 'agent_status');
    expect(statuses.map(f => [f.agent_id, f.online])).toEqual([['a-one', true]]);
    expect(agent.types()).toEqual(['auth_ok']);
    watcher.ws.close(); agent.ws.close();
  }, 20_000);
});
