import { Database } from 'bun:sqlite';
import { countTopics, countSubscriptions, countAgentsOnline, countPendingMessages } from './db.ts';

// ──────────────────────────────────────────────
// Internal state (module-level)
// ──────────────────────────────────────────────

type LabeledCounter = Map<string, number>;
// Key encoding: label VALUES joined by NUL (\0) in a FIXED order. NUL cannot
// appear in agent ids / kinds / statuses / error codes.
const msgStatus: LabeledCounter   = new Map(); // key = `${kind}\0${status}`
const topicFanout: LabeledCounter = new Map(); // #136: key = outcome. NO topic label — see incTopicFanout.
const sent: LabeledCounter        = new Map(); // key = from_agent
const received: LabeledCounter    = new Map(); // key = to_agent
const aclDenied: LabeledCounter   = new Map(); // key = from_agent
const errors: LabeledCounter      = new Map(); // key = error_code
const bytes: LabeledCounter       = new Map(); // key = direction ("in"|"out")
let filesTotal = 0;
let remindersFired = 0;

interface Histogram {
  buckets: number[];   // ascending upper bounds (le), excludes +Inf
  counts: number[];    // per-bucket (non-cumulative) hit counts (len = buckets.length)
  inf: number;         // observations greater than the last bucket bound
  sum: number;
  count: number;
}
function newHistogram(buckets: number[]): Histogram {
  return { buckets, counts: new Array(buckets.length).fill(0), inf: 0, sum: 0, count: 0 };
}
function histObserve(h: Histogram, v: number): void {
  h.sum += v; h.count += 1;
  for (let i = 0; i < h.buckets.length; i++) {
    if (v <= h.buckets[i]) { h.counts[i] += 1; return; }
  }
  h.inf += 1;
}
const payloadBytes    = newHistogram([64, 256, 1024, 4096, 16384, 65536, 262144, 1048576]);

function bump(m: LabeledCounter, key: string, by = 1): void { m.set(key, (m.get(key) ?? 0) + by); }
function s(v: unknown): string { return typeof v === 'string' ? v : String(v); }

// F1b: alias \0 direction \0 outcome -> count.
const peerRelays = new Map<string, number>();

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ──────────────────────────────────────────────
// Public functions (ALL wrapped try/catch, never throw)
// ──────────────────────────────────────────────

/**
 * F1b (§1.1, #12): peer relay counters.
 *
 * LABELLED PER PEER ALIAS, never per remote agent. A remote mesh chooses its
 * own agent ids, so a per-agent label lets a peer mint unbounded label values
 * in our metrics store — cardinality we do not control. The alias is OURS: we
 * issued it, and there is exactly one per peering.
 */
export function incPeerRelay(alias: string, direction: string, outcome: string): void {
  try { bump(peerRelays, `${s(alias)}\0${s(direction)}\0${s(outcome)}`); } catch (_) { /* metrics must never affect delivery */ }
}

/**
 * #136 — per-subscriber outcomes of a TOPIC fan-out.
 *
 * WHY THIS IS NOT `incAclDenied`. On a topic publish the sender does NOT choose
 * the recipients: it names a topic, and the ACL filters the subscriber list.
 * Counting each filtered subscriber as an "ACL-denied send attempt by sender"
 * is a semantics error for EVERY topic — the sender attempted one publish, not
 * N sends to N agents it never named.
 *
 * It surfaced on `sys.presence.turn` because that topic is published ~2/s
 * fleet-wide by the turn-status publisher, producing ~5,800 "denials" an hour
 * attributed to no client and swamping the counter so completely that a real
 * refusal storm would have been invisible in it. The topic was the messenger;
 * the defect is the semantics.
 *
 * THE OUTCOMES ARE `allowed` / `filtered`, NOT `delivered` / `filtered`, and the
 * distinction is the same class of defect this series exists to fix. The
 * increment happens where the ACL decision is made, which is BEFORE the
 * online/offline branch: one message to an offline subscriber produced
 * `delivered` here and `dropped` in mesh_messages_total at the same time. On a
 * ttl=0 topic like the turn feed, offline subscribers are the systematic case,
 * not the edge. The counter measures "passed the ACL filter" and now says so.
 * There is no third outcome: delivery is already counted by mesh_messages_total,
 * and a second authority on it is how counters start disagreeing.
 *
 * THE LABEL SET IS CLOSED BECAUSE THERE IS NO NAME LABEL. Topic names are
 * agent-chosen — `routeSubscribe` calls `getOrCreateTopic` with whatever an
 * agent asks for — so a `topic` label CANNOT be made party-free by any guard:
 * a prefix check only decides which agent-chosen strings get in. An earlier
 * revision of this series carried `{topic}` behind a `sys.` prefix check and
 * was reachable — an agent publishing to `sys.<victim-id>` with one other
 * subscriber put that id in the unauthenticated document. The fix is not a
 * better guard on the name; it is having no name.
 */
