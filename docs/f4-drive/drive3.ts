// F4 drive — topics across peerings (hub-and-spoke), steps P13–P18.
//
// THREE meshes in ONE sandbox network stack sharing localhost:
//   pod1  ws 7432 / admin 7433   (spoke)
//   orch  ws 7442 / admin 7443   (hub — owns the topics)
//   pod2  ws 7452 / admin 7453   (spoke)
// The driver runs as a FOURTH service on the same stack. It starts nothing:
// see f2-verify/DRIVE3.md for the services and env it requires.
//
// Conventions inherited from drive2.ts: one JSONL record per probe on stdout,
// the admin-API helper, the metrics scrape, and the IDENTITY-LABELS-OFF
// assumption (drive2.ts:51 — MESH_METRICS_IDENTITY_LABELS unset, so every
// relay assertion reads the AGGREGATE series and the driver asserts that no
// identity label is rendered). New here: an `expect`-style assertion helper
// with a CONTROL per step, a timeout on every await, a PASS/FAIL summary, and
// exit 0 only when every step passes.
//
// Observes a SANDBOX, never production. Run with
//   MESH_SERVER_URL= MESH_AGENT_ID= MESH_AGENT_TOKEN= MESH_HTTP_URL=
// blanked — the SDK falls back to those env vars, which in this container name
// PRODUCTION (#100).
//
// THE PINNED CHECKOUT. `CHECKOUT` below and the import literal on the next
// line are the ONLY two occurrences of the worktree name: repoint both when a
// later head replaces f62fca6c713259767a62a6bf536b7586ac45dbba (PR #172,
// ASolidBPlus/claude-mesh, branch feat/f4-topics-across-peerings).
const CHECKOUT = 'mesh-f4';
import { MeshClient, PeerClient } from './mesh-f4/client/src/index.ts';
import type { Inbound } from './mesh-f4/client/src/index.ts';

// ── topology ────────────────────────────────────────────────────────────────
type Mesh = { name: string; ws: string; admin: string; tok: string; loop: string };
const HOST = process.env.MESH_HOST ?? 'mesh-planner-sandbox';
const POD1: Mesh = { name: 'pod1', ws: `ws://${HOST}:7432`, admin: `http://${HOST}:7433`, tok: process.env.MESH_ADMIN_TOKEN_POD1 ?? 'verify-admin-pod1', loop: 'ws://127.0.0.1:7432' };
const ORCH: Mesh = { name: 'orch', ws: `ws://${HOST}:7442`, admin: `http://${HOST}:7443`, tok: process.env.MESH_ADMIN_TOKEN_ORCH ?? 'verify-admin-orch', loop: 'ws://127.0.0.1:7442' };
const POD2: Mesh = { name: 'pod2', ws: `ws://${HOST}:7452`, admin: `http://${HOST}:7453`, tok: process.env.MESH_ADMIN_TOKEN_POD2 ?? 'verify-admin-pod2', loop: 'ws://127.0.0.1:7452' };
const MESHES = [POD1, ORCH, POD2];

// §12 P13 kinds arrays. Both tables of a directed peering carry the SAME array:
// the receiver's `peers` row (what it will accept) and the sender's
// outbound_peers row (what it will send).
const SPOKE_TO_HUB = ['direct', 'topic-subscribe', 'topic-publish'];
const HUB_TO_SPOKE = ['direct', 'topic'];
const POD_TO_POD = ['direct'];

const RUN = Date.now().toString(36).slice(-5);
// Aliases are FIXED (§16 A3 same-alias rule, and P14 asserts the literal route
// /peers/pod1/subscriptions), so the driver must be idempotent against a
// persisted sandbox DB — see reset().
const AGENT_PREFIX = 'f4-';
const id = (n: string) => `${AGENT_PREFIX}${n}-${RUN}`;
const SUB1A = id('sub1a'), SUB1B = id('sub1b'), PUB1 = id('pub1'), PROBE1 = id('probe1');
const SUB2 = id('sub2'), SUB2B = id('sub2b');
const HUBPUB = id('hubpub');
const TROLLBOX = 'trollbox';
const ANALYTICS = 'analytics';

// ── timeouts (every await is bounded) ───────────────────────────────────────
const HTTP_MS = 10_000;
const CONNECT_MS = 15_000;
const ACK_MS = 15_000;
const DELIVER_MS = 25_000;
const BORDER_MS = 40_000;

// ── result log (JSONL, one record per probe — drive2 convention) ────────────
const log = (probe: string, o: Record<string, unknown>) => console.log(JSON.stringify({ probe, run: RUN, ...o }));

// ── assertions ──────────────────────────────────────────────────────────────
type Check = { step: string; kind: 'assert' | 'control'; name: string; pass: boolean; expected: unknown; actual: unknown; note: string | null };
const checks: Check[] = [];
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function record(step: string, kind: 'assert' | 'control', name: string, actual: unknown, expected: unknown, note?: string): boolean {
  const pass = eq(actual, expected);
  const c: Check = { step, kind, name, pass, expected, actual, note: note ?? null };
  checks.push(c);
  log('check', c as unknown as Record<string, unknown>);
  return pass;
}
/** An assertion: what the step claims must be true. */
const expect = (step: string, name: string, actual: unknown, expected: unknown, note?: string) =>
  record(step, 'assert', name, actual, expected, note);
/** A CONTROL: the case that must NOT happen. `expected` is the value that
 *  proves it did not — both the control and its reading are recorded. */
const control = (step: string, name: string, actual: unknown, expected: unknown, note?: string) =>
  record(step, 'control', name, actual, expected, note);
/** For a reading whose correct value is disputed between two authorities: the
 *  set of admissible answers is asserted and the answer is recorded, so a
 *  divergence is a FINDING rather than a driver crash. */
function expectOneOf(step: string, name: string, actual: unknown, allowed: unknown[], note: string): boolean {
  const pass = allowed.some(a => eq(a, actual));
  const c: Check = { step, kind: 'assert', name, pass, expected: allowed, actual, note };
  checks.push(c);
  log('check', c as unknown as Record<string, unknown>);
  return pass;
}

// ── primitives ──────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => { setTimeout(r, ms); });

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`TIMEOUT ${label} after ${ms}ms`)), ms); });
  return Promise.race([p, timer]).finally(() => { if (t !== undefined) clearTimeout(t); });
}

