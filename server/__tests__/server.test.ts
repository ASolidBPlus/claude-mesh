import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { Config } from '../server.ts';

// Helper to call loadConfig with injected env vars, intercepting process.exit
async function callLoadConfig(env: Record<string, string | undefined>): Promise<{ config?: Config; exitCode?: number }> {
  // Save original env
  const saved: Record<string, string | undefined> = {};
  const keys = ['MESH_ADMIN_TOKEN', 'MESH_DB_PATH', 'MESH_WS_PORT', 'MESH_MAX_FILE_BYTES', 'MESH_PRESENCE_DEBOUNCE_MS', 'MESH_MCP_MODE', 'MESH_RETENTION_MS', 'MESH_PLAINTEXT_PEER_CIDRS', 'MESH_TLS_CERT', 'MESH_TLS_KEY', 'MESH_TLS_CA', 'MESH_METRICS_TOKEN', 'MESH_ADMIN_PORT', 'MESH_WS_TLS_PORT', 'MESH_ADMIN_TLS_PORT', 'MESH_ADMIN_TOKEN_PREV'];
  for (const key of keys) {
    saved[key] = process.env[key];
    if (env[key] !== undefined) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }

  let exitCode: number | undefined;
  const origExit = process.exit.bind(process);
  const exitSpy = spyOn(process, 'exit').mockImplementation((code?: number) => {
    exitCode = code as number;
    throw new Error(`process.exit(${code})`);
  });

  let config: Config | undefined;
  try {
    // Dynamic import with cache busting is complex in bun — use direct require
    const mod = await import('../server.ts');
    config = mod.loadConfig();
  } catch (err: unknown) {
    if (!(err instanceof Error && err.message.startsWith('process.exit'))) {
      throw err;
    }
  } finally {
    exitSpy.mockRestore();
    // Restore env
    for (const key of keys) {
      if (saved[key] !== undefined) {
        process.env[key] = saved[key];
      } else {
        delete process.env[key];
      }
    }
  }

  return { config, exitCode };
}

