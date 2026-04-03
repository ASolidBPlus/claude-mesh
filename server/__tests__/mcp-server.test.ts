import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, setOnline, aclGrant } from '../db.ts';
import { startMcpServer, McpServerHandle } from '../mcp-server.ts';
import { Database } from 'bun:sqlite';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ListToolsResultSchema, CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';

const EXPECTED_TOOLS = [
  'mesh_send',
  'mesh_broadcast',
  'mesh_subscribe',
  'mesh_unsubscribe',
  'mesh_discover',
  'mesh_status',
  'mesh_acl_allow',
  'mesh_acl_deny',
  'mesh_request',
];

const REQUIRED_FIELDS: Record<string, string[]> = {
  mesh_send: ['to', 'message', 'as_agent'],
  mesh_broadcast: ['topic', 'message'],
  mesh_subscribe: ['topic'],
  mesh_unsubscribe: ['topic'],
  mesh_discover: [],
  mesh_status: [],
  mesh_acl_allow: ['agent_id', 'as_agent'],
  mesh_acl_deny: ['agent_id', 'as_agent'],
  mesh_request: ['to', 'message'],
};

describe('startMcpServer', () => {
  let db: Database;
  let handle: McpServerHandle;
  let client: Client;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startMcpServer(db);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await handle.server.connect(serverTransport);

    client = new Client({ name: 'test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close().catch(() => {});
    await handle.shutdown().catch(() => {});
    db.close();
  });

  it('startMcpServer resolves without throwing', async () => {
    expect(handle).toBeDefined();
    expect(handle.server).toBeDefined();
  });

  it('ListTools returns exactly 9 tools', async () => {
    const result = await client.listTools();
    expect(result.tools).toHaveLength(9);
  });

  it('ListTools includes all nine tool names', async () => {
    const result = await client.listTools();
    const names = result.tools.map((t: { name: string }) => t.name);
    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
  });

  it('each tool has correct required fields', async () => {
    const result = await client.listTools();
    for (const tool of result.tools as Array<{ name: string; inputSchema: { required?: string[] } }>) {
      const expectedRequired = REQUIRED_FIELDS[tool.name];
      if (expectedRequired === undefined) continue;
      const actualRequired = tool.inputSchema.required ?? [];
      expect(actualRequired.sort()).toEqual(expectedRequired.sort());
    }
  });

  it('CallTool mesh_send with valid args routes message (AGENT_NOT_FOUND when recipient missing)', async () => {
    registerAgent(db, { id: 'sender-agent', token_hash: 'a'.repeat(64), hostname: 'host1' });
    const result = await client.callTool({ name: 'mesh_send', arguments: { to: 'ghost', message: 'hello', as_agent: 'sender-agent' } });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.error).toBe('AGENT_NOT_FOUND');
  });

  it('CallTool mesh_send with valid agents and ACL returns ok:true', async () => {
    registerAgent(db, { id: 'mcp-sender', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'mcp-recip', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'mcp-sender', 'mcp-recip', 'system');
    const result = await client.callTool({ name: 'mesh_send', arguments: { to: 'mcp-recip', message: 'hello', as_agent: 'mcp-sender' } });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
    expect(typeof parsed.msg_id).toBe('string');
  });

  it('CallTool mesh_request returns isError true and not implemented text', async () => {
    const result = await client.callTool({ name: 'mesh_request', arguments: { to: 'a', message: 'b' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('{"error": "not implemented"}');
  });

  it('CallTool mesh_status with empty input returns isError true and not implemented text', async () => {
    const result = await client.callTool({ name: 'mesh_status', arguments: {} });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('{"error": "not implemented"}');
  });

  it('CallTool for unknown tool name returns MCP error and does not crash', async () => {
    await expect(
      client.callTool({ name: 'mesh_nonexistent', arguments: {} })
    ).rejects.toThrow();
  });

  it('handle.shutdown resolves without throwing', async () => {
    await expect(handle.shutdown()).resolves.toBeUndefined();
  });

  // ──────────────────────────────────────────────
  // Sprint 4: mesh_discover
  // ──────────────────────────────────────────────

  it('mesh_discover on empty DB returns isError:false and empty array', async () => {
    const result = await client.callTool({ name: 'mesh_discover', arguments: {} });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toEqual([]);
  });

  it('mesh_discover with two registered agents returns both (length 2)', async () => {
    registerAgent(db, { id: 'disc-1', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'disc-2', token_hash: 'b'.repeat(64), hostname: 'host2' });

    const result = await client.callTool({ name: 'mesh_discover', arguments: {} });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed).toHaveLength(2);
  });

  it('each result object has required fields with correct types', async () => {
    registerAgent(db, { id: 'disc-fields', token_hash: 'a'.repeat(64), hostname: 'host1' });

    const result = await client.callTool({ name: 'mesh_discover', arguments: {} });
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>[];

    expect(parsed).toHaveLength(1);
    const agent = parsed[0];
    expect(typeof agent.id).toBe('string');
    expect(typeof agent.hostname).toBe('string');
    expect(typeof agent.online).toBe('boolean');
    expect(Array.isArray(agent.capabilities)).toBe(true);
    expect(typeof agent.metadata).toBe('object');
    expect(typeof agent.last_seen).toBe('number');
    expect(typeof agent.registered_at).toBe('number');
  });

  it('mesh_discover with filter_online:true returns only online agents', async () => {
    registerAgent(db, { id: 'disc-online', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'disc-offline', token_hash: 'b'.repeat(64), hostname: 'host2' });
    setOnline(db, 'disc-online', true);

    const result = await client.callTool({ name: 'mesh_discover', arguments: { filter_online: true } });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('disc-online');
    expect(parsed[0].online).toBe(true);
  });

  it('mesh_discover with capability filter returns only agents with that capability', async () => {
    registerAgent(db, {
      id: 'disc-cap-ft',
      token_hash: 'a'.repeat(64),
      hostname: 'host1',
      capabilities: '["file-transfer","broadcast"]',
    });
    registerAgent(db, {
      id: 'disc-cap-none',
      token_hash: 'b'.repeat(64),
      hostname: 'host2',
      capabilities: '[]',
    });

    const result = await client.callTool({ name: 'mesh_discover', arguments: { capability: 'file-transfer' } });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('disc-cap-ft');
  });

  it('mesh_discover with both filter_online and capability applies both filters (intersection)', async () => {
    registerAgent(db, {
      id: 'disc-both-online-cap',
      token_hash: 'a'.repeat(64),
      hostname: 'host1',
      capabilities: '["file-transfer"]',
    });
    registerAgent(db, {
      id: 'disc-both-offline-cap',
      token_hash: 'b'.repeat(64),
      hostname: 'host2',
      capabilities: '["file-transfer"]',
    });
    registerAgent(db, {
      id: 'disc-both-online-nocap',
      token_hash: 'c'.repeat(64),
      hostname: 'host3',
      capabilities: '[]',
    });
    setOnline(db, 'disc-both-online-cap', true);
    setOnline(db, 'disc-both-online-nocap', true);

    const result = await client.callTool({ name: 'mesh_discover', arguments: { filter_online: true, capability: 'file-transfer' } });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text) as Record<string, unknown>[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('disc-both-online-cap');
  });

  it('remaining stub tools still return isError:true with not implemented text', async () => {
    const stubTools = [
      { name: 'mesh_broadcast', arguments: { topic: 't', message: 'm' } },
      { name: 'mesh_subscribe', arguments: { topic: 't' } },
      { name: 'mesh_unsubscribe', arguments: { topic: 't' } },
    ];

    for (const tool of stubTools) {
      const result = await client.callTool(tool);
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('{"error": "not implemented"}');
    }
  });

  it('CallTool mesh_acl_allow grants ACL permission', async () => {
    registerAgent(db, { id: 'acl-agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'acl-agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    // as_agent='acl-agent-b' allows agent_id='acl-agent-a' to send to acl-agent-b
    const result = await client.callTool({ name: 'mesh_acl_allow', arguments: { agent_id: 'acl-agent-a', as_agent: 'acl-agent-b' } });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.from_agent).toBe('acl-agent-a');
    expect(parsed.to_agent).toBe('acl-agent-b');
  });

  it('CallTool mesh_acl_deny revokes ACL permission', async () => {
    registerAgent(db, { id: 'deny-agent-a', token_hash: 'a'.repeat(64), hostname: 'host1' });
    registerAgent(db, { id: 'deny-agent-b', token_hash: 'b'.repeat(64), hostname: 'host2' });
    aclGrant(db, 'deny-agent-a', 'deny-agent-b', 'system');
    const result = await client.callTool({ name: 'mesh_acl_deny', arguments: { agent_id: 'deny-agent-a', as_agent: 'deny-agent-b' } });
    expect(result.isError).toBe(false);
    const text = (result.content as Array<{ type: string; text: string }>)[0].text;
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
  });
});
