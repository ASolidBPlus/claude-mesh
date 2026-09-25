import { describe, it, expect, beforeAll, afterEach } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, registerAgent, upsertPeer, insertOutboundPeer, aclGrant } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, type WsServerHandle } from '../ws-server.ts';
import { startBorder, forwarders, borderEvents } from '../border.ts';
import { loadTls, expiryWarning, EXPIRY_WARN_DAYS, type ServerTls } from '../tls-config.ts';
import { MeshClient } from '../../client/src/client.ts';

// Native TLS on the WS listener (MESH_TLS_CERT / MESH_TLS_KEY), and the CA the
// border verifies dialled peers against (MESH_TLS_CA).
//
// Certificates are generated per run, not committed: a committed private key
// would be exactly what no-committed-secrets refuses, and a committed
// certificate expires. The bus certificate is the deployment's normal shape,
// not an edge: TWO IP SANs — the address peers dial AND 127.0.0.1, because the
// host's own services reach their bus through the same TLS listener.

const dir = mkdtempSync(join(tmpdir(), 'mesh-tls-'));
const f = (name: string): string => join(dir, name);

function openssl(...args: string[]): void {
  const r = Bun.spawnSync(['openssl', ...args], { cwd: dir, stderr: 'pipe' });
  if (r.exitCode !== 0) throw new Error(`openssl ${args[0]} failed: ${r.stderr.toString()}`);
}

function issue(name: string, ca: string, san: string): void {
  openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${name}`);
  writeFileSync(f(`${name}.ext`), `subjectAltName=${san}\n`);
  openssl('x509', '-req', '-in', `${name}.csr`, '-CA', `${ca}.pem`, '-CAkey', `${ca}.key`,
    '-CAcreateserial', '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`);
}

beforeAll(() => {
  for (const ca of ['range-ca', 'other-ca']) {
    openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', `${ca}.key`, '-out', `${ca}.pem`, '-days', '2', '-subj', `/CN=${ca}`);
  }
  issue('bus', 'range-ca', 'IP:127.0.0.2,IP:127.0.0.1');
  issue('elsewhere', 'other-ca', 'IP:127.0.0.1');
});

const pem = (name: string): string => readFileSync(f(name), 'utf8');

