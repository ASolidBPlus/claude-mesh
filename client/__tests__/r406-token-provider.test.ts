import { describe, it, expect, beforeAll, afterEach, afterAll } from 'bun:test';
import { join } from 'path';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { hashToken } from '../../server/auth.ts';
import { startWsServer, WsServerHandle } from '../../server/ws-server.ts';
import { createOidcVerifier, type OidcVerifier } from '../../server/oidc.ts';
import { accessToken, makeCa, makeKey, startIssuer, type TestIssuer, type TestKey } from '../../server/__tests__/helpers/test-issuer.ts';
import { tempDirs } from '../../server/__tests__/helpers/temp-dirs.ts';
import { MeshClient } from '../src/index.ts';

// R-406 — the SDK half: `agentToken` may be a function, called on every
// connect; with an OAuth token the client re-authenticates the live socket
// shortly before it expires (no reconnect, so no presence flap), and falls
// back to a reconnect if the re-auth is refused.

delete process.env.MESH_SERVER_URL;
delete process.env.MESH_AGENT_ID;
delete process.env.MESH_AGENT_TOKEN;

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));

let portCounter = 23900;
const nextPort = () => portCounter++;
let ca: ReturnType<typeof makeCa>;
let key: TestKey;
beforeAll(async () => { ca = makeCa(tmp('r406-sdk-'), 'ca'); key = await makeKey('k1'); });

let issuer: TestIssuer | undefined;
let verifier: OidcVerifier | undefined;
let ws: WsServerHandle | undefined;
const clients: MeshClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } }
  await ws?.shutdown().catch(() => {});
  verifier?.stop(); issuer?.stop();
  ws = undefined; verifier = undefined; issuer = undefined;
});

async function bus(): Promise<number> {
  issuer = startIssuer(nextPort(), ca, [key]);
  verifier = createOidcVerifier({ issuer: issuer.url, audience: 'mesh', idClaim: 'preferred_username', caFile: ca.caFile, jwksFile: null }, { log: () => {} });
  for (let i = 0; i < 50 && !verifier.ready(); i++) await wait(20);
  const db = openDb(':memory:');
  registerAgent(db, { id: 'fred', token_hash: hashToken('fred-tok'), hostname: 'h' });
  aclGrant(db, 'fred', 'fred', 'admin');
  const port = nextPort();
  ws = await startWsServer(port, db, 10_485_760, join(tmp('r406-sdk-files-'), 'f'), 0, new Map(), null, { tokenAuth: { oidc: verifier, staticTokens: true } });
  return port;
}
const tok = (who: string, expIn: number) => accessToken(key, { iss: issuer!.url, aud: 'mesh', preferred_username: who, sub: `u-${who}` }, { expIn });

describe('R-406 SDK token function', () => {
  it('re-authenticates the live socket ~30 s before exp, with no reconnect', async () => {
    const port = await bus();
    const issued: number[] = [];
    // 31 s, so the re-auth (30 s ahead) comes after about one second.
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'fred', agentToken: async () => { issued.push(Date.now()); return tok('fred', 31); } });
    clients.push(c);
    let disconnects = 0;
    c.on('disconnect', () => { disconnects++; });
    await c.connect();
    await wait(1800);
    expect(issued.length).toBeGreaterThanOrEqual(2);
    expect(disconnects).toBe(0);
    await c.send('fred', 'still here');
  }, 10_000);

  it('a refused re-auth falls back to a reconnect, which logs in with a fresh token', async () => {
    const port = await bus();
    let n = 0;
    // The second token names someone else, so the re-auth is refused.
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'fred', agentToken: async () => (++n === 2 ? tok('mallory', 600) : tok('fred', n === 1 ? 31 : 600)) });
    clients.push(c);
    let connects = 0;
    let disconnects = 0;
    c.on('connect', () => { connects++; });
    c.on('disconnect', () => { disconnects++; });
    await c.connect();
    await wait(4000);
    expect(n).toBeGreaterThanOrEqual(3);
    expect(disconnects).toBeGreaterThanOrEqual(1);
    expect(connects).toBeGreaterThanOrEqual(2);
    await c.send('fred', 'back');
  }, 15_000);

  it('a plain string token behaves as before', async () => {
    const port = await bus();
    const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId: 'fred', agentToken: 'fred-tok' });
    clients.push(c);
    await c.connect();
    await c.send('fred', 'static');
  });
});
