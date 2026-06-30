import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  openDb,
  registerAgent,
  aclGrant,
  unsubscribe,
  getTopicSubscribers,
} from '../../server/db.ts';
import { generateToken, hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MeshClient, Inbound } from '../src/index.ts';

// Use a port range distinct from client.test.ts (which starts at 19500).
let portCounter = 21500;
function nextPort() { return portCounter++; }
function urlFor(port: number) { return `ws://127.0.0.1:${port}`; }
function delay(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

// Resolves on the next fresh `connect` event (or one already pending). Re-armable
// so the same hook can wait through several reconnects.
function makeConnectWaiter(client: MeshClient) {
  let resolveFn: (() => void) | null = null;
  let fired = false;
  client.on('connect', () => {
    fired = true;
    if (resolveFn) { resolveFn(); resolveFn = null; fired = false; }
  });
  return {
    next(): Promise<void> {
      if (fired) { fired = false; return Promise.resolve(); }
      return new Promise<void>((res) => { resolveFn = res; });
    },
  };
}

describe('MeshClient reconnect robustness', () => {
  let db: Database;
  let handle: WsServerHandle;
  let port: number;
  let filesDir: string;
  const clients: MeshClient[] = [];

  let tokenA: string;
  let tokenB: string;

  function newClient(agentId: string, token: string): MeshClient {
    const c = new MeshClient({ serverUrl: urlFor(port), agentId, agentToken: token });
    clients.push(c);
    return c;
  }

  beforeEach(async () => {
    db = openDb(':memory:');
    port = nextPort();
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-reconnect-test-'));

    tokenA = generateToken();
    tokenB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hostA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hostB' });
    // C is registered but never connected — used as an allowed-but-offline
    // request target so a request to it queues server-side and only ever
    // settles via the client's own timeout (never an error frame).
    registerAgent(db, { id: 'C', token_hash: hashToken(generateToken()), hostname: 'hostC' });

    handle = await startWsServer(port, db, 10_485_760, filesDir);
  });

  afterEach(async () => {
    for (const c of clients) c.close();
    clients.length = 0;
    await handle.shutdown().catch(() => {});
    db.close();
  });

  // ── Test 1 ───────────────────────────────────────────────────────────
  // ISOLATED proof that the CLIENT replays its tracked subscriptions on
  // reconnect, independent of server-side persistence.
  //
  // The existing `client.test.ts` reconnect test restarts the server with the
  // SAME in-memory db, so the `subscriptions` row survives the restart — that
  // test would pass even if the client never re-sent a `subscribe` frame.
  // Here we DELETE the server-side subscription row during the down-window, so
  // after reconnect the only way "B" can be a subscriber of "t" again — and the
  // only way the publish can be delivered — is if the client re-sent `subscribe`
  // on `auth_ok`.
  it('re-subscribes on reconnect (isolated from server-side persistence)', async () => {
    aclGrant(db, 'A', 'B', 'system');
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);

    const bConnect = makeConnectWaiter(b);
    await b.connect();
    await a.connect();
    await b.subscribe('t'); // resolves on ack; server row now exists

    // sanity: B really is a server-side subscriber before the restart
    expect(getTopicSubscribers(db, 't')).toContain('B');

    // Restart the server on the SAME port, but REMOVE the server-side
    // subscription while it is down. The `topics` row remains (FK), so a
    // replayed client `subscribe` will succeed and re-create the row.
    await handle.shutdown();
    unsubscribe(db, 'B', 't');
    expect(getTopicSubscribers(db, 't')).not.toContain('B');
    handle = await startWsServer(port, db, 10_485_760, filesDir);

    // Wait for B to reconnect (and thus replay its subscription), and A to
    // reconnect so it can publish.
    await bConnect.next();
    await delay(1500);

    // The client replay must have re-created the server-side subscription.
    expect(getTopicSubscribers(db, 't')).toContain('B');

    // And delivery resumes — only possible because the client re-subscribed.
    const got = new Promise<Inbound>((resolve) => { b.onMessage(resolve); });
    await a.publish('t', 'again');
    const msg = await got;
    expect(msg.kind).toBe('topic');
    expect(msg.topic).toBe('t');
    expect(msg.text).toBe('again');
  }, 15000);

  // ── Test 2 ───────────────────────────────────────────────────────────
  // An in-flight request that spans a forced reconnect must settle
  // DETERMINISTICALLY (no hang), exactly once, and must not leave a stale timer
  // that double-settles or disrupts later requests. We also assert that the
  // request still works normally once the client has reconnected.
  //
  // NOTE on actual behaviour: dropping the socket does NOT itself reject a
  // pending request (the client only clears pendingRequests on explicit
  // `close()`); the request's own timeout timer survives the reconnect and is
  // what settles it. With a small timeoutMs this is fast and deterministic —
  // it rejects with `request timeout`, never hangs, and never double-settles.
  it('in-flight request across a forced reconnect settles once and never hangs', async () => {
    aclGrant(db, 'A', 'B', 'system');
    aclGrant(db, 'B', 'A', 'system');
    aclGrant(db, 'A', 'C', 'system'); // allowed-but-offline target for the in-flight request
    const a = newClient('A', tokenA);
    const b = newClient('B', tokenB);

    const aConnect = makeConnectWaiter(a);
    // B answers any request it sees (used for the post-reconnect normal request).
    b.onMessage((m) => {
      if (m.kind === 'request' && m.correlationId) {
        b.send('A', 'ans', { kind: 'response', correlationId: m.correlationId });
      }
    });
    await b.connect();
    await a.connect();

    // Start a request to C (registered+allowed but OFFLINE, so it is queued and
    // never answered), then immediately drop A's socket so the request is
    // in-flight across the reconnect.
    let settleCount = 0;
    let outcome: string = 'pending';
    const inflight = a
      .request('C', 'q?', { timeoutMs: 500 })
      .then(
        () => { settleCount++; outcome = 'resolved'; },
        (e) => { settleCount++; outcome = 'rejected:' + (e as Error).message; },
      );

    // Force-close the underlying socket → drives the real reconnect path.
    (a as unknown as { ws: { close: () => void } }).ws.close();

    // It must settle (not hang). With the small timeout it rejects deterministically.
    await inflight;
    expect(settleCount).toBe(1);
    expect(outcome).toBe('rejected:request timeout');

    // Give the old timer's window time to (not) fire a second time and let A reconnect.
    await aConnect.next();
    await delay(800);

    // The promise did not double-settle from any stale timer.
    expect(settleCount).toBe(1);

    // A subsequent normal request works after reconnect — no leaked correlation
    // state from the aborted one. (B answers this one.)
    const res = await a.request('B', 'q2?', { timeoutMs: 3000 });
    expect(res.kind).toBe('response');
    expect(res.text).toBe('ans');
  }, 15000);

  // ── Test 2b ──────────────────────────────────────────────────────────
  // close() rejects and clears EVERY pending map (requests, acks, reminds,
  // reminderLists) with `client closed`, leaving no leaks.
  it('close() rejects and clears all pending waiters with no leaks', async () => {
    aclGrant(db, 'A', 'C', 'system'); // C is offline → request queues, never answers
    const a = newClient('A', tokenA);
    await a.connect();

    const results: string[] = [];
    const collect = (label: string, p: Promise<unknown>) =>
      p.then(
        () => results.push(label + ':resolved'),
        (e) => results.push(label + ':' + (e as Error).message),
      );

    // (a) A genuinely-pending request: target C is registered + ACL-allowed but
    // OFFLINE, so the server queues it and never sends a response. It sits in
    // pendingRequests (with a live 30s timeout timer) until close() clears it.
    const reqP = collect('req', a.request('C', 'q?', { timeoutMs: 30_000 }));

    // (b) The send/remind/listReminders ack-style waiters are normally cleared
    // the instant the (in-process, same-tick) server acks them, so they cannot
    // be observed "pending" deterministically. Seed those three maps directly
    // with settler objects to prove close() rejects AND clears every map — this
    // exercises the exact close() teardown code for acks, reminds, and lists.
    const internals = a as unknown as {
      pendingRequests: Map<string, unknown>;
      pendingAcks: Map<string, { resolve: () => void; reject: (e: Error) => void }>;
      pendingReminds: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
      pendingReminderLists: Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>;
    };
    const ackP = new Promise<void>((resolve, reject) => {
      internals.pendingAcks.set('seed-ack', { resolve, reject });
    });
    const remindP = new Promise<unknown>((resolve, reject) => {
      internals.pendingReminds.set('seed-remind', { resolve, reject });
    });
    const listP = new Promise<unknown>((resolve, reject) => {
      internals.pendingReminderLists.set('seed-list', { resolve, reject });
    });
    const all = Promise.all([
      reqP,
      collect('ack', ackP),
      collect('remind', remindP),
      collect('list', listP),
    ]);

    // All four maps are non-empty before close().
    expect(internals.pendingRequests.size).toBe(1);
    expect(internals.pendingAcks.size).toBe(1);
    expect(internals.pendingReminds.size).toBe(1);
    expect(internals.pendingReminderLists.size).toBe(1);

    a.close();
    await all;

    // Every waiter rejected with `client closed` — none resolved, none hung.
    expect(results.sort()).toEqual(
      ['ack:client closed', 'list:client closed', 'remind:client closed', 'req:client closed'].sort(),
    );

    // All maps cleared — no leaks.
    expect(internals.pendingRequests.size).toBe(0);
    expect(internals.pendingAcks.size).toBe(0);
    expect(internals.pendingReminds.size).toBe(0);
    expect(internals.pendingReminderLists.size).toBe(0);
  }, 15000);

  // ── Test 3 ───────────────────────────────────────────────────────────
  // A reconnect (with its repeated `connect` events) must NOT re-settle the
  // original connect() promise. connect() resolves exactly once even though the
  // 'connect' event fires again on every successful re-auth.
  it('connect() settles once even across a reconnect that re-fires connect', async () => {
    const a = newClient('A', tokenA);

    let connectEventCount = 0;
    // Resolves on the NEXT connect event after it is armed (used to await the
    // reconnect specifically, not the initial connect).
    let reconnectResolve: (() => void) | null = null;
    a.on('connect', () => {
      connectEventCount++;
      if (reconnectResolve) { const r = reconnectResolve; reconnectResolve = null; r(); }
    });

    // connect() must resolve exactly once; wrap it to count settlements.
    let connectSettleCount = 0;
    await a.connect().then(() => { connectSettleCount++; });
    expect(connectSettleCount).toBe(1);
    expect(connectEventCount).toBe(1);

    // Arm the reconnect waiter, then force a reconnect by restarting the server
    // on the same port.
    const reconnected = new Promise<void>((res) => { reconnectResolve = res; });
    await handle.shutdown();
    handle = await startWsServer(port, db, 10_485_760, filesDir);

    // The 'connect' event fires again on re-auth (backoff can take ~0.5–0.8s)...
    await reconnected;
    expect(connectEventCount).toBeGreaterThanOrEqual(2);

    // ...but the original connect() promise did not re-settle.
    await delay(200);
    expect(connectSettleCount).toBe(1);
  }, 15000);
});