function serverTls(): ServerTls {
  const r = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key') });
  if (!r.ok || r.server === null) throw new Error('fixture TLS did not load');
  return r.server;
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

/** Every line of base64 body in a PEM — what "the key's content" means. */
function pemBody(text: string): string[] {
  return text.split('\n').filter(l => l.length >= 16 && !l.startsWith('-----'));
}

// ════════════════════════════════════════════════════════════════════════════
// loadTls — boot-time parsing
// ════════════════════════════════════════════════════════════════════════════

describe('loadTls: neither set is plain HTTP, exactly as before', () => {
  it('unset and empty are both "off"', () => {
    expect(loadTls({})).toEqual({ ok: true, server: null, ca: null });
    expect(loadTls({ MESH_TLS_CERT: '', MESH_TLS_KEY: '', MESH_TLS_CA: '' })).toEqual({ ok: true, server: null, ca: null });
  });
});

describe('loadTls: a HALF configuration is refused, naming what is missing', () => {
  it('cert without key', () => {
    const r = loadTls({ MESH_TLS_CERT: f('bus.pem') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toStartWith('MESH_TLS_CERT is set but MESH_TLS_KEY is not');
  });
  it('key without cert', () => {
    const r = loadTls({ MESH_TLS_KEY: f('bus.key') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toStartWith('MESH_TLS_KEY is set but MESH_TLS_CERT is not');
  });
});

describe('loadTls: PATH or PEM CONTENT', () => {
  it('a path, content, and content with literal \\n escapes all load the same pair', () => {
    const byPath = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('bus.key') });
    const byContent = loadTls({ MESH_TLS_CERT: pem('bus.pem'), MESH_TLS_KEY: pem('bus.key') });
    const escaped = (s: string): string => s.replace(/\n/g, '\\n');
    const byEscaped = loadTls({ MESH_TLS_CERT: escaped(pem('bus.pem')), MESH_TLS_KEY: escaped(pem('bus.key')) });
    for (const r of [byPath, byContent, byEscaped]) {
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.server!.info.sans).toEqual(['IP Address:127.0.0.2', 'IP Address:127.0.0.1']);
    }
  });

  it('an unreadable CERT path is refused naming the path; an unreadable KEY value is NEVER shown', () => {
    const cert = loadTls({ MESH_TLS_CERT: f('no-such.pem'), MESH_TLS_KEY: f('bus.key') });
    expect(cert.ok).toBe(false);
    if (!cert.ok) expect(cert.error).toContain(f('no-such.pem'));

    const key = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: f('no-such.key') });
    expect(key.ok).toBe(false);
    if (!key.ok) {
      expect(key.error).toStartWith('MESH_TLS_KEY: cannot read the key — value not shown (ENOENT)');
      // Not even a path: this branch cannot tell a path from mangled content.
      expect(key.error).not.toContain('no-such.key');
    }
  });

  it('MESH_TLS_CA: path or content; a non-certificate is refused', () => {
    expect(loadTls({ MESH_TLS_CA: f('range-ca.pem') })).toEqual({ ok: true, server: null, ca: pem('range-ca.pem') });
    expect(loadTls({ MESH_TLS_CA: pem('range-ca.pem') })).toEqual({ ok: true, server: null, ca: pem('range-ca.pem') });
    const bad = loadTls({ MESH_TLS_CA: '-----BEGIN CERTIFICATE-----\\nnot base64\\n-----END CERTIFICATE-----' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toStartWith('MESH_TLS_CA is not a valid PEM certificate');
  });
});

describe('loadTls: an invalid or MISMATCHED pair refuses at boot — and never echoes the key', () => {
  it('a key that does not match the certificate', () => {
    // other-ca.key is a perfectly valid key — for a different certificate.
    const keyText = pem('other-ca.key');
    for (const keyVal of [f('other-ca.key'), keyText]) {
      const r = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: keyVal });
      expect(r).toEqual({ ok: false, error: 'MESH_TLS_KEY does not match the certificate in MESH_TLS_CERT' });
    }
  });

  it('an unparseable key: refused, and no line of it appears in the error', () => {
    // Real key material, truncated so it no longer parses: the error path most
    // likely to quote its input is the one being fed something close to a key.
    const lines = pem('bus.key').split('\n');
    const broken = [lines[0], ...lines.slice(1, -3), lines.at(-2)].join('\n');
    const r = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: broken });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toStartWith('MESH_TLS_KEY is unreadable');
      for (const l of pemBody(broken)) expect(r.error).not.toContain(l);
    }
  });

  it('KEY CONTENT WITH A LEADING PREFIX never reaches the error, whether it parses or not', () => {
    // The hole this closes: content that does not START with -----BEGIN was
    // routed to the path branch, whose refusal echoed the value — the whole
    // private key, into the boot error, exactly when something went wrong. A
    // well-formed value never errors, which is why a check on the happy path
    // could not see it. Every realistic prefix, plus one nothing strips.
    const key = pem('bus.key');
    const body = pemBody(key);
    expect(body.length).toBeGreaterThan(0);   // the needle exists
    const variants: [string, string][] = [
      ['leading newline (YAML block scalar)', '\n' + key],
      ['leading space', ' ' + key],
      ['BOM', '\uFEFF' + key],
      ['leading escaped \\n', '\\n' + key.replace(/\n/g, '\\n')],
      ['a prefix nothing strips', 'x' + key],
    ];
    const outcomes: Record<string, string> = {};
    for (const [name, value] of variants) {
      const r = loadTls({ MESH_TLS_CERT: f('bus.pem'), MESH_TLS_KEY: value });
      outcomes[name] = r.ok ? 'parsed' : 'refused';
      // EVERY case, parsed or refused: nothing of the key in what comes back.
      const said = JSON.stringify(r.ok ? { ...r, server: r.server && { ...r.server, key: '<held>', cert: '<held>' } } : r);
      for (const line of body) {
        for (let i = 0; i + 24 <= line.length; i += 8) {
          expect({ name, leaked: said.includes(line.slice(i, i + 24)) }).toEqual({ name, leaked: false });
        }
      }
    }
    // The strippable prefixes are CONTENT and load; the one that isn't is
    // refused — without being shown.
    expect(outcomes).toEqual({
      'leading newline (YAML block scalar)': 'parsed',
      'leading space': 'parsed',
      'BOM': 'parsed',
      'leading escaped \\n': 'parsed',
      'a prefix nothing strips': 'refused',
    });
  });

  it('an invalid certificate', () => {
    const r = loadTls({ MESH_TLS_CERT: '-----BEGIN CERTIFICATE-----\\ngarbage\\n-----END CERTIFICATE-----', MESH_TLS_KEY: f('bus.key') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toStartWith('MESH_TLS_CERT is not a valid PEM certificate');
  });
});