describe('loadConfig', () => {
  // Clear relevant env vars before each test
  beforeEach(() => {
    delete process.env.MESH_ADMIN_TOKEN;
    delete process.env.MESH_DB_PATH;
    delete process.env.MESH_WS_PORT;
    delete process.env.MESH_MAX_FILE_BYTES;
  });

  afterEach(() => {
    delete process.env.MESH_ADMIN_TOKEN;
    delete process.env.MESH_DB_PATH;
    delete process.env.MESH_WS_PORT;
    delete process.env.MESH_MAX_FILE_BYTES;
  });

  it('returns defaults when only MESH_ADMIN_TOKEN is set', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok' });
    expect(exitCode).toBeUndefined();
    expect(config).toEqual({ dbPath: '/data/mesh.db', wsPort: 7384, adminPort: 7385, wsTlsPort: null, adminTlsPort: null, adminToken: 'tok', adminTokenPrev: null, cleanupIntervalMs: 60000, maxFileBytes: 10_485_760, filesDir: '/data/files', reminderIntervalMs: 10000, presenceDebounceMs: 12000, mcpMode: false, retentionMs: null, plaintextPeerCidrs: [], tls: null, tlsCa: null, metricsToken: null });
  });

  it('returns correct values when all valid env vars are set', async () => {
    const { config, exitCode } = await callLoadConfig({
      MESH_ADMIN_TOKEN: 'secret',
      MESH_DB_PATH: '/tmp/test.db',
      MESH_WS_PORT: '8080',
    });
    expect(exitCode).toBeUndefined();
    expect(config).toEqual({ dbPath: '/tmp/test.db', wsPort: 8080, adminPort: 7385, wsTlsPort: null, adminTlsPort: null, adminToken: 'secret', adminTokenPrev: null, cleanupIntervalMs: 60000, maxFileBytes: 10_485_760, filesDir: '/data/files', reminderIntervalMs: 10000, presenceDebounceMs: 12000, mcpMode: false, retentionMs: null, plaintextPeerCidrs: [], tls: null, tlsCa: null, metricsToken: null });
  });

  it('MESH_MAX_FILE_BYTES: defaults to 10 MB when not set', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok' });
    expect(exitCode).toBeUndefined();
    expect(config?.maxFileBytes).toBe(10_485_760);
  });

  it('MESH_MAX_FILE_BYTES: reads custom value correctly', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_MAX_FILE_BYTES: '1048576' });
    expect(exitCode).toBeUndefined();
    expect(config?.maxFileBytes).toBe(1048576);
  });

  it('MESH_MAX_FILE_BYTES: exits with 1 when set to non-integer', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_MAX_FILE_BYTES: 'abc' });
    expect(exitCode).toBe(1);
  });

  it('MESH_MAX_FILE_BYTES: exits with 1 when set to 0', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_MAX_FILE_BYTES: '0' });
    expect(exitCode).toBe(1);
  });

  it('MESH_MAX_FILE_BYTES: exits with 1 when set to negative', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_MAX_FILE_BYTES: '-1' });
    expect(exitCode).toBe(1);
  });

  it('P1-f: MESH_PRESENCE_DEBOUNCE_MS defaults to 12000', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok' });
    expect(exitCode).toBeUndefined();
    expect(config?.presenceDebounceMs).toBe(12000);
  });

  it('P1-f: MESH_PRESENCE_DEBOUNCE_MS reads custom value', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_PRESENCE_DEBOUNCE_MS: '5000' });
    expect(exitCode).toBeUndefined();
    expect(config?.presenceDebounceMs).toBe(5000);
  });

  it('P1-f: MESH_PRESENCE_DEBOUNCE_MS allows 0 (disable debounce)', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_PRESENCE_DEBOUNCE_MS: '0' });
    expect(exitCode).toBeUndefined();
    expect(config?.presenceDebounceMs).toBe(0);
  });

  it('P1-f: MESH_PRESENCE_DEBOUNCE_MS exits with 1 on non-integer', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_PRESENCE_DEBOUNCE_MS: 'abc' });
    expect(exitCode).toBe(1);
  });

  it('P1-f: MESH_PRESENCE_DEBOUNCE_MS exits with 1 above max', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_PRESENCE_DEBOUNCE_MS: '600001' });
    expect(exitCode).toBe(1);
  });

  it('MESH_MCP_MODE: defaults to false (standalone daemon; stdin EOF must not shut down)', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok' });
    expect(exitCode).toBeUndefined();
    expect(config?.mcpMode).toBe(false);
  });

  it('MESH_MCP_MODE=1 enables MCP stdio mode', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_MCP_MODE: '1' });
    expect(exitCode).toBeUndefined();
    expect(config?.mcpMode).toBe(true);
  });

  it('MESH_MCP_MODE: any value other than "1" is false', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_MCP_MODE: 'true' });
    expect(exitCode).toBeUndefined();
    expect(config?.mcpMode).toBe(false);
  });

  it('MESH_RETENTION_MS: defaults to null (keep forever)', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok' });
    expect(exitCode).toBeUndefined();
    expect(config?.retentionMs).toBeNull();
  });

  it('MESH_RETENTION_MS: reads a positive integer', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_RETENTION_MS: '604800000' });
    expect(exitCode).toBeUndefined();
    expect(config?.retentionMs).toBe(604800000);
  });

  it('MESH_RETENTION_MS: exits with 1 when set to 0', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_RETENTION_MS: '0' });
    expect(exitCode).toBe(1);
  });

  it('MESH_PLAINTEXT_PEER_CIDRS: parsed at boot into its NORMALISED form', async () => {
    const { config, exitCode } = await callLoadConfig({
      MESH_ADMIN_TOKEN: 'tok', MESH_PLAINTEXT_PEER_CIDRS: ' 10.20.0.0/16 , FD00::/8,::ffff:192.168.0.0/120',
    });
    expect(exitCode).toBeUndefined();
    expect(config?.plaintextPeerCidrs.map(c => c.text)).toEqual(['10.20.0.0/16', 'fd00::/8', '192.168.0.0/24']);
  });

  it('MESH_PLAINTEXT_PEER_CIDRS: an unreadable entry REFUSES TO START and names the entry', async () => {
    // Each of these is a typo that would otherwise have shrunk or widened the
    // set of networks the peering token crosses in cleartext.
    for (const bad of ['10.20.0.0/16,10.30.0.0', '10.20.0.0/16,', 'lab.example/24', '10.20.0.5/16', '10.0.0.0/33', '0.0.0.0/0', '::/0', '10.20.0.0/16,10.0.0.0/0']) {
      const writes: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
      let exitCode: number | undefined;
      try {
        ({ exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_PLAINTEXT_PEER_CIDRS: bad }));
      } finally { process.stderr.write = realWrite; }
      expect(exitCode).toBe(1);
      const said = writes.join('');
      expect(said).toContain('MESH_PLAINTEXT_PEER_CIDRS');
      const offending = bad.split(',').map(e => e.trim()).find(e => !/^(10\.20\.0\.0\/16)$/.test(e))!;
      expect(said).toContain(JSON.stringify(offending));
    }
  });

  it('MESH_TLS_CERT without MESH_TLS_KEY REFUSES TO START — no silent fallback to plain HTTP', async () => {
    const writes: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    let exitCode: number | undefined;
    try {
      ({ exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_TLS_CERT: '/nonexistent/cert.pem' }));
    } finally { process.stderr.write = realWrite; }
    expect(exitCode).toBe(1);
    expect(writes.join('')).toContain('MESH_TLS_CERT is set but MESH_TLS_KEY is not');
  });

  it('MESH_METRICS_TOKEN: unset = null (/metrics open); a clean value is read as-is', async () => {
    expect((await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok' })).config?.metricsToken).toBeNull();
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_METRICS_TOKEN: 'm-3f9a.Token_x' });
    expect(exitCode).toBeUndefined();
    expect(config?.metricsToken).toBe('m-3f9a.Token_x');
  });

  it('MESH_METRICS_TOKEN: empty, whitespace or control characters REFUSE to start — never trimmed, value never shown', async () => {
    const secret = 'S3CRETvalue';
    for (const bad of ['', ` ${secret}`, `${secret}\n`, `${secret} x`, `${secret}\t`, `${secret}\u0007`]) {
      const writes: string[] = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
      let exitCode: number | undefined;
      try {
        ({ exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_METRICS_TOKEN: bad }));
      } finally { process.stderr.write = realWrite; }
      const said = writes.join('');
      expect({ bad, exitCode }).toEqual({ bad, exitCode: 1 });
      expect(said).toContain('MESH_METRICS_TOKEN');
      expect(said).not.toContain(secret);
      expect(said).not.toContain(String(bad.length));
    }
  });

  // R-65 — the port rules. Each refusal names what to do, and exits 1.
  async function refused(env: Record<string, string>): Promise<{ exitCode: number | undefined; said: string }> {
    const writes: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write;
    try {
      const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', ...env });
      return { exitCode, said: writes.join('') };
    } finally { process.stderr.write = realWrite; }
  }

  it('R-65: a TLS port with its plaintext sibling ABSENT refuses — no silent plaintext default', async () => {
    for (const [tlsVar, plainVar] of [['MESH_WS_TLS_PORT', 'MESH_WS_PORT'], ['MESH_ADMIN_TLS_PORT', 'MESH_ADMIN_PORT']]) {
      const r = await refused({ [tlsVar!]: '7432' });
      expect({ tlsVar, exitCode: r.exitCode }).toEqual({ tlsVar, exitCode: 1 });
      expect(r.said).toContain(`say ${plainVar}=off or give it a port`);
    }
  });

  it("R-65: 'off' without its TLS sibling refuses", async () => {
    for (const [plainVar, tlsVar] of [['MESH_WS_PORT', 'MESH_WS_TLS_PORT'], ['MESH_ADMIN_PORT', 'MESH_ADMIN_TLS_PORT']]) {
      const r = await refused({ [plainVar!]: 'off' });
      expect({ plainVar, exitCode: r.exitCode }).toEqual({ plainVar, exitCode: 1 });
      expect(r.said).toContain(`${plainVar}=off needs ${tlsVar}`);
    }
  });

  it('R-65: a TLS port without MESH_TLS_CERT/KEY refuses', async () => {
    const r = await refused({ MESH_WS_PORT: 'off', MESH_WS_TLS_PORT: '7432' });
    expect(r.exitCode).toBe(1);
    expect(r.said).toContain('MESH_WS_TLS_PORT is set but MESH_TLS_CERT/MESH_TLS_KEY are not');
  });

  it('R-65: the same port for a plaintext/TLS pair refuses', async () => {
    const r = await refused({ MESH_WS_PORT: '7432', MESH_WS_TLS_PORT: '7432' });
    expect(r.exitCode).toBe(1);
    expect(r.said).toContain('must differ');
  });

  it('R-65: any two listeners on one port refuse — defaults included', async () => {
    // MESH_WS_TLS_PORT on the DEFAULTED admin port 7385.
    const r = await refused({ MESH_WS_PORT: 'off', MESH_WS_TLS_PORT: '7385' });
    expect(r.exitCode).toBe(1);
    expect(r.said).toContain('MESH_WS_TLS_PORT and MESH_ADMIN_PORT are both 7385');
    const r2 = await refused({ MESH_WS_PORT: '9000', MESH_WS_TLS_PORT: '9001', MESH_ADMIN_PORT: '9002', MESH_ADMIN_TLS_PORT: '9001' });
    expect(r2.exitCode).toBe(1);
    expect(r2.said).toContain('every listener needs its own port');
  });

  it('R-65: MESH_ADMIN_TOKEN_PREV set but empty refuses; set is read as-is', async () => {
    expect((await refused({ MESH_ADMIN_TOKEN_PREV: '' })).exitCode).toBe(1);
    expect((await refused({ MESH_ADMIN_TOKEN_PREV: '   ' })).exitCode).toBe(1);
    const { config } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_ADMIN_TOKEN_PREV: 'old' });
    expect(config?.adminTokenPrev).toBe('old');
  });

  it('MESH_RETENTION_MS: exits with 1 when non-integer', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_RETENTION_MS: 'abc' });
    expect(exitCode).toBe(1);
  });

  it('exits with code 1 when MESH_WS_PORT is not a number', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_WS_PORT: 'abc' });
    expect(exitCode).toBe(1);
  });

  it('exits with code 1 when MESH_WS_PORT is 0', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_WS_PORT: '0' });
    expect(exitCode).toBe(1);
  });

  it('exits with code 1 when MESH_WS_PORT is 65536', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_WS_PORT: '65536' });
    expect(exitCode).toBe(1);
  });

  it('does not exit when MESH_WS_PORT is 65535 (valid upper bound)', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_WS_PORT: '65535' });
    expect(exitCode).toBeUndefined();
    expect(config?.wsPort).toBe(65535);
  });

  it('does not exit when MESH_WS_PORT is 1 (valid lower bound)', async () => {
    const { config, exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: 'tok', MESH_WS_PORT: '1' });
    expect(exitCode).toBeUndefined();
    expect(config?.wsPort).toBe(1);
  });

  it('exits with code 1 when MESH_ADMIN_TOKEN is absent', async () => {
    const { exitCode } = await callLoadConfig({});
    expect(exitCode).toBe(1);
  });

  it('exits with code 1 when MESH_ADMIN_TOKEN is empty string', async () => {
    const { exitCode } = await callLoadConfig({ MESH_ADMIN_TOKEN: '' });
    expect(exitCode).toBe(1);
  });
});
