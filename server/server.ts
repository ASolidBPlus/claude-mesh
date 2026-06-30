import { openDb } from './db.ts';
import { startWsServer, WsServerHandle } from './ws-server.ts';
import { startMcpServer, McpServerHandle } from './mcp-server.ts';
import { startHttpAdmin, HttpAdminHandle } from './http-admin.ts';
import { startCleanup, CleanupHandle } from './cleanup.ts';
import { startReminderScheduler, ReminderSchedulerHandle } from './reminder-scheduler.ts';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Database } from 'bun:sqlite';
import { WebSocket } from 'ws';
import { mkdirSync } from 'fs';

export interface Config {
  dbPath: string;
  wsPort: number;
  adminPort: number;
  adminToken: string;
  cleanupIntervalMs: number;
  maxFileBytes: number;
  filesDir: string;
  reminderIntervalMs: number;
  presenceDebounceMs: number;
  mcpMode: boolean;
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

  let cleanupIntervalMs = 60_000;
  const cleanupStr = process.env.MESH_CLEANUP_INTERVAL_MS;
  if (cleanupStr !== undefined) {
    const parsed = parseInt(cleanupStr, 10);
    if (isNaN(parsed) || parsed <= 0 || parsed > 3_600_000) {
      process.stderr.write(`MESH_CLEANUP_INTERVAL_MS must be an integer between 1 and 3600000, got: ${cleanupStr}\n`);
      process.exit(1);
    }
    cleanupIntervalMs = parsed;
  }

  let maxFileBytes = 10_485_760;
  const maxFileBytesStr = process.env.MESH_MAX_FILE_BYTES;
  if (maxFileBytesStr !== undefined) {
    const parsed = parseInt(maxFileBytesStr, 10);
    if (isNaN(parsed) || parsed <= 0) {
      process.stderr.write(`MESH_MAX_FILE_BYTES must be a positive integer, got: ${maxFileBytesStr}\n`);
      process.exit(1);
    }
    maxFileBytes = parsed;
  }

  const filesDir = process.env.MESH_FILES_DIR ?? '/data/files';

  let reminderIntervalMs = 10_000;
  const reminderStr = process.env.MESH_REMINDER_INTERVAL_MS;
  if (reminderStr !== undefined) {
    const parsed = parseInt(reminderStr, 10);
    if (isNaN(parsed) || parsed <= 0 || parsed > 3_600_000) {
      process.stderr.write(`MESH_REMINDER_INTERVAL_MS must be an integer between 1 and 3600000, got: ${reminderStr}\n`);
      process.exit(1);
    }
    reminderIntervalMs = parsed;
  }

  let presenceDebounceMs = 12_000;
  const presenceStr = process.env.MESH_PRESENCE_DEBOUNCE_MS;
  if (presenceStr !== undefined) {
    const parsed = parseInt(presenceStr, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 600_000 || String(parsed) !== presenceStr.trim()) {
      process.stderr.write(`MESH_PRESENCE_DEBOUNCE_MS must be an integer between 0 and 600000, got: ${presenceStr}\n`);
      process.exit(1);
    }
    presenceDebounceMs = parsed;
  }

  // MCP stdio mode: when running as an MCP server driven over the process's
  // stdin/stdout (set MESH_MCP_MODE=1), stdin EOF means the parent disconnected
  // and the server should shut down. As a standalone WS+HTTP daemon (the default,
  // e.g. `docker run -d`), stdin EOF is environmental noise and must NOT trigger
  // shutdown — otherwise the daemon exits immediately on startup.
  const mcpMode = process.env.MESH_MCP_MODE === '1';

  return { dbPath, wsPort, adminPort, adminToken, cleanupIntervalMs, maxFileBytes, filesDir, reminderIntervalMs, presenceDebounceMs, mcpMode };
}

async function main() {
  const config = loadConfig();

  mkdirSync(config.filesDir, { recursive: true });

  let db: Database;
  try {
    db = openDb(config.dbPath);
  } catch (err) {
    process.stderr.write(`Failed to open database: ${err}\n`);
    process.exit(1);
  }

  // Single shared observerIndex: created ONCE here and passed to startWsServer
  // (populate/cleanup/fan-out), startHttpAdmin (live grant/revoke), AND
  // startMcpServer (so MCP-originated traffic is tapped too). The SAME Map
  // instance must reach all three so admin grant/revoke mutate exactly the map
  // the WS and MCP fan-out read.
  const observerIndex = new Map<string, WebSocket>();

  let wsHandle: WsServerHandle;
  try {
    wsHandle = await startWsServer(config.wsPort, db, config.maxFileBytes, config.filesDir, config.presenceDebounceMs, observerIndex);
  } catch (err) {
    process.stderr.write(`Failed to start WebSocket server: ${err}\n`);
    process.exit(1);
  }

  const { agentIndex, pendingRequests } = wsHandle;

  const httpHandle: HttpAdminHandle = await startHttpAdmin(config.adminPort, db, config.adminToken, config.maxFileBytes, config.filesDir, wsHandle.agentIndex, wsHandle.pendingRequests, observerIndex);

  let cleanupHandle: CleanupHandle | null = null;
  let reminderHandle: ReminderSchedulerHandle | null = null;

  let shutdownStarted = false;

  async function shutdown() {
    if (shutdownStarted) return;
    shutdownStarted = true;

    const safetyTimeout = setTimeout(() => {
      process.exit(1);
    }, 3000);

    try {
      cleanupHandle?.stop();
      reminderHandle?.stop();
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

  const mcpHandle = await startMcpServer(db, agentIndex, pendingRequests, observerIndex);
  const transport = new StdioServerTransport();
  await mcpHandle.server.connect(transport);

  cleanupHandle = startCleanup(db, pendingRequests, agentIndex, config.cleanupIntervalMs);
  reminderHandle = startReminderScheduler(db, wsHandle.agentIndex, config.reminderIntervalMs);

  // Only treat stdin EOF as a shutdown signal in MCP stdio mode. A standalone
  // daemon (the default) must survive stdin being closed (e.g. `docker run -d`).
  if (config.mcpMode) {
    process.stdin.on('end', shutdown);
    process.stdin.on('close', shutdown);
  }
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