type Settled = { ok: true } | { ok: false; code: string; message: string };
async function settle(p: Promise<unknown>, ms: number, label: string): Promise<Settled> {
  try { await withTimeout(p, ms, label); return { ok: true }; }
  catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: typeof err.code === 'string' ? err.code : 'NONE', message: String(err.message ?? e) };
  }
}
/** The refusal BYTES, as a pure function of what the caller supplied — the
 *  shape §16 N is read against. */
const bytes = (s: Settled) => s.ok ? 'OK' : `${s.code}|${s.message}`;

/** Poll a predicate to a deadline. Bounded by construction: never an unbounded
 *  await. Returns the predicate's final reading. */
async function waitUntil(pred: () => boolean, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (pred()) return true; await sleep(150); }
  return pred();
}

// ── admin API (drive2 helper, with a timeout) ───────────────────────────────
type ApiResult = { status: number; text: string; json: any };
async function api(m: Mesh, method: string, path: string, body?: unknown, auth = true): Promise<ApiResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) headers.Authorization = `Bearer ${m.tok}`;
  const init: RequestInit = body === undefined
    ? { method, headers }
    : { method, headers, body: JSON.stringify(body) };
  const r = await withTimeout(fetch(m.admin + path, init), HTTP_MS, `${method} ${m.name}${path}`);
  const text = await withTimeout(r.text(), HTTP_MS, `body ${method} ${m.name}${path}`);
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON body is recorded as text */ }
  return { status: r.status, text, json };
}

// ── metrics ─────────────────────────────────────────────────────────────────
// Flag-off render, read verbatim from server/metrics.ts (the aggregated arm):
//   mesh_peer_relays_total{direction="…",outcome="…",kind="…"} N
//   mesh_topic_fanout_total{outcome="…"} N
// The label ORDER below is the order the server renders, not a convention.
const RELAY_IN_TOPIC = 'mesh_peer_relays_total{direction="in",outcome="delivered",kind="topic"}';
const RELAY_IN_SUB = 'mesh_peer_relays_total{direction="in",outcome="delivered",kind="topic-subscribe"}';
const RELAY_IN_PUB = 'mesh_peer_relays_total{direction="in",outcome="delivered",kind="topic-publish"}';
const RELAY_IN_REFUSED_PUB = 'mesh_peer_relays_total{direction="in",outcome="refused",kind="topic-publish"}';
const RELAY_OUT_REFUSED_PUB = 'mesh_peer_relays_total{direction="outbound",outcome="refused",kind="topic-publish"}';
const FANOUT_ALLOWED = 'mesh_topic_fanout_total{outcome="allowed"}';
const FANOUT_FILTERED = 'mesh_topic_fanout_total{outcome="filtered"}';

type Scrape = Map<string, number>;
async function scrape(m: Mesh): Promise<Scrape> {
  const text = (await api(m, 'GET', '/metrics', undefined, false)).text;
  const out: Scrape = new Map();
  for (const line of text.split('\n')) {
    if (line.length === 0 || line.startsWith('#')) continue;
    const sp = line.lastIndexOf(' ');
    if (sp <= 0) continue;
    const v = Number(line.slice(sp + 1));
    if (Number.isFinite(v)) out.set(line.slice(0, sp), v);
  }
  return out;
}
const delta = (before: Scrape, after: Scrape, key: string) => (after.get(key) ?? 0) - (before.get(key) ?? 0);
/** drive2.ts:51 — the identity-labels-off assumption, asserted rather than
 *  assumed: zero identity labels anywhere in the document. */
async function identityLabelCount(m: Mesh): Promise<number> {
  const text = (await api(m, 'GET', '/metrics', undefined, false)).text;
  return (text.match(/(alias|from_agent|to_agent|agent)=/g) ?? []).length;
}

// ── agents ──────────────────────────────────────────────────────────────────
type Seat = { id: string; mesh: Mesh; c: MeshClient; msgs: Inbound[]; errs: { code: string; message: string }[] };
const seats: Seat[] = [];
async function seat(m: Mesh, agentId: string): Promise<Seat> {
  const created = await api(m, 'POST', '/agents', { id: agentId, hostname: 'f4-drive' });
  const token = created.json?.token;
  if (typeof token !== 'string') throw new Error(`no token for ${agentId}@${m.name}: ${created.status} ${created.text.slice(0, 160)}`);
  const c = new MeshClient({ serverUrl: m.ws, agentId, agentToken: token });
  const msgs: Inbound[] = [];
  const errs: { code: string; message: string }[] = [];
  c.onMessage(x => { msgs.push(x); });
  c.on('error', (e: any) => { errs.push({ code: typeof e?.code === 'string' ? e.code : 'NONE', message: String(e?.message ?? e) }); });
  await withTimeout(c.connect(), CONNECT_MS, `connect ${agentId}@${m.name}`);
  const s: Seat = { id: agentId, mesh: m, c, msgs, errs };
  seats.push(s);
  return s;
}
/** Deliveries of one payload — the only counter the steps assert on, so a
 *  stale message from an earlier step can never be read as this one's. */
const got = (s: Seat, marker: string) => s.msgs.filter(x => x.text === marker);

// ── reset: the aliases are fixed, the sandbox DB persists ───────────────────
// Deleting an f4-* agent purges its subscriptions and ACL rows (deleteAgent),
// and cascades away any topic it created; deleting the outbound peering and
// revoking the peer key clear the peering rows and (revokePeerKey ->
// deleteRemoteSubscriptions) that alias's remote subscriptions. Everything a
// previous run left that could pollute a delta is therefore removed here.
async function reset(m: Mesh, aliases: string[]) {
  const agents = (await api(m, 'GET', '/agents')).json;
  let deletedAgents = 0;
  if (Array.isArray(agents)) {
    for (const a of agents) {
      const aid = a?.id;
      if (typeof aid === 'string' && aid.startsWith(AGENT_PREFIX)) {
        await api(m, 'DELETE', `/agents/${encodeURIComponent(aid)}`);
        deletedAgents++;
      }
    }
  }
  let deletedPeerings = 0;
  for (const alias of aliases) {
    if ((await api(m, 'DELETE', `/outbound-peers/${alias}`)).status === 200) deletedPeerings++;
  }
  let revokedKeys = 0;
  const keys = (await api(m, 'GET', '/peer-keys')).json?.keys;
  if (Array.isArray(keys)) {
    for (const k of keys) {
      if (typeof k?.alias === 'string' && aliases.includes(k.alias) && k?.revoked_at === null && typeof k?.id === 'string') {
        await api(m, 'DELETE', `/peer-keys/${k.id}`);
        revokedKeys++;
      }
    }
  }
  return { mesh: m.name, deletedAgents, deletedPeerings, revokedKeys };
}

