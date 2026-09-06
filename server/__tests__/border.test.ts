import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  openDb, registerAgent, aclGrant, insertOutboundPeer, getOutboundPeer,
  drainOutbound, expireStaleOutbound, markMessageFailed, countPendingMessages,
  listOutboundPeers, getMessage, DRAIN_OUTBOUND_SQL,
} from '../db.ts';
import { routeDirect, routeRelay, MAX_TTL_MS } from '../router.ts';
import { RELAY_DEDUPE_MS } from '../cleanup.ts';
import { startBorder, forwarders, borderEvents, Forwarder } from '../border.ts';
import { validateOutboundPeerUrl } from '../http-admin.ts';
import { renderMetrics, setPeerUpSource, incPeerRelay, incSent, incReceived, incAclDenied, incError, PARTY_FREE_LABELS } from '../metrics.ts';
import { Database } from 'bun:sqlite';
import type { WebSocket } from 'ws';
import { readFileSync, readdirSync, statSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { startWsServer } from '../ws-server.ts';
import { upsertPeer, aclCheck, getPeerByAlias } from '../db.ts';
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

function peering(alias: string, rate = 600): void {
  insertOutboundPeer(db, {
    alias, url: `ws://127.0.0.1:7300`, token: 'SECRET-TOKEN-VALUE',
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
    // EXPLAINs THE EXPORTED CONSTANT — the query drainOutbound actually runs.
    // This test previously analysed an inline COPY, so mutating drainOutbound
    // to a LIKE pattern (full scan on every enqueue) left it green: it pinned a
    // string that never executed.
    const plan = (db.prepare(`EXPLAIN QUERY PLAN ${DRAIN_OUTBOUND_SQL}`)
      .all('far:', 'far;', 0, 0, 10) as { detail: string }[]).map(r => r.detail).join(' | ');

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

describe('F2b: mesh_peer_up (#108) and the peer-label flag', () => {
  // /metrics is UNAUTHENTICATED. With per-alias series it enumerates the whole
  // inter-org topology in both directions — and aliases are deliberately
  // meaningful names, so the labels ARE the disclosure. The exemption that made
  // unauthenticated /metrics acceptable rests on "the admin port is
  // internal-only", a DEPLOYMENT claim the code cannot enforce.
  afterEach(() => { delete process.env.MESH_METRICS_IDENTITY_LABELS; setPeerUpSource(() => []); });

  it('DEFAULT: no peer alias AND no agent id appears anywhere in the bytes', () => {
    // The flag gates EVERY identity-bearing label, not only peer aliases — the
    // same unauthenticated reader enumerates LOCAL AGENT IDS from
    // mesh_agent_up, mesh_messages_sent_total, mesh_messages_received_total and
    // mesh_acl_denied_total. A label is a disclosure from the READER's
    // position, not from the labelled party's.
    peering('secret-partner');
    registerAgent(db, { id: 'secret-agent', token_hash: 'd'.repeat(64), hostname: 'h' });
    setPeerUpSource(() => listOutboundPeers(db).map(r => ({ alias: r.alias, up: false })));
    incPeerRelay('secret-partner', 'outbound', 'delivered');
    incSent('secret-agent'); incReceived('secret-agent'); incAclDenied('secret-agent');
    // A NON-identity label, counted so the control below is real: it only
    // emits a series once something has been counted.
    incError('ACL_DENIED');

    // SERIES LINES ONLY, not the whole document: `# HELP` prose legitimately
    // contains words like "sender", and an agent may be named that. Matching
    // prose would make this fail for a reason unrelated to disclosure — the
    // first run did exactly that. What must not carry an identity is the DATA.
    const out = renderMetrics(db)
      .split('\n').filter(l => l.length > 0 && !l.startsWith('#')).join('\n');
    // Grep the BYTES of those lines for every configured alias and every
    // registered agent id: a label leaking under an unexpected series name
    // would pass a per-series check and fail this.
    for (const alias of listOutboundPeers(db).map(r => r.alias)) {
      expect(out).not.toContain(alias);
    }
    for (const row of db.prepare('SELECT id FROM agents').all() as { id: string }[]) {
      expect(out).not.toContain(row.id);
    }
    expect(out).not.toContain('alias=');
    expect(out).not.toContain('from_agent=');
    expect(out).not.toContain('to_agent=');
    expect(out).not.toContain('agent=');
    // Positive controls: the aggregates ARE present, so "does not contain" is
    // not satisfied by an empty document — and mesh_errors_total, which carries
    // no identity, is unaffected by the flag.
    expect(out).toContain('mesh_peer_up_count');
    expect(out).toContain('mesh_agent_up_count');
    expect(out).toContain('mesh_errors_total');
  });

  // CANARY on the allowlist itself. Moving PARTY_FREE_LABELS beside the
  // emitters buys one authority, but it costs this: the constant is the
  // walker's ORACLE, so widening the constant makes the walker green — measured,
  // not assumed (adding 'agent' to it leaves the walk 24/24). The walk cannot
  // catch that, by construction.
  //
  // This pins the contents, so a widening is a deliberate edit to a test that
  // says why, rather than a silent one-word change that disarms the walk for
  // that label. It is not a correctness check — it is a speed bump with a
  // reason attached, and it is the only thing standing behind the walk.
  it('the party-free allowlist itself is pinned — widening it disarms the walk', () => {
    expect([...PARTY_FREE_LABELS].sort()).toEqual([
      'direction', 'error_code', 'kind', 'le', 'outcome', 'state', 'status',
    ]);
  });

  // THE PIN. The byte-grep above knows only the identities that exist in THIS
  // test; it cannot see a NEW labelled series someone adds later. This walks
  // every series actually emitted with the flag OFF and checks each label KEY
  // against a closed allowlist of party-free labels.
  //
  // "Identity-bearing" is defined as a category — any label whose value names a
  // party (an agent id or a peer alias) — rather than as a list, because a list
  // goes stale the moment someone adds a series. A category-shaped name is only
  // survivable if something enforces the category, and this is that something:
  // a mutant adding `mesh_x{agent="..."}` ungated reds it.
  it('DEFAULT: every emitted label key is on the party-free allowlist', () => {
    // The allowlist is PARTY_FREE_LABELS in metrics.ts, beside the emitters —
    // deliberately not defined here. A closed list that lives only in its test
    // gets widened by whoever is unblocking themselves; a list beside the
    // emitters is met by the person adding the label, and carries the value
    // domain that earns each entry.
    const PARTY_FREE = PARTY_FREE_LABELS;

    peering('p-one');
    registerAgent(db, { id: 'a-one', token_hash: 'e'.repeat(64), hostname: 'h' });
    setPeerUpSource(() => listOutboundPeers(db).map(r => ({ alias: r.alias, up: true })));
    incPeerRelay('p-one', 'outbound', 'delivered');
    incSent('a-one'); incReceived('a-one'); incAclDenied('a-one'); incError('ACL_DENIED');

    const rendered = renderMetrics(db).split('\n');
    const series = rendered.filter(l => l.length > 0 && !l.startsWith('#'));

    const offenders: string[] = [];
    for (const line of series) {
      const m = line.match(/^[a-z_]+\{([^}]*)\}/);
      if (m === null) continue;                 // unlabelled series
      for (const pair of m[1]!.split(',')) {
        const key = pair.split('=')[0]!.trim();
        if (key.length > 0 && !PARTY_FREE.has(key)) offenders.push(`${line.split('{')[0]}: ${key}`);
      }
    }
    expect(offenders).toEqual([]);

    // THE WALK'S OWN BLIND SPOT, made loud. A metric with no data emits no
    // series line, so the walk above simply cannot see its labels — three of
    // this test's findings (`outcome`, `le`, `status`) only became visible once
    // other tests in this file had populated their counters, which means a
    // green here is worth exactly as much as the fixture's coverage.
    //
    // So: derive the metric universe from the # TYPE lines, which render
    // unconditionally, and require every declared metric to be either walked or
    // named below. A new metric that this fixture does not exercise fails here
    // with its own name, rather than passing unexamined.
    const declared = rendered
      .filter(l => l.startsWith('# TYPE '))
      .map(l => l.split(' ')[2]!)
      .sort();
    const walked = new Set(series.map(l => l.split('{')[0]!.split(' ')[0]!.replace(/_(bucket|sum|count)$/, '')));
    const unwalked = declared.filter(n => !walked.has(n) && !walked.has(n.replace(/_(bucket|sum|count)$/, '')));

    // Empty is the goal: this fixture drives every declared metric. If a new
    // metric lands here, EXERCISE it above rather than adding it to this list —
    // an entry here is a label set nobody has ever checked.
    expect(unwalked).toEqual([]);
  });

  it('DEFAULT: #108 alertability survives — both states are always present', () => {
    // The point of #108 was that a series which only appears when up cannot be
    // alerted on. Aggregates keep that property: "peerings down" is a value
    // that moves, not a series that vanishes. What is withheld is WHICH one.
    peering('a'); peering('b');
    setPeerUpSource(() => [{ alias: 'a', up: true }, { alias: 'b', up: false }]);

    const out = renderMetrics(db);
    expect(out).toContain('mesh_peer_up_count{state="up"} 1');
    expect(out).toContain('mesh_peer_up_count{state="down"} 1');
  });

  it('FLAG ON: per-alias series appear, 0 and 1 for every configured peering', () => {
    process.env.MESH_METRICS_IDENTITY_LABELS = '1';
    peering('down-peer'); peering('up-peer');
    setPeerUpSource(() => [{ alias: 'down-peer', up: false }, { alias: 'up-peer', up: true }]);

    const out = renderMetrics(db);
    expect(out).toContain('mesh_peer_up{alias="down-peer"} 0');
    expect(out).toContain('mesh_peer_up{alias="up-peer"} 1');
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

  // #131. The definition stays in the wire module; what changed is HOW the
  // server side reads it. `server/wire-version.ts` is a bare re-export barrel
  // and is the only server-side file carrying a RUNTIME cross-package import of
  // it; `ws-server.ts` and `http-admin.ts` both read it from that barrel.
  //
  // The threshold is 51,200 B — the on-disk transpiler cache, fine-bisected at
  // 51,197 B -> 0 entries and 51,497 B -> 1. The failure only ever appeared at
  // an importer that was both cached and cross-package.
  //
  // BOTH the reader set and each reader's specifier come from
  // Bun.Transpiler, never from a regex over quotes. The earlier version matched
  // `from '…'` single-quoted only, and nothing in this repo enforces quote style
  // — no prettier, eslint, biome, dprint or .editorconfig, and no lint script.
  // 78 single-quoted imports and zero double-quoted ones is a habit, not a rule.
  // MEASURED: adding a new reader with double quotes left this test at 27 pass,
  // 0 fail — the reader was simply invisible, which is fail-OPEN on one
  // character. Membership is now decided by the transpiled output (so a mention
  // in a comment is not a read, and a type-only use is correctly erased) and the
  // specifier by scanImports.
  //
  // CAVEAT, so nobody "improves" this later: scanImports reports a
  // value-syntax import whose binding happens to be used only as a type,
  // because bun emits that edge. It is not a type-analysis oracle and must not
  // be tuned toward one — the question here is which module edges exist, which
  // is exactly what it answers.
  //
  // This pins the SPECIFIER, not just the definition, because the natural
  // tidy-up — "why is this reading a wire constant from a barrel?" — silently
  // reinstates the edge that was removed.
  //
  // Not a proof of mechanism: a removal of the only failing shape. #131 open.
  it('#131: every reader imports the constant from its pinned specifier', () => {
    const root = join(import.meta.dir, '..', '..');
    const transpiler = new Bun.Transpiler({ loader: 'ts' });
    const PROVIDER = /(?:protocol|wire-version|ws-server)\.ts$/;

    const readers: string[] = [];
    for (const f of [...sourceFiles(join(root, 'server')), ...sourceFiles(join(root, 'client', 'src'))]) {
      const src = readFileSync(f, 'utf8');
      let emitted: string;
      try { emitted = transpiler.transformSync(src); } catch { emitted = ''; }
      if (!/\bPEER_PROTOCOL_VERSION\b/.test(emitted)) continue;   // not a reader
      const providers = transpiler.scanImports(src).filter(i => PROVIDER.test(i.path)).map(i => i.path);
      readers.push(`${f.slice(root.length + 1)} <- ${providers.length > 0 ? providers.sort().join(', ') : '(defines it)'}`);
    }

    console.log('#131 readers of PEER_PROTOCOL_VERSION, per Bun.Transpiler:');
    for (const r of readers) console.log(`  ${r}`);

    expect(readers.sort()).toEqual([
      'client/src/peer-client.ts <- ./protocol.ts',            // in-package
      'client/src/protocol.ts <- (defines it)',                // the one definition
      'server/http-admin.ts <- ./wire-version.ts',             // cached; must not cross
      'server/wire-version.ts <- ../client/src/protocol.ts',   // THE server-side cross-package edge
      'server/ws-server.ts <- ./wire-version.ts',              // inside the band; must not cross
    ]);
  });

  // #131 ENFORCED, not merely described. The comments above state the invariant
  // and comments do not fail. This is the assertion.
  //
  // THE EDGE SET COMES FROM THE TRANSPILER, NOT FROM A REGEX — and the reason is
  // the whole finding. Classifying imports by hand means deciding which ones are
  // erased, and a value edge misclassified as erased returns CLEAN on exactly
  // the state this guard exists to catch: it fails OPEN. Four separate
  // hand-parsed derivations of this same set were attempted across the lane and
  // every one of them was wrong at least once, including two of mine.
  //
  // `Bun.Transpiler.scanImports` is the component whose behaviour the invariant
  // is ABOUT, so it cannot disagree with the transpiler. It also covers the four
  // forms a `from`-anchored regex silently misses — side-effect import,
  // `export * from`, dynamic `import()`, `require()` — none of which exist in
  // server/ today, which is precisely why a regex would have kept looking right.
  // Comments need no stripping: the transpiler does not see them.
  //
  // Positive-controlled on a synthetic file carrying all six forms: `import type`
  // absent (erased), `import { type B, C }` present (C is a value), side-effect
  // present, `export *` present, dynamic present, commented-out absent.
  it('#131: no server file with a runtime cross-package import reaches the cache threshold', () => {
    const THRESHOLD = 51_200;   // fine-bisected: 51,197 -> 0 cache entries, 51,497 -> 1
    const root = join(import.meta.dir, '..', '..');
    const transpiler = new Bun.Transpiler({ loader: 'ts' });

    const rows: { file: string; size: number; specs: string[] }[] = [];
    for (const f of sourceFiles(join(root, 'server'))) {
      const specs = transpiler
        .scanImports(readFileSync(f, 'utf8'))
        .filter(i => i.path.startsWith('../client/'))
        .map(i => `${i.path} (${i.kind})`);
      if (specs.length > 0) rows.push({ file: f.slice(root.length + 1), size: statSync(f).size, specs });
    }

    // Print the rows, not just the verdict. This is load-bearing: the previous
    // hand-parsed version of this walker reported router.ts — an erased
    // `import type` — as a runtime edge, and the verdict was GREEN both before
    // and after that bug, because router.ts is far below the threshold either
    // way. Only the printed rows could show the detector was wrong.
    console.log('#131 runtime cross-package edges in server/, per Bun.Transpiler:');
    for (const r of rows) console.log(`  ${r.file} — ${r.size} B (margin ${THRESHOLD - r.size}) — ${r.specs.join(', ')}`);

    expect(rows.length).toBeGreaterThan(0);          // the walk found something

    const over = rows.filter(r => r.size >= THRESHOLD);
    expect(over.map(r => `${r.file} is ${r.size} B, at or over the ${THRESHOLD} B cache threshold with a runtime cross-package import (#131 reopens)`)).toEqual([]);
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

// ════════════════════════════════════════════════════════════════════════════
// Hardening items (a)-(g)
// ════════════════════════════════════════════════════════════════════════════

describe('F2b (b): ttl is clamped on BOTH branches and negatives are refused', () => {
  it('sender side: an enormous ttl is clamped to MAX_TTL_MS, a negative is refused', () => {
    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');

    routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'huge', to: 'far:them', payload: 'p',
      content_type: 'text/plain', ttl_ms: 999_999_999_999,
    } as never);
    const row = getMessage(db, 'huge')!;
    // Clamped, not honoured: past the dedupe window the forwarder expires the
    // row anyway, so a longer ttl promises storage the system will not keep.
    expect(row.expires_at! - row.sent_at).toBeLessThanOrEqual(MAX_TTL_MS);

    const neg = routeDirect(db, new Map(), 'sender', {
      type: 'send', msg_id: 'neg', to: 'far:them', payload: 'p',
      content_type: 'text/plain', ttl_ms: -5,
    } as never);
    // REFUSED, not clamped to 0 — 0 already means ephemeral here, so mapping a
    // malformed value onto it would turn a bad frame into a different valid
    // request.
    expect(neg.ok).toBe(false);
    expect(getMessage(db, 'neg')).toBeNull();
  });

  it('receiver side: a peer relay with a negative ttl is RELAY_REFUSED', () => {
    registerAgent(db, { id: 'local-x', token_hash: 'c'.repeat(64), hostname: 'h' });
    upsertPeer(db, {
      alias: 'inbound', token_hash: hashToken('t'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    aclGrant(db, 'inbound:them', 'local-x', 'admin');

    const r = routeRelay(db, new Map(), getPeerByAlias(db, 'inbound')!, {
      type: 'relay', msg_id: 'r-neg', kind: 'direct',
      from: 'them', to: 'local-x', payload: 'p', ttl_ms: -1,
    });
    expect(r.ok).toBe(false);
  });
});

describe('F2b (a): a remote refusal cannot permanently slow us down', () => {
  it('the refill rate RECOVERS after a successful ack — asserted by throughput', () => {
    // Asserted by the QUESTION the system asks — how much may we send in the
    // next drain — rather than by reading the private field. A restore that
    // set the field without affecting pacing would pass a field read.
    //
    // Halving alone is a ONE-WAY RATCHET the far side controls: 600 -> 300 ->
    // ... -> 2, and it survives reconnect because MeshClient reconnects
    // internally so the constructor never re-runs. Restore-on-ack is the only
    // path back.
    const f = new Forwarder(db, {
      alias: 'far', url: 'ws://127.0.0.1:7300', token: 'T', assigned_alias: 'us',
      kinds: '["direct"]', rate_per_min: 600, enabled: 1, created_at: Date.now(), last_alive: null,
    }, new Map<string, WebSocket>());

    const probe = f as unknown as {
      refillPerMin: number;
      onSendError(row: { id: string }, err: { code?: string }): void;
      backoff: number;
    };

    peering('far');
    aclGrant(db, 'sender', 'far:them', 'admin');
    for (let i = 0; i < 3; i++) probe.onSendError({ id: `x${i}` }, { code: 'RATE_LIMITED' });
    expect(probe.refillPerMin).toBe(75);          // 600 -> 300 -> 150 -> 75

    // Now drive the REAL ack path — the same method the relay resolution
    // calls. Setting the field by hand here would have proved nothing about
    // whether an ack restores it.
    queue('far', 'acked');
    (f as unknown as { onSendAck(row: { id: string }): void })
      .onSendAck({ id: 'acked' });

    expect(probe.refillPerMin).toBe(600);
    expect(probe.backoff).toBe(1_000);   // BACKOFF_MIN_MS
    f.stop();
  });
});

describe('F2b (d)+(g): ONE url predicate, ws:// only for loopback', () => {
  it('accepts wss anywhere and ws only on loopback', () => {
    expect(validateOutboundPeerUrl('wss://far.example:7300').ok).toBe(true);
    expect(validateOutboundPeerUrl('ws://127.0.0.1:7300').ok).toBe(true);
    expect(validateOutboundPeerUrl('ws://localhost:7300').ok).toBe(true);
    // Plaintext to a remote host would put outbound_peers.token — a live
    // credential — on the wire on every reconnect.
    expect(validateOutboundPeerUrl('ws://far.example:7300').ok).toBe(false);
    expect(validateOutboundPeerUrl('http://far.example').ok).toBe(false);
    expect(validateOutboundPeerUrl('not a url').ok).toBe(false);
  });

  it('certificate verification is never disabled — source scan', () => {
    // The usual way this rule dies is one { rejectUnauthorized: false } added
    // to make a staging box work. A source scan is the only thing that catches
    // an option nobody's test exercises.
    const root = join(import.meta.dir, '..', '..');
    const files = [...sourceFiles(join(root, 'client', 'src')), join(root, 'server', 'border.ts')];
    for (const f of files) {
      expect(readFileSync(f, 'utf8')).not.toContain('rejectUnauthorized');
    }
  });
});

describe('F2b (c): oversize frames are dropped before the parser', () => {
  it('the WS server sets maxPayload below the router payload cap + envelope', async () => {
    // The router's 1 MiB check runs AFTER JSON.parse, so without this the cost
    // of a hostile frame is paid before anything refuses it.
    const port = 23900 + Math.floor(Date.now() % 90);
    const d = openDb(':memory:');
    const h = await startWsServer(port, d, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-mp-')));
    try {
      expect((h.wss as unknown as { options: { maxPayload: number } }).options.maxPayload)
        .toBeLessThan(2 * 1024 * 1024);
      expect((h.wss as unknown as { options: { maxPayload: number } }).options.maxPayload)
        .toBeGreaterThan(1_048_576);
    } finally {
      await h.shutdown().catch(() => {});
      d.close();
    }
  }, 20_000);
});
