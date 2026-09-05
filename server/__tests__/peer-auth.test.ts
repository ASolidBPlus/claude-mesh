import { describe, it, expect } from 'bun:test';
import { openDb, registerAgent, upsertPeer, getPeerByAlias } from '../db.ts';
import { hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle, PEER_PROTOCOL_VERSION } from '../ws-server.ts';
import { startCleanup } from '../cleanup.ts';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// F1a (§5.1) — peer authentication on the WS server.
//
// THE DISCRIMINATOR IS THE CREDENTIAL, NEVER THE CLIENT'S FIELD. A socket is a
// peer because its token authenticates against peers.token_hash and an agent
// because it authenticates against agents.token_hash. `protocol` is checked
// only AFTER a peer credential matches. Both directions of the confusion are
// tested, because each is a real privilege error: a peer treated as an agent
// gets local ACL semantics; an agent treated as a peer gets relay semantics.

let portCounter = 22100;
const nextPort = () => portCounter++;
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

interface Session { ws: WebSocket; frames: any[]; }

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function open(port: number, authFrame: Record<string, unknown>): Promise<Session> {
  const ws = await connect(port);
  const frames: any[] = [];
  ws.on('message', (d) => frames.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify(authFrame));
  await wait(120);
  return { ws, frames };
}