export function incTopicFanout(outcome: 'allowed' | 'filtered'): void {
  try { bump(topicFanout, s(outcome)); } catch (_) { /* metrics must never affect delivery */ }
}

export function incReminderFired(): void {
  try { remindersFired += 1; } catch (_) { /* metrics must never affect delivery */ }
}
export function incMsgStatus(kind: string, status: string): void {
  try { bump(msgStatus, `${s(kind)}\0${s(status)}`); } catch (_) { /* metrics must never affect delivery */ }
}
export function incSent(from: string): void {
  try { bump(sent, s(from)); } catch (_) { /* metrics must never affect delivery */ }
}
export function incReceived(to: string): void {
  try { bump(received, s(to)); } catch (_) { /* metrics must never affect delivery */ }
}
export function incAclDenied(from: string): void {
  try { bump(aclDenied, s(from)); } catch (_) { /* metrics must never affect delivery */ }
}
export function incError(code: string): void {
  try { bump(errors, s(code)); } catch (_) { /* metrics must never affect delivery */ }
}
export function incBytes(direction: string, n: number): void {
  try {
    const amt = Number.isFinite(n) ? n : 0;
    bump(bytes, s(direction), amt);
  } catch (_) { /* metrics must never affect delivery */ }
}
export function incFile(): void {
  try { filesTotal += 1; } catch (_) { /* metrics must never affect delivery */ }
}
export function incExpiredByKind(kind: string, n: number): void {
  try {
    if (Number.isFinite(n) && n > 0) bump(msgStatus, `${s(kind)}\0expired`, n);
  } catch (_) { /* metrics must never affect delivery */ }
}
export function observePayloadBytes(n: number): void {
  try {
    if (Number.isFinite(n)) histObserve(payloadBytes, n);
  } catch (_) { /* metrics must never affect delivery */ }
}

// ──────────────────────────────────────────────
// Rendering
// ──────────────────────────────────────────────

function renderHistogram(name: string, help: string, h: Histogram, lines: string[]) {
  lines.push(`# HELP ${name} ${help}`);
  lines.push(`# TYPE ${name} histogram`);
  let cumulative = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    cumulative += h.counts[i];
    lines.push(`${name}_bucket{le="${String(h.buckets[i])}"} ${cumulative}`);
  }
  cumulative += h.inf;
  lines.push(`${name}_bucket{le="+Inf"} ${cumulative}`); // == h.count
  lines.push(`${name}_sum ${h.sum}`);
  lines.push(`${name}_count ${h.count}`);
}

/**
 * Supplies mesh_peer_up's series: EVERY CONFIGURED PEER with its state, not
 * only the connected ones (#108).
 *
 * The distinction is the whole point. A gauge emitted only when up produces a
 * series that APPEARS on connect and VANISHES on disconnect — and you cannot
 * alert on a series that is absent, because "no data" is indistinguishable from
 * "never configured". The alert an operator wants is "this peering went to 0",
 * which requires the 0 to exist.
 *
 * Set once at boot by server.ts; defaults to none so every existing caller of
 * renderMetrics (and every test) is unchanged.
 */
/** Read at render time, not at import: a test (and an operator) can change it
 *  without restarting, and there is no cached copy to disagree with the env. */
/**
 * Does this deployment accept that /metrics is internal-only?
 *
 * /metrics is UNAUTHENTICATED. Every label below that carries an AGENT ID or a
 * PEER ALIAS is an enumeration of something the system otherwise withholds:
 * `handleListPresence` is ACL-filtered so an agent cannot enumerate agents it
 * has no edge to, and peer aliases are meaningful names that map this org's
 * federation topology. A metrics label is not a lesser disclosure than an API
 * response — it is the same information with no auth in front of it.
 *
 * It was first written as a PEER-alias flag. That was too narrow: the same
 * reader enumerates LOCAL AGENT IDS from mesh_agent_up, mesh_messages_sent_total,
 * mesh_messages_received_total and mesh_acl_denied_total. The label is a
 * disclosure from the READER's position, not from the labelled party's.
 *
 * Off: aggregates only — still alertable, naming nobody.
 * On:  identity labels, an explicit deployment decision.
 */
