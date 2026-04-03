import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb } from '../db.ts';
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
  mesh_send: ['to', 'message'],
  mesh_broadcast: ['topic', 'message'],
  mesh_subscribe: ['topic'],
  mesh_unsubscribe: ['topic'],
  mesh_discover: [],
  mesh_status: [],
  mesh_acl_allow: ['agent_id'],
  mesh_acl_deny: ['agent_id'],
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

  it('CallTool mesh_send returns isError true and not implemented text', async () => {
    const result = await client.callTool({ name: 'mesh_send', arguments: { to: 'a', message: 'b' } });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ type: string; text: string }>)[0].text).toBe('{"error": "not implemented"}');
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
});
