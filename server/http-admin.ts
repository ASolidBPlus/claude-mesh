import { Database } from 'bun:sqlite';
import * as http from 'http';
import { WebSocket } from 'ws';
import { renderMetrics } from './metrics.ts';
import { handleAclDelete, handleAclGet, handleAclPost } from './admin-acl.ts';
import { handleAgentById, handleAgentDelete, handleAgentGet, handleAgentPatch, handleAgentPost } from './admin-agents.ts';
import type { ForwarderRegistry, Route } from './admin-ctx.ts';
import { exact, idMatch, requestSource, resolveRouteAuth } from './admin-ctx.ts';
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
  server: http.Server;
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
  { method: 'GET',    match: exact('/messages'),                     handler: handleMessagesGet, auth: 'agentOrAdmin' },
  { method: 'GET',    match: idMatch(/^\/files\/([^/]+)$/),          handler: handleFileById, auth: 'agentOrAdmin' },
  { method: 'POST',   match: exact('/files'),                        handler: handleFilePost },
  { method: 'POST',   match: exact('/reminders'),                    handler: handleReminderPost },
  { method: 'GET',    match: exact('/reminders'),                    handler: handleReminderGet },
  { method: 'PATCH',  match: idMatch(/^\/reminders\/([^/]+)$/),      handler: handleReminderPatch },
  { method: 'DELETE', match: idMatch(/^\/reminders\/([^/]+)$/),      handler: handleReminderDelete },
];

export function startHttpAdmin(
  port: number,
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
): Promise<HttpAdminHandle> {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // /metrics is unauthenticated by design — this listener binds to the admin port
      // which is internal-only (not exposed publicly). Read-only Prometheus exposition.
      if (req.method === 'GET' && new URL(req.url!, 'http://localhost').pathname === '/metrics') {
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

      const auth = resolveRouteAuth(req, res, db, adminToken, matched?.auth);
      if (auth === null) return; // 401 already written

      if (matched) {
        // A handler throw here used to become an unhandled rejection (async
        // createServer callback, no catch) and KILL THE PROCESS — the header
        // incident was one instance; any future handler bug is another. One
        // request fails loudly instead of the whole mesh dying quietly: log,
        // 500 if the head isn't out yet, sever the socket if it is.
        try {
          await matched.handler({ req, res, db, url, params, agentIndex, observerIndex, peerIndex, forwarders, maxFileBytes, filesDir, auth });
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
          if (method !== 'GET' && res.statusCode >= 200 && res.statusCode < 300) {
            console.log(JSON.stringify({
              evt: 'admin.mutation',
              method, path: pathname, status: res.statusCode,
              // Path parameters only — object ids by construction. No query
              // string and no body.
              params,
              actor: auth.mode,       // 'admin' | 'agent' | 'unauthenticated'
              ...requestSource(req),
              at: Date.now(),
            }));
          }
        } catch (err) {
          console.error(`[http-admin] handler crashed: ${method} ${pathname}:`, err);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'internal error' }));
          } else {
            res.destroy();
          }
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
    });

    server.on('error', reject);

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
    const onListening = () => {
      const addr = server.address();
      const bound = typeof addr === 'object' && addr !== null ? `${addr.address}:${addr.port}` : String(addr);
      // Names the bind AND what is unauthenticated on it. A deployer reading
      // 0.0.0.0 here is being told, at boot, that /metrics is reachable from
      // wherever that resolves to — which is the whole point of the line.
      console.log(JSON.stringify({
        evt: 'admin.listening',
        bind: bindHost ?? '(all interfaces)',
        bound,
        metrics_unauthenticated: true,
        note: bindHost === undefined
          ? 'admin port bound to ALL interfaces; /metrics is unauthenticated on it — set MESH_ADMIN_BIND to restrict, or accept this as the deployment decision'
          : '/metrics is unauthenticated on this bind',
        at: Date.now(),
      }));
      const handle: HttpAdminHandle = {
        server,
        shutdown(): Promise<void> {
          return new Promise((res, rej) => {
            server.close((err) => {
              if (err) rej(err);
              else res();
            });
          });
        },
      };
      resolve(handle);
    };
    // `host: undefined` is byte-identical to listen(port) — verified, both bind
    // `::` — so the default path is unchanged by construction rather than by
    // a branch that could drift from it.
    server.listen({ port, host: bindHost }, onListening);
  });
}
