import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  openDb, registerAgent, aclGrant, insertOutboundPeer, getOutboundPeer,
  drainOutbound, expireStaleOutbound, markMessageFailed, countPendingMessages,
  listOutboundPeers, getMessage,
} from '../db.ts';
import { routeDirect } from '../router.ts';
import { RELAY_DEDUPE_MS } from '../cleanup.ts';
import { startBorder, forwarders, borderEvents } from '../border.ts';
import { renderMetrics, setPeerUpSource } from '../metrics.ts';
import { Database } from 'bun:sqlite';
import type { WebSocket } from 'ws';
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWsServer } from '../ws-server.ts';
import { upsertPeer, aclCheck } from '../db.ts';
import { hashToken } from '../auth.ts';

// F2b — the OUTBOUND border. Tests here cover the parts that do not need a
// second live server: the drain query and its plan, the stale-window rule, the
// outcome taxonomy's effect on rows, the boot path in BOTH directions, and the
// protocol-version enumeration.

let db: Database;

beforeEach(() => {
  db = openDb(':memory:');
  registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });
});
afterEach(() => {
  for (const f of forwarders.values()) f.stop();
  forwarders.clear();
  borderEvents.removeAllListeners();
  db.close();
});

function peering(alias: string, rate = 600): void {
  insertOutboundPeer(db, {
    alias, url: `ws://${alias}.example:7300`, token: 'SECRET-TOKEN-VALUE',
    assigned_alias: 'us', kinds: '["direct"]', rate_per_min: rate, created_at: Date.now(),
  });
}
function queue(alias: string, id: string): void {
  routeDirect(db, new Map(), 'sender', {
    type: 'send', msg_id: id, to: `${alias}:them`, payload: 'p', content_type: 'text/plain',
  } as never);
}

describe('F2b: the drain query', () => {
  it('is served by the to_agent index — SEARCH, no SCAN', () => {
    // The ORDER BY's temp b-tree is EXPECTED and is not a failure: asserting
    // the absence of temp structures would red for a reason unrelated to the
    // property under test, which is that the range does not full-scan.
    const plan = (db.prepare(
      `EXPLAIN QUERY PLAN
       SELECT * FROM messages
       WHERE to_agent >= ? AND to_agent < ?
         AND delivered_at IS NULL AND failed_code IS NULL
         AND (expires_at IS NULL OR expires_at >= ?)
         AND sent_at >= ?
       ORDER BY sent_at LIMIT ?`
    ).all('far:', 'far;', 0, 0, 10) as { detail: string }[]).map(r => r.detail).join(' | ');

    expect(plan).toContain('idx_messages_to_agent');
    expect(plan).not.toContain('SCAN');
  });

  it('returns only rows that are pending, unexpired, unfailed and inside the window', () => {
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');
    for (const id of ['ok', 'failed', 'delivered', 'stale']) queue('far', id);

    markMessageFailed(db, 'failed', 'RELAY_REFUSED', Date.now());
    db.prepare('UPDATE messages SET delivered_at = ? WHERE id = ?').run(Date.now(), 'delivered');
    db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(Date.now() - RELAY_DEDUPE_MS - 5000, 'stale');

    const rows = drainOutbound(db, 'far', Date.now(), RELAY_DEDUPE_MS, 100);
    expect(rows.map(r => r.id)).toEqual(['ok']);
  });

  it('a BYSTANDER alias is not drained — the prefix range is exact', () => {
    // 'far' must not drain 'farther'. A bare >= without the upper bound, or a
    // LIKE pattern, would.
    peering('far'); peering('farther');
    aclGrant(db, 'sender', 'far:them', 'admin');
    aclGrant(db, 'sender', 'farther:them', 'admin');
    queue('far', 'a'); queue('farther', 'b');

    expect(drainOutbound(db, 'far', Date.now(), RELAY_DEDUPE_MS, 100).map(r => r.id)).toEqual(['a']);
  });
});

describe('F2b: the dedupe window bounds the sender too', () => {
  it('a row older than RELAY_DEDUPE_MS is EXPIRED, never sent', () => {
    // The receiver forgets a remote msg_id after this window, so re-sending an
    // older row would be delivered a SECOND time. The two bounds are the same
    // constant on purpose.
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');
    queue('far', 'old');
    db.prepare('UPDATE messages SET sent_at = ? WHERE id = ?').run(Date.now() - RELAY_DEDUPE_MS - 5000, 'old');
    expect(countPendingMessages(db)).toBe(1);

    const expired = expireStaleOutbound(db, 'far', Date.now(), RELAY_DEDUPE_MS);

    expect(expired).toBe(1);
    expect(countPendingMessages(db)).toBe(0);
  });

  it('positive control: a row INSIDE the window is untouched', () => {
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');
    queue('far', 'fresh');

    expect(expireStaleOutbound(db, 'far', Date.now(), RELAY_DEDUPE_MS)).toBe(0);
    expect(countPendingMessages(db)).toBe(1);
  });
});