// ── one directed peering, per docs/FEDERATION.md §2 (steps 1-3) ─────────────
// The RECEIVER mints (it decides what the peering may carry); the SENDER
// registers against the receiver's admin port with the key; the SENDER then
// configures the outbound link over loopback. Returns the token so P18's raw
// PeerClient can present the same credential the forwarder holds.
async function peering(sender: Mesh, receiver: Mesh, aliasOnSender: string, aliasOnReceiver: string, kinds: string[]) {
  const mint = await api(receiver, 'POST', '/peer-keys', { alias: aliasOnReceiver, kinds, note: 'f4-drive' });
  const key = mint.json?.key;
  if (typeof key !== 'string') throw new Error(`mint ${aliasOnReceiver}@${receiver.name}: ${mint.status} ${mint.text.slice(0, 160)}`);
  const reg = await api(receiver, 'POST', '/peers/register', { key }, false);
  const token = reg.json?.token;
  if (typeof token !== 'string') throw new Error(`register ${aliasOnReceiver}@${receiver.name}: ${reg.status} ${reg.text.slice(0, 160)}`);
  const out = await api(sender, 'POST', '/outbound-peers', {
    alias: aliasOnSender, url: receiver.loop, token, assigned_alias: aliasOnReceiver, kinds,
  });
  return {
    edge: `${sender.name}->${receiver.name}`,
    mint_status: mint.status, register_status: reg.status, outbound_status: out.status,
    register_kinds: reg.json?.kinds, outbound_kinds: out.json?.kinds,
    token, token_in_outbound_body: out.text.includes(token),
  };
}

const kindsFrom = (rows: any, aliasKey: string, alias: string): unknown =>
  (Array.isArray(rows) ? rows.find((r: any) => r?.[aliasKey] === alias)?.kinds : undefined) ?? null;

