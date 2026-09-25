/**
 * MESH_PLAINTEXT_PEER_CIDRS — the networks where a plaintext `ws://` OUTBOUND
 * peering is permitted, declared by the operator at boot.
 *
 * Unset or empty is today's rule exactly: `ws://` for loopback and nothing
 * else. Every existing deployment must see no change, so the empty list is not
 * a special case of matching — `validateOutboundPeerUrl` returns before it
 * reaches the list at all.
 *
 * ONE ADDRESS SPACE. Every address and every range is held as a 128-bit
 * integer, IPv4 as its v4-mapped IPv6 form (`::ffff:a.b.c.d`). The URL parser
 * spells `ws://[::ffff:10.20.0.5]` as `[::ffff:a14:5]`, and an allow-list that
 * matched only one of the two spellings of an address would false-refuse the
 * other — or, the other way round, a list written in one spelling would not
 * cover the address it names. With one space there is no second spelling to
 * miss.
 *
 * STRICT AT BOOT. A malformed entry refuses to start, naming it: a typo that
 * silently shrinks the list breaks a peering nobody connects to the typo, and
 * one that silently WIDENS it puts a credential on the wire in cleartext. The
 * same holds for an entry with host bits set (`10.20.0.5/16`): it has two
 * readings — the host, or its network — and picking one for the operator is
 * the silent widening.
 */
import { isIPv4, isIPv6 } from 'net';

export interface PlaintextCidr {
  /** The NORMALISED spelling — what the matcher compares, not what was typed. */
  readonly text: string;
  readonly base: bigint;
  /** Prefix length in the 128-bit space (a v4 /16 is 112 here). */
  readonly bits: number;
}

const MAPPED = 0xffffn << 32n;          // ::ffff:0:0/96
const ALL = (1n << 128n) - 1n;

function v4ToBig(s: string): bigint {
  return s.split('.').reduce((acc, o) => (acc << 8n) | BigInt(Number(o)), 0n);
}

function v6ToBig(s: string): bigint {
  // An embedded dotted-quad tail (`::ffff:10.20.0.5`) is two groups.
  const tail = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (tail !== null) {
    const v4 = v4ToBig(tail[1]!);
    s = s.slice(0, -tail[1]!.length) + `${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head, rest] = s.includes('::') ? s.split('::') as [string, string] : [s, undefined];
  const h = head === '' ? [] : head.split(':');
  const r = rest === undefined || rest === '' ? [] : rest.split(':');
  const groups = rest === undefined ? h : [...h, ...Array(8 - h.length - r.length).fill('0'), ...r];
  return groups.reduce((acc, g) => (acc << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/**
 * A LITERAL address as a 128-bit integer, or null for anything else — a name,
 * a zone-scoped address, garbage. Brackets are accepted because that is how
 * the URL parser hands a v6 host over.
 */
export function addressToBig(host: string): bigint | null {
  const h = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIPv4(h)) return MAPPED | v4ToBig(h);
  if (isIPv6(h) && !h.includes('%')) return v6ToBig(h);
  return null;
}

function bigToText(base: bigint, bits: number): string {
  if (bits >= 96 && (base >> 32n) === 0xffffn) {
    const v4 = base & 0xffffffffn;
    return `${[24n, 16n, 8n, 0n].map(sh => (v4 >> sh) & 0xffn).join('.')}/${bits - 96}`;
  }
  const groups = Array.from({ length: 8 }, (_, i) => ((base >> BigInt(112 - 16 * i)) & 0xffffn).toString(16));
  // The URL parser is the canonical v6 spelling (lower case, longest zero run
  // compressed) — the same one it will hand the matcher at dial time.
  return `${new URL(`ws://[${groups.join(':')}]`).hostname.slice(1, -1)}/${bits}`;
}

function mask(bits: number): bigint {
  return bits === 0 ? 0n : (ALL << BigInt(128 - bits)) & ALL;
}

export type ParseResult =
  | { ok: true; cidrs: PlaintextCidr[] }
  | { ok: false; entry: string; reason: string };

export function parsePlaintextPeerCidrs(raw: string | undefined): ParseResult {
  if (raw === undefined || raw.trim() === '') return { ok: true, cidrs: [] };
  const cidrs: PlaintextCidr[] = [];
  for (const piece of raw.split(',')) {
    const entry = piece.trim();
    if (entry === '') return { ok: false, entry: piece, reason: 'empty entry (stray comma?)' };
    const slash = entry.indexOf('/');
    if (slash === -1 || entry.indexOf('/', slash + 1) !== -1) {
      return { ok: false, entry, reason: 'expected exactly one ADDRESS/PREFIX' };
    }
    const addr = entry.slice(0, slash);
    const len = entry.slice(slash + 1);
    const v4 = isIPv4(addr);
    if (!v4 && !(isIPv6(addr) && !addr.includes('%'))) {
      return { ok: false, entry, reason: 'not a literal IPv4 or IPv6 address' };
    }
    const max = v4 ? 32 : 128;
    if (!/^\d{1,3}$/.test(len) || Number(len) > max) {
      return { ok: false, entry, reason: `prefix must be an integer 0-${max}` };
    }
    // A /0 is not a network, it is the rule switched off: plaintext to every
    // address, the public internet included. No other prefix floor — only the
    // one entry nobody writes meaning a network.
    if (Number(len) === 0) {
      return { ok: false, entry, reason: 'a /0 permits plaintext to every address; list the networks you mean, or use wss://' };
    }
    const bits = Number(len) + (v4 ? 96 : 0);
    const base = addressToBig(addr)!;
    const net = base & mask(bits);
    if (net !== base) {
      return { ok: false, entry, reason: `host bits set; did you mean ${bigToText(net, bits)}?` };
    }
    cidrs.push({ text: bigToText(net, bits), base: net, bits });
  }
  return { ok: true, cidrs };
}

export function cidrContains(c: PlaintextCidr, addr: bigint): boolean {
  return (addr & mask(c.bits)) === c.base;
}

// Set once at boot from the parsed env (server.ts). The default — never set —
// is the empty list, which is today's loopback-only rule: a process that forgot
// to configure this is the old, safe build, not a permissive one.
let active: readonly PlaintextCidr[] = [];

export function plaintextPeerCidrs(): readonly PlaintextCidr[] {
  return active;
}

/**
 * Install the list and announce it. One function for both, so the policy in
 * force and the line that states it cannot come from two different lists.
 *
 * The line fires when the list is EMPTY too: a verifier that greps for it and
 * finds nothing cannot tell "loopback only" from "this build predates the
 * feature", and removing that ambiguity is the line's whole job. `cidrs` is
 * the NORMALISED form — the line proves the policy, not the input.
 */
export function applyPlaintextPeerCidrs(cidrs: readonly PlaintextCidr[]): void {
  active = cidrs;
  console.log(JSON.stringify({
    evt: 'peering.plaintext_policy',
    cidrs: cidrs.map(c => c.text),
    note: cidrs.length === 0
      ? 'plaintext ws:// outbound peering is loopback-only; every other peering must use wss://'
      : 'plaintext ws:// outbound peering is permitted to LITERAL addresses in these ranges and to loopback; the peering token crosses these networks in cleartext',
    at: Date.now(),
  }));
}
