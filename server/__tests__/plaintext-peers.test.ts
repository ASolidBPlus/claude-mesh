import { describe, it, expect, afterEach } from 'bun:test';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { hostname } from 'os';
import { lookup } from 'dns/promises';
import { openDb, registerAgent, insertOutboundPeer } from '../db.ts';
import { validateOutboundPeerUrl } from '../http-admin.ts';
import { startBorder, forwarders, borderEvents } from '../border.ts';
import {
  parsePlaintextPeerCidrs, applyPlaintextPeerCidrs, type PlaintextCidr,
} from '../plaintext-peers.ts';

// MESH_PLAINTEXT_PEER_CIDRS — an operator-declared list of networks where a
// plaintext ws:// OUTBOUND peering is permitted.

function cidrs(raw: string): PlaintextCidr[] {
  const r = parsePlaintextPeerCidrs(raw);
  if (!r.ok) throw new Error(`fixture list did not parse: ${r.entry} — ${r.reason}`);
  return r.cidrs;
}

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const origErr = console.error;
  const origLog = console.log;
  const cap = (...a: unknown[]): void => { lines.push(a.map(String).join(' ')); };
  console.error = cap as typeof console.error;
  console.log = cap as typeof console.log;
  return { lines, restore: () => { console.error = origErr; console.log = origLog; } };
}

function eventsNamed(lines: string[], evt: string): Record<string, unknown>[] {
  return lines.flatMap(l => {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      return o?.evt === evt ? [o] : [];
    } catch { return []; }
  });
}

afterEach(() => {
  const cap = captureConsole();
  try { applyPlaintextPeerCidrs([]); } finally { cap.restore(); }
});

describe('MESH_PLAINTEXT_PEER_CIDRS: the empty list is TODAY\'S RULE exactly', () => {
  // The regression that matters most: this must be a no-op for every existing
  // deployment. The rule is written out here independently of the code — wss
  // anywhere, ws only for the loopback set, and today's words on refusal — so
  // the expectation cannot drift along with the implementation.
  const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
  const TODAY_REFUSAL = 'ws:// is permitted only for loopback; use wss://';
  const urls = [
    'wss://far.example:7300', 'wss://10.30.0.9', 'ws://127.0.0.1:7300', 'ws://localhost:7300',
    'ws://[::1]:7300', 'ws://127.0.0.2:7300', 'ws://10.20.0.5:7300', 'ws://[fd00::5]:7300',
    'ws://[::ffff:10.20.0.5]:7300', 'ws://far.example:7300', 'ws://0x0a.1:7300',
  ];

  for (const u of urls) {
    it(`${u}`, () => {
      const host = new URL(u).hostname;
      const todayOk = u.startsWith('wss://') || LOOPBACK.has(host);
      const got = validateOutboundPeerUrl(u, []);
      expect(got.ok).toBe(todayOk);
      if (!got.ok) expect(got.error).toBe(TODAY_REFUSAL);
    });
  }

  it('unset, empty and whitespace all parse to the empty list', () => {
    for (const raw of [undefined, '', '   ']) expect(parsePlaintextPeerCidrs(raw)).toEqual({ ok: true, cidrs: [] });
  });

  it('a process that never configured it is loopback-only (the default is the old build, not a permissive one)', () => {
    expect(validateOutboundPeerUrl('ws://10.20.0.5:7300').ok).toBe(false);
  });
});

