import { Database } from 'bun:sqlite';
import { countTopics, countSubscriptions, countAgentsOnline, countPendingMessages } from './db.ts';

// ──────────────────────────────────────────────
// Internal state (module-level)
// ──────────────────────────────────────────────

type LabeledCounter = Map<string, number>;
// Key encoding: label VALUES joined by NUL (\0) in a FIXED order. NUL cannot
// appear in agent ids / kinds / statuses / error codes.
const msgStatus: LabeledCounter   = new Map(); // key = `${kind}\0${status}`
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
const requestDuration = newHistogram([0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]);
const payloadBytes    = newHistogram([64, 256, 1024, 4096, 16384, 65536, 262144, 1048576]);

function bump(m: LabeledCounter, key: string, by = 1): void { m.set(key, (m.get(key) ?? 0) + by); }
function s(v: unknown): string { return typeof v === 'string' ? v : String(v); }

export function escapeLabelValue(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

// ──────────────────────────────────────────────
// Public functions (ALL wrapped try/catch, never throw)
// ──────────────────────────────────────────────

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
export function observeRequestDuration(seconds: number): void {
  try {
    if (Number.isFinite(seconds)) histObserve(requestDuration, seconds);
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

export function renderMetrics(db: Database, pendingRequests?: Map<string, unknown>): string {
  const lines: string[] = [];

  // mesh_messages_total {kind,status}
  lines.push('# HELP mesh_messages_total Messages by kind and delivery status.');
  lines.push('# TYPE mesh_messages_total counter');
  for (const [key, v] of msgStatus) {
    const sep = key.indexOf('\0');
    const kind = key.slice(0, sep);
    const status = key.slice(sep + 1);
    lines.push(`mesh_messages_total{kind="${escapeLabelValue(kind)}",status="${escapeLabelValue(status)}"} ${v}`);
  }

  // mesh_messages_sent_total {from_agent}
  lines.push('# HELP mesh_messages_sent_total Messages accepted and routed, by sender.');
  lines.push('# TYPE mesh_messages_sent_total counter');
  for (const [key, v] of sent) {
    lines.push(`mesh_messages_sent_total{from_agent="${escapeLabelValue(key)}"} ${v}`);
  }

  // mesh_messages_received_total {to_agent}
  lines.push('# HELP mesh_messages_received_total Messages delivered, by recipient.');
  lines.push('# TYPE mesh_messages_received_total counter');
  for (const [key, v] of received) {
    lines.push(`mesh_messages_received_total{to_agent="${escapeLabelValue(key)}"} ${v}`);
  }

  // mesh_acl_denied_total {from_agent}
  lines.push('# HELP mesh_acl_denied_total ACL-denied send attempts, by sender.');
  lines.push('# TYPE mesh_acl_denied_total counter');
  for (const [key, v] of aclDenied) {
    lines.push(`mesh_acl_denied_total{from_agent="${escapeLabelValue(key)}"} ${v}`);
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

  // mesh_agent_up {agent}
  lines.push('# HELP mesh_agent_up 1 if the agent is currently connected, else 0.');
  lines.push('# TYPE mesh_agent_up gauge');
  const agentRows = db.prepare('SELECT id, online FROM agents').all() as { id: string; online: number }[];
  for (const row of agentRows) {
    lines.push(`mesh_agent_up{agent="${escapeLabelValue(row.id)}"} ${row.online === 1 ? 1 : 0}`);
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

  // mesh_pending_requests
  lines.push('# HELP mesh_pending_requests In-flight request/response correlations.');
  lines.push('# TYPE mesh_pending_requests gauge');
  lines.push(`mesh_pending_requests ${pendingRequests ? pendingRequests.size : 0}`);

  // mesh_reminders_pending
  lines.push('# HELP mesh_reminders_pending Reminders currently in pending status.');
  lines.push('# TYPE mesh_reminders_pending gauge');
  const pendingReminders = (db.prepare("SELECT COUNT(*) AS c FROM reminders WHERE status = 'pending'").get() as { c: number }).c;
  lines.push(`mesh_reminders_pending ${pendingReminders}`);

  // Histograms
  renderHistogram('mesh_request_duration_seconds', 'Request to response round-trip seconds.', requestDuration, lines);
  renderHistogram('mesh_message_payload_bytes', 'Accepted message payload sizes in bytes.', payloadBytes, lines);

  return lines.join('\n') + '\n';
}

// ──────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────

export function __resetMetricsForTest(): void {
  msgStatus.clear();
  sent.clear();
  received.clear();
  aclDenied.clear();
  errors.clear();
  bytes.clear();
  filesTotal = 0;
  remindersFired = 0;
  for (const h of [requestDuration, payloadBytes]) {
    h.counts.fill(0);
    h.inf = 0;
    h.sum = 0;
    h.count = 0;
  }
}
