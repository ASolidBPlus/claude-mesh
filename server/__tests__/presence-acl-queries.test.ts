import { describe, it, expect } from 'bun:test';
import { openDb, registerAgent, aclGrant, aclRelated, listAclPeers, listAgents } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// #11 — presence was O(n) ACL QUERIES per event: broadcastStatus called
// aclRelated once per connected peer, and list_presence once per registered
// agent. Both now compute the ACL-related set in ONE query and filter the
// registry in memory.
//
// The cost assertion is the mutant-killer, so it is written as "does not grow
// with N" rather than "is fast": a timing test would pass on a fast machine
// with the loop restored, and a fixed-number test would pin an incidental
// constant. Growth is the actual defect.

let portCounter = 19900;
function nextPort() { return portCounter++; }

/** Wraps db.prepare to count EXECUTIONS of statements touching the acl table.
 *  Counts executions, not prepares, so it stays honest if statements are ever
 *  cached and reused. */
function countAclQueries(db: Database): { count: () => number; reset: () => void } {
  let n = 0;
  const realPrepare = db.prepare.bind(db);
  (db as unknown as { prepare: typeof realPrepare }).prepare = ((sql: string) => {
    const stmt = realPrepare(sql);
    if (!/\bacl\b/i.test(sql)) return stmt;
    return new Proxy(stmt, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v === 'function' && (prop === 'all' || prop === 'get' || prop === 'run')) {
          return (...args: unknown[]) => { n++; return (v as Function).apply(target, args); };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  }) as typeof realPrepare;
  return { count: () => n, reset: () => { n = 0; } };
}

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function authConnect(port: number, id: string, token: string): Promise<WebSocket> {
  return connectWs(port).then(ws => new Promise<WebSocket>((resolve) => {
    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === 'auth_ok') resolve(ws);
    });
    ws.send(JSON.stringify({ type: 'auth', agent_id: id, token }));
  }));
}

function wait(ms: number) { return new Promise(r => setTimeout(r, ms)); }

/** Seed a hub agent plus `peers` agents, all ACL-related to the hub. */
function seed(db: Database, peers: number): string[] {
  registerAgent(db, { id: 'hub', token_hash: hashToken('tok-hub'), hostname: 'h' });
  const ids: string[] = [];
  for (let i = 0; i < peers; i++) {
    const id = `peer-${i}`;
    registerAgent(db, { id, token_hash: hashToken(`tok-${id}`), hostname: 'h' });
    // Alternate direction so the inbound half of the union is exercised too.
    if (i % 2 === 0) aclGrant(db, 'hub', id, 'system');
    else aclGrant(db, id, 'hub', 'system');
    ids.push(id);
  }
  return ids;
}

async function aclQueriesForConnectEvent(peers: number): Promise<number> {
  const db = openDb(':memory:');
  const port = nextPort();
  const filesDir = mkdtempSync(join(tmpdir(), 'mesh-11-'));
  const handle: WsServerHandle = await startWsServer(port, db, 10_485_760, filesDir);
  const ids = seed(db, peers);
  const sockets: WebSocket[] = [];
  try {
    for (const id of ids) sockets.push(await authConnect(port, id, `tok-${id}`));
    await wait(50);

    // Measure ONLY the hub's connect, which fires one presence broadcast to a
    // registry holding `peers` connected, ACL-related agents.
    const counter = countAclQueries(db);
    counter.reset();
    sockets.push(await authConnect(port, 'hub', 'tok-hub'));
    await wait(80);
    return counter.count();
  } finally {
    for (const ws of sockets) { try { ws.close(); } catch { /* ignore */ } }
    await handle.shutdown().catch(() => {});
    db.close();
  }
}

describe('#11: presence ACL cost does not grow with the number of peers', () => {
  it('one presence event costs the same number of ACL queries at 2 peers and at 6', async () => {
    const small = await aclQueriesForConnectEvent(2);
    const large = await aclQueriesForConnectEvent(6);

    // The defect was linear growth. With the per-peer loop restored this is
    // 2 vs 6; with the single query it is flat.
    expect(large).toBe(small);
    // And flat at a small constant, so "equal" can't be satisfied by both
    // being large — the positive control on the equality above.
    expect(large).toBeLessThanOrEqual(2);
  }, 20_000);

  it('list_presence costs one ACL query regardless of roster size', () => {
    const db = openDb(':memory:');
    seed(db, 8);
    const counter = countAclQueries(db);
    counter.reset();

    // The exact work handleListPresence does for its ACL filter.
    const peers = listAclPeers(db, 'hub');
    const roster = listAgents(db).filter(a => a.id === 'hub' || peers.has(a.id));

    expect(counter.count()).toBe(1);
    expect(roster.length).toBe(9); // hub + 8 peers
    db.close();
  });
});

describe('#11: the single query returns exactly the old per-peer answer', () => {
  it('agrees with aclRelated on a fixture with mixed edge directions', () => {
    const db = openDb(':memory:');
    for (const id of ['hub', 'out-only', 'in-only', 'both', 'unrelated', 'other-pair-a', 'other-pair-b']) {
      registerAgent(db, { id, token_hash: hashToken(`t-${id}`), hostname: 'h' });
    }
    aclGrant(db, 'hub', 'out-only', 'system');       // outbound edge
    aclGrant(db, 'in-only', 'hub', 'system');        // inbound edge
    aclGrant(db, 'hub', 'both', 'system');           // both directions
    aclGrant(db, 'both', 'hub', 'system');
    aclGrant(db, 'other-pair-a', 'other-pair-b', 'system'); // unrelated to hub

    const all = listAgents(db).map(a => a.id);
    const viaSingleQuery = listAclPeers(db, 'hub');
    // The reference implementation the loop used, kept for exactly this.
    const viaPerPeer = new Set(all.filter(id => id !== 'hub' && aclRelated(db, 'hub', id)));

    expect([...viaSingleQuery].sort()).toEqual([...viaPerPeer].sort());
    // Pinned literally too, so a bug in BOTH implementations can't agree its
    // way to green.
    expect([...viaSingleQuery].sort()).toEqual(['both', 'in-only', 'out-only']);
    db.close();
  });

  it('excludes self even when a self-edge exists', () => {
    const db = openDb(':memory:');
    registerAgent(db, { id: 'solo', token_hash: hashToken('t-solo'), hostname: 'h' });
    aclGrant(db, 'solo', 'solo', 'system');
    expect([...listAclPeers(db, 'solo')]).toEqual([]);
    db.close();
  });
});