describe('MESH_PLAINTEXT_PEER_CIDRS: matching', () => {
  const list = cidrs('10.20.0.0/16,fd00::/8');

  it('in range: v4 and v6 literals are permitted', () => {
    expect(validateOutboundPeerUrl('ws://10.20.0.5:7300', list)).toEqual({ ok: true });
    expect(validateOutboundPeerUrl('ws://[fd00::5]:7300', list)).toEqual({ ok: true });
  });

  it('out of range: refused, naming the ADDRESS and the RULE', () => {
    const v4 = validateOutboundPeerUrl('ws://10.30.0.9:7300', list);
    expect(v4).toEqual({
      ok: false,
      error: 'ws://10.30.0.9 is outside MESH_PLAINTEXT_PEER_CIDRS (10.20.0.0/16, fd00::/8); use wss:// or add its range',
    });
    const v6 = validateOutboundPeerUrl('ws://[fe80::1]:7300', list);
    expect(v6.ok).toBe(false);
    if (!v6.ok) expect(v6.error).toContain('ws://[fe80::1] is outside MESH_PLAINTEXT_PEER_CIDRS');
  });

  it('the edges of a range: first and last in, one past each side out', () => {
    expect(validateOutboundPeerUrl('ws://10.20.0.0', list).ok).toBe(true);
    expect(validateOutboundPeerUrl('ws://10.20.255.255', list).ok).toBe(true);
    expect(validateOutboundPeerUrl('ws://10.19.255.255', list).ok).toBe(false);
    expect(validateOutboundPeerUrl('ws://10.21.0.0', list).ok).toBe(false);
  });

  it('v4-mapped v6 matches the v4 range — and a mapped-spelled range matches plain v4', () => {
    // The URL parser hands the matcher `[::ffff:a14:5]`, so this is the
    // spelling a list must cover, not a curiosity.
    expect(new URL('ws://[::ffff:10.20.0.5]').hostname).toBe('[::ffff:a14:5]');
    expect(validateOutboundPeerUrl('ws://[::ffff:10.20.0.5]:7300', list).ok).toBe(true);
    expect(validateOutboundPeerUrl('ws://[::ffff:10.30.0.9]:7300', list).ok).toBe(false);
    const mappedList = cidrs('::ffff:10.20.0.0/112');
    expect(mappedList.map(c => c.text)).toEqual(['10.20.0.0/16']);
    expect(validateOutboundPeerUrl('ws://10.20.0.5:7300', mappedList).ok).toBe(true);
  });

  it('odd v4 spellings are canonicalised by the URL parser before they reach the list', () => {
    // 0x0a.1 is 10.0.0.1 — the matcher sees the address, not the spelling.
    expect(validateOutboundPeerUrl('ws://0x0a.1:7300', cidrs('10.0.0.0/8')).ok).toBe(true);
    expect(validateOutboundPeerUrl('ws://0x0a.1:7300', list).ok).toBe(false);
  });

  it('wss:// is untouched by the list — permitted everywhere, names included', () => {
    expect(validateOutboundPeerUrl('wss://far.example', list).ok).toBe(true);
    expect(validateOutboundPeerUrl('wss://10.30.0.9', list).ok).toBe(true);
  });

  it('loopback keeps working under a list that does not contain it', () => {
    for (const u of ['ws://127.0.0.1:1', 'ws://localhost:1', 'ws://[::1]:1']) {
      expect(validateOutboundPeerUrl(u, list).ok).toBe(true);
    }
  });
});

describe('MESH_PLAINTEXT_PEER_CIDRS: a NAME is refused for plaintext even when it resolves in range', () => {
  it('this host\'s own name, with the list set to exactly the address it resolves to', async () => {
    // Positive control first: the name DOES resolve, and its address IS in the
    // list. Without this the refusal below could be about an unresolvable name
    // rather than about names — passing for the neighbour's reason.
    const name = hostname();
    const { address, family } = await lookup(name);
    const list = cidrs(family === 6 ? `${address}/128` : `${address}/32`);
    const literal = family === 6 ? `ws://[${address}]:7300` : `ws://${address}:7300`;
    expect(validateOutboundPeerUrl(literal, list).ok).toBe(true);

    const got = validateOutboundPeerUrl(`ws://${name}:7300`, list);
    expect(got.ok).toBe(false);
    if (!got.ok) {
      expect(got.error).toContain(`ws://${name.toLowerCase()} is a name, not an address`);
    }
  });
});

