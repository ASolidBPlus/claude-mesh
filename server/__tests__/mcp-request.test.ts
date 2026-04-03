import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { openDb, registerAgent, aclGrant } from '../db.ts';
import { startMcpServer, McpServerHandle } from '../mcp-server.ts';
import { PendingRequest } from '../router.ts';
import { Database } from 'bun:sqlite';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocket } from 'ws';

describe('mesh_request MCP tool', () => {
  let db: Database;
  let handle: McpServerHandle;
  let client: Client;
  let pendingRequests: Map<string, PendingRequest>;

  beforeEach(async () => {
    db = openDb(':memory:');
    pendingRequests = new Map();
    handle = await startMcpServer(db, new Map(), pendingRequests);

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

  it('happy path — resolves with response payload when the responder answers within timeout', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host-a' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host-b' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    // Start the mesh_request call — it will block waiting for a response
    const requestPromise = client.callTool({
      name: 'mesh_request',
      arguments: { to: 'agent-b', message: 'hello', as_agent: 'agent-a', timeout_seconds: 5 },
    }, CallToolResultSchema);

    // Simulate the response arriving — poll until the pending entry is registered
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (pendingRequests.size > 0) {
          clearInterval(check);
          resolve();
        }
      }, 10);
    });

    // Get the pending entry and resolve it with a response
    const [corrId, pending] = [...pendingRequests.entries()][0];
    clearTimeout(pending.timer);
    pendingRequests.delete(corrId);
    pending.resolve!('{"answer":42}');

    const result = await requestPromise;
    expect(result.isError).toBeFalsy();
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.ok).toBe(true);
    expect(parsed.response).toBe('{"answer":42}');
  }, 10000);

  it('timeout — returns REQUEST_TIMEOUT error when no response arrives', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host-a' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host-b' });
    aclGrant(db, 'agent-a', 'agent-b', 'system');

    const result = await client.callTool({
      name: 'mesh_request',
      arguments: { to: 'agent-b', message: 'hello', as_agent: 'agent-a', timeout_seconds: 0.1 },
    }, CallToolResultSchema);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toBe('REQUEST_TIMEOUT');
  }, 5000);

  it('ACL denied — returns error if routeRequest returns ACL_DENIED', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host-a' });
    registerAgent(db, { id: 'agent-b', token_hash: 'b'.repeat(64), hostname: 'host-b' });
    // No aclGrant — ACL denied

    const result = await client.callTool({
      name: 'mesh_request',
      arguments: { to: 'agent-b', message: 'hello', as_agent: 'agent-a', timeout_seconds: 5 },
    }, CallToolResultSchema);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toBe('ACL_DENIED');
  }, 5000);

  it('agent not found — returns error if target agent does not exist', async () => {
    registerAgent(db, { id: 'agent-a', token_hash: 'a'.repeat(64), hostname: 'host-a' });

    const result = await client.callTool({
      name: 'mesh_request',
      arguments: { to: 'ghost-agent', message: 'hello', as_agent: 'agent-a', timeout_seconds: 5 },
    }, CallToolResultSchema);

    expect(result.isError).toBe(true);
    const parsed = JSON.parse((result.content[0] as { text: string }).text);
    expect(parsed.error).toBe('AGENT_NOT_FOUND');
  }, 5000);
});
