import { openDb, findPeerAliasCollisions, findInvalidTopicNames, findTopicPrefixAgents, listPeers, listOutboundPeers,
  findUngrammaticalAgentIds, findUngrammaticalTopicNames } from './db.ts';
import { setPeerUpSource } from './metrics.ts';
import { startBorder, forwarders } from './border.ts';
import { parsePlaintextPeerCidrs, applyPlaintextPeerCidrs, type PlaintextCidr } from './plaintext-peers.ts';
import { loadTls, expiryWarning, type ServerTls } from './tls-config.ts';
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
  /** R-65: 'off' only beside a TLS sibling (see loadConfig). */
  wsPort: number | 'off';
  adminPort: number | 'off';
  /** R-65 M1/M2: a TLS listener beside the plaintext one, or null. */
  wsTlsPort: number | null;
  adminTlsPort: number | null;
  adminToken: string;
  /** R-65 M7: MESH_ADMIN_TOKEN_PREV, accepted beside the admin token. */
  adminTokenPrev: string | null;
  cleanupIntervalMs: number;
  maxFileBytes: number;
  filesDir: string;
  reminderIntervalMs: number;
  presenceDebounceMs: number;
  mcpMode: boolean;
  retentionMs: number | null;
  plaintextPeerCidrs: PlaintextCidr[];
  tls: ServerTls | null;
  tlsCa: string | null;
  metricsToken: string | null;
}