function identityLabelsEnabled(): boolean {
  return process.env.MESH_METRICS_IDENTITY_LABELS === '1';
}

let peerUpSource: () => Iterable<{ alias: string; up: boolean }> = () => [];
export function setPeerUpSource(fn: () => Iterable<{ alias: string; up: boolean }>): void {
  peerUpSource = fn;
}

/**
 * Labels whose values can never name a party (an agent id or a peer alias).
 * Closed and exhaustive: everything NOT on this list must sit behind
 * identityLabelsEnabled().
 *
 * It lives here, beside the emitters, rather than in the test that enforces it,
 * so that the person adding a label meets it while adding the label. Each entry
 * states its value domain, and an entry is only earned by a domain that is a
 * fixed set of constants at the call sites:
 *
 *   direction   'in' | 'outbound'                              (router.ts, border.ts)
 *   error_code  the ERR_* code constants                        (errors.ts)
 *   kind        the message-kind constants                      (protocol.ts)
 *   le          a histogram bucket boundary — a number
 *   outcome     'delivered'|'refused'|'rate_limited'|'duplicate'|'transient'
 *   state       'online'|'offline' / 'up'|'down'
 *   status      'delivered'|'queued'|'dropped'|'expired'
 */
export const PARTY_FREE_LABELS: ReadonlySet<string> = new Set([
  'direction', 'error_code', 'kind', 'le', 'outcome', 'state', 'status',
]);

