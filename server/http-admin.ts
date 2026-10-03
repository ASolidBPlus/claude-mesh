import { Database } from 'bun:sqlite';
import * as http from 'http';
import { WebSocket } from 'ws';
import { renderMetrics } from './metrics.ts';
import { timingSafeEqual, adminTokenMatches } from './auth.ts';
import * as https from 'https';
import type { ServerTls } from './tls-config.ts';
import { handleAclDelete, handleAclGet, handleAclPost } from './admin-acl.ts';
import { handleAgentById, handleAgentDelete, handleAgentGet, handleAgentPatch, handleAgentPost, handleAgentTlsLatchDelete, handleAgentRotate, handleConnectionsGet } from './admin-agents.ts';
import type { AdminCtx, ForwarderRegistry, Route } from './admin-ctx.ts';
import { exact, idMatch, requestSource, resolveRouteAuth, routeLabel } from './admin-ctx.ts';
import { recordCaller } from './connections.ts';
import { recordAgentConnection } from './db.ts';
import { handleFileById, handleFilePost } from './admin-files.ts';
import { handleMessagesGet } from './admin-messages.ts';
import { handleObserverDelete, handleObserverGet, handleObserverPost } from './admin-observers.ts';
import { handleOutboundPeerDelete, handleOutboundPeerGet, handleOutboundPeerPatch, handleOutboundPeerPost } from './admin-outbound.ts';
import { handlePeerGet, handlePeerKeyDelete, handlePeerKeyGet, handlePeerKeyPost, handlePeerRegister, handlePeerSubscriptionsGet } from './admin-peers.ts';
import { handleReminderDelete, handleReminderGet, handleReminderPatch, handleReminderPost } from './admin-reminders.ts';
import { handleTopicGet, handleTopicPost } from './admin-topics.ts';
export { resolveRouteAuth, type AdminCtx, type Route, type ForwarderRegistry, type AuthResult } from './admin-ctx.ts';
export { contentDispositionFor, fileAccessAuthorized } from './admin-files.ts';
// #70/#143: `safeContentType` and its grammar live in file-hygiene.ts, and this
// path is the one existing importers name — the definition has moved twice now
// and the SURFACE has not moved once.
export { safeContentType, SAFE_CONTENT_TYPE } from './file-hygiene.ts';
export { validateOutboundPeerUrl } from './admin-outbound.ts';

// #143 — THE ROUTE TABLE AND THE SERVER, and nothing else.
//
// Every handler used to live here: 2,300 lines and 100 KB of admin routes, peer
// and outbound handlers, file transfer, reminders, and the C9 commentary that
// explains each. It was readable — the reasoning is at the sites — and it was
// the size where a reader looking for one route reads past nine others.
//
// The handlers now sit in `admin-<concern>.ts` beside this file, one per URL
// family, and this file keeps what only it can hold: the ROUTES table that
// orders them, `startHttpAdmin`, and the dispatcher whose single site records
// `admin.mutation` (#161). A mechanical move: no behaviour change, and no
// comment dropped — each one travelled with the code it explains.
//
// FLAT FILES, NOT A DIRECTORY, and that is measured rather than stylistic.
// `border.test.ts`'s #131 walker and its population control both say in
// comments that server/ being FLAT is why their recursion is dead code today,
// and that "the first real directory under server/" is what wakes it. A
// subdirectory would turn a mechanical tidy into a behaviour change in the test
// infrastructure.
//
// The public surface is unchanged: everything other modules and tests imported
// from `http-admin.ts` is still exported from `http-admin.ts`, re-exported
// below where the definition moved.

export interface HttpAdminHandle {
  /** The first listener: the plaintext one when there is one, else the TLS one. */
  server: http.Server;
  /** R-65: every listener this handle owns, by name. */
  servers: { name: 'admin' | 'admin_tls'; scheme: 'http' | 'https'; server: http.Server }[];
  shutdown(): Promise<void>;
}