describe('F2b: a permanent refusal stops the row being pending', () => {
  it('failed_code + expires_at, and countPendingMessages excludes it', () => {
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');
    queue('far', 'refused');
    expect(countPendingMessages(db)).toBe(1);

    markMessageFailed(db, 'refused', 'RELAY_REFUSED', Date.now());

    const row = getMessage(db, 'refused')!;
    expect(row.failed_code).toBe('RELAY_REFUSED');
    // The row records WHY, rather than pretending it was delivered.
    expect(row.delivered_at).toBeNull();
    expect(countPendingMessages(db)).toBe(0);
  });
});

describe('F2b: the boot path — pinned in BOTH directions', () => {
  // A boot property pinned only in the starts-nothing direction is satisfied by
  // code that can never start. Both halves, or neither means anything.

  it('starts one forwarder per ENABLED row and none for a disabled one', () => {
    peering('one'); peering('two'); peering('paused');
    db.prepare('UPDATE outbound_peers SET enabled = 0 WHERE alias = ?').run('paused');

    const border = startBorder(db, new Map<string, WebSocket>());
    try {
      expect([...forwarders.keys()].sort()).toEqual(['one', 'two']);
    } finally {
      border.stopAll();
    }
  });

  it('the F2a inert property survives: no registry means nothing starts', () => {
    // startHttpAdmin's registry defaults to {} — no `create` — which is what
    // makes POST /outbound-peers answer 503. This pins that F2b did not
    // accidentally make the front half live by another route.
    peering('one');
    expect(forwarders.size).toBe(0);
  });
});

describe('F2b: mesh_peer_up is 0 or 1 for every CONFIGURED peering (#108)', () => {
  it('emits a 0 series for a configured-but-disconnected peering', () => {
    // The defect this closes: a gauge emitted only when up VANISHES on
    // disconnect, and you cannot alert on an absent series — "no data" is
    // indistinguishable from "never configured". The alert an operator wants
    // is "this went to 0", which requires the 0 to exist.
    peering('down-peer');
    setPeerUpSource(() => listOutboundPeers(db).map(r => ({ alias: r.alias, up: false })));
    try {
      expect(renderMetrics(db)).toContain('mesh_peer_up{alias="down-peer"} 0');
    } finally {
      setPeerUpSource(() => []);
    }
  });

  it('positive control: a connected peering emits 1', () => {
    peering('up-peer');
    setPeerUpSource(() => listOutboundPeers(db).map(r => ({ alias: r.alias, up: true })));
    try {
      expect(renderMetrics(db)).toContain('mesh_peer_up{alias="up-peer"} 1');
    } finally {
      setPeerUpSource(() => []);
    }
  });
});

