import { describe, it, expect, afterEach, afterAll } from 'bun:test';
import { join } from 'path';
import { openDb, registerAgent, aclGrant } from '../../server/db.ts';
import { hashToken } from '../../server/auth.ts';
import { startWsServer } from '../../server/ws-server.ts';
import { tempDirs } from '../../server/__tests__/helpers/temp-dirs.ts';
import { MeshClient, Inbound } from '../src/index.ts';

// R-377 — the SDK half of mesh aliases: `alias` connects as `<agentId>+<alias>`
// with the agent's own token; `as: 'alias'` sends from the alias; inbound
// messages expose `identity` (always) and `alias` (on a default send from one).

delete process.env.MESH_SERVER_URL;
delete process.env.MESH_AGENT_ID;
delete process.env.MESH_AGENT_TOKEN;

const { tmp, cleanup: cleanupTempDirs } = tempDirs();
afterAll(cleanupTempDirs);

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const clients: MeshClient[] = [];
afterEach(() => { for (const c of clients.splice(0)) { try { c.close(); } catch { /* ignore */ } } });

describe('R-377 SDK aliases against the real server', () => {
  it('the plugin receives as fred, the alias sends; replies reach the right connection', async () => {
    const db = openDb(':memory:');
    for (const id of ['fred', 'bob']) registerAgent(db, { id, token_hash: hashToken(`${id}-tok`), hostname: 'h' });
    aclGrant(db, 'fred', 'bob', 'admin');
    aclGrant(db, 'bob', 'fred', 'admin');
    const port = 24800;
    const handle = await startWsServer(port, db, 10_485_760, join(tmp('r377-sdk-'), 'files'), 0, new Map());
    try {
      const mk = (agentId: string, extra: { alias?: string } = {}) => {
        const c = new MeshClient({ serverUrl: `ws://127.0.0.1:${port}`, agentId, agentToken: `${agentId}-tok`, ...extra });
        clients.push(c);
        const got: Inbound[] = [];
        c.onMessage((m) => { got.push(m); });
        return { c, got };
      };
      const plugin = mk('fred');
      const mcp = mk('fred', { alias: 'mcp' });
      const bob = mk('bob');
      await Promise.all([plugin.c.connect(), mcp.c.connect(), bob.c.connect()]);

      await mcp.c.send('bob', 'default');
      await mcp.c.send('bob', 'as alias', { as: 'alias' });
      await wait(80);
      expect(bob.got.map(m => [m.text, m.from, m.identity, m.alias])).toEqual([
        ['default', 'fred', 'fred', 'fred+mcp'],
        ['as alias', 'fred+mcp', 'fred', undefined],
      ]);

      for (const m of bob.got) await bob.c.send(m.from, `re: ${m.text}`);
      await wait(80);
      expect(plugin.got.map(m => m.text)).toEqual(['re: default']);
      expect(mcp.got.map(m => m.text)).toEqual(['re: as alias']);
      expect(plugin.got[0]!.identity).toBe('bob');
    } finally {
      await handle.shutdown().catch(() => {});
      db.close();
    }
  }, 20_000);
});