export const ROUTES: Route[] = [
  { method: 'POST',   match: exact('/outbound-peers'),               handler: handleOutboundPeerPost },
  { method: 'GET',    match: exact('/outbound-peers'),               handler: handleOutboundPeerGet },
  { method: 'DELETE', match: idMatch(/^\/outbound-peers\/([^/]+)$/), handler: handleOutboundPeerDelete },
  { method: 'PATCH',  match: idMatch(/^\/outbound-peers\/([^/]+)$/), handler: handleOutboundPeerPatch },
  { method: 'POST',   match: exact('/peer-keys'),                    handler: handlePeerKeyPost },
  { method: 'GET',    match: exact('/peer-keys'),                    handler: handlePeerKeyGet },
  { method: 'DELETE', match: idMatch(/^\/peer-keys\/([^/]+)$/),      handler: handlePeerKeyDelete },
  // #153: the inbound listing. `exact`, so it cannot swallow /peers/register —
  // and that route is POST regardless, so the two never contend.
  { method: 'GET',    match: exact('/peers'),                        handler: handlePeerGet },
  // F4: after exact('/peers'), which cannot swallow it — an exact matcher and
  // a two-segment pattern can never contend.
  { method: 'GET',    match: idMatch(/^\/peers\/([^/]+)\/subscriptions$/), handler: handlePeerSubscriptionsGet },
  // The ONLY handler-authenticated route: a peer presents a key, which is
  // neither the admin token nor an agent token.
  { method: 'POST',   match: exact('/peers/register'),               handler: handlePeerRegister, auth: 'handler' },
  { method: 'POST',   match: exact('/acl'),                          handler: handleAclPost },
  { method: 'DELETE', match: exact('/acl'),                          handler: handleAclDelete },
  { method: 'GET',    match: exact('/acl'),                          handler: handleAclGet },
  { method: 'POST',   match: exact('/observers'),                    handler: handleObserverPost },
  { method: 'DELETE', match: idMatch(/^\/observers\/([^/]+)$/),      handler: handleObserverDelete },
  { method: 'GET',    match: exact('/observers'),                    handler: handleObserverGet },
  { method: 'POST',   match: exact('/topics'),                       handler: handleTopicPost },
  { method: 'GET',    match: exact('/topics'),                       handler: handleTopicGet },
  { method: 'POST',   match: exact('/agents'),                       handler: handleAgentPost },
  { method: 'GET',    match: exact('/agents'),                       handler: handleAgentGet },
  { method: 'GET',    match: idMatch(/^\/agents\/([^/]+)$/),         handler: handleAgentById },
  { method: 'PATCH',  match: idMatch(/^\/agents\/([^/]+)$/),         handler: handleAgentPatch },
  { method: 'DELETE', match: idMatch(/^\/agents\/([^/]+)$/),         handler: handleAgentDelete },
  // R-65: clears the TLS latch. Two segments, so it cannot contend with the
  // one-segment DELETE above.
  { method: 'DELETE', match: idMatch(/^\/agents\/([^/]+)\/tls-latch$/), handler: handleAgentTlsLatchDelete },
  // R-65 M5: a new token for the id; every socket held under the old one closes.
  { method: 'POST',   match: idMatch(/^\/agents\/([^/]+)\/rotate$/), handler: handleAgentRotate },
  // R-65 M6: who connects, by what scheme — the gate for closing plaintext.
  { method: 'GET',    match: exact('/connections'),                  handler: handleConnectionsGet },
  { method: 'GET',    match: exact('/messages'),                     handler: handleMessagesGet, auth: 'agentOrAdmin' },
  { method: 'GET',    match: idMatch(/^\/files\/([^/]+)$/),          handler: handleFileById, auth: 'agentOrAdmin' },
  { method: 'POST',   match: exact('/files'),                        handler: handleFilePost },
  { method: 'POST',   match: exact('/reminders'),                    handler: handleReminderPost },
  { method: 'GET',    match: exact('/reminders'),                    handler: handleReminderGet },
  { method: 'PATCH',  match: idMatch(/^\/reminders\/([^/]+)$/),      handler: handleReminderPatch },
  { method: 'DELETE', match: idMatch(/^\/reminders\/([^/]+)$/),      handler: handleReminderDelete },
];

/** Bearer credential for /metrics: the metrics token or the admin token. */
function metricsAuthorized(req: http.IncomingMessage, metricsToken: string, adminToken: string, adminTokenPrev: string | null): 'metrics' | 'admin' | null {
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) return null;
  const presented = auth.slice('Bearer '.length);
  const viaMetrics = timingSafeEqual(presented, metricsToken);
  const viaAdmin = adminTokenMatches(presented, adminToken, adminTokenPrev);
  return viaMetrics ? 'metrics' : viaAdmin ? 'admin' : null;
}