async function setup(): Promise<{ db: Database; handle: WsServerHandle; port: number }> {
  const db = openDb(':memory:');
  const port = nextPort();
  const handle = await startWsServer(port, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-f1a-')));
  registerAgent(db, { id: 'local-a', token_hash: hashToken('agent-tok'), hostname: 'h' });
  registerAgent(db, { id: 'local-b', token_hash: hashToken('agent-tok-b'), hostname: 'h' });
  upsertPeer(db, {
    alias: 'othermesh', token_hash: hashToken('peer-tok'),
    minted_by_key: 'k1', kinds: '["direct"]', rate_per_min: 600,
  });
  return { db, handle, port };
}

describe('F1a: peer authentication', () => {
  it('a valid peer credential + protocol authenticates as a PEER', async () => {
    const { db, handle, port } = await setup();
    const s = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 1 });
    try {
      expect(s.frames.length).toBe(1);
      // No queue fields: a peer has no mailbox here.
      expect(s.frames[0]).toEqual({ type: 'auth_ok', peer: 'othermesh', protocol: PEER_PROTOCOL_VERSION });
      expect(handle.peerIndex.get('othermesh')).toBeDefined();
      // It is NOT in the agent world at all.
      expect(handle.agentIndex.get('othermesh')).toBeUndefined();
      expect(getPeerByAlias(db, 'othermesh')?.last_seen).not.toBeNull();
    } finally {
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  // The oracle test. It compares the three outcomes a PROBER CAN REACH against
  // each other — the previous version compared a disabled peer against an
  // AGENT with a wrong token, which is byte-identity against the wrong
  // subject: it passed while a revoked peer could still distinguish itself.
  it('all three peer-reachable refusals are byte-identical', async () => {
    const { db, handle, port } = await setup();
    upsertPeer(db, {
      alias: 'deadmesh', token_hash: hashToken('peer-tok'),
      minted_by_key: 'k1', kinds: '["direct"]', rate_per_min: 600,
    });
    db.prepare('UPDATE peers SET disabled = 1 WHERE alias = ?').run('deadmesh');

    const nonexistent = await open(port, { type: 'auth', agent_id: 'nosuchmesh', token: 'peer-tok', protocol: 1 });
    const wrongToken  = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'WRONG', protocol: 1 });
    const disabled    = await open(port, { type: 'auth', agent_id: 'deadmesh', token: 'peer-tok', protocol: 1 });
    try {
      const errs = [nonexistent, wrongToken, disabled].map(s => JSON.stringify(s.frames.find(f => f.type === 'error')));
      // A distinct DISABLED message is a revocation oracle; making all three
      // 'invalid token' would instead be an alias-existence oracle. Identical
      // is the only shape that leaks on neither axis.
      expect(new Set(errs).size).toBe(1);
      expect(JSON.parse(errs[0]!)).toEqual({ type: 'error', code: 'AUTH_FAILED', message: 'unknown agent' });
      expect(handle.peerIndex.get('deadmesh')).toBeUndefined();
    } finally {
      for (const s of [nonexistent, wrongToken, disabled]) { try { s.ws.close(); } catch { /* ignore */ } }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('positive control: an AGENT with a wrong token still says "invalid token"', async () => {
    // Agents keep their existing contract — the unified refusal is the PEER
    // path's, not a global flattening. Without this, the test above is
    // satisfied by making every refusal in the server identical.
    const { db, handle, port } = await setup();
    const s = await open(port, { type: 'auth', agent_id: 'local-a', token: 'WRONG' });
    try {
      expect(s.frames.find(f => f.type === 'error')?.message).toBe('invalid token');
    } finally {
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('a peer credential with the WRONG or ABSENT protocol gets PROTOCOL_MISMATCH', async () => {
    const { db, handle, port } = await setup();
    const wrong = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 99 });
    const absent = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok' });
    try {
      for (const s of [wrong, absent]) {
        const err = s.frames.find(f => f.type === 'error');
        expect(err?.code).toBe('PROTOCOL_MISMATCH');
      }
      // CRITICALLY: never silently downgraded to agent auth.
      expect(absent.frames.some(f => f.type === 'auth_ok')).toBe(false);
      expect(handle.peerIndex.get('othermesh')).toBeUndefined();
    } finally {
      try { wrong.ws.close(); absent.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});

describe('F1a: the credential decides, not the protocol field', () => {
  it('an AGENT sending protocol:1 is still an agent, with a byte-identical auth_ok', async () => {
    // If `protocol` chose the table, this frame would promote an agent to a
    // peer — a client selecting its own semantics by setting a field.
    const { db, handle, port } = await setup();
    const plain = await open(port, { type: 'auth', agent_id: 'local-a', token: 'agent-tok' });
    const plainOk = plain.frames.find(f => f.type === 'auth_ok');
    try { plain.ws.close(); } catch { /* ignore */ }
    await wait(60);

    const claiming = await open(port, { type: 'auth', agent_id: 'local-b', token: 'agent-tok-b', protocol: 1 });
    try {
      const claimOk = claiming.frames.find(f => f.type === 'auth_ok');
      expect(claimOk).toBeDefined();
      // Same SHAPE as an ordinary agent's auth_ok (ids differ by construction).
      expect(Object.keys(claimOk).sort()).toEqual(Object.keys(plainOk).sort());
      expect(claimOk.peer).toBeUndefined();
      expect(handle.agentIndex.get('local-b')).toBeDefined();
      expect(handle.peerIndex.get('local-b')).toBeUndefined();
    } finally {
      try { claiming.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('an unknown id is refused as before — peers is consulted, not assumed', async () => {
    // Positive control on the branch order: adding the peer lookup must not
    // change what happens to an id that is in neither table.
    const { db, handle, port } = await setup();
    const s = await open(port, { type: 'auth', agent_id: 'nobody', token: 'x', protocol: 1 });
    try {
      const err = s.frames.find(f => f.type === 'error');
      expect(err?.code).toBe('AUTH_FAILED');
      expect(err?.message).toBe('unknown agent');
    } finally {
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});

describe('F1a: the peer frame allowlist', () => {
  it('a peer sending an AGENT frame gets NOT_ALLOWED', async () => {
    const { db, handle, port } = await setup();
    const s = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 1 });
    try {
      s.ws.send(JSON.stringify({ type: 'send', to: 'local-a', payload: 'hi', msg_id: 'm1' }));
      await wait(150);
      const err = s.frames.find(f => f.type === 'error' && f.ref === 'm1');
      expect(err?.code).toBe('NOT_ALLOWED');
      // An allowlist, not a denylist: list_presence is refused too, and it is
      // not a frame anyone thought to deny.
      s.ws.send(JSON.stringify({ type: 'list_presence' }));
      await wait(150);
      expect(s.frames.filter(f => f.code === 'NOT_ALLOWED').length).toBe(2);
    } finally {
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('an AGENT sending relay gets NOT_ALLOWED — the forge in the other direction', async () => {
    const { db, handle, port } = await setup();
    const s = await open(port, { type: 'auth', agent_id: 'local-a', token: 'agent-tok' });
    try {
      s.ws.send(JSON.stringify({ type: 'relay', msg_id: 'r1', kind: 'direct', from: 'x', to: 'local-b', payload: 'p' }));
      await wait(150);
      const err = s.frames.find(f => f.type === 'error' && f.ref === 'r1');
      expect(err?.code).toBe('NOT_ALLOWED');
    } finally {
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it("a peer's ping is answered and stamps last_seen", async () => {
    const { db, handle, port } = await setup();
    db.prepare('UPDATE peers SET last_seen = 1 WHERE alias = ?').run('othermesh');
    const s = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 1 });
    try {
      s.ws.send(JSON.stringify({ type: 'ping' }));
      await wait(150);
      expect(s.frames.some(f => f.type === 'pong')).toBe(true);
      expect(getPeerByAlias(db, 'othermesh')!.last_seen).toBeGreaterThan(1);
    } finally {
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('positive control: an AGENT can still send — the allowlist is not a wall', async () => {
    const { db, handle, port } = await setup();
    const a = await open(port, { type: 'auth', agent_id: 'local-a', token: 'agent-tok' });
    try {
      // No ACL edge, so this is refused on ACL grounds — the point is that it
      // reaches the router at all rather than being blocked as a frame type.
      a.ws.send(JSON.stringify({ type: 'send', to: 'local-b', payload: 'p', msg_id: 'ok1' }));
      await wait(150);
      const resp = a.frames.find(f => f.ref === 'ok1');
      expect(resp).toBeDefined();
      expect(resp.code).not.toBe('NOT_ALLOWED');
    } finally {
      try { a.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});

describe('F1a: second socket for one alias — newer wins (D11)', () => {
  it('the older socket is closed with PEER_REPLACED and the newer is indexed', async () => {
    const { db, handle, port } = await setup();
    const first = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 1 });
    const second = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 1 });
    try {
      expect(first.frames.some(f => f.code === 'PEER_REPLACED')).toBe(true);
      expect(handle.peerIndex.get('othermesh')).toBeDefined();
      expect(second.ws.readyState).toBe(WebSocket.OPEN);

      // THE IDENTITY GUARD (#92's shape): the older socket's close must NOT
      // evict the replacement. Without the guard the alias goes unroutable
      // while a healthy socket sits connected — map and world disagreeing with
      // nothing reporting it.
      await wait(250);
      expect(handle.peerIndex.get('othermesh')).toBeDefined();
    } finally {
      try { first.ws.close(); second.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});

describe('F1a: the revoked-peer sweep', () => {
  it('closes a disabled peer\'s socket, driven through the REAL startCleanup', async () => {
    // Never by calling the sweep: a test that did would stay green if the timer
    // were removed from startCleanup — claude-spawner#320's shape.
    const { db, handle, port } = await setup();
    const s = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 1 });
    // Long housekeeping interval so ONLY the peer sweep can act.
    const cleanup = startCleanup(db, handle.agentIndex, 3_600_000, null, handle.peerIndex, 25);
    try {
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
      // The post-crash state: DB says revoked, socket still up.
      db.prepare('UPDATE peers SET disabled = 1 WHERE alias = ?').run('othermesh');
      await wait(250);
      expect(s.frames.some(f => f.code === 'AUTH_FAILED')).toBe(true);
    } finally {
      cleanup.stop();
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('leaves an ENABLED peer alone — positive control', async () => {
    const { db, handle, port } = await setup();
    const s = await open(port, { type: 'auth', agent_id: 'othermesh', token: 'peer-tok', protocol: 1 });
    const cleanup = startCleanup(db, handle.agentIndex, 3_600_000, null, handle.peerIndex, 25);
    try {
      await wait(250);
      expect(s.frames.some(f => f.type === 'error')).toBe(false);
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      cleanup.stop();
      try { s.ws.close(); } catch { /* ignore */ }
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);

  it('the sweep interval is a fixed constant, not the DB-churn knob', async () => {
    const { PEER_SWEEP_INTERVAL_MS } = await import('../cleanup.ts');
    expect(PEER_SWEEP_INTERVAL_MS).toBe(15_000);
    expect(process.env.MESH_CLEANUP_INTERVAL_MS).not.toBe(String(PEER_SWEEP_INTERVAL_MS));
  });
});
