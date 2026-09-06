import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, registerAgent, aclGrant } from '../db.ts';
import { generateToken, hashToken } from '../auth.ts';
import { startWsServer, WsServerHandle } from '../ws-server.ts';

// #152 — a displacing auth is not an arrival.
//
// A second socket authenticating for an agent id that already has a live one
// took the "genuinely fresh connect" branch and broadcast `online` for an agent
// that never went offline. The displaced socket's own close correctly
// broadcasts nothing (#92's identity-guarded teardown), so the stream carried
// an ARRIVAL WITH NO DEPARTURE.
//
// Direction was always safe — never an unpaired departure, no reachable agent
// marked offline. The cost falls on consumers that count transitions or infer
// session boundaries from the stream.
//
// PRE-EXISTING, NOT #145's: the presence block is byte-identical to e3de095^.
// #145 changed how often it is reached, by making displacement the deliberate
// reconnect path rather than an accident.

let portCounter = 20300;
const nextPort = () => portCounter++;

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function connectWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

async function authConnect(port: number, token: string, agentId: string): Promise<WebSocket> {
  const ws = await connectWs(port);
  await new Promise<void>((resolve, reject) => {
    ws.once('message', () => resolve());
    ws.once('error', reject);
    ws.send(JSON.stringify({ type: 'auth', agent_id: agentId, token }));
  });
  return ws;
}

/** Every agent_status frame the watcher sees, in order, as ['A', true|false].
 *  A RECORDER rather than a one-shot wait: the defect is an EXTRA frame, and a
 *  test that waits for the frames it expects cannot see one it does not. */
function recordStatuses(ws: WebSocket): [string, boolean][] {
  const seen: [string, boolean][] = [];
  ws.on('message', (data) => {
    const m = JSON.parse(data.toString()) as { type?: string; agent_id?: string; online?: boolean };
    if (m.type === 'agent_status') seen.push([m.agent_id!, m.online!]);
  });
  return seen;
}

describe('#152 presence under a displacing auth', () => {
  let db: Database;
  let filesDir: string;
  let handle: WsServerHandle | undefined;
  let tokenA: string;
  let tokenB: string;

  beforeEach(() => {
    db = openDb(':memory:');
    filesDir = mkdtempSync(join(tmpdir(), 'mesh-152-'));
    tokenA = generateToken();
    tokenB = generateToken();
    registerAgent(db, { id: 'A', token_hash: hashToken(tokenA), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: hashToken(tokenB), hostname: 'hB' });
    aclGrant(db, 'A', 'B', 'system');   // B may see A's presence
  });
  afterEach(async () => {
    await handle?.shutdown().catch(() => {});
    handle = undefined;
    db.close();
  });

  // THE ISSUE, stated as the property rather than as a frame count: every
  // arrival is followed by exactly one departure and vice versa.
  it('a displacing auth adds no arrival — the stream stays paired', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const wsB = await authConnect(port, tokenB, 'B');
    const seen = recordStatuses(wsB);

    const s1 = await authConnect(port, tokenA, 'A');
    await delay(80);
    expect(seen).toEqual([['A', true]]);

    // The displacement. s1 is closed by the server with DISPLACED (#92).
    const s2 = await authConnect(port, tokenA, 'A');
    await delay(150);
    // Nothing new: A was already here. Before the fix this was a second
    // ['A', true].
    expect(seen).toEqual([['A', true]]);

    // ...and the departure still happens, exactly once, when the agent really
    // leaves. Suppressing the arrival must not cost the exit — a fix that
    // muted presence for displaced ids would pass the assertion above and
    // fail here.
    s2.close();
    await delay(150);
    expect(seen).toEqual([['A', true], ['A', false]]);

    try { s1.close(); } catch { /* already closed by the server */ }
    wsB.close();
  }, 20_000);

  // POSITIVE CONTROL. Without it, the whole file is satisfied by a server that
  // never broadcasts an arrival at all — which is indistinguishable from the
  // fix, and strictly worse than the defect.
  it('CONTROL: a genuinely fresh connect after a real departure DOES broadcast online', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const wsB = await authConnect(port, tokenB, 'B');
    const seen = recordStatuses(wsB);

    const s1 = await authConnect(port, tokenA, 'A');
    await delay(80);
    s1.close();
    await delay(120);
    expect(seen).toEqual([['A', true], ['A', false]]);

    // Same id, new socket, but the stream has been told A left — so this one
    // IS an arrival and must be announced.
    const s2 = await authConnect(port, tokenA, 'A');
    await delay(120);
    expect(seen).toEqual([['A', true], ['A', false], ['A', true]]);

    s2.close();
    wsB.close();
  }, 20_000);

  // The debounce branch is the OTHER suppression in this block, and the new
  // one sits directly beside it. Pinned so a fix that collapses the two — or
  // an edit that reaches the new branch when it meant the debounce one —
  // reds here rather than silently changing flap behaviour.
  it('the debounce flap-back is unchanged: no churn, and the reconnect is not muted afterwards', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 250);
    const wsB = await authConnect(port, tokenB, 'B');
    const seen = recordStatuses(wsB);

    const s1 = await authConnect(port, tokenA, 'A');
    await delay(80);
    expect(seen).toEqual([['A', true]]);

    s1.close();
    await delay(60);                        // inside the 250ms window
    const s2 = await authConnect(port, tokenA, 'A');
    await delay(400);                       // past where the timer would have fired
    // Net zero churn: peers never saw the departure, so they get no re-arrival.
    expect(seen).toEqual([['A', true]]);

    // And A is still a real presence afterwards — the flap did not leave the
    // state in a shape where the eventual real departure goes missing.
    s2.close();
    await delay(400);
    expect(seen).toEqual([['A', true], ['A', false]]);

    wsB.close();
  }, 20_000);

  // Displacement's delivery half must be untouched by a presence-only change:
  // the newest socket is the one that receives. Asserted here because the fix
  // lives three lines from the displacement block, and "presence went quiet"
  // and "the wrong socket is indexed" would look the same from the stream.
  it('the newest socket still receives — the fix touches presence only', async () => {
    const port = nextPort();
    handle = await startWsServer(port, db, 10_485_760, filesDir, 0);
    const wsB = await authConnect(port, tokenB, 'B');
    aclGrant(db, 'B', 'A', 'system');       // B may send to A

    const s1 = await authConnect(port, tokenA, 'A');
    await delay(60);
    const s2 = await authConnect(port, tokenA, 'A');
    await delay(120);
    expect(handle.agentIndex.get('A')).toBeDefined();

    const got = new Promise<string>((resolve) => {
      s2.on('message', (d) => {
        // `deliver`, which is what routeDirect actually sends — named from the
        // router rather than from memory, after a first version waited on a
        // frame type that does not exist and timed out.
        const m = JSON.parse(d.toString()) as { type?: string; payload?: string };
        if (m.type === 'deliver') resolve(m.payload!);
      });
    });
    wsB.send(JSON.stringify({ type: 'send', msg_id: crypto.randomUUID(), to: 'A', payload: 'to-the-newest' }));
    expect(await got).toBe('to-the-newest');

    try { s1.close(); } catch { /* already closed by the server */ }
    s2.close();
    wsB.close();
  }, 20_000);
});
