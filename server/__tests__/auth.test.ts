import { describe, it, expect } from 'bun:test';
import { generateToken, hashToken, timingSafeEqual, validateToken } from '../auth.ts';
import { openDb, getAgentById } from '../db.ts';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { spawnSync } from 'child_process';

// ──────────────────────────────────────────────
// Unit tests
// ──────────────────────────────────────────────

describe('generateToken', () => {
  it('returns a 64-character lowercase hex string', () => {
    const token = generateToken();
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a different value on each call', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
  });
});

describe('hashToken', () => {
  it("returns a 64-character lowercase hex string for 'abc'", () => {
    const hash = hashToken('abc');
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    const a = hashToken('abc');
    const b = hashToken('abc');
    expect(a).toBe(b);
  });

  it('produces different hashes for different inputs', () => {
    const a = hashToken('abc');
    const b = hashToken('xyz');
    expect(a).not.toBe(b);
  });
});

describe('timingSafeEqual', () => {
  it("returns true for ('aaa', 'aaa')", () => {
    expect(timingSafeEqual('aaa', 'aaa')).toBe(true);
  });

  it("returns false for ('aaa', 'aab')", () => {
    expect(timingSafeEqual('aaa', 'aab')).toBe(false);
  });

  it("returns false for ('aa', 'aaa') — different lengths", () => {
    expect(timingSafeEqual('aa', 'aaa')).toBe(false);
  });
});

describe('validateToken', () => {
  it('returns true when rawToken matches stored hash', () => {
    const rawToken = generateToken();
    const stored = hashToken(rawToken);
    expect(validateToken(rawToken, stored)).toBe(true);
  });

  it('returns false when rawToken does not match stored hash', () => {
    const rawToken = generateToken();
    const stored = hashToken('other');
    expect(validateToken(rawToken, stored)).toBe(false);
  });
});

// ──────────────────────────────────────────────
// CLI subprocess tests
// ──────────────────────────────────────────────

function tmpDbPath(): string {
  return path.join(os.tmpdir(), `mesh-test-${crypto.randomBytes(8).toString('hex')}.db`);
}

describe('cli register', () => {
  it('exits with code 0 and stdout contains "registered agent" and "token:"', () => {
    const dbPath = tmpDbPath();
    const result = spawnSync('bun', ['server/cli.ts', 'register', 'agent-1', 'localhost'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, MESH_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('registered agent');
    expect(result.stdout).toContain('token:');
  });

  it('prints a 64-char hex token in stdout', () => {
    const dbPath = tmpDbPath();
    const result = spawnSync('bun', ['server/cli.ts', 'register', 'agent-tok', 'localhost'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, MESH_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/\b[0-9a-f]{64}\b/);
  });

  it('exits with code 1 and stderr contains "already exists" when agent-id is reused', () => {
    const dbPath = tmpDbPath();
    spawnSync('bun', ['server/cli.ts', 'register', 'agent-dup', 'localhost'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, MESH_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    const result = spawnSync('bun', ['server/cli.ts', 'register', 'agent-dup', 'localhost'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, MESH_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('already exists');
  });

  it('exits with code 1 and stderr contains "usage:" when no arguments are given', () => {
    const result = spawnSync('bun', ['server/cli.ts'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage:');
  });

  it('exits with code 1 and stderr contains "usage:" when register is given but no agent-id', () => {
    const result = spawnSync('bun', ['server/cli.ts', 'register'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env },
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('usage:');
  });

  it('stores a hashed token (not raw) in the DB and agent is online=0 after registration', () => {
    const dbPath = tmpDbPath();
    const result = spawnSync('bun', ['server/cli.ts', 'register', 'agent-db', 'localhost'], {
      cwd: path.resolve(__dirname, '../..'),
      env: { ...process.env, MESH_DB_PATH: dbPath },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);

    // Extract the raw token from stdout
    const match = result.stdout.match(/\b([0-9a-f]{64})\b/);
    expect(match).not.toBeNull();
    const rawToken = match![1];

    const db = openDb(dbPath);
    const agent = getAgentById(db, 'agent-db');
    db.close();

    expect(agent).not.toBeNull();
    expect(agent!.online).toBe(0);
    expect(agent!.token_hash).toHaveLength(64);
    expect(agent!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    // The stored hash must not equal the raw token
    expect(agent!.token_hash).not.toBe(rawToken);
  });
});