/**
 * Run one matched route: the handler, the crash guard, and the #161 mutation
 * record. Extracted so the WS listener's door for /peers/register runs the
 * SAME wrapper as this one — the handler alone is not the behaviour; the guard
 * that keeps a throw from killing the process and the audit line are part of
 * it, and a second door without them would be a second, weaker rule.
 */
export async function serveRoute(route: Route, ctx: AdminCtx, listener: 'admin' | 'ws'): Promise<void> {
  const { req, res } = ctx;
  // A handler throw here used to become an unhandled rejection (async
  // createServer callback, no catch) and KILL THE PROCESS — the header
  // incident was one instance; any future handler bug is another. One
  // request fails loudly instead of the whole mesh dying quietly: log,
  // 500 if the head isn't out yet, sever the socket if it is.
  try {
    await route.handler(ctx);
    // #161 — EVERY privileged mutation leaves a record, DERIVED rather
    // than enumerated. 23 of 28 routes emitted nothing, and the fix for
    // that cannot be a hand-maintained list of mutators: the next route
    // added is exactly the one whose entry nobody remembers. This asks
    // the route table instead — a non-GET that succeeded changed
    // something — so a route added tomorrow is covered by existing code.
    //
    // The detail events (peer_key.minted, acl.granted, …) stay: this one
    // says THAT a mutation happened and names the object in the path;
    // those say WHAT changed, from inside the handler where the object is
    // known. Neither reads the request body, which is where credentials
    // arrive.
    if (req.method !== 'GET' && res.statusCode >= 200 && res.statusCode < 300) {
      console.log(JSON.stringify({
        evt: 'admin.mutation',
        method: req.method, path: ctx.url.pathname, status: res.statusCode,
        // Path parameters only — object ids by construction. No query
        // string and no body.
        params: ctx.params,
        actor: ctx.auth.mode,       // 'admin' | 'agent' | 'unauthenticated'
        ...requestSource(req),
        // Which door: registration is served on the WS listener too.
        listener,
        at: Date.now(),
      }));
    }
  } catch (err) {
    console.error(`[http-admin] handler crashed: ${req.method} ${ctx.url.pathname}:`, err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal error' }));
    } else {
      res.destroy();
    }
  }
}

/**
 * The one admin route that also faces peers, as the SAME object the table
 * holds: a peer presents a key that is neither the admin token nor an agent
 * token, so it must be reachable from the port peers can reach (the WS
 * listener) and not only from the admin port. Looked up rather than
 * re-declared, so there is one route and two doors.
 */
export const PEER_REGISTER_ROUTE: Route = ROUTES.find(r => r.handler === handlePeerRegister)!;