describe('#11: the self-edge diagonal — the one intended behaviour delta', () => {
  // registry is keyed by SOCKET, so an agent holding a second live connection
  // appears in it twice. Before #11, an agent with a self-edge row in acl had
  // aclRelated(A, A) === true, so its own status frame went to its other
  // socket. listAclPeers excludes self, so it no longer does.
  //
  // Pinned rather than merely stated: replacing a pairwise predicate with set
  // membership is exact only OFF the diagonal, and this is the diagonal.
  it('an agent with a self-edge and two sockets does not receive its own status', async () => {
    const db = openDb(':memory:');
    const port = nextPort();
    const filesDir = mkdtempSync(join(tmpdir(), 'mesh-11-self-'));
    const handle: WsServerHandle = await startWsServer(port, db, 10_485_760, filesDir);
    registerAgent(db, { id: 'twin', token_hash: hashToken('tok-twin'), hostname: 'h' });
    aclGrant(db, 'twin', 'twin', 'system'); // the diagonal row

    const first = await authConnect(port, 'twin', 'tok-twin');
    const seen: unknown[] = [];
    first.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'agent_status') seen.push(m);
    });
    await wait(50);

    // Second socket for the SAME agent: its connect fires a presence broadcast
    // with the new socket excluded, so the first socket is the only candidate.
    const second = await authConnect(port, 'twin', 'tok-twin');
    await wait(120);

    expect(seen).toEqual([]);

    try { first.close(); second.close(); } catch { /* ignore */ }
    await handle.shutdown().catch(() => {});
    db.close();
  }, 20_000);

  it('positive control: a DIFFERENT agent with an edge does receive it', async () => {
    // Without this, the assertion above would pass just as well if presence
    // broadcasting were broken entirely.
    const db = openDb(':memory:');
    const port = nextPort();
    const filesDir = mkdtempSync(join(tmpdir(), 'mesh-11-ctl-'));
    const handle: WsServerHandle = await startWsServer(port, db, 10_485_760, filesDir);
    registerAgent(db, { id: 'watcher', token_hash: hashToken('tok-watcher'), hostname: 'h' });
    registerAgent(db, { id: 'subject', token_hash: hashToken('tok-subject'), hostname: 'h' });
    aclGrant(db, 'watcher', 'subject', 'system');

    const w = await authConnect(port, 'watcher', 'tok-watcher');
    const seen: { agent_id: string }[] = [];
    w.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'agent_status') seen.push(m);
    });
    await wait(50);

    const s2 = await authConnect(port, 'subject', 'tok-subject');
    await wait(120);

    expect(seen.map(m => m.agent_id)).toContain('subject');

    try { w.close(); s2.close(); } catch { /* ignore */ }
    await handle.shutdown().catch(() => {});
    db.close();
  }, 20_000);
});

describe('#11: the reverse index serves the queries it was added for', () => {
  // Asserted on the UNION and on listInboundAcl — NOT on aclRelated. The issue
  // claimed aclRelated's reversed OR arm was unindexed; it is not. That arm
  // swaps the ARGUMENTS, not the columns, so the (from_agent, to_agent) PK
  // serves both arms, and a plan assertion there would pass identically with
  // and without the index — proving nothing.
  function plan(db: Database, sql: string, ...params: unknown[]): string {
    return (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params as never[]) as { detail: string }[])
      .map(r => r.detail).join(' | ');
  }

  const UNION_SQL =
    `SELECT to_agent AS peer FROM acl WHERE from_agent = ? UNION SELECT from_agent AS peer FROM acl WHERE to_agent = ?`;
  const INBOUND_SQL = 'SELECT * FROM acl WHERE to_agent = ?';

  it('the peer-set union searches the reverse index instead of scanning', () => {
    const db = openDb(':memory:');
    const p = plan(db, UNION_SQL, 'x', 'x');
    expect(p).toContain('idx_acl_reverse');
    expect(p).not.toContain('SCAN acl');
    db.close();
  });

  it('listInboundAcl searches it too — a bare SCAN before this index existed', () => {
    const db = openDb(':memory:');
    const p = plan(db, INBOUND_SQL, 'x');
    expect(p).toContain('idx_acl_reverse');
    expect(p).not.toContain('SCAN acl');
    db.close();
  });

  it('positive control: without the index these plans DO scan', () => {
    // Without this, the two assertions above could pass for reasons unrelated
    // to the index (e.g. SQLite choosing the PK), and dropping the migration
    // would look harmless.
    const db = openDb(':memory:');
    db.exec('DROP INDEX IF EXISTS idx_acl_reverse');
    expect(plan(db, UNION_SQL, 'x', 'x')).toContain('SCAN acl');
    expect(plan(db, INBOUND_SQL, 'x')).toContain('SCAN acl');
    db.close();
  });
});