describe('MESH_PLAINTEXT_PEER_CIDRS: the boot line states the policy, EMPTY included', () => {
  it('empty: fires anyway, with cidrs [] and says loopback-only', () => {
    const cap = captureConsole();
    try { applyPlaintextPeerCidrs([]); } finally { cap.restore(); }
    const line = eventsNamed(cap.lines, 'peering.plaintext_policy');
    expect(line.length).toBe(1);
    expect(line[0]!.cidrs).toEqual([]);
    expect(String(line[0]!.note)).toContain('loopback-only');
    expect(typeof line[0]!.at).toBe('number');
  });

  it('non-empty: the list in its NORMALISED form — what the matcher compares, not what was typed', () => {
    const cap = captureConsole();
    try { applyPlaintextPeerCidrs(cidrs('FD00:0::/16, ::ffff:10.20.0.0/112')); } finally { cap.restore(); }
    const line = eventsNamed(cap.lines, 'peering.plaintext_policy');
    expect(line.length).toBe(1);
    expect(line[0]!.cidrs).toEqual(['fd00::/16', '10.20.0.0/16']);
  });
});

describe('MESH_PLAINTEXT_PEER_CIDRS: re-checked at DIAL time', () => {
  // 127.0.0.2 is loopback to the kernel but NOT in LOOPBACK_HOSTS, so the list
  // governs it — which lets this dial for real, against a listener that counts
  // TCP connections. The count is the evidence of "no dial", and the permissive
  // half is its positive control: the same row, the same listener, dialled.
  let db: ReturnType<typeof openDb>;
  let wss: WebSocketServer;
  let connections = 0;

  async function listen(): Promise<number> {
    connections = 0;
    wss = new WebSocketServer({ host: '0.0.0.0', port: 0 });
    wss.on('connection', () => { connections++; });
    await new Promise<void>(r => wss.once('listening', () => r()));
    return (wss.address() as { port: number }).port;
  }

  afterEach(async () => {
    for (const f of forwarders.values()) f.stop();
    forwarders.clear();
    borderEvents.removeAllListeners();
    db?.close();
    await new Promise<void>(r => wss.close(() => r()));
  });

  it('registered under a permissive list, then the list is tightened: no dial, and the refusal reads as POLICY', async () => {
    const port = await listen();
    db = openDb(':memory:');
    registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });
    const permissive = cidrs('127.0.0.0/8');
    const url = `ws://127.0.0.2:${port}`;
    // Registration is what POST/PATCH do: it passes under the wider list.
    expect(validateOutboundPeerUrl(url, permissive).ok).toBe(true);
    insertOutboundPeer(db, {
      alias: 'lab', url, token: 'T', assigned_alias: 'us',
      kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });

    // Positive control: under the permissive list the forwarder DOES dial.
    let cap = captureConsole();
    try {
      applyPlaintextPeerCidrs(permissive);
      const border = startBorder(db, new Map<string, WebSocket>());
      await new Promise(r => setTimeout(r, 400));
      border.stopAll();
    } finally { cap.restore(); }
    expect(connections).toBeGreaterThan(0);

    // Tightened — the restart an operator would do. Same row, same listener.
    connections = 0;
    cap = captureConsole();
    try {
      applyPlaintextPeerCidrs(cidrs('10.20.0.0/16'));
      startBorder(db, new Map<string, WebSocket>());
      await new Promise(r => setTimeout(r, 800));
    } finally { cap.restore(); }

    expect(connections).toBe(0);
    const down = eventsNamed(cap.lines, 'border.link_down');
    expect(down.length).toBe(1);
    expect(down[0]!.alias).toBe('lab');
    expect(String(down[0]!.error)).toBe(
      `refused by policy: ws://127.0.0.2 is outside MESH_PLAINTEXT_PEER_CIDRS (10.20.0.0/16); use wss:// or add its range`,
    );
    expect(forwarders.get('lab')!.connected).toBe(false);
  }, 20_000);
});
