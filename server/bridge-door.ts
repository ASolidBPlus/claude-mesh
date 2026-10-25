/**
 * R-393 — the mesh's declared-actions door, behind fleet-bridge.
 *
 * Four actions, served with fleet-bridge's declaration library
 * (vendor/fleet-bridge-declare, docs/declare.md there) on the admin listener at
 * `/actions/v1`. Every call carries the bridge's Ed25519 vouch for who is
 * calling (bridgeCallers, with the bridge's public keys pinned in config), and
 * that vouched caller is the only identity these actions act for:
 *
 *   token_issue {}           a new token for the CALLER's own agent id, returned
 *                            once. The old token stops working for new connects;
 *                            open sockets stay (unlike POST /agents/:id/rotate).
 *                            An unregistered caller is created.
 *   acl_list                 every edge, with granted_by.          (edge callers)
 *   acl_grant {from, to}     an edge, granted_by = the caller.      (edge callers)
 *   acl_revoke {from, to}    only an edge the caller granted.       (edge callers)
 *
 * OFF UNLESS CONFIGURED: with no MESH_BRIDGE_KEYS the server never builds this,
 * so the route doesn't exist (http-admin answers /actions/v1 like any unknown
 * admin path) and the boot line says `bridge_door: off`. The admin API,
 * registration and rotate are untouched; this is a second door with its own
 * credential, not a new way through the old one.
 */
import type { Database } from 'bun:sqlite';
import {
  bridgeCallers, checkVia, declareAction, memoryRepeats, refuse, serveActions, z, CALLER_RE,
  type Call, type Verdict,
} from './vendor/fleet-bridge-declare/index.ts';
import {
  RESERVED_ALIAS, aclGrant, agentIdRefusal, getAgentById, getLivePeerKeyForAlias, getPeerByAlias,
  registerAgent, rotateAgentToken,
} from './db.ts';
import { generateToken, hashToken } from './auth.ts';

/** The app's name in the declaration and in every vouch the bridge signs for it. */
export const BRIDGE_SYSTEM = 'mesh';

export interface BridgeDoorConfig {
  /** The bridge's pinned public keys (base64url Ed25519); any one verifying is enough. */
  keys: string[];
  /** The base URL this door is declared at: https, or http on 127.0.0.1. */
  url: string;
  /** Caller ids that may list, grant and revoke edges (fleet-access's service id). */
  edgeCallers: string[];
}

export type BridgeConfigParse = { ok: true; config: BridgeDoorConfig | null } | { ok: false; error: string };

/**
 * MESH_BRIDGE_KEYS (comma-separated), MESH_BRIDGE_URL, MESH_BRIDGE_EDGE_CALLERS
 * (comma-separated, may be empty). No keys = the door is off, and then the
 * other two must be unset too: half a configuration refuses to start rather
 * than leaving the operator believing a door is open that isn't.
 */