describe('expiryWarning: expired or close to it announces itself at boot', () => {
  const info = (daysFromNow: number, now: number): ServerTls['info'] => ({
    subject: 'CN=bus', sans: [], not_after: new Date(now + daysFromNow * 86_400_000).toUTCString(),
    not_after_ms: now + daysFromNow * 86_400_000,
  });
  const now = Date.UTC(2026, 8, 25);

  it('comfortably valid: silent', () => {
    expect(expiryWarning(info(EXPIRY_WARN_DAYS + 1, now), now)).toBeNull();
    expect(expiryWarning(info(EXPIRY_WARN_DAYS, now), now)).toBeNull();
  });
  it('under the window: warns with days left', () => {
    const w = expiryWarning(info(EXPIRY_WARN_DAYS - 1, now), now)!;
    expect(w.evt).toBe('ws.tls_cert_expiry');
    expect(w.days_left).toBe(EXPIRY_WARN_DAYS - 1);
  });
  it('expired: warns and says so', () => {
    const w = expiryWarning(info(-1, now), now)!;
    expect(String(w.note)).toContain('EXPIRED');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// The listener
// ════════════════════════════════════════════════════════════════════════════

describe('the WS listener', () => {
  let handle: WsServerHandle | undefined;
  const clients: MeshClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } }
    await handle?.shutdown().catch(() => {});
    handle = undefined;
  });

  async function start(tls: ServerTls | null): Promise<{ port: number; lines: string[] }> {
    const port = 25000 + Math.floor(Math.random() * 3000);
    const db = openDb(':memory:');
    registerAgent(db, { id: 'svc', token_hash: hashToken('svc-token'), hostname: 'h' });
    const cap = captureConsole();
    try {
      handle = await startWsServer(port, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-tls-files-')), 0, new Map(), tls);
    } finally { cap.restore(); }
    return { port, lines: cap.lines };
  }

  /**
   * Did an SDK client authenticate within the window? A transport failure
   * never rejects connect() — the SDK retries underneath — so "refused" is
   * "an error was emitted and connect() had not resolved".
   */
  async function dial(url: string, ca?: string): Promise<{ connected: boolean; error: string | null }> {
    const c = new MeshClient({ serverUrl: url, agentId: 'svc', agentToken: 'svc-token', ...(ca === undefined ? {} : { ca }) });
    clients.push(c);
    let error: string | null = null;
    c.on('error', (e: unknown) => { error ??= String((e as { message?: string })?.message ?? e); });
    const connected = await Promise.race([
      c.connect().then(() => true, () => false),
      new Promise<boolean>(r => setTimeout(() => r(false), 1500)),
    ]);
    c.close();
    return { connected, error };
  }

  it('UNSET: plain HTTP as before — /healthz over http, ws:// connects, and the boot line says tls:false', async () => {
    const { port, lines } = await start(null);
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"db_ok":true}');
    expect((await dial(`ws://127.0.0.1:${port}`)).connected).toBe(true);

    const boot = eventsNamed(lines, 'ws.listening');
    expect(boot.length).toBe(1);
    // The line's shape is today's plus ONE field, and that field says off.
    expect(Object.keys(boot[0]!).sort()).toEqual(['at', 'bind', 'bound', 'evt', 'note', 'tls']);
    expect(boot[0]!.tls).toBe(false);
  }, 20_000);

  it('ON: a client trusting the range CA connects over wss:// at EITHER SAN', async () => {
    const { port } = await start(serverTls());
    for (const host of ['127.0.0.2', '127.0.0.1']) {
      const r = await dial(`wss://${host}:${port}`, pem('range-ca.pem'));
      expect({ host, ...r }).toEqual({ host, connected: true, error: null });
    }
  }, 20_000);

  it('ON: the CONTROLS — a third address, an unrelated CA, and no CA at all are each REFUSED', async () => {
    // Without these, the test above proves the bus serves TLS and nothing
    // about verification: a client that verified nothing would pass it too.
    const { port } = await start(serverTls());
    const thirdAddress = await dial(`wss://127.0.0.3:${port}`, pem('range-ca.pem'));
    const unrelatedCa = await dial(`wss://127.0.0.2:${port}`, pem('other-ca.pem'));
    const noCa = await dial(`wss://127.0.0.2:${port}`);
    for (const [name, r] of Object.entries({ thirdAddress, unrelatedCa, noCa })) {
      expect({ name, connected: r.connected }).toEqual({ name, connected: false });
      expect({ name, sawError: r.error !== null }).toEqual({ name, sawError: true });
    }
  }, 20_000);

  it('ON: plaintext ws:// to the TLS port does not connect — there is no fallback', async () => {
    const { port } = await start(serverTls());
    expect((await dial(`ws://127.0.0.1:${port}`)).connected).toBe(false);
  }, 20_000);

  it('ON: /healthz is served over https with the same body', async () => {
    const { port } = await start(serverTls());
    const res = await fetch(`https://127.0.0.1:${port}/healthz`, { tls: { ca: pem('range-ca.pem') } } as RequestInit);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"db_ok":true}');
  }, 20_000);

  it('ON: the boot line PROVES it — tls:true, subject, both SANs, not_after — and carries no key material', async () => {
    const { lines } = await start(serverTls());
    const boot = eventsNamed(lines, 'ws.listening');
    expect(boot.length).toBe(1);
    expect(boot[0]!.tls).toBe(true);
    expect(boot[0]!.tls_subject).toBe('CN=bus');
    expect(boot[0]!.tls_sans).toEqual(['IP Address:127.0.0.2', 'IP Address:127.0.0.1']);
    expect(typeof boot[0]!.tls_not_after).toBe('string');
    const everything = lines.join('\n');
    for (const l of pemBody(pem('bus.key'))) expect(everything).not.toContain(l);
  }, 20_000);
});

