import { openDb } from './db.ts';
import { startWsServer, WsServerHandle } from './ws-server.ts';
import { startMcpServer, McpServerHandle } from './mcp-server.ts';
import { startHttpAdmin, HttpAdminHandle } from './http-admin.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Database } from 'bun:sqlite';

export interface Config {
  dbPath: string;
  wsPort: number;
  adminPort: number;
  adminToken: string;
}

export function loadConfig(): Config {
  const adminToken = process.env.MESH_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    process.stderr.write('MESH_ADMIN_TOKEN is required but not set or empty\n');
    process.exit(1);
  }

  const dbPath = process.env.MESH_DB_PATH ?? '/data/mesh.db';

  let wsPort = 7384;
  const wsPortStr = process.env.MESH_WS_PORT;
  if (wsPortStr !== undefined) {
    const parsed = parseInt(wsPortStr, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== wsPortStr.trim()) {
      process.stderr.write(`MESH_WS_PORT must be an integer between 1 and 65535, got: ${wsPortStr}\n`);
      process.exit(1);
    }
    wsPort = parsed;
  }

  let adminPort = 7385;
  const adminPortStr = process.env.MESH_ADMIN_PORT;
  if (adminPortStr !== undefined) {
    const parsed = parseInt(adminPortStr, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== adminPortStr.trim()) {
      process.stderr.write(`MESH_ADMIN_PORT must be an integer between 1 and 65535, got: ${adminPortStr}\n`);
      process.exit(1);
    }
    adminPort = parsed;
  }

  return { dbPath, wsPort, adminPort, adminToken };
}

async function main() {
  const config = loadConfig();

  let db: Database;
  try {
    db = openDb(config.dbPath);
  } catch (err) {
    process.stderr.write(`Failed to open database: ${err}\n`);
    process.exit(1);
  }

  let wsHandle: WsServerHandle;
  try {
    wsHandle = await startWsServer(config.wsPort, db);
  } catch (err) {
    process.stderr.write(`Failed to start WebSocket server: ${err}\n`);
    process.exit(1);
  }

  const { agentIndex } = wsHandle;

  const httpHandle: HttpAdminHandle = await startHttpAdmin(config.adminPort, db, config.adminToken);

  const mcpHandle = await startMcpServer(db, agentIndex);
  const transport = new StdioServerTransport();
  await mcpHandle.server.connect(transport);

  let shutdownStarted = false;

  async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;

    const safetyTimeout = setTimeout(() => {
      process.exit(1);
    }, 3000);

    try {
      await wsHandle.shutdown();
      await httpHandle.shutdown();
      await mcpHandle.shutdown();
      db.close();
      process.stdout.write('mesh-server stopped\n');
    } finally {
      clearTimeout(safetyTimeout);
    }
    process.exit(0);
  }

  process.stdin.on('end', shutdown);
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.stdout.write(`mesh-server started — ws=${config.wsPort} db=${config.dbPath}\n`);
}

// Only run main when this file is the entry point, not when imported as a module
if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`Unhandled startup error: ${err}\n`);
    process.exit(1);
  });
}