export function loadConfig(): Config {
  const adminToken = process.env.MESH_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    process.stderr.write('MESH_ADMIN_TOKEN is required but not set or empty\n');
    process.exit(1);
  }

  const dbPath = process.env.MESH_DB_PATH ?? '/data/mesh.db';

  // R-65 M7: the previous admin token, accepted beside the current one so a
  // rotation is not a flag day. Same rule as the admin token itself: set
  // means non-empty. Never logged; the boot line says only whether it is set.
  const prevRaw = process.env.MESH_ADMIN_TOKEN_PREV;
  if (prevRaw !== undefined && prevRaw === '') {
    process.stderr.write('MESH_ADMIN_TOKEN_PREV is set but empty; unset it, or set it to the previous admin token\n');
    process.exit(1);
  }
  const adminTokenPrev = prevRaw ?? null;

  // R-65 PORTS. Each listener pair is a plaintext port and an optional TLS
  // port. The rules, all refusals at boot:
  //   - a TLS port needs MESH_TLS_CERT + MESH_TLS_KEY (checked below, once TLS
  //     is loaded);
  //   - a plaintext port may be 'off' only when its TLS sibling is set;
  //   - with a TLS port set, the plaintext port must be STATED — a number or
  //     'off'. Absent is refused, never the plaintext default: an operator
  //     adding TLS must decide about plaintext, not inherit it.
  // With no TLS port the old rules hold exactly, default included.
  const parsePort = (name: string, raw: string): number => {
    const parsed = parseInt(raw, 10);
    if (isNaN(parsed) || parsed < 1 || parsed > 65535 || String(parsed) !== raw.trim()) {
      process.stderr.write(`${name} must be an integer between 1 and 65535, got: ${raw}\n`);
      process.exit(1);
    }
    return parsed;
  };
  const portPair = (plainName: string, tlsName: string, plainDefault: number): { plain: number | 'off'; tls: number | null } => {
    const tlsRaw = process.env[tlsName];
    const tlsPort = tlsRaw === undefined ? null : parsePort(tlsName, tlsRaw);
    const plainRaw = process.env[plainName];
    if (plainRaw === undefined) {
      if (tlsPort !== null) {
        process.stderr.write(`${tlsName} is set but ${plainName} is not; say ${plainName}=off or give it a port — the plaintext default is not applied beside a TLS listener\n`);
        process.exit(1);
      }
      return { plain: plainDefault, tls: null };
    }
    if (plainRaw.trim() === 'off') {
      if (tlsPort === null) {
        process.stderr.write(`${plainName}=off needs ${tlsName}: turning plaintext off with no TLS listener would leave nothing to connect to\n`);
        process.exit(1);
      }
      return { plain: 'off', tls: tlsPort };
    }
    const plain = parsePort(plainName, plainRaw);
    if (tlsPort !== null && tlsPort === plain) {
      process.stderr.write(`${plainName} and ${tlsName} are both ${plain}; they must differ\n`);
      process.exit(1);
    }
    return { plain, tls: tlsPort };
  };
  const wsPorts = portPair('MESH_WS_PORT', 'MESH_WS_TLS_PORT', 7384);
  const adminPorts = portPair('MESH_ADMIN_PORT', 'MESH_ADMIN_TLS_PORT', 7385);
  const wsPort = wsPorts.plain;
  const wsTlsPort = wsPorts.tls;
  const adminPort = adminPorts.plain;
  const adminTlsPort = adminPorts.tls;

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

  // Message retention (#34): how long delivered/expired rows stay in the store,
  // swept by the cleanup tick against sent_at. Unset ⇒ null ⇒ keep forever.
  // No upper cap — retention windows are legitimately large (days/weeks).
  let retentionMs: number | null = null;
  const retentionStr = process.env.MESH_RETENTION_MS;
  if (retentionStr !== undefined) {
    const parsed = parseInt(retentionStr, 10);
    if (isNaN(parsed) || parsed <= 0 || String(parsed) !== retentionStr.trim()) {
      process.stderr.write(`MESH_RETENTION_MS must be a positive integer (ms), got: ${retentionStr}\n`);
      process.exit(1);
    }
    retentionMs = parsed;
  }

  // Same stance as MESH_RETENTION_MS: an entry the parser cannot read refuses
  // to start, naming it. Guessing would silently shrink or widen the set of
  // networks the peering token crosses in cleartext.
  const plaintext = parsePlaintextPeerCidrs(process.env.MESH_PLAINTEXT_PEER_CIDRS);
  if (!plaintext.ok) {
    process.stderr.write(`MESH_PLAINTEXT_PEER_CIDRS: invalid entry ${JSON.stringify(plaintext.entry)} — ${plaintext.reason}\n`);
    process.exit(1);
  }
  const plaintextPeerCidrs = plaintext.cidrs;

  // Native TLS (tls-config.ts): a half configuration, an unreadable file or a
  // key that does not match its certificate refuses to start. Falling back to
  // plain HTTP instead would be a silent downgrade the operator cannot see.
  const tlsLoad = loadTls(process.env);
  if (!tlsLoad.ok) {
    process.stderr.write(`${tlsLoad.error}\n`);
    process.exit(1);
  }
  const tls = tlsLoad.server;
  const tlsCa = tlsLoad.ca;
  for (const [name, p] of [['MESH_WS_TLS_PORT', wsTlsPort], ['MESH_ADMIN_TLS_PORT', adminTlsPort]] as const) {
    if (p !== null && tls === null) {
      process.stderr.write(`${name} is set but MESH_TLS_CERT/MESH_TLS_KEY are not; a TLS listener needs both\n`);
      process.exit(1);
    }
  }

  // R-18: MESH_METRICS_TOKEN gates /metrics. UNSET keeps /metrics open, as it
  // has always been — Prometheus scrapes with no credential until the token is
  // configured on both sides. SET but unusable is REFUSED, not repaired:
  //   - empty: an operator who meant to lock /metrics would get it silently
  //     OPEN — the failure in the dangerous direction;
  //   - whitespace or control characters (a pasted trailing newline, most
  //     often): trimming would accept a different token than the one
  //     configured, and left alone no HTTP header could ever carry it.
  // The message names the variable and the condition, never the value or its
  // length.
  let metricsToken: string | null = null;
  const metricsRaw = process.env.MESH_METRICS_TOKEN;
  if (metricsRaw !== undefined) {
    // eslint-disable-next-line no-control-regex -- the control set is the point
    if (metricsRaw === '' || /[\s\x00-\x1f\x7f]/.test(metricsRaw)) {
      process.stderr.write('MESH_METRICS_TOKEN is set but empty or contains whitespace/control characters; refused rather than trimmed (value not shown). Unset it to leave /metrics open.\n');
      process.exit(1);
    }
    metricsToken = metricsRaw;
  }

  return { dbPath, wsPort, adminPort, wsTlsPort, adminTlsPort, adminToken, adminTokenPrev, cleanupIntervalMs, maxFileBytes, filesDir, reminderIntervalMs, presenceDebounceMs, mcpMode, retentionMs, plaintextPeerCidrs, tls, tlsCa, metricsToken };
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

  // F0b (§6): report legacy agent ids containing ':' rather than rejecting
  // them. ':' now separates mesh from agent in a remote id, so such an id is
  // ambiguous — but a live agent that can no longer re-register is a worse
  // outcome than an ambiguous one, and the operator is the only party who can
  // decide to rename it. New ids are refused at POST /agents.
  try {
    const legacy = (db.prepare("SELECT id FROM agents WHERE id LIKE '%:%'").all() as { id: string }[]).map(r => r.id);
    if (legacy.length > 0) {
      console.warn(JSON.stringify({
        evt: 'agents.legacy_colon_ids', count: legacy.length, ids: legacy,
        msg: "agent ids containing ':' predate the remote-id grammar and are ambiguous; rename when convenient",
        at: Date.now(),
      }));
    }
  } catch { /* never block boot on a diagnostic */ }

  // F4 (§7): report topic names that predate the naming rules. A colon name is
  // only ambiguous when its prefix names NO outbound peering — `orch:trollbox`
  // is exactly what a mirrored remote topic is called — and a PAUSED peering
  // still counts as configured (§16 M), so pausing a link never turns that
  // mesh's topics into boot noise.
  try {
    const invalid = findInvalidTopicNames(db);
    if (invalid.length > 0) {
      console.warn(JSON.stringify({
        evt: 'topics.invalid_names', count: invalid.length, names: invalid,
        msg: "topic names containing ':' with no matching outbound peering, or over 256 bytes, cannot cross a border; rename when convenient",
        at: Date.now(),
      }));
    }
  } catch { /* never block boot on a diagnostic */ }

  // F4 (§7): report agent ids inside the reserved `topic:` range. POST /agents
  // has refused any ':' since F0b, so such an id can only predate that rule —
  // which is why this reports rather than guards, exactly like the two above.
  // Such an id and a topic principal are indistinguishable to the ACL.
  try {
    const topicIds = findTopicPrefixAgents(db);
    if (topicIds.length > 0) {
      console.warn(JSON.stringify({
        evt: 'agents.topic_prefix_ids', count: topicIds.length, ids: topicIds,
        msg: "agent ids in the reserved 'topic:' range are indistinguishable from topic ACL principals; rename when convenient",
        at: Date.now(),
      }));
    }
  } catch { /* never block boot on a diagnostic */ }

  // #187: report ids and topic names that predate the CHARACTER GRAMMAR. Same
  // shape and the same reason as the two reports above: the rule is enforced at
  // creation, so a non-conformer can only predate it, and renaming one would
  // silently rewire every ACL edge that names it. Ingest grandfathers exactly
  // these, so this list is also what an operator would have to fix before the
  // border could ever be tightened to strict.
  try {
    const ids = findUngrammaticalAgentIds(db);
    if (ids.length > 0) {
      console.warn(JSON.stringify({
        evt: 'agents.ungrammatical_ids', count: ids.length, ids,
        msg: 'agent ids outside ^[A-Za-z0-9._@-]+$ are rendered by consumers and matched by the ACL; rename when convenient',
        at: Date.now(),
      }));
    }
    const names = findUngrammaticalTopicNames(db);
    if (names.length > 0) {
      console.warn(JSON.stringify({
        evt: 'topics.ungrammatical_names', count: names.length, names,
        msg: 'topic names outside ^[A-Za-z0-9._@:-]+$ are rendered as a delivery\'s from_agent; rename when convenient',
        at: Date.now(),
      }));
    }
  } catch { /* never block boot on a diagnostic */ }

  // F0b (§6): report an id that names BOTH a local agent and a peer alias (or a
  // live peer key). Same shape and reason as the legacy ':' report above —
  // surfaced rather than silently tolerated, because the gates prevent NEW
  // collisions and can do nothing about one already on disk.
  try {
    const collisions = findPeerAliasCollisions(db);
    if (collisions.length > 0) {
      console.warn(JSON.stringify({
        evt: 'agents.peer_alias_collision', count: collisions.length, ids: collisions,
        msg: 'these ids name both a local agent and a peer; routing cannot distinguish them',
        at: Date.now(),
      }));
    }
  } catch { /* never block boot on a diagnostic */ }

  // Single shared observerIndex: created ONCE here and passed to startWsServer
  // (populate/cleanup/fan-out), startHttpAdmin (live grant/revoke), AND
  // startMcpServer (so MCP-originated traffic is tapped too). The SAME Map
  // instance must reach all three so admin grant/revoke mutate exactly the map
  // the WS and MCP fan-out read.
  const observerIndex = new Map<string, WebSocket>();

  let wsHandle: WsServerHandle;
  try {
    if (config.tls !== null) {
      const warn = expiryWarning(config.tls.info, Date.now());
      if (warn !== null) console.error(JSON.stringify(warn));
    }
    wsHandle = await startWsServer(config.wsPort, db, config.maxFileBytes, config.filesDir, config.presenceDebounceMs, observerIndex, config.tls,
      config.wsTlsPort === null ? {} : { tlsPort: config.wsTlsPort });
  } catch (err) {
    process.stderr.write(`Failed to start WebSocket server: ${err}\n`);
    process.exit(1);
  }

  const { agentIndex, peerIndex } = wsHandle;

  // F1b: mesh_peer_up reads the LIVE index rather than a stored column —
  // `peers` has no `online` field, and after #87 a durable liveness claim that
  // outlives the process is exactly what must not exist.
  // #108, BOTH HALVES: mesh_peer_up must be emitted at 0 OR 1 for every
  // CONFIGURED peer, never only for connected ones. A series that appears only
  // once set cannot be alerted on — "no data" and "never configured" look
  // identical, and the alert you want is exactly "this peering went to 0".
  setPeerUpSource(() => {
    const out: { alias: string; up: boolean }[] = [];
    // Inbound: every peer that has registered, up iff a socket is held.
    for (const p of listPeers(db)) out.push({ alias: p.alias, up: peerIndex.has(p.alias) });
    // Outbound: every configured peering, up iff its forwarder is connected.
    for (const row of listOutboundPeers(db)) {
      out.push({ alias: row.alias, up: forwarders.get(row.alias)?.connected === true });
    }
    return out;
  });

  // F2b: the border. Registering the factory is what makes POST
  // /outbound-peers work at all — F2a refuses with 503 while `create` is
  // absent, which is what kept main inert between the two merges. This call
  // also starts one forwarder per ENABLED row, the boot path F2a had no owner
  // for.
  // Before the border: every forwarder startBorder starts re-checks its URL
  // against this list, so it must be the operator's list and not the default.
  applyPlaintextPeerCidrs(config.plaintextPeerCidrs);
  const border = startBorder(db, wsHandle.agentIndex, { ca: config.tlsCa });

  const httpHandle: HttpAdminHandle = await startHttpAdmin(config.adminPort, db, config.adminToken, config.maxFileBytes, config.filesDir, wsHandle.agentIndex, observerIndex, peerIndex, border, {
    metricsToken: config.metricsToken,
    adminTokenPrev: config.adminTokenPrev,
    ...(config.adminTlsPort === null ? {} : { tls: config.tls, tlsPort: config.adminTlsPort }),
  });

  // R-65: EVERY listener, in one line — including the ones that are 'off', so
  // a verifier can PROVE plaintext is closed rather than infer it from a line
  // that is missing. Built from the config that was actually applied.
  console.log(JSON.stringify({
    evt: 'mesh.listeners',
    listeners: [
      { name: 'ws', port: config.wsPort, scheme: config.wsPort === 'off' ? 'off' : (config.wsTlsPort === null && config.tls !== null ? 'wss' : 'ws') },
      ...(config.wsTlsPort === null ? [] : [{ name: 'ws_tls', port: config.wsTlsPort, scheme: 'wss' }]),
      { name: 'admin', port: config.adminPort, scheme: config.adminPort === 'off' ? 'off' : 'http' },
      ...(config.adminTlsPort === null ? [] : [{ name: 'admin_tls', port: config.adminTlsPort, scheme: 'https' }]),
    ],
    at: Date.now(),
  }));

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

  // adminToken passed so the ACL tools can gate on it (#8) — without it the
  // stdio plane would keep writing ACL edges with no credential while the
  // equivalent HTTP routes require one.
  const mcpHandle = await startMcpServer(db, agentIndex, observerIndex, config.adminToken, config.adminTokenPrev);
  const transport = new StdioServerTransport();
  await mcpHandle.server.connect(transport);

  cleanupHandle = startCleanup(db, agentIndex, config.cleanupIntervalMs, config.retentionMs, peerIndex);
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