// ════════════════════════════════════════════════════════════════════════════
// The SDK's `ca` REPLACES the default trust store; without it, defaults apply.
// ════════════════════════════════════════════════════════════════════════════

describe('SDK ca: REPLACES the default store, and its absence keeps the defaults', () => {
  it('measured in a child whose DEFAULT store trusts other-ca (NODE_EXTRA_CA_CERTS)', async () => {
    // Hermetic stand-in for "a publicly-trusted certificate": the child's
    // default store is given other-ca at process start, and `elsewhere` is
    // signed by it. No `ca` → the default store verifies it (the positive
    // control). `ca: range-ca` → refused, which is only possible if the option
    // REPLACED the store rather than adding to it.
    const script = f('child.ts');
    writeFileSync(script, `
      import { readFileSync } from 'fs';
      import { WebSocket } from 'ws';
      const server = Bun.serve({
        port: 0, hostname: '127.0.0.1',
        tls: { cert: readFileSync(${JSON.stringify(f('elsewhere.pem'))}, 'utf8'), key: readFileSync(${JSON.stringify(f('elsewhere.key'))}, 'utf8') },
        fetch(req, s) { return s.upgrade(req) ? undefined : new Response('no'); },
        websocket: { message() {} },
      });
      const range = readFileSync(${JSON.stringify(f('range-ca.pem'))}, 'utf8');
      const tryc = (opts) => new Promise(res => {
        const ws = opts === undefined ? new WebSocket('wss://127.0.0.1:' + server.port) : new WebSocket('wss://127.0.0.1:' + server.port, opts);
        const t = setTimeout(() => res('timeout'), 3000);
        ws.on('open', () => { clearTimeout(t); ws.close(); res('open'); });
        ws.on('error', () => { clearTimeout(t); res('refused'); });
      });
      // The SDK's exact option shape (client.ts openSocket).
      const out = { defaults: await tryc(undefined), rangeCa: await tryc({ ca: range, tls: { ca: range } }) };
      console.log(JSON.stringify(out));
      server.stop(true);
      process.exit(0);
    `);
    const r = Bun.spawnSync([process.execPath, script], {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, NODE_EXTRA_CA_CERTS: f('other-ca.pem') },
      stdout: 'pipe', stderr: 'pipe',
    });
    const out = JSON.parse(r.stdout.toString().trim().split('\n').at(-1)!);
    expect(out).toEqual({ defaults: 'open', rangeCa: 'refused' });
  }, 20_000);
});

