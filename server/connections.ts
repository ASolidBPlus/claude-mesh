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
export type CallerPrincipal = 'observer' | 'admin' | 'metrics';

interface Caller { src_ip: string; principal: CallerPrincipal; last_scheme: string; last_seen: number }

/**
 * BOUNDED. Keyed by source address, which an unauthenticated /metrics caller
 * chooses freely (an IPv6 /64 alone is 2^64 of them), so an unbounded map is
 * memory an outsider can grow without limit. At the cap, a NEW caller evicts
 * the one seen longest ago; refreshing an existing caller evicts nothing.
 */
export const CALLER_CAP = 1024;

const callers = new Map<string, Caller>();
let sinceBoot = Date.now();

/** `::ffff:a.b.c.d` (an IPv4 client on a dual-stack socket) → `a.b.c.d`. */
export function normaliseIp(ip: string | null | undefined): string | null {
  if (ip === null || ip === undefined) return null;
  return ip.startsWith('::ffff:') && ip.slice(7).includes('.') ? ip.slice(7) : ip;
}

export function recordCaller(srcIp: string | null | undefined, principal: CallerPrincipal, scheme: string): void {
  const ip = normaliseIp(srcIp) ?? 'unknown';
  const key = `${principal} ${ip}`;
  if (!callers.has(key) && callers.size >= CALLER_CAP) {
    let oldestKey: string | null = null;
    let oldest = Infinity;
    for (const [k, c] of callers) if (c.last_seen < oldest) { oldest = c.last_seen; oldestKey = k; }
    if (oldestKey !== null) callers.delete(oldestKey);
  }
  // Re-inserted so Map order tracks recency too (ties on last_seen evict the
  // older insertion first).
  callers.delete(key);
  callers.set(key, { src_ip: ip, principal, last_scheme: scheme, last_seen: Date.now() });
}

export function listCallers(): { since_boot: number; callers: Caller[] } {
  return { since_boot: sinceBoot, callers: [...callers.values()].sort((a, b) => a.principal.localeCompare(b.principal) || a.src_ip.localeCompare(b.src_ip)) };
}

export function __resetCallersForTest(): void {
  callers.clear();
  sinceBoot = Date.now();
}