export function renderMetrics(db: Database): string {
  const lines: string[] = [];

  // #136: mesh_topic_fanout_total {outcome} — per-subscriber outcomes of topic
  // fan-out. NO topic label: names are agent-chosen, so the label set is closed
  // only because there is no name in it.
  lines.push('# HELP mesh_topic_fanout_total Per-subscriber ACL outcomes of topic fan-out: allowed = passed the ACL filter, filtered = refused by it. NOT delivery — a subscriber that is offline is counted allowed here and dropped in mesh_messages_total, which is the authority on delivery. ACL filtering here is NOT counted in mesh_acl_denied_total or mesh_errors_total, which count DIRECT sends where the sender chose the recipient.');
  lines.push('# TYPE mesh_topic_fanout_total counter');
  for (const [outcome, v] of topicFanout) {
    lines.push(`mesh_topic_fanout_total{outcome="${escapeLabelValue(outcome)}"} ${v}`);
  }

  // mesh_messages_total {kind,status}
  lines.push('# HELP mesh_messages_total Messages by kind and delivery status.');
  lines.push('# TYPE mesh_messages_total counter');
  for (const [key, v] of msgStatus) {
    const sep = key.indexOf('\0');
    const kind = key.slice(0, sep);
    const status = key.slice(sep + 1);
    lines.push(`mesh_messages_total{kind="${escapeLabelValue(kind)}",status="${escapeLabelValue(status)}"} ${v}`);
  }

  // mesh_messages_sent_total — identity label, gated.
  if (identityLabelsEnabled()) {
    lines.push('# HELP mesh_messages_sent_total Messages accepted and routed, by sender.');
    lines.push('# TYPE mesh_messages_sent_total counter');
    for (const [key, v] of sent) {
      lines.push(`mesh_messages_sent_total{from_agent="${escapeLabelValue(key)}"} ${v}`);
    }
  } else {
    let total = 0;
    for (const [, v] of sent) total += v;
    lines.push('# HELP mesh_messages_sent_total Messages accepted and routed, by sender. (identities hidden; set MESH_METRICS_IDENTITY_LABELS=1)');
    lines.push('# TYPE mesh_messages_sent_total counter');
    lines.push(`mesh_messages_sent_total ${total}`);
  }

  // mesh_messages_received_total — identity label, gated.
  if (identityLabelsEnabled()) {
    lines.push('# HELP mesh_messages_received_total Messages delivered, by recipient.');
    lines.push('# TYPE mesh_messages_received_total counter');
    for (const [key, v] of received) {
      lines.push(`mesh_messages_received_total{to_agent="${escapeLabelValue(key)}"} ${v}`);
    }
  } else {
    let total = 0;
    for (const [, v] of received) total += v;
    lines.push('# HELP mesh_messages_received_total Messages delivered, by recipient. (identities hidden; set MESH_METRICS_IDENTITY_LABELS=1)');
    lines.push('# TYPE mesh_messages_received_total counter');
    lines.push(`mesh_messages_received_total ${total}`);
  }

  // mesh_acl_denied_total — identity label, gated.
  if (identityLabelsEnabled()) {
    lines.push('# HELP mesh_acl_denied_total ACL-denied DIRECT send attempts, by sender — sends where the sender chose the recipient. Topic fan-out filtering is counted in mesh_topic_fanout_total (#136).');
    lines.push('# TYPE mesh_acl_denied_total counter');
    for (const [key, v] of aclDenied) {
      lines.push(`mesh_acl_denied_total{from_agent="${escapeLabelValue(key)}"} ${v}`);
    }
  } else {
    let total = 0;
    for (const [, v] of aclDenied) total += v;
    lines.push('# HELP mesh_acl_denied_total ACL-denied DIRECT send attempts, by sender — sends where the sender chose the recipient. Topic fan-out filtering is counted in mesh_topic_fanout_total (#136). (identities hidden; set MESH_METRICS_IDENTITY_LABELS=1)');
    lines.push('# TYPE mesh_acl_denied_total counter');
    lines.push(`mesh_acl_denied_total ${total}`);
  }

  // mesh_errors_total {error_code}
  lines.push('# HELP mesh_errors_total Router errors returned, by error_code.');
  lines.push('# TYPE mesh_errors_total counter');
  for (const [key, v] of errors) {
    lines.push(`mesh_errors_total{error_code="${escapeLabelValue(key)}"} ${v}`);
  }

  // mesh_bytes_total {direction}
  lines.push('# HELP mesh_bytes_total Payload bytes by direction (in=accepted, out=delivered).');
  lines.push('# TYPE mesh_bytes_total counter');
  for (const [key, v] of bytes) {
    lines.push(`mesh_bytes_total{direction="${escapeLabelValue(key)}"} ${v}`);
  }

  // mesh_files_total
  lines.push('# HELP mesh_files_total Files routed.');
  lines.push('# TYPE mesh_files_total counter');
  lines.push(`mesh_files_total ${filesTotal}`);

  // mesh_reminders_fired_total
  lines.push('# HELP mesh_reminders_fired_total Total reminders fired since process start.');
  lines.push('# TYPE mesh_reminders_fired_total counter');
  lines.push(`mesh_reminders_fired_total ${remindersFired}`);

  // mesh_agents_online
  lines.push('# HELP mesh_agents_online Number of agents currently online.');
  lines.push('# TYPE mesh_agents_online gauge');
  lines.push(`mesh_agents_online ${countAgentsOnline(db)}`);

  // mesh_agent_up {agent} — the widest identity label here: it lists EVERY
  // registered agent id, which is precisely the roster handleListPresence
  // ACL-filters. Gated.
  const agentRows = db.prepare('SELECT id, online FROM agents').all() as { id: string; online: number }[];
  if (identityLabelsEnabled()) {
    lines.push('# HELP mesh_agent_up 1 if the agent is currently connected, else 0.');
    lines.push('# TYPE mesh_agent_up gauge');
    for (const row of agentRows) {
      lines.push(`mesh_agent_up{agent="${escapeLabelValue(row.id)}"} ${row.online === 1 ? 1 : 0}`);
    }
  } else {
    const up = agentRows.filter(r => r.online === 1).length;
    lines.push('# HELP mesh_agent_up_count Registered agents by connection state (identities hidden; set MESH_METRICS_IDENTITY_LABELS=1).');
    lines.push('# TYPE mesh_agent_up_count gauge');
    lines.push(`mesh_agent_up_count{state="up"} ${up}`);
    lines.push(`mesh_agent_up_count{state="down"} ${agentRows.length - up}`);
  }

  // mesh_topics
  lines.push('# HELP mesh_topics Number of topics.');
  lines.push('# TYPE mesh_topics gauge');
  lines.push(`mesh_topics ${countTopics(db)}`);

  // mesh_subscriptions
  lines.push('# HELP mesh_subscriptions Number of subscriptions.');
  lines.push('# TYPE mesh_subscriptions gauge');
  lines.push(`mesh_subscriptions ${countSubscriptions(db)}`);

  // mesh_pending_messages
  lines.push('# HELP mesh_pending_messages Undelivered, unexpired queued messages.');
  lines.push('# TYPE mesh_pending_messages gauge');
  lines.push(`mesh_pending_messages ${countPendingMessages(db)}`);

  // mesh_reminders_pending
  lines.push('# HELP mesh_reminders_pending Reminders currently in pending status.');
  lines.push('# TYPE mesh_reminders_pending gauge');
  const pendingReminders = (db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE status = 'pending'").get() as { c: number }).c;
  lines.push(`mesh_reminders_pending ${pendingReminders}`);

  // Histograms
  renderHistogram('mesh_message_payload_bytes', 'Accepted message payload sizes in bytes.', payloadBytes, lines);

  // PEER-ALIAS LABELS ARE OPT-IN (F2b probe finding 2).
  //
  // /metrics is unauthenticated. With per-alias series it enumerates the
  // COMPLETE inter-org topology in both directions, with volumes and outcomes —
  // and aliases are deliberately meaningful names (§9), so the labels ARE the
  // disclosure. The exemption that made unauthenticated /metrics acceptable
  // rests on "the admin port is internal-only", which is a DEPLOYMENT claim the
  // code cannot enforce; before F2 it protected traffic counts, now it would
  // protect who this org federates with.
  //
  // Default: aggregates, which keep the numbers useful and name nobody.
  // MESH_METRICS_IDENTITY_LABELS=1: per-alias series, an explicit deployment
  // decision that /metrics is genuinely internal-only.
  if (identityLabelsEnabled()) {
    lines.push('# HELP mesh_peer_relays_total Relayed messages by peer alias, direction and outcome.');
    lines.push('# TYPE mesh_peer_relays_total counter');
    for (const [key, v] of peerRelays) {
      const [alias, direction, outcome] = key.split('\0');
      lines.push(`mesh_peer_relays_total{alias="${escapeLabelValue(alias ?? '')}",direction="${escapeLabelValue(direction ?? '')}",outcome="${escapeLabelValue(outcome ?? '')}"} ${v}`);
    }
  } else {
    // Aggregated over aliases: direction and outcome carry no topology.
    const agg = new Map<string, number>();
    for (const [key, v] of peerRelays) {
      const [, direction, outcome] = key.split('\0');
      const k = `${direction ?? ''}\0${outcome ?? ''}`;
      agg.set(k, (agg.get(k) ?? 0) + v);
    }
    lines.push('# HELP mesh_peer_relays_total Relayed messages by direction and outcome (identity labels hidden; set MESH_METRICS_IDENTITY_LABELS=1 to label by party).');
    lines.push('# TYPE mesh_peer_relays_total counter');
    for (const [k, v] of agg) {
      const [direction, outcome] = k.split('\0');
      lines.push(`mesh_peer_relays_total{direction="${escapeLabelValue(direction ?? '')}",outcome="${escapeLabelValue(outcome ?? '')}"} ${v}`);
    }
  }

  // mesh_peer_up {alias} — 0 or 1 for EVERY configured peering, both
  // directions (#108). State is read LIVE (the socket index, the forwarder's
  // connection), never from a stored column: after #87, a durable liveness
  // claim that outlives the process is exactly what must not be invented.
  const peers = [...peerUpSource()];
  if (identityLabelsEnabled()) {
    lines.push('# HELP mesh_peer_up Whether a configured peering currently holds an authenticated socket.');
    lines.push('# TYPE mesh_peer_up gauge');
    for (const { alias, up } of peers) {
      lines.push(`mesh_peer_up{alias="${escapeLabelValue(alias)}"} ${up ? 1 : 0}`);
    }
  } else {
    // #108's ALERTABILITY SURVIVES the default: both series always exist, so
    // "peerings went down" is still a value that moves rather than a series
    // that vanishes. What is withheld is WHICH peering — the alert fires and
    // the operator looks at a labelled instance or the logs.
    const up = peers.filter(p => p.up).length;
    lines.push('# HELP mesh_peer_up_count Configured peerings by connection state (identity labels hidden; set MESH_METRICS_IDENTITY_LABELS=1 to label by party).');
    lines.push('# TYPE mesh_peer_up_count gauge');
    lines.push(`mesh_peer_up_count{state="up"} ${up}`);
    lines.push(`mesh_peer_up_count{state="down"} ${peers.length - up}`);
  }

  return lines.join('\n') + '\n';
}

// ──────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────

export function __resetMetricsForTest(): void {
  msgStatus.clear();
  topicFanout.clear();
  sent.clear();
  received.clear();
  aclDenied.clear();
  errors.clear();
  bytes.clear();
  filesTotal = 0;
  remindersFired = 0;
  for (const h of [payloadBytes]) {
    h.counts.fill(0);
    h.inf = 0;
    h.sum = 0;
    h.count = 0;
  }
}