// ════════════════════════════════════════════════════════════════════════════
// The border dials with MESH_TLS_CA
// ════════════════════════════════════════════════════════════════════════════

describe('border: MESH_TLS_CA is what the forwarder verifies a wss:// peer against', () => {
  let b: WsServerHandle | undefined;
  let db: ReturnType<typeof openDb> | undefined;
  afterEach(async () => {
    for (const fw of forwarders.values()) fw.stop();
    forwarders.clear();
    borderEvents.removeAllListeners();
    await b?.shutdown().catch(() => {});
    db?.close();
  });

  async function farBus(): Promise<number> {
    const port = 28000 + Math.floor(Math.random() * 1500);
    const bDb = openDb(':memory:');
    upsertPeer(bDb, {
      alias: 'ourmesh', token_hash: hashToken('PEER-TOKEN'), minted_by_key: 'k',
      kinds: '["direct"]', rate_per_min: 600,
    });
    const cap = captureConsole();
    try {
      b = await startWsServer(port, bDb, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-tls-b-')), 0, new Map(), serverTls());
    } finally { cap.restore(); }
    return port;
  }

  function peering(port: number): void {
    db = openDb(':memory:');
    registerAgent(db, { id: 'sender', token_hash: 'a'.repeat(64), hostname: 'h' });
    insertOutboundPeer(db, {
      alias: 'far', url: `wss://127.0.0.2:${port}`, token: 'PEER-TOKEN',
      assigned_alias: 'ourmesh', kinds: '["direct"]', rate_per_min: 600, created_at: Date.now(),
    });
    aclGrant(db, 'sender', 'far:bob', 'admin');
  }

  it('with the range CA the link comes UP; without it the link is DOWN and says TLS', async () => {
    const port = await farBus();
    peering(port);

    let cap = captureConsole();
    try {
      startBorder(db!, new Map(), { ca: pem('range-ca.pem') });
      await new Promise(r => setTimeout(r, 1000));
    } finally { cap.restore(); }
    expect(eventsNamed(cap.lines, 'border.link_up').map(e => e.alias)).toEqual(['far']);
    expect(forwarders.get('far')!.connected).toBe(true);

    for (const fw of forwarders.values()) fw.stop();
    forwarders.clear();
    borderEvents.removeAllListeners();

    cap = captureConsole();
    try {
      startBorder(db!, new Map());
      await new Promise(r => setTimeout(r, 1000));
    } finally { cap.restore(); }
    const down = eventsNamed(cap.lines, 'border.link_down');
    expect(down.length).toBe(1);
    expect(String(down[0]!.error)).toContain('TLS');
    expect(forwarders.get('far')!.connected).toBe(false);
  }, 20_000);
});
