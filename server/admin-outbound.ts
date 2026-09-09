/**
 * #143 — Outbound peerings (`/outbound-peers`) — F2a §4, §5.3, §5.6, §6.
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import {
  OutboundPeer, PEER_ALIAS_RE, RESERVED_ALIAS, endOutboundPeering, getOutboundPeer, insertOutboundPeer, listOutboundPeers, updateOutboundPeer,
} from './db.ts';
import type { AdminCtx } from './admin-ctx.ts';
import { readBody } from './admin-ctx.ts';

/**
 * (d)+(g) THE OUTBOUND URL RULE — ONE predicate, both doors.
 *
 * POST and PATCH validated the URL with two COPIES of the same regex and
 * nothing bound them. The likely future edit is a TIGHTENING, and a tightening
 * that lands on one door leaves the other as the bypass — and the other is
 * PATCH, the rotation path, which is exactly where an attacker who can already
 * reach the admin API would look. Two copies of a security predicate is one
 * predicate and one hole waiting to be opened.
 *
 * The rule: `wss://` anywhere; `ws://` ONLY for loopback. Plaintext to a remote
 * host would put `outbound_peers.token` — a live credential (C7) — on the wire
 * in cleartext on every reconnect, and the peer protocol has no other
 * authentication to fall back on.
 *
 * Certificate verification is never disabled: the SDK uses `ws`'s default
 * (rejectUnauthorized: true), and a source-scan test pins that
 * `rejectUnauthorized` appears nowhere in client/ or border.ts — because the
 * usual way this rule dies is one `{ rejectUnauthorized: false }` added to make
 * a staging box work.
 */
export const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function validateOutboundPeerUrl(raw: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof raw !== 'string' || raw.length === 0) {
    return { ok: false, error: 'url must be ws:// or wss://' };
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch {
    return { ok: false, error: 'url must be ws:// or wss://' };
  }
  if (parsed.protocol === 'wss:') return { ok: true };
  if (parsed.protocol !== 'ws:') {
    return { ok: false, error: 'url must be ws:// or wss://' };
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    return { ok: false, error: 'ws:// is permitted only for loopback; use wss://' };
  }
  return { ok: true };
}

/** Public shape of an outbound peering. NEVER includes `token` (C7): it is a
 *  live credential, and a read API that returned it would put it in every
 *  operator's shell history and every log of this endpoint. */
export function publicOutboundFields(row: OutboundPeer) {
  return {
    alias: row.alias,
    url: row.url,
    assigned_alias: row.assigned_alias,
    kinds: JSON.parse(row.kinds) as string[],
    rate_per_min: row.rate_per_min,
    enabled: row.enabled === 1,
    created_at: row.created_at,
    // NO last_responded here. This serialises an OutboundPeer — a PEERING —
    // and its last_alive is the peering's liveness, a different subject from an
    // agent's. #133 exists because one entity's liveness was read as another's;
    // adding a loop-liveness field to a peering row would be the same
    // conflation, committed while fixing it. (It was: an edit matching
    // `last_alive` by name landed here first.)
    last_alive: row.last_alive,
  };
}

export async function handleOutboundPeerPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db, forwarders } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' })); return;
  }

  // THE JOIN IN TIME. Between F2a and F2b merging, main would be a complete
  // front half with no back half: a peering could be created, sends to it
  // accepted and ACKED (D8), and the rows would sit forever because nothing
  // drains them — the exact state endOutboundPeering exists to prevent, reached
  // through a scheduling door rather than a code one.
  //
  // So the front half REFUSES until a forwarder factory is registered. F2b
  // registers the real one. A refusal holds regardless of merge order; a
  // process rule holds only while someone remembers it.
  if (forwarders.create === undefined) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no forwarder available' })); return;
  }

  const alias = body.alias;
  if (typeof alias !== 'string' || !PEER_ALIAS_RE.test(alias)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'alias must match ^[a-z0-9][a-z0-9-]{0,62}$' })); return;
  }
  // F4: `topic` joins `mesh` as a reserved alias, at BOTH doors — either one
  // alone leaves the other as the way in. A peering called `topic` would make
  // every LOCAL topic principal (`topic:trollbox`) read as a remote id, and
  // revocation's prefix-range `deletePeeringEdges('topic', …)` would delete
  // every topic grant on the mesh.
  if (alias === RESERVED_ALIAS || alias === 'topic') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `alias '${alias}' is reserved` })); return;
  }

  // An outbound alias must not PREFIX a legacy local id. `assertPeeringAllowed`
  // classifies `legacy:node` as LOCAL when such an agent exists — so creating an
  // outbound peering named `legacy` would make that population addressable as
  // remote, and routeDirect's remote branch would capture sends meant for the
  // local agent. The population the classifier calls local must stay local.
  const prefixed = db.prepare('SELECT id FROM agents WHERE id >= ? AND id < ? LIMIT 1')
    .get(`${alias}:`, `${alias};`) as { id: string } | null;
  if (prefixed !== null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `alias would shadow the local agent '${prefixed.id}'` })); return;
  }

  const url = body.url;
  const urlCheck = validateOutboundPeerUrl(url);
  if (!urlCheck.ok) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: urlCheck.error })); return;
  }
  const token = body.token;
  if (typeof token !== 'string' || token.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'token is required' })); return;
  }
  const assigned_alias = body.assigned_alias;
  if (typeof assigned_alias !== 'string' || assigned_alias.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'assigned_alias is required' })); return;
  }
  if (getOutboundPeer(db, alias) !== null) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'an outbound peering already exists for this alias' })); return;
  }

  let kinds: string[] = ['direct'];
  if (body.kinds !== undefined) {
    if (!Array.isArray(body.kinds) || !body.kinds.every(k => typeof k === 'string')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'kinds must be an array of strings' })); return;
    }
    kinds = body.kinds as string[];
  }
  let rate_per_min = 600;
  if (body.rate_per_min !== undefined) {
    if (typeof body.rate_per_min !== 'number' || !Number.isInteger(body.rate_per_min) || body.rate_per_min <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_per_min must be a positive integer' })); return;
    }
    rate_per_min = body.rate_per_min;
  }

  const row = insertOutboundPeer(db, {
    // `url` is narrowed by validateOutboundPeerUrl above, which the compiler
    // cannot see through a returned discriminated union — asserted, not cast
    // past a real unknown.
    alias, url: url as string, token, assigned_alias,
    kinds: JSON.stringify(kinds), rate_per_min, created_at: Date.now(),
  });
  // Event-driven, never polled: the handler that changed the state starts the
  // forwarder. C7 — the row carries the token, so nothing here logs the row.
  forwarders.create(row);
  console.log(JSON.stringify({ evt: 'outbound_peering.created', alias, url, assigned_alias, at: Date.now() }));

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(publicOutboundFields(row)));
}