// ════════════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const t0 = Date.now();
  log('setup', {
    checkout: CHECKOUT,
    pinned_head: 'f62fca6c713259767a62a6bf536b7586ac45dbba (PR #172; repoint CHECKOUT + the import on a later head)',
    reachability: await Promise.all(MESHES.map(async m => ({ mesh: m.name, agents: (await api(m, 'GET', '/agents')).status }))),
    identity_labels: await Promise.all(MESHES.map(async m => ({ mesh: m.name, hits: await identityLabelCount(m) }))),
    note: 'identity_labels hits MUST be 0 on every mesh — drive2.ts:51: MESH_METRICS_IDENTITY_LABELS unset, so every relay assertion reads the aggregate series',
  });
  for (const m of MESHES) {
    expect('setup', `identity_labels_off_${m.name}`, await identityLabelCount(m), 0,
      'flag-off aggregates; a non-zero count invalidates every metric key in this driver');
  }

  // ── P13 — mint the topology ───────────────────────────────────────────────
  // 2N peering rows + N(N-1) direct rows, N = 2: four hub<->spoke directed
  // peerings and two pod<->pod ones. Same local alias in BOTH tables on each
  // mesh (§16 A3): the hub's peers.pod1 pairs with its outbound_peers.pod1.
  log('p13_reset', { meshes: await Promise.all([reset(POD1, ['orch', 'pod2']), reset(ORCH, ['pod1', 'pod2']), reset(POD2, ['orch', 'pod1'])]) });

  const p13 = {
    pod1_to_orch: await peering(POD1, ORCH, 'orch', 'pod1', SPOKE_TO_HUB),
    orch_to_pod1: await peering(ORCH, POD1, 'pod1', 'orch', HUB_TO_SPOKE),
    pod2_to_orch: await peering(POD2, ORCH, 'orch', 'pod2', SPOKE_TO_HUB),
    orch_to_pod2: await peering(ORCH, POD2, 'pod2', 'orch', HUB_TO_SPOKE),
    pod1_to_pod2: await peering(POD1, POD2, 'pod2', 'pod1', POD_TO_POD),
    pod2_to_pod1: await peering(POD2, POD1, 'pod1', 'pod2', POD_TO_POD),
  };
  log('p13_mint', { edges: Object.values(p13).map(e => ({ ...e, token: '<withheld>' })) });
  for (const [name, e] of Object.entries(p13)) {
    expect('p13', `${name}_created`, [e.mint_status, e.register_status, e.outbound_status], [201, 201, 201]);
  }

  const peersOf = async (m: Mesh) => (await api(m, 'GET', '/peers')).json?.peers;
  const outOf = async (m: Mesh) => (await api(m, 'GET', '/outbound-peers')).json?.peerings;
  const [pod1Peers, pod1Out, orchPeers, orchOut, pod2Peers, pod2Out] =
    [await peersOf(POD1), await outOf(POD1), await peersOf(ORCH), await outOf(ORCH), await peersOf(POD2), await outOf(POD2)];
  log('p13_kinds', { pod1: { peers: pod1Peers, outbound: pod1Out }, orch: { peers: orchPeers, outbound: orchOut }, pod2: { peers: pod2Peers, outbound: pod2Out } });

  // The kinds arrays come back from BOTH read APIs, on all six directed rows.
  expect('p13', 'orch_peers_kinds', [kindsFrom(orchPeers, 'alias', 'pod1'), kindsFrom(orchPeers, 'alias', 'pod2')], [SPOKE_TO_HUB, SPOKE_TO_HUB]);
  expect('p13', 'orch_outbound_kinds', [kindsFrom(orchOut, 'alias', 'pod1'), kindsFrom(orchOut, 'alias', 'pod2')], [HUB_TO_SPOKE, HUB_TO_SPOKE]);
  expect('p13', 'pod1_peers_kinds', [kindsFrom(pod1Peers, 'alias', 'orch'), kindsFrom(pod1Peers, 'alias', 'pod2')], [HUB_TO_SPOKE, POD_TO_POD]);
  expect('p13', 'pod1_outbound_kinds', [kindsFrom(pod1Out, 'alias', 'orch'), kindsFrom(pod1Out, 'alias', 'pod2')], [SPOKE_TO_HUB, POD_TO_POD]);
  expect('p13', 'pod2_peers_kinds', [kindsFrom(pod2Peers, 'alias', 'orch'), kindsFrom(pod2Peers, 'alias', 'pod1')], [HUB_TO_SPOKE, POD_TO_POD]);
  expect('p13', 'pod2_outbound_kinds', [kindsFrom(pod2Out, 'alias', 'orch'), kindsFrom(pod2Out, 'alias', 'pod1')], [SPOKE_TO_HUB, POD_TO_POD]);
  expect('p13', 'row_counts_2N_plus_N_N_minus_1',
    { peers: [pod1Peers?.length, orchPeers?.length, pod2Peers?.length], outbound: [pod1Out?.length, orchOut?.length, pod2Out?.length] },
    { peers: [2, 2, 2], outbound: [2, 2, 2] },
    'N=2: 2N=4 hub<->spoke directed peerings + N(N-1)=2 pod<->pod = 6, and 6 outbound rows');

  // CONTROL — the alias `topic` must NOT be mintable or configurable at either
  // door: a peering called `topic` would reinterpret every local topic
  // principal as remote.
  const resTopicKey = await api(ORCH, 'POST', '/peer-keys', { alias: 'topic', kinds: ['direct'] });
  const resTopicOut = await api(ORCH, 'POST', '/outbound-peers', { alias: 'topic', url: POD1.loop, token: 'x', assigned_alias: 'orch', kinds: ['direct'] });
  control('p13', 'alias_topic_reserved_at_both_doors',
    [resTopicKey.status, resTopicKey.json?.error, resTopicOut.status, resTopicOut.json?.error],
    [400, "alias 'topic' is reserved", 400, "alias 'topic' is reserved"]);
  const tokenLeak = Object.values(p13).some(e => e.token_in_outbound_body)
    || (await api(POD1, 'GET', '/outbound-peers')).text.includes(p13.pod1_to_orch.token)
    || (await api(ORCH, 'GET', '/outbound-peers')).text.includes(p13.orch_to_pod1.token)
    || (await api(POD2, 'GET', '/outbound-peers')).text.includes(p13.pod2_to_orch.token);
  control('p13', 'no_token_bytes_in_read_apis', tokenLeak, false,
    'C7 carried into F4: neither the POST body nor the GET listing echoes the outbound token');

  // Let the six forwarders connect. Recorded, not asserted: the gauges are a
  // readiness reading, and the functional steps are the authority on delivery.
  await sleep(4000);
  log('p13_gauges', {
    up: await Promise.all(MESHES.map(async m => ({ mesh: m.name, series: ((await api(m, 'GET', '/metrics', undefined, false)).text.match(/mesh_peer_up_count\{state="[a-z]+"\} \d+/g) ?? []) }))),
    note: 'flag-off aggregates; per-alias mesh_peer_up is hidden by #126 by design',
  });

  // ── seats, topics, grants ─────────────────────────────────────────────────
  const hubpub = await seat(ORCH, HUBPUB);
  const sub1a = await seat(POD1, SUB1A);
  const sub1b = await seat(POD1, SUB1B);
  const pub1 = await seat(POD1, PUB1);
  const probe1 = await seat(POD1, PROBE1);
  const sub2 = await seat(POD2, SUB2);
  const sub2b = await seat(POD2, SUB2B);

  // §16 A6 — remote callers NEVER create topics: the hub's topics are created
  // here, on the hub, by a LOCAL hub agent, before anyone subscribes.
  const mkTrollbox = await api(ORCH, 'POST', '/topics', { name: TROLLBOX, created_by: HUBPUB, description: 'f4 drive' });
  const mkAnalytics = await api(ORCH, 'POST', '/topics', { name: ANALYTICS, created_by: HUBPUB, description: 'f4 drive read-only' });
  log('p14_topics', { trollbox: mkTrollbox.status, analytics: mkAnalytics.status, created_by: HUBPUB });
  expect('p14', 'hub_topics_created_locally', [mkTrollbox.status, mkAnalytics.status], [201, 201]);

  // The two enumerable grant classes (§1.4).
  //   RIGHT TO HEAR: hub `topic:trollbox -> pod1:sub`; spoke `orch:trollbox -> sub`
  //   RIGHT TO POST: spoke `publisher -> orch:trollbox`; hub `pod1:publisher -> topic:trollbox`
  // sub1b is deliberately given NEITHER half of RIGHT TO HEAR — it is P15's
  // filtered subscriber.
  const grants = {
    hub_hear_sub1a: (await api(ORCH, 'POST', '/acl', { from_agent: `topic:${TROLLBOX}`, to_agent: `pod1:${SUB1A}`, granted_by: 'f4-drive' })).status,
    hub_hear_sub2: (await api(ORCH, 'POST', '/acl', { from_agent: `topic:${TROLLBOX}`, to_agent: `pod2:${SUB2}`, granted_by: 'f4-drive' })).status,
    spoke_hear_sub1a: (await api(POD1, 'POST', '/acl', { from_agent: `orch:${TROLLBOX}`, to_agent: SUB1A, granted_by: 'f4-drive' })).status,
    spoke_hear_sub2: (await api(POD2, 'POST', '/acl', { from_agent: `orch:${TROLLBOX}`, to_agent: SUB2, granted_by: 'f4-drive' })).status,
    spoke_post_pub1: (await api(POD1, 'POST', '/acl', { from_agent: PUB1, to_agent: `orch:${TROLLBOX}`, granted_by: 'f4-drive' })).status,
    hub_post_pub1: (await api(ORCH, 'POST', '/acl', { from_agent: `pod1:${PUB1}`, to_agent: `topic:${TROLLBOX}`, granted_by: 'f4-drive' })).status,
    // P18a: the RIGHT TO POST is granted on the SPOKE and WITHHELD on the HUB
    // for `analytics` — a read-only hub topic is the hub withholding the
    // inbound post edge.
    spoke_post_pub1_analytics: (await api(POD1, 'POST', '/acl', { from_agent: PUB1, to_agent: `orch:${ANALYTICS}`, granted_by: 'f4-drive' })).status,
    // P18b: sub2b holds an edge from the FORGED principal and none from the
    // real one. Nothing may make `origin` the ACL principal.
    spoke_hear_sub2b_from_forged_origin: (await api(POD2, 'POST', '/acl', { from_agent: 'orch:admin', to_agent: SUB2B, granted_by: 'f4-drive' })).status,
  };
  log('p14_grants', { grants, withheld: [`orch: topic:${TROLLBOX} -> pod1:${SUB1B}`, `pod1: orch:${TROLLBOX} -> ${SUB1B}`, `orch: pod1:${PUB1} -> topic:${ANALYTICS}`, `pod2: orch:${TROLLBOX} -> ${SUB2B}`] });
  expect('p14', 'grants_all_201', Object.values(grants), Object.values(grants).map(() => 201));

  // ── P14 — subscribe both pods to orch:trollbox ────────────────────────────
  const subBefore = await scrape(ORCH);
  const s1a = await settle(sub1a.c.subscribe(`orch:${TROLLBOX}`), ACK_MS, 'sub1a subscribe');
  const s1b = await settle(sub1b.c.subscribe(`orch:${TROLLBOX}`), ACK_MS, 'sub1b subscribe');
  const s2 = await settle(sub2.c.subscribe(`orch:${TROLLBOX}`), ACK_MS, 'sub2 subscribe');
  const s2b = await settle(sub2b.c.subscribe(`orch:${TROLLBOX}`), ACK_MS, 'sub2b subscribe');
  expect('p14', 'local_subscribe_acks', [s1a.ok, s1b.ok, s2.ok, s2b.ok], [true, true, true, true],
    'D8: the spoke ack means ACCEPTED FOR THE BORDER, not "the hub agreed"');

  // The border rows land asynchronously; the hub's registry is the authority.
  const subsOn = async (alias: string) => (await api(ORCH, 'GET', `/peers/${alias}/subscriptions`)).json;
  const wantPod1 = [`pod1:${SUB1A}`, `pod1:${SUB1B}`].sort();
  let pod1Subs: any = null;
  {
    const t = Date.now();
    while (Date.now() - t < BORDER_MS) {
      pod1Subs = await subsOn('pod1');
      const ids = (Array.isArray(pod1Subs?.subscriptions) ? pod1Subs.subscriptions.map((r: any) => r.agent_id) : []).sort();
      if (eq(ids, wantPod1)) break;
      await sleep(500);
    }
  }
  const pod2Subs = await subsOn('pod2');
  const missing = await api(ORCH, 'GET', '/peers/nosuchalias/subscriptions');
  log('p14_registry', { pod1: pod1Subs, pod2: pod2Subs, unknown_alias: { status: missing.status, body: missing.text }, relay_in_subscribe_delta: delta(subBefore, await scrape(ORCH), RELAY_IN_SUB) });

  const pod1Ids = (Array.isArray(pod1Subs?.subscriptions) ? pod1Subs.subscriptions.map((r: any) => r.agent_id) : []).sort();
  const pod2Ids = (Array.isArray(pod2Subs?.subscriptions) ? pod2Subs.subscriptions.map((r: any) => r.agent_id) : []).sort();
  expect('p14', 'hub_lists_pod1_subscriptions', [pod1Subs?.alias, pod1Ids], ['pod1', wantPod1]);
  expect('p14', 'hub_subscription_topic_is_bare', (Array.isArray(pod1Subs?.subscriptions) ? pod1Subs.subscriptions.map((r: any) => r.topic) : []), [TROLLBOX, TROLLBOX],
    'the hub stores its own bare name; the `orch:` prefix exists only on the spoke');
  expect('p14', 'unknown_alias_404', [missing.status, missing.json?.error], [404, 'no such peer']);
  // CONTROL — prefix isolation: pod2's listing must NOT contain a pod1 row.
  control('p14', 'no_pod1_rows_under_pod2', pod2Ids.filter((x: string) => x.startsWith('pod1:')), [],
    `pod2's listing is ${JSON.stringify(pod2Ids)} — every id must be pod2-prefixed`);
  control('p14', 'pod2_rows_all_pod2_prefixed', pod2Ids.every((x: string) => x.startsWith('pod2:')), true);

  // The three C9 causes at routeSubscribe (§6): every one answers
  // AGENT_NOT_FOUND `unknown topic: <what you supplied>` — a PURE FUNCTION OF
  // THE INPUT (§16 N), not identical bytes across different inputs.
  const c9NonPeered = await settle(probe1.c.subscribe(`ghost-${RUN}:${TROLLBOX}`), ACK_MS, 'c9 non-peered');
  const c9NoKind = await settle(probe1.c.subscribe(`pod2:${TROLLBOX}`), ACK_MS, 'c9 peering without topic-subscribe');
  // Cause 3 is NOT refused locally: A6's "remote subscribe to a nonexistent
  // topic is refused" is enforced at the HUB, and the subscriber learns it
  // through the forwarder's REMOTE_REFUSED (§6, border.ts onSendError).
  const errsBeforeGhostTopic = probe1.errs.length;
  const c9NoTopic = await settle(probe1.c.subscribe(`orch:nosuch-${RUN}`), ACK_MS, 'c9 nonexistent topic');
  await waitUntil(() => probe1.errs.slice(errsBeforeGhostTopic).some(e => e.code === 'REMOTE_REFUSED'), BORDER_MS);
  const ghostTopicErrs = probe1.errs.slice(errsBeforeGhostTopic).filter(e => e.code === 'REMOTE_REFUSED');

  log('p14_c9_causes', {
    non_peered_alias: bytes(c9NonPeered),
    peering_without_kind: bytes(c9NoKind),
    nonexistent_topic_local: bytes(c9NoTopic),
    nonexistent_topic_remote_errors: ghostTopicErrs,
    note: 'causes 1 and 2 refuse locally; cause 3 is accepted for the border (D8) and refused at the hub',
  });
  expect('p14', 'c9_non_peered_alias', bytes(c9NonPeered), `AGENT_NOT_FOUND|unknown topic: ghost-${RUN}:${TROLLBOX}`);
  expect('p14', 'c9_peering_without_kind', bytes(c9NoKind), `AGENT_NOT_FOUND|unknown topic: pod2:${TROLLBOX}`);
  expect('p14', 'c9_nonexistent_topic_refused_at_hub', [c9NoTopic.ok, ghostTopicErrs.length], [true, 1],
    'exactly one REMOTE_REFUSED — RELAY_REFUSED is permanent, so the row is failed, not retried');

  // §16 N — ONE INPUT THROUGH TWO CAUSES must produce IDENTICAL BYTES. `orch:`
  // is an empty remainder while the peering is enabled, and an unpeered prefix
  // while it is paused (hasOutboundPeer is enabled-only, db.ts:1226), so the
  // same string reaches the refusal down two different code paths.
  const nEnabled = await settle(probe1.c.subscribe('orch:'), ACK_MS, 'N empty remainder');
  await api(POD1, 'PATCH', '/outbound-peers/orch', { enabled: false });
  await sleep(800);
  const nPaused = await settle(probe1.c.subscribe('orch:'), ACK_MS, 'N unpeered prefix');
  await api(POD1, 'PATCH', '/outbound-peers/orch', { enabled: true });
  await sleep(1500);
  log('p14_uniformity_one_input_two_causes', { cause_empty_remainder: bytes(nEnabled), cause_unpeered_prefix: bytes(nPaused) });
  expect('p14', 'n_one_input_two_causes_identical_bytes', bytes(nEnabled), bytes(nPaused),
    '§16 N: the only comparison that can detect a cause leaking');
  probe1.c.close();

  // ── P15 — the hub publishes, three spoke subscribers, one deaf ────────────
  const p15Marker = `p15-${RUN}`;
  const b1 = await scrape(POD1), bo = await scrape(ORCH), b2 = await scrape(POD2);
  const p15Ack = await settle(hubpub.c.publish(TROLLBOX, p15Marker), ACK_MS, 'p15 hub publish');
  await waitUntil(() => got(sub1a, p15Marker).length >= 1 && got(sub2, p15Marker).length >= 1, DELIVER_MS);
  await sleep(2000); // a second copy, if the border produced one, would have landed by now
  const a1 = await scrape(POD1), ao = await scrape(ORCH), a2 = await scrape(POD2);
  const p15 = {
    ack: p15Ack,
    sub1a: got(sub1a, p15Marker).length, sub1b: got(sub1b, p15Marker).length, sub2: got(sub2, p15Marker).length, sub2b: got(sub2b, p15Marker).length,
    pod1_relay_in_topic: delta(b1, a1, RELAY_IN_TOPIC), pod2_relay_in_topic: delta(b2, a2, RELAY_IN_TOPIC),
    pod1_fanout: { allowed: delta(b1, a1, FANOUT_ALLOWED), filtered: delta(b1, a1, FANOUT_FILTERED) },
    pod2_fanout: { allowed: delta(b2, a2, FANOUT_ALLOWED), filtered: delta(b2, a2, FANOUT_FILTERED) },
    orch_fanout: { allowed: delta(bo, ao, FANOUT_ALLOWED), filtered: delta(bo, ao, FANOUT_FILTERED) },
    delivery: got(sub1a, p15Marker)[0] ?? null,
  };
  log('p15_hub_publish', p15);
  expect('p15', 'two_deliveries_of_three_subscribers', [p15.sub1a, p15.sub1b, p15.sub2], [1, 0, 1],
    'sub1b holds neither half of RIGHT TO HEAR');
  expect('p15', 'one_filtered_at_the_spoke', p15.pod1_fanout, { allowed: 1, filtered: 1 });
  expect('p15', 'delivered_once_per_peering_not_per_subscriber', [p15.pod1_relay_in_topic, p15.pod2_relay_in_topic], [1, 1],
    'one outbound row per pod, asserted through the border counter — the admin API exposes no message rows');
  expect('p15', 'delivery_shape', [p15.delivery?.kind, p15.delivery?.from, p15.delivery?.topic, p15.delivery?.origin],
    ['topic', `orch:${TROLLBOX}`, `orch:${TROLLBOX}`, HUBPUB],
    'stampedFrom is the topic principal; origin is the hub publisher for a hub-originated post');
  // CONTROL — pod1 has TWO subscribers; a per-subscriber frame would make the
  // border counter +2 and sub1b a recipient. Neither may happen.
  control('p15', 'pod1_border_counter_not_two', p15.pod1_relay_in_topic === 2, false);
  control('p15', 'deaf_subscriber_received_nothing', p15.sub1b, 0);
  // CONTROL — A2: the hub's own fan-out SKIPS remote subscribers, so the hub's
  // per-subscriber counters must not move at all for a topic whose only
  // subscribers are remote.
  control('p15', 'hub_fanout_untouched_by_remote_subscribers', p15.orch_fanout, { allowed: 0, filtered: 0 });

  // ── P16 — pause orch->pod2, then re-enable ───────────────────────────────
  const pause = await api(ORCH, 'PATCH', '/outbound-peers/pod2', { enabled: false });
  await sleep(1200);
  const p16Marker = `p16-${RUN}`;
  const p16Acks: Settled[] = [];
  for (let i = 0; i < 3; i++) p16Acks.push(await settle(hubpub.c.publish(TROLLBOX, p16Marker), ACK_MS, `p16 publish ${i}`));
  await waitUntil(() => got(sub1a, p16Marker).length >= 3, DELIVER_MS);
  await sleep(2000);
  const duringPause = { sub2: got(sub2, p16Marker).length, sub1a: got(sub1a, p16Marker).length };
  const reenable = await api(ORCH, 'PATCH', '/outbound-peers/pod2', { enabled: true });
  await waitUntil(() => got(sub2, p16Marker).length >= 3, BORDER_MS);
  await sleep(2000);
  const backlog = got(sub2, p16Marker).length;
  const backlogIds = new Set(got(sub2, p16Marker).map(x => x.msgId));
  // A FRESH publish after re-enabling: the path is restored and dedupe means once.
  const p16Fresh = `p16-fresh-${RUN}`;
  const freshAck = await settle(hubpub.c.publish(TROLLBOX, p16Fresh), ACK_MS, 'p16 fresh publish');
  await waitUntil(() => got(sub2, p16Fresh).length >= 1, DELIVER_MS);
  await sleep(2500);
  log('p16_pause_resume', {
    pause_status: pause.status, pause_enabled: pause.json?.enabled, reenable_status: reenable.status, reenable_enabled: reenable.json?.enabled,
    publisher_acked_while_paused: p16Acks.map(a => a.ok), during_pause: duringPause,
    backlog_delivered_after_reenable: backlog, backlog_distinct_msg_ids: backlogIds.size,
    fresh_after_reenable: { ack: freshAck, delivered: got(sub2, p16Fresh).length },
    predictions: {
      plan_F4_PLAN_s12_P16: 'rows queue while paused; re-enable delivers the backlog once each (3)',
      code_router_enqueueOutboundTopicRows: 'listEnabledOutboundPeers skips a disabled peering, so NO row is written while paused (0)',
    },
  });
  expect('p16', 'publisher_acked_while_paused', p16Acks.map(a => a.ok), [true, true, true]);
  expect('p16', 'pod2_silent_during_pause', duringPause.sub2, 0);
  // CONTROL — only the paused peering is affected: pod1 keeps receiving, so the
  // publishes demonstrably happened and pod2's silence is the pause, not a
  // failed publish.
  control('p16', 'pod1_unaffected_by_pod2_pause', duringPause.sub1a, 3);
  expectOneOf('p16', 'backlog_after_reenable', backlog, [0, 3],
    'FINDING if 0: F4_PLAN §12 P16 says the rows queue, but enqueueOutboundTopicRows iterates listEnabledOutboundPeers (router.ts) so a paused peering is skipped and there is no backlog to drain. Anything other than 0 or 3 is a real failure.');
  control('p16', 'no_duplicate_backlog_copies', backlogIds.size, backlog, 'dedupe: whatever arrives, arrives once');
  expect('p16', 'fresh_publish_after_reenable_delivered_once', [freshAck.ok, got(sub2, p16Fresh).length], [true, 1]);

  // ── P17 — pod1 posts to orch:trollbox (spoke -> hub -> spokes) ───────────
  const p17Marker = `p17-${RUN}`;
  const b17a = await scrape(POD1), b17o = await scrape(ORCH), b17b = await scrape(POD2);
  const p17Ack = await settle(pub1.c.publish(`orch:${TROLLBOX}`, p17Marker), ACK_MS, 'p17 spoke post');
  await waitUntil(() => got(sub2, p17Marker).length >= 1 && got(sub1a, p17Marker).length >= 1, BORDER_MS);
  await sleep(2500);
  const a17a = await scrape(POD1), a17o = await scrape(ORCH), a17b = await scrape(POD2);
  const echo = got(sub1a, p17Marker)[0] ?? null;
  const remote = got(sub2, p17Marker)[0] ?? null;
  const p17 = {
    ack: p17Ack,
    pod2_received: got(sub2, p17Marker).length, pod1_echo: got(sub1a, p17Marker).length,
    sub1b: got(sub1b, p17Marker).length, sub2b: got(sub2b, p17Marker).length,
    echo: echo === null ? null : { msgId: echo.msgId, from: echo.from, topic: echo.topic, origin: echo.origin },
    remote: remote === null ? null : { msgId: remote.msgId, from: remote.from, topic: remote.topic, origin: remote.origin },
    orch_relay_in_publish: delta(b17o, a17o, RELAY_IN_PUB),
    pod1_relay_in_topic: delta(b17a, a17a, RELAY_IN_TOPIC), pod2_relay_in_topic: delta(b17b, a17b, RELAY_IN_TOPIC),
  };
  log('p17_transit', p17);
  expect('p17', 'post_accepted_and_crossed_two_borders', [p17Ack.ok, p17.orch_relay_in_publish, p17.pod1_relay_in_topic, p17.pod2_relay_in_topic], [true, 1, 1, 1]);
  expect('p17', 'granted_remote_subscriber_receives_exactly_once', p17.pod2_received, 1);
  expect('p17', 'publishers_own_mesh_receives_the_echo', p17.pod1_echo, 1,
    'one frame per peering cannot exclude the publisher; suppression would mean routing on origin');
  expect('p17', 'origin_names_the_real_speaker', [remote?.origin, echo?.origin], [`pod1:${PUB1}`, `pod1:${PUB1}`]);
  expect('p17', 'from_is_the_topic_principal_on_both_spokes', [remote?.from, echo?.from], [`orch:${TROLLBOX}`, `orch:${TROLLBOX}`]);
  expect('p17', 'pod2_msg_id_differs_from_pod1', remote !== null && echo !== null && remote.msgId !== echo.msgId, true,
    'each mesh mints a fresh crypto.randomUUID() per copy; the SDK does not expose the publisher-side msg_id, so pod1\'s id is read from its own delivery');
  // CONTROL — a `topic` delivery is never re-originated: if pod2 re-originated,
  // pod1 would see a second copy. And the spoke ACL still binds on a transited
  // post, so the deaf subscribers stay deaf.
  control('p17', 'never_re_originated', p17.pod1_echo === 1 && p17.pod2_received === 1, true);
  control('p17', 'deaf_subscribers_still_deaf', [p17.sub1b, p17.sub2b], [0, 0]);

  // ── P18a — the hub withholds the inbound post edge for topic:analytics ───
  const p18Marker = `p18-${RUN}`;
  const b18o = await scrape(ORCH), b18a = await scrape(POD1);
  const errsBefore18 = pub1.errs.length;
  const p18Ack = await settle(pub1.c.publish(`orch:${ANALYTICS}`, p18Marker), ACK_MS, 'p18 read-only topic post');
  await waitUntil(() => pub1.errs.slice(errsBefore18).some(e => e.code === 'REMOTE_REFUSED'), BORDER_MS);
  await sleep(3000);
  const refusals = pub1.errs.slice(errsBefore18).filter(e => e.code === 'REMOTE_REFUSED');
  // CONTROL for P18a, driven in the same window: the SAME publisher over the
  // SAME peering to a topic where the hub DID grant the post edge is delivered
  // and produces no refusal.
  const p18Control = `p18-control-${RUN}`;
  const errsBeforeCtl = pub1.errs.length;
  const ctlAck = await settle(pub1.c.publish(`orch:${TROLLBOX}`, p18Control), ACK_MS, 'p18 control post');
  await waitUntil(() => got(sub2, p18Control).length >= 1, BORDER_MS);
  await sleep(2000);
  const a18o = await scrape(ORCH), a18a = await scrape(POD1);
  log('p18a_read_only_topic', {
    local_ack: p18Ack, remote_refused: refusals,
    orch_relay_in_refused_publish: delta(b18o, a18o, RELAY_IN_REFUSED_PUB),
    pod1_relay_outbound_refused_publish: delta(b18a, a18a, RELAY_OUT_REFUSED_PUB),
    control: { ack: ctlAck, refusals: pub1.errs.slice(errsBeforeCtl).filter(e => e.code === 'REMOTE_REFUSED'), delivered_to_pod2: got(sub2, p18Control).length },
    note: 'the spoke accepts (its own RIGHT TO POST edge exists); the HUB refuses at the border with RELAY_REFUSED (no_post_edge)',
  });
  expect('p18a', 'accepted_at_the_spoke_refused_at_the_border', [p18Ack.ok, refusals.length], [true, 1],
    'exactly one REMOTE_REFUSED: RELAY_REFUSED is permanent, so border.ts fails the row instead of retrying');
  expect('p18a', 'refusal_counted_on_both_sides', [delta(b18o, a18o, RELAY_IN_REFUSED_PUB), delta(b18a, a18a, RELAY_OUT_REFUSED_PUB)], [1, 1]);
  expect('p18a', 'no_delivery_of_the_refused_post', [got(sub1a, p18Marker).length, got(sub2, p18Marker).length], [0, 0]);
  control('p18a', 'granted_topic_over_the_same_peering_unaffected',
    [ctlAck.ok, pub1.errs.slice(errsBeforeCtl).filter(e => e.code === 'REMOTE_REFUSED').length, got(sub2, p18Control).length],
    [true, 0, 1]);

  // ── P18b — a forged `origin` on a raw peer frame ─────────────────────────
  // LAST, and deliberately so: this connects to pod2 as the alias `orch` with
  // the credential orch's forwarder holds, which EVICTS that forwarder's socket
  // (newer-wins). It reconnects, but nothing after this step may depend on the
  // hub->pod2 peering being continuously up.
  const b18b = await scrape(POD2);
  const rogue = new PeerClient({ serverUrl: POD2.ws, agentId: 'orch', agentToken: p13.orch_to_pod2.token });
  await withTimeout(rogue.connect(), CONNECT_MS, 'rogue peer connect to pod2');
  const forgedMarker = `p18b-${RUN}`;
  const forged = await settle(rogue.relay({
    type: 'relay',
    msg_id: `forged-${RUN}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'topic',
    from: TROLLBOX,          // bare — the topic principal; a ':' here is from_not_one_hop
    topic: TROLLBOX,
    origin: 'orch:admin',    // THE FORGERY: a principal sub2b holds an edge from
    payload: forgedMarker,
    content_type: 'text/plain',
  }), ACK_MS, 'forged origin relay');
  await waitUntil(() => got(sub2, forgedMarker).length >= 1, DELIVER_MS);
  await sleep(2500);
  const a18b = await scrape(POD2);
  const forgedDelivery = got(sub2, forgedMarker)[0] ?? null;
  log('p18b_origin_forgery', {
    relay: forged,
    sub2: got(sub2, forgedMarker).length, sub2b: got(sub2b, forgedMarker).length,
    delivery: forgedDelivery === null ? null : { from: forgedDelivery.from, topic: forgedDelivery.topic, origin: forgedDelivery.origin, kind: forgedDelivery.kind },
    pod2_fanout: { allowed: delta(b18b, a18b, FANOUT_ALLOWED), filtered: delta(b18b, a18b, FANOUT_FILTERED) },
    note: 'sub2b holds `orch:admin -> sub2b` and NOT `orch:trollbox -> sub2b`; origin is display-only, never an ACL principal and never from_agent',
  });
  expect('p18b', 'forged_frame_accepted_at_the_border', forged.ok, true);
  expect('p18b', 'from_agent_unchanged_by_origin', [forgedDelivery?.from, forgedDelivery?.topic], [`orch:${TROLLBOX}`, `orch:${TROLLBOX}`]);
  expect('p18b', 'origin_carried_verbatim_and_display_only', forgedDelivery?.origin, 'orch:admin');
  expect('p18b', 'granted_subscriber_still_receives', got(sub2, forgedMarker).length, 1);
  // CONTROL — the whole point: an edge from the FORGED principal must buy
  // nothing. If sub2b receives, `origin` became the ACL principal.
  control('p18b', 'no_acl_outcome_changed_by_origin', got(sub2b, forgedMarker).length, 0);
  control('p18b', 'forged_principal_counted_as_filtered_not_allowed', delta(b18b, a18b, FANOUT_FILTERED) >= 1, true);
  rogue.close();

  // ── summary ───────────────────────────────────────────────────────────────
  const steps = ['setup', 'p13', 'p14', 'p15', 'p16', 'p17', 'p18a', 'p18b'];
  const perStep = steps.map(s => {
    const of = checks.filter(c => c.step === s);
    return { step: s, checks: of.length, failed: of.filter(c => !c.pass).map(c => c.name), pass: of.every(c => c.pass) };
  });
  const allPass = perStep.every(s => s.pass);
  log('SUMMARY', {
    verdict: allPass ? 'PASS' : 'FAIL',
    steps: perStep,
    totals: { checks: checks.length, failed: checks.filter(c => !c.pass).length, controls: checks.filter(c => c.kind === 'control').length },
    elapsed_ms: Date.now() - t0,
    sandbox_caveat: 'observes a SANDBOX built from the pinned PR head — NOT production',
  });
  for (const s of seats) s.c.close();
  process.exit(allPass ? 0 : 1);
}

main().catch(async (e: unknown) => {
  log('FATAL', {
    error: String(e),
    checks_completed: checks.length,
    failed_so_far: checks.filter(c => !c.pass).map(c => `${c.step}/${c.name}`),
    note: 'a step threw; the remaining steps were NOT DRIVEN — wrap the failing probe before re-running',
  });
  try {
    log('gauges_after_fatal', { up: await Promise.all(MESHES.map(async m => ({ mesh: m.name, series: ((await api(m, 'GET', '/metrics', undefined, false)).text.match(/mesh_peer_up_count\{state="[a-z]+"\} \d+/g) ?? []) }))) });
  } catch { /* the sandbox may be gone; the FATAL line is the record */ }
  for (const s of seats) { try { s.c.close(); } catch { /* already closed */ } }
  process.exit(1);
});