describe('F2b: the protocol version has exactly ONE definition', () => {
  // ENUMERATION BY VALUE across server/ and client/, not by the sites anyone
  // named. Grepping the IDENTIFIER finds only the sites already doing the right
  // thing — every site that needs fixing is invisible to that search, which is
  // how the third site (registration's 201 body) was missed the first time.
  //
  // A mutant re-introducing a literal at any reader is what this exists to
  // prevent.
  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === '__tests__') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
      else if (name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('exactly one definition, and no bare `protocol: <number>` literal anywhere', () => {
    const root = join(import.meta.dir, '..', '..');
    const files = [...sourceFiles(join(root, 'server')), ...sourceFiles(join(root, 'client', 'src'))];
    expect(files.length).toBeGreaterThan(5);   // the walk found something

    const defs: string[] = [];
    const literals: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (/export const PEER_PROTOCOL_VERSION\s*=/.test(src)) defs.push(f);
      // A literal in a `protocol:` position — the shape all three sites had.
      for (const m of src.matchAll(/protocol:\s*(\d+)/g)) literals.push(`${f}: ${m[0]}`);
    }

    expect(defs.length).toBe(1);
    expect(defs[0]).toContain(join('client', 'src', 'protocol.ts'));
    expect(literals).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Two real servers in one process. A stub PeerClient would prove the
// forwarder's bookkeeping and nothing about the wire; these drive B's actual
// WS server, so the relay is refused or accepted by the code that ships.
// ════════════════════════════════════════════════════════════════════════════

describe('F2b: end to end over two servers', () => {
  let bDb: Database;
  let bHandle: Awaited<ReturnType<typeof startWsServer>>;
  let bPort: number;
  let border: ReturnType<typeof startBorder>;

  beforeEach(async () => {
    bPort = 23500 + Math.floor(Date.now() % 400);
    bDb = openDb(':memory:');
    bHandle = await startWsServer(bPort, bDb, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f2b-')));
    // B's side: an inbound peering for A, and a local recipient with an edge.
    registerAgent(bDb, { id: 'bob', token_hash: 'b'.repeat(64), hostname: 'h' });
    upsertPeer(bDb, {
      alias: 'ourmesh', token_hash: hashToken('PEER-TOKEN'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    aclGrant(bDb, 'ourmesh:sender', 'bob', 'admin');
  });
  afterEach(async () => {
    border?.stopAll();
    await bHandle.shutdown().catch(() => {});
    bDb.close();
  });

  function outboundToB(alias = 'far', rate = 600): void {
    insertOutboundPeer(db, {
      alias, url: `ws://127.0.0.1:${bPort}`, token: 'PEER-TOKEN',
      assigned_alias: 'ourmesh', kinds: '["direct"]', rate_per_min: rate, created_at: Date.now(),
    });
    aclGrant(db, 'sender', `${alias}:bob`, 'admin');
  }
  const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('relays a queued row and sets delivered_at ONLY on the peer ack', async () => {
    outboundToB();
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'e2e-1', to: 'far:bob', payload: 'hello', content_type: 'text/plain',
    } as never);
    // Queued, not delivered — acceptance meant "queued for the border" (D8).
    expect(getMessage(db, 'e2e-1')!.delivered_at).toBeNull();

    border = startBorder(db, new Map<string, WebSocket>());
    await wait(900);

    expect(getMessage(db, 'e2e-1')!.delivered_at).not.toBeNull();
    // It arrived at B with the FQ sender, and B stored it for its local agent.
    const arrived = bDb.prepare('SELECT from_agent, to_agent FROM messages').all() as
      { from_agent: string; to_agent: string }[];
    expect(arrived.length).toBe(1);
    expect(arrived[0]!.from_agent).toBe('ourmesh:sender');
    expect(arrived[0]!.to_agent).toBe('bob');
  }, 20_000);

  it('a row with NO edge at B is refused permanently — failed_code, not a retry loop', async () => {
    outboundToB();
    // Remove B's inbound edge so the relay is refused on arrival.
    bDb.prepare('DELETE FROM acl').run();
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'e2e-refused', to: 'far:bob', payload: 'p', content_type: 'text/plain',
    } as never);

    border = startBorder(db, new Map<string, WebSocket>());
    await wait(900);

    const row = getMessage(db, 'e2e-refused')!;
    expect(row.failed_code).toBe('RELAY_REFUSED');
    expect(row.delivered_at).toBeNull();
    // No longer pending: a permanent refusal is an outcome, not a pause.
    expect(countPendingMessages(db)).toBe(0);
  }, 20_000);

  it('a backlog drains without tripping the receiver — ZERO rate limits', async () => {
    // Sender-side pacing exists so we do not arrive at the receiver's limit and
    // get refused: the refusal costs a round trip AND counts against the
    // receiver's bucket, so being told to slow down is strictly worse than
    // having slowed down.
    outboundToB('far', 600);
    for (let i = 0; i < 120; i++) {
      routeDirect(db, new Map(), 'sender', {
        type: 'send', msg_id: `backlog-${i}`, to: 'far:bob', payload: 'p', content_type: 'text/plain',
      } as never);
    }

    border = startBorder(db, new Map<string, WebSocket>());
    await wait(1500);

    const metrics = renderMetrics(db);
    expect(metrics).not.toContain('outcome="rate_limited"');
    // And it made real progress rather than stalling.
    expect(countPendingMessages(db)).toBeLessThan(120);
  }, 20_000);

  it('a peering DOWN queues, and the row survives to be drained later', async () => {
    // Down is not revoked: the rows must survive, because the peering is
    // expected to come back.
    insertOutboundPeer(db, {
      alias: 'downp', url: 'ws://127.0.0.1:1', token: 'T',
      assigned_alias: 'ourmesh', kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    aclGrant(db, 'sender', 'downp:bob', 'admin');
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'down-1', to: 'downp:bob', payload: 'p', content_type: 'text/plain',
    } as never);

    border = startBorder(db, new Map<string, WebSocket>());
    await wait(700);

    expect(getMessage(db, 'down-1')!.delivered_at).toBeNull();
    expect(getMessage(db, 'down-1')!.failed_code).toBeNull();
    expect(countPendingMessages(db)).toBe(1);
  }, 20_000);

  it('receiver-side revocation ENDS the peering — no reconnect loop', async () => {
    // §5.6: AUTH_FAILED is fatal precisely because it will not recover
    // unaided. The rows are undeliverable from that instant, and this is the
    // door where nobody typed a command.
    outboundToB();
    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'rev-1', to: 'far:bob', payload: 'p', content_type: 'text/plain',
    } as never);
    // B revokes us between queueing and connecting.
    bDb.prepare('UPDATE peers SET disabled = 1 WHERE alias = ?').run('ourmesh');

    border = startBorder(db, new Map<string, WebSocket>());
    await wait(1200);

    expect(getOutboundPeer(db, 'far')?.enabled).toBe(0);
    expect(countPendingMessages(db)).toBe(0);      // rows expired by endOutboundPeering
    expect(aclCheck(db, 'sender', 'far:bob')).toBe(false);   // outbound edges gone
  }, 20_000);
});