export function handleOutboundPeerGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ peerings: listOutboundPeers(db).map(publicOutboundFields) }));
}

export function handleOutboundPeerDelete(ctx: AdminCtx): void {
  const { res, db, params, forwarders } = ctx;
  const alias = params.id as string;
  if (getOutboundPeer(db, alias) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such outbound peering' })); return;
  }
  // Stop first, then end: a forwarder still draining while its rows are being
  // expired would race its own teardown.
  forwarders.stop?.(alias);
  const { expired, edges } = endOutboundPeering(db, alias, 'deleted_by_admin', { delete: true });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ deleted: true, alias, expired_rows: expired, removed_edges: edges }));
}

/**
 * PATCH an outbound peering. `{enabled:false}` is the PAUSE, and what pausing
 * does is not what most operators expect it to do.
 *
 * WHILE PAUSED, NEW SENDS TO THE ALIAS ARE REFUSED with the uniform
 * `AGENT_NOT_FOUND`: `hasOutboundPeer` is enabled-only, so a paused peering
 * makes the remote id unknown to local senders. Only ALREADY-QUEUED messages
 * wait; re-enabling drains them. So pausing is not buffering — an admin who
 * pauses expecting new traffic to accumulate reads the refusal as a bug.
 *
 * What pausing DOES keep, and what makes it the reversible option: the queued
 * rows and the ACL edges both survive, unlike a DELETE or a receiver-side
 * revocation, either of which expires the queue and drops the edges.
 * Documented for operators in docs/FEDERATION.md §5.
 */
export async function handleOutboundPeerPatch(ctx: AdminCtx): Promise<void> {
  const { req, res, db, params, forwarders } = ctx;
  const alias = params.id as string;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' })); return;
  }
  if (getOutboundPeer(db, alias) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such outbound peering' })); return;
  }

  const patch: { enabled?: boolean; token?: string; url?: string; rate_per_min?: number } = {};
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'enabled must be a boolean' })); return;
    }
    patch.enabled = body.enabled;
  }
  if (body.token !== undefined) {
    if (typeof body.token !== 'string' || body.token.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'token must be a non-empty string' })); return;
    }
    patch.token = body.token;
  }
  if (body.url !== undefined) {
    // The SAME predicate as POST — see validateOutboundPeerUrl. PATCH is the
    // rotation path and would be the bypass if these ever diverged.
    const check = validateOutboundPeerUrl(body.url);
    if (!check.ok) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: check.error })); return;
    }
    patch.url = body.url as string;
  }
  if (body.rate_per_min !== undefined) {
    if (typeof body.rate_per_min !== 'number' || !Number.isInteger(body.rate_per_min) || body.rate_per_min <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rate_per_min must be a positive integer' })); return;
    }
    patch.rate_per_min = body.rate_per_min;
  }

  updateOutboundPeer(db, alias, patch);
  const row = getOutboundPeer(db, alias)!;

  // PATCH {enabled:false} is a PAUSE — reversible, and it keeps both the queued
  // rows and the outbound ACL edges. It deliberately does NOT call
  // endOutboundPeering: pausing and ending are different operations, and a
  // paused peering is expected to come back.
  forwarders.stop?.(alias);
  if (row.enabled === 1) forwarders.create!(row);

  console.log(JSON.stringify({
    evt: 'outbound_peering.patched', alias,
    // C7: which FIELDS changed, never their values — token must not reach a log.
    fields: Object.keys(patch), at: Date.now(),
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(publicOutboundFields(row)));
}

