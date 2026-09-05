import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclCheck, aclGrant } from '../db.ts';
import { startMcpServer, McpServerHandle } from '../mcp-server.ts';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Database } from 'bun:sqlite';

// #8 — the stdio MCP plane wrote ACL edges with NO credential, while the
// equivalent HTTP routes (POST /acl, DELETE /acl) require the admin token.
// Same write, two doors, one unlocked. DESIGN_FEDERATION P1 will not ship a
// narrower front door while a wider one stands beside it.
//
// These assert the WRITE, not the response: a refusal that still mutated the
// table would be the worst outcome and would pass a response-only assertion.

const ADMIN = 'admin-secret-for-gate-tests';

describe('#8 — mesh_acl_allow / mesh_acl_deny require the admin token', () => {
  let db: Database;
  let handle: McpServerHandle;
  let client: Client;

  const call = (name: string, args: Record<string, unknown>) =>
    client.callTool({ name, arguments: args });
  const parse = (r: Awaited<ReturnType<typeof call>>) =>
    JSON.parse((r.content as Array<{ text: string }>)[0]!.text);

  beforeEach(async () => {
    db = openDb(':memory:');
    registerAgent(db, { id: 'A', token_hash: 'a'.repeat(64), hostname: 'hA' });
    registerAgent(db, { id: 'B', token_hash: 'b'.repeat(64), hostname: 'hB' });
    handle = await startMcpServer(db, new Map(), new Map(), ADMIN);
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test', version: '1' }, { capabilities: {} });
    await handle.server.connect(serverT);
    await client.connect(clientT);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    db.close();
  });

  it('★ allow WITHOUT a token writes NOTHING and says why', async () => {
    const r = await call('mesh_acl_allow', { agent_id: 'A', as_agent: 'B' });
    expect(r.isError).toBe(true);
    expect(parse(r).error).toBe('UNAUTHORIZED');
    // The property that matters: the table is untouched.
    expect(aclCheck(db, 'A', 'B')).toBe(false);
  });

  it('★ allow with a WRONG token writes nothing', async () => {
    const r = await call('mesh_acl_allow', { agent_id: 'A', as_agent: 'B', admin_token: 'not-the-token' });
    expect(r.isError).toBe(true);
    expect(aclCheck(db, 'A', 'B')).toBe(false);
  });

  it('★ deny WITHOUT a token does not REVOKE — the dangerous direction', async () => {
    // Revocation failing open is worse than granting failing open: it silently
    // cuts an agent off. Assert the edge SURVIVES the refused call.
    aclGrant(db, 'A', 'B', 'system');
    expect(aclCheck(db, 'A', 'B')).toBe(true);
    const r = await call('mesh_acl_deny', { agent_id: 'A', as_agent: 'B' });
    expect(r.isError).toBe(true);
    expect(aclCheck(db, 'A', 'B')).toBe(true);
  });

  it('with the RIGHT token both still work — the gate is not a wall', async () => {
    const allow = await call('mesh_acl_allow', { agent_id: 'A', as_agent: 'B', admin_token: ADMIN });
    expect(allow.isError).toBe(false);
    expect(aclCheck(db, 'A', 'B')).toBe(true);

    const deny = await call('mesh_acl_deny', { agent_id: 'A', as_agent: 'B', admin_token: ADMIN });
    expect(deny.isError).toBe(false);
    expect(aclCheck(db, 'A', 'B')).toBe(false);
  });

  it('an EMPTY admin_token is not a token, even against an empty configured one', async () => {
    // The classic: '' === '' turns a missing secret into a universal key.
    // server.ts exits at boot on an empty MESH_ADMIN_TOKEN, so this is defence
    // in depth — but the check must not DEPEND on that guard being upstream,
    // because a harness or a future embedder can construct the server directly.
    const db2 = openDb(':memory:');
    registerAgent(db2, { id: 'A', token_hash: 'a'.repeat(64), hostname: 'hA' });
    registerAgent(db2, { id: 'B', token_hash: 'b'.repeat(64), hostname: 'hB' });
    const h2 = await startMcpServer(db2, new Map(), new Map(), ''); // unconfigured
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const c2 = new Client({ name: 't2', version: '1' }, { capabilities: {} });
    await h2.server.connect(st);
    await c2.connect(ct);

    for (const tok of ['', undefined]) {
      const r = await c2.callTool({
        name: 'mesh_acl_allow',
        arguments: tok === undefined ? { agent_id: 'A', as_agent: 'B' } : { agent_id: 'A', as_agent: 'B', admin_token: tok },
      });
      expect(r.isError).toBe(true);
    }
    expect(aclCheck(db2, 'A', 'B')).toBe(false);
    await c2.close().catch(() => {});
    db2.close();
  });

  it('★ an ABSENT admin_token REFUSES — it does not crash the tool plane', async () => {
    // The contract, pinned. `admin_token?: unknown` means an absent argument
    // arrives as `undefined`, and timingSafeEqual would throw on it — which
    // the reviewer's mutant produced as `MCP -32603`. No write happens either
    // way (the throw precedes aclGrant, so it was never a bypass), but a tool
    // that CRASHES where its siblings return a typed error is a worse
    // contract: the shape of a refusal must not depend on which field was
    // missing. So this asserts the typed refusal specifically, not merely
    // "isError".
    const r = await call('mesh_acl_deny', { agent_id: 'A', as_agent: 'B' });
    expect(r.isError).toBe(true);
    const body = parse(r);
    expect(body.error).toBe('UNAUTHORIZED');
    expect(body.message).toContain('admin_token');
  });

  it('the read-only tools are unchanged — mesh_discover still needs no token', async () => {
    // Scope check: #8's fix is the two WRITE tools. discover/status returning
    // the roster is a separate, stated exposure (still operator-plane only).
    const r = await call('mesh_discover', {});
    expect(r.isError).toBe(false);
  });
});
