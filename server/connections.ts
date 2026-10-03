/**
 * R-65 M6 — NON-AGENT callers, by source address: observer sockets and
 * admin-port callers (the admin token, the metrics token, an unauthenticated
 * /metrics scrape). Agents are tracked PERSISTENTLY on their own row
 * (recordAgentConnection, db.ts); these are not, because a caller here has no
 * row — it is an address. In memory, since boot, and GET /connections says so.
 *
 * The question it answers is the gate for closing plaintext: "who still talks
 * to this bus over plaintext?" — so the scheme is recorded per caller.
 */
export type CallerKind = 'observer' | 'admin' | 'metrics';

interface Caller { src_ip: string; kind: CallerKind; last_scheme: string; last_seen: number }

const callers = new Map<string, Caller>();
let sinceBoot = Date.now();

export function recordCaller(srcIp: string | undefined, kind: CallerKind, scheme: string): void {
  const ip = srcIp ?? 'unknown';
  callers.set(`${kind} ${ip}`, { src_ip: ip, kind, last_scheme: scheme, last_seen: Date.now() });
}

export function listCallers(): { since_boot: number; callers: Caller[] } {
  return { since_boot: sinceBoot, callers: [...callers.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.src_ip.localeCompare(b.src_ip)) };
}

export function __resetCallersForTest(): void {
  callers.clear();
  sinceBoot = Date.now();
}