export function startHttpAdmin(
  port: number | 'off',
  db: Database,
  adminToken: string,
  maxFileBytes: number = 10_485_760,
  filesDir: string = '/data/files',
  agentIndex: Map<string, WebSocket> = new Map(),
  observerIndex: Map<string, WebSocket> = new Map(),   // NEW — defaulted
  // F1a: alias -> peer socket, so revocation can close the connection NOW
  // rather than waiting for the sweep. Defaulted, so every existing caller and
  // test is unchanged.
  peerIndex: Map<string, WebSocket> = new Map(),
  // F2a: parameter 8, following agentIndex (6) and observerIndex (7) — the
  // same positional convention. Defaulted to an EMPTY registry, so every
  // existing caller and test is unchanged AND gets the inert front half.
  forwarders: ForwarderRegistry = {},
  // R-18: MESH_METRICS_TOKEN, parsed and validated by loadConfig. null (the
  // default) = /metrics unauthenticated, exactly as before.
  //
  // R-65: `tls` + `tlsPort` add a TLS listener BESIDE the plaintext one (M2),
  // with the same handler, so every route — /messages and /files/:id
  // included — is served on both. Absent = one plaintext listener, as before.
  // `adminTokenPrev` (M7) is accepted wherever the admin token is.
  opts: {
    metricsToken?: string | null;
    tls?: ServerTls | null;
    tlsPort?: number;
    adminTokenPrev?: string | null;
    /** R-65 M6: every listener the bus runs (server.ts builds it), for GET /connections. */
    listeners?: { name: string; port: number | 'off'; scheme: string }[];
  } = {},
): Promise<HttpAdminHandle> {
  const metricsToken = opts.metricsToken ?? null;
  const adminTokenPrev = opts.adminTokenPrev ?? null;
  return new Promise((resolve, reject) => {
    const sideBySide = opts.tlsPort !== undefined;
    if (sideBySide && (opts.tls ?? null) === null) {
      reject(new Error('a TLS admin listener needs MESH_TLS_CERT and MESH_TLS_KEY'));
      return;
    }
    if (!sideBySide && port === 'off') {
      reject(new Error("the admin port can be 'off' only beside a TLS listener"));
      return;
    }
    // `tls` is fixed per LISTENER, never read from the request: it is which
    // door the request came through.
    const handleRequest = async (req: http.IncomingMessage, res: http.ServerResponse, tls: boolean): Promise<void> => {
      // /metrics is unauthenticated by design — this listener binds to the admin port
      // which is internal-only (not exposed publicly). Read-only Prometheus exposition.
      if (req.method === 'GET' && new URL(req.url!, 'http://localhost').pathname === '/metrics') {
        // With a metrics token configured, /metrics takes it OR the admin
        // token, each compared in constant time — and BOTH comparisons always
        // run, so the timing does not say which one matched. The refusal is
        // byte-identical to every other admin 401. Nothing about the
        // presented credential is logged.
        const scheme = tls ? 'https' : 'http';
        const srcIp = req.socket.remoteAddress ?? null;
        if (metricsToken !== null) {
          const via = metricsAuthorized(req, metricsToken, adminToken, adminTokenPrev);
          if (via === null) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'unauthorized' }));
            return;
          }
          // R-65 M4/M6: a token-authenticated scrape is logged and recorded
          // like any other token-authenticated request.
          console.log(JSON.stringify({ evt: 'agent.http', agent_id: via, route: 'GET /metrics', src_ip: srcIp, tls, at: Date.now() }));
          recordCaller(srcIp ?? undefined, via, scheme);
        } else {
          // Unauthenticated scrape: no credential to log, but still a caller —
          // the one most likely to still be on plaintext.
          recordCaller(srcIp ?? undefined, 'metrics', scheme);
        }
        try {
          const body = renderMetrics(db);
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
          res.end(body);
        } catch (_) {
          res.writeHead(500); res.end();
        }
        return;
      }
      const url = new URL(req.url!, 'http://localhost');
      const pathname = url.pathname;
      const method = req.method;

      // Find the matched route first, then apply its auth. This preserves the
      // original ordering: unmatched paths (and admin routes) go through
      // requireAdmin, so an unauthenticated request to an unknown path still
      // gets 401 (not 404). Only 'agentOrAdmin' routes accept an agent token.
      let matched: Route | undefined;
      let params: Record<string, string> = {};
      for (const route of ROUTES) {
        if (route.method !== method) continue;
        const p = route.match(pathname);
        if (p === null) continue;
        matched = route;
        params = p;
        break;
      }

      const auth = resolveRouteAuth(req, res, db, adminToken, matched?.auth, { adminTokenPrev, tls });
      if (auth === null) return; // 401 already written

      // R-65 M4 + M6: every TOKEN-authenticated request — admin or agent — is
      // logged with the route PATTERN (never the raw URL: no ids, no query
      // string), the socket's address and the listener's scheme, and recorded
      // in the connection report. `handler`-authenticated routes carry no
      // token the dispatcher checked, so they are not "token-authenticated".
      if (auth.mode !== 'unauthenticated') {
        const scheme = tls ? 'https' : 'http';
        const srcIp = req.socket.remoteAddress ?? null;
        console.log(JSON.stringify({
          evt: 'agent.http', agent_id: auth.mode === 'admin' ? 'admin' : auth.agentId,
          route: routeLabel(method, matched), src_ip: srcIp, tls, at: Date.now(),
        }));
        try {
          if (auth.mode === 'agent') recordAgentConnection(db, auth.agentId, scheme, srcIp);
          else recordCaller(srcIp ?? undefined, 'admin', scheme);
        } catch (_) { /* the report never breaks a request */ }
      }

      if (matched) {
        await serveRoute(matched, { req, res, db, url, params, agentIndex, observerIndex, peerIndex, forwarders, maxFileBytes, filesDir, auth, listeners: opts.listeners ?? [] }, 'admin');
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    };

    const specs: { name: 'admin' | 'admin_tls'; port: number; scheme: 'http' | 'https' }[] = sideBySide
      ? [
        ...(port === 'off' ? [] : [{ name: 'admin' as const, port, scheme: 'http' as const }]),
        { name: 'admin_tls' as const, port: opts.tlsPort!, scheme: 'https' as const },
      ]
      : [{ name: 'admin' as const, port: port as number, scheme: 'http' as const }];
    const servers = specs.map(spec => ({
      ...spec,
      server: spec.scheme === 'https'
        ? https.createServer({ cert: opts.tls!.cert, key: opts.tls!.key }, (req, res) => { void handleRequest(req, res, true); })
        : http.createServer((req, res) => { void handleRequest(req, res, false); }),
    }));
    for (const { server } of servers) server.on('error', reject);

    // #127: MESH_ADMIN_BIND — the bind address for the ADMIN listener.
    //
    // Default is UNCHANGED: absent means listen(port) with no host, i.e. every
    // interface, exactly as before. NOT a loopback default, deliberately —
    // inside the container the spawner stack reaches this port over the Docker
    // network, so a loopback default would make the mesh unreachable in
    // production. This is a knob and a disclosure, not a new restriction.
    //
    // WHAT IT IS FOR. C9 exempts /metrics' per-cause counters on the premise
    // that the admin port is internal-only. Until now the process did the
    // OPPOSITE of what that premise needs — bound everything — and nothing in
    // the system knew whether the network controls making it true were present.
    // That made the premise an ASSUMPTION: checkable by nobody. With a bind
    // address and a boot log naming it, it becomes CONFIGURATION: checkable by
    // the deployer, at boot. C9 does not need the premise true everywhere; it
    // needs it falsifiable somewhere.
    const bindHost = process.env.MESH_ADMIN_BIND;
    const logListening = (spec: typeof servers[number]): void => {
      const addr = spec.server.address();
      const bound = typeof addr === 'object' && addr !== null ? `${addr.address}:${addr.port}` : String(addr);
      // Names the bind AND what is unauthenticated on it. A deployer reading
      // 0.0.0.0 here is being told, at boot, that /metrics is reachable from
      // wherever that resolves to — which is the whole point of the line.
      console.log(JSON.stringify({
        evt: 'admin.listening',
        // R-65: named only when there is more than one door, so the single-
        // listener line keeps the shape existing readers parse.
        ...(sideBySide ? { listener: spec.name, tls: spec.scheme === 'https' } : {}),
        bind: bindHost ?? '(all interfaces)',
        bound,
        // R-18: which mode /metrics is in, stated in both. The old flag stays
        // in the unauthenticated case, where it is still true and existing
        // readers look for it.
        metrics_auth: metricsToken === null ? 'none' : 'token',
        ...(metricsToken === null ? { metrics_unauthenticated: true } : {}),
        // R-65 M7: whether a previous admin token is ALSO accepted. A boolean
        // only — never the value, never its length.
        admin_token_prev: adminTokenPrev !== null,
        note: metricsToken !== null
          ? (bindHost === undefined
            ? 'admin port bound to ALL interfaces; /metrics requires MESH_METRICS_TOKEN or the admin token'
            : '/metrics requires MESH_METRICS_TOKEN or the admin token on this bind')
          : bindHost === undefined
            ? 'admin port bound to ALL interfaces; /metrics is unauthenticated on it — set MESH_METRICS_TOKEN to require a token, MESH_ADMIN_BIND to restrict, or accept this as the deployment decision'
            : '/metrics is unauthenticated on this bind — set MESH_METRICS_TOKEN to require a token',
        at: Date.now(),
      }));
    };
    // `host: undefined` is byte-identical to listen(port) — verified, both bind
    // `::` — so the default path is unchanged by construction rather than by
    // a branch that could drift from it.
    Promise.all(servers.map(spec => new Promise<void>((res) => {
      spec.server.listen({ port: spec.port, host: bindHost }, () => res());
    }))).then(() => {
      for (const spec of servers) logListening(spec);
      const handle: HttpAdminHandle = {
        server: servers[0]!.server,
        servers: servers.map(({ name, scheme, server }) => ({ name, scheme, server })),
        shutdown(): Promise<void> {
          return Promise.all(servers.map(({ server }) => new Promise<void>((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          }))).then(() => undefined);
        },
      };
      resolve(handle);
    });
  });
}
