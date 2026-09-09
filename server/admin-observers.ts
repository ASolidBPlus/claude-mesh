/**
 * #143 — Admin routes for observers (`/observers`).
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import {
  getAgentById, grantObserver, listObservers, revokeObserver,
} from './db.ts';
import type { AdminCtx } from './admin-ctx.ts';
import { readBody } from './admin-ctx.ts';

export async function handleObserverPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db, agentIndex, observerIndex } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); }
  catch { res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'invalid JSON'})); return; }

  const agent_id = body.agent_id;
  if (typeof agent_id !== 'string' || !agent_id) {
    res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'agent_id is required'})); return;
  }
  if (getAgentById(db, agent_id) === null) {
    res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'agent not found'})); return;
  }
  const granted_by = typeof body.granted_by === 'string' ? body.granted_by : 'system';
  // F3: the wider scope must be asked for EXPLICITLY and with a boolean true.
  // Not truthiness — `"false"`, `0`, `"no"` and a stray `{}` all mean "did not
  // ask", and a grant that widens on a typo is the failure this scope exists to
  // stop. An absent field is a narrow grant, which is also what a pre-F3 client
  // sends, so old callers keep getting exactly what they got before.
  if (body.cross_border !== undefined && typeof body.cross_border !== 'boolean') {
    res.writeHead(400, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'cross_border must be a boolean'})); return;
  }
  const cross_border = body.cross_border === true;
  const row = grantObserver(db, agent_id, granted_by, cross_border);
  // Live-activate for a currently-connected socket (no reconnect needed).
  try { const ws = agentIndex.get(agent_id); if (ws !== undefined) observerIndex.set(agent_id, ws); } catch (_) { /* never 500 on live-index update */ }
  res.writeHead(201, {'Content-Type':'application/json'}); res.end(JSON.stringify(row));
}

export function handleObserverDelete(ctx: AdminCtx): void {
  const { res, db, observerIndex, params } = ctx;
  const id = params.id;
  const removed = revokeObserver(db, id);
  if (!removed) {
    res.writeHead(404, {'Content-Type':'application/json'}); res.end(JSON.stringify({error:'not an observer'})); return;
  }
  try { observerIndex.delete(id); } catch (_) { /* never 500 on live-index update */ }
  res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify({ok:true}));
}

export function handleObserverGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(listObservers(db)));
}

