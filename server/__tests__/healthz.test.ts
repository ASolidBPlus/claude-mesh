import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { openDb, registerAgent } from '../db.ts';
import { startWsServer } from '../ws-server.ts';
import WebSocket from 'ws';

// #22 — unauthenticated liveness for orchestrators.
//
// ON THE WS LISTENER, NOT THE ADMIN PORT, and that is the design decision worth
// testing rather than assuming. #127 exists so an operator CAN restrict the
// admin port; a liveness endpoint that vanishes when someone takes that option
// would report the bus dead exactly when it was hardened.
describe('#22 GET /healthz', () => {
  let db: Database;
  let handle: Awaited<ReturnType<typeof startWsServer>>;
  let port: number;

  beforeEach(async () => {
    db = openDb(':memory:');
    handle = await startWsServer(0, db, 10_485_760, mkdtempSync(join(tmpdir(), 'mesh-22-')));
    port = (handle.wss.address() as { port: number }).port;
  });
  afterEach(async () => { await handle.shutdown().catch(() => {}); db?.close(); });

  it('200s with db_ok, unauthenticated', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json() as { db_ok: boolean };
    expect(body.db_ok).toBe(true);
  });

  // NOTHING THAT VARIES PER PROCESS may appear here. An earlier version
  // returned uptime_ms — a restart fingerprint, readable by any peer that can
  // reach this port, with no reachability argument to justify it on an endpoint
  // that is unauthenticated by design. This pins the SHAPE, not just the
  // absence of that one field, so the next convenience addition has to be a
  // decision rather than a habit.
  it('returns db_ok and nothing else', async () => {
    const body = await (await fetch(`http://127.0.0.1:${port}/healthz`)).json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['db_ok']);
  });

  it('sends NO credentials — the point is that an orchestrator has none', async () => {
    // No Authorization header, no token, no agent identity. If this ever needs
    // one, an orchestrator cannot probe it and the endpoint has no purpose.
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { headers: {} });
    expect(res.status).toBe(200);
  });


  // db_ok must be a REAL answer, not a constant. Closing the database is the
  // failure this endpoint exists to catch: process up, store gone. Without
  // this, `db_ok: true` hard-coded would pass every other test here.
  it('db_ok reports FALSE when the store is unusable', async () => {
    db.close();
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);                       // still answers — it is liveness, not readiness
    const body = await res.json() as { db_ok: boolean };
    expect(body.db_ok).toBe(false);
    db = openDb(':memory:');                            // so afterEach's close is safe
  });

  it('an unknown path 404s rather than hanging', async () => {
    // Before #22 this listener had no request handler at all, so a plain GET
    // hung until the caller timed out. A 404 is the smallest honest answer.
    const res = await fetch(`http://127.0.0.1:${port}/nope`, { signal: AbortSignal.timeout(3000) });
    expect(res.status).toBe(404);
  });

  // CONTROL: the endpoint must not have broken the thing this port exists for.
  //
  // WHAT THIS CAN AND CANNOT CATCH, measured rather than assumed. I could NOT
  // construct a request-handler mutant that defeats it: Node dispatches
  // upgrades on the 'upgrade' event, not through the request handler, so even
  // `req.socket.destroy()` on every request reds all five HTTP tests here and
  // leaves this one green. The request handler cannot eat the upgrade.
  //
  // It is kept anyway, and its real subject is the CONSTRUCTION — the
  // httpServer/WebSocketServer pairing. A change there (noServer, a different
  // server instance, an upgrade listener added elsewhere) does break it, and
  // every other test in this file would still pass. Stated so nobody reads it
  // as guarding the handler.
  it('CONTROL: the WebSocket upgrade still works on the same port', async () => {
    registerAgent(db, { id: 'a-one', token_hash: 'a'.repeat(64), hostname: 'h' });
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const opened = await new Promise<boolean>((resolve) => {
      ws.once('open', () => resolve(true));
      ws.once('error', () => resolve(false));
      setTimeout(() => resolve(false), 3000);
    });
    ws.close();
    expect(opened).toBe(true);
  });
});
