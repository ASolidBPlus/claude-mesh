import { describe, it, expect, beforeEach, afterEach, spyOn, mock } from 'bun:test';
import type { Config } from '../server.ts';

// Helper to call loadConfig with injected env vars, intercepting process.exit
async function callLoadConfig(env: Record<string, string | undefined>): Promise<{ config?: Config; exitCode?: number }> {
  // Save original env
  const saved: Record<string, string | undefined> = {};
  const keys = ['MESH_ADMIN_TOKEN', 'MESH_DB_PATH', 'MESH_WS_PORT', 'MESH_MAX_FILE_BYTES'];
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
    expect(config).toEqual({ dbPath: '/data/mesh.db', wsPort: 7384, adminPort: 7385, adminToken: 'tok', cleanupIntervalMs: 60000, maxFileBytes: 10_485_760, filesDir: '/data/files' });
  });

  it('returns correct values when all valid env vars are set', async () => {
    const { config, exitCode } = await callLoadConfig({
      MESH_ADMIN_TOKEN: 'secret',
      MESH_DB_PATH: '/tmp/test.db',
      MESH_WS_PORT: '8080',
    });
    expect(exitCode).toBeUndefined();
    expect(config).toEqual({ dbPath: '/tmp/test.db', wsPort: 8080, adminPort: 7385, adminToken: 'secret', cleanupIntervalMs: 60000, maxFileBytes: 10_485_760, filesDir: '/data/files' });
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