export function parseBridgeDoorConfig(env: Record<string, string | undefined>): BridgeConfigParse {
  const list = (raw: string | undefined) => (raw ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const keys = list(env.MESH_BRIDGE_KEYS);
  const url = env.MESH_BRIDGE_URL ?? '';
  const edgeCallers = list(env.MESH_BRIDGE_EDGE_CALLERS);
  if (keys.length === 0) {
    if (url !== '' || edgeCallers.length > 0) {
      return { ok: false, error: 'MESH_BRIDGE_URL / MESH_BRIDGE_EDGE_CALLERS are set but MESH_BRIDGE_KEYS is not; set the bridge key(s) or unset both' };
    }
    return { ok: true, config: null };
  }
  if (url === '') return { ok: false, error: 'MESH_BRIDGE_KEYS is set but MESH_BRIDGE_URL is not (the URL this door is declared at)' };
  try {
    checkVia({ http: { url } }, 'MESH_BRIDGE_URL');
    bridgeCallers(keys);
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
  for (const c of edgeCallers) {
    if (!CALLER_RE.test(c)) return { ok: false, error: `MESH_BRIDGE_EDGE_CALLERS: "${c}" is not a caller id (${CALLER_RE})` };
  }
  return { ok: true, config: { keys, url, edgeCallers } };
}

const log = (fields: Record<string, unknown>) => console.log(JSON.stringify({ evt: 'bridge.action', ...fields, at: Date.now() }));

/** The door's fetch handler. Throws at startup on a bad setup (the library's rule). */
export function bridgeDoor(db: Database, config: BridgeDoorConfig, opts: { bootMs?: number; now?: () => number } = {}): (req: Request) => Promise<Response> {
  const edgeCallers = new Set(config.edgeCallers);
  const edge = z.object({ from: z.string().min(1).max(256), to: z.string().min(1).max(256) }).strict();

  const tokenIssue = declareAction(
    'token_issue',
    {
      description: 'Issue a new mesh token for the calling agent itself; returned once.',
      input: z.object({}).strict(),
      output: z.object({ agent_id: z.string(), token: z.string(), created: z.boolean() }).strict(),
    },
    // Nothing in the input names an agent: the id is the vouched caller, so
    // this can never issue for anyone else.
    (_input, call) => {
      const id = call.caller;
      const refusal = agentIdRefusal(id);
      if (refusal !== null || id.includes('+') || id.includes(':')) {
        log({ action: 'token_issue', caller: id, outcome: 'ID_INVALID' });
        return refuse('ID_INVALID', 'the caller id is not a mesh agent id', 400);
      }
      const token = generateToken();
      if (getAgentById(db, id) !== null) {
        rotateAgentToken(db, id, hashToken(token));
        log({ action: 'token_issue', caller: id, outcome: 'issued', created: false });
        return { agent_id: id, token, created: false };
      }
      // Registration's rules for a NEW id (handleAgentPost): not the reserved
      // alias, and not the alias of a peer that exists or has a live key.
      if (id === RESERVED_ALIAS || getPeerByAlias(db, id) !== null || getLivePeerKeyForAlias(db, id, Date.now()) !== null) {
        log({ action: 'token_issue', caller: id, outcome: 'ID_UNAVAILABLE' });
        return refuse('ID_UNAVAILABLE', 'that id is reserved or taken by a peer', 409);
      }
      registerAgent(db, { id, token_hash: hashToken(token), hostname: 'bridge' });
      log({ action: 'token_issue', caller: id, outcome: 'issued', created: true });
      return { agent_id: id, token, created: true };
    },
  );

  const aclList = declareAction(
    'acl_list',
    {
      description: 'Every ACL edge on the mesh, with who granted it.',
      input: z.object({}).strict(),
      output: z.object({ edges: z.array(z.object({ from: z.string(), to: z.string(), granted_by: z.string(), granted_at: z.number() }).strict()) }).strict(),
      readOnly: true,
    },
    (_input, call) => {
      const rows = db.prepare('SELECT from_agent, to_agent, granted_by, granted_at FROM acl ORDER BY from_agent, to_agent').all() as
        { from_agent: string; to_agent: string; granted_by: string; granted_at: number }[];
      log({ action: 'acl_list', caller: call.caller, outcome: 'ok', edges: rows.length });
      return { edges: rows.map((r) => ({ from: r.from_agent, to: r.to_agent, granted_by: r.granted_by, granted_at: r.granted_at })) };
    },
  );

  const aclGrantAction = declareAction(
    'acl_grant',
    {
      description: 'Grant an ACL edge from one endpoint to another, recorded as granted by the caller.',
      input: edge,
      output: z.object({ from: z.string(), to: z.string(), granted_by: z.string(), created: z.boolean() }).strict(),
    },
    ({ from, to }, call) => {
      const existing = db.prepare('SELECT granted_by FROM acl WHERE from_agent = ? AND to_agent = ?').get(from, to) as { granted_by: string } | null;
      // An edge that already exists keeps whoever granted it. Re-recording it as
      // the caller's would let the caller then revoke an edge it never granted.
      if (existing !== null) {
        log({ action: 'acl_grant', caller: call.caller, outcome: 'exists', from, to });
        return { from, to, granted_by: existing.granted_by, created: false };
      }
      try {
        aclGrant(db, from, to, call.caller);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'AGENT_NOT_FOUND' || code === 'NO_PEERING') {
          log({ action: 'acl_grant', caller: call.caller, outcome: 'ENDPOINT_UNKNOWN', from, to });
          return refuse('ENDPOINT_UNKNOWN', 'an endpoint is not on this mesh yet; retry later', 409);
        }
        throw err;
      }
      log({ action: 'acl_grant', caller: call.caller, outcome: 'granted', from, to });
      return { from, to, granted_by: call.caller, created: true };
    },
  );

  const aclRevokeAction = declareAction(
    'acl_revoke',
    {
      description: 'Revoke an ACL edge, only one the caller itself granted.',
      input: edge,
      output: z.object({ from: z.string(), to: z.string(), revoked: z.literal(true) }).strict(),
    },
    ({ from, to }, call) => {
      // The ownership check and the delete are one statement, so nothing can
      // change the edge between them.
      const removed = db.prepare('DELETE FROM acl WHERE from_agent = ? AND to_agent = ? AND granted_by = ?').run(from, to, call.caller).changes;
      if (removed === 0) {
        log({ action: 'acl_revoke', caller: call.caller, outcome: 'NOT_GRANTED_BY_CALLER', from, to });
        return refuse('NOT_GRANTED_BY_CALLER', 'no such edge granted by this caller; the edge, if any, stays', 409);
      }
      log({ action: 'acl_revoke', caller: call.caller, outcome: 'revoked', from, to });
      return { from, to, revoked: true as const };
    },
  );

  // token_issue is the caller's own; the edge actions are the sync's alone.
  const may = (call: Call): Verdict => (call.action === 'token_issue' ? 'allow' : edgeCallers.has(call.caller) ? 'allow' : 'deny');

  return serveActions(
    {
      system: BRIDGE_SYSTEM,
      via: { http: { url: config.url } },
      callers: bridgeCallers(config.keys, opts.bootMs === undefined ? {} : { bootMs: opts.bootMs }),
      may,
      // A repeated call with the same id gets the first answer back, which for
      // token_issue includes the token: kept for minutes, not the default day.
      repeats: memoryRepeats({ ttlMs: 10 * 60_000, ...(opts.now === undefined ? {} : { now: opts.now }) }),
      ...(opts.now === undefined ? {} : { now: opts.now }),
      // The library's own refusal lines (who, access, input): never a body,
      // so never a token.
      log: (line) => console.log(JSON.stringify({ evt: 'bridge.refused', line, at: Date.now() })),
    },
    [tokenIssue, aclList, aclGrantAction, aclRevokeAction],
  );
}
