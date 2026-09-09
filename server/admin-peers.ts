/**
 * #143 — Inbound peering: peer keys, registration and the peer read APIs
(`/peer-keys`, `/peers`) — F0b §3, §4, §6.
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import { Database } from 'bun:sqlite';
import * as http from 'http';
import {
  generateToken, hashToken,
} from './auth.ts';
import {
  PEER_ALIAS_RE, Peer, PeerKey, RESERVED_ALIAS, getAgentById, getLivePeerKeyForAlias, getPeerByAlias, getPeerKeyById, getPeerKeyBySecret, insertPeerKey, listPeerKeys, listPeerSubscriptions, listPeers, revokePeerKey, upsertPeer,
} from './db.ts';
// #131: read via ./wire-version.ts, never as a direct cross-package import
// from the client wire module.
//
// #143 MOVED THIS COMMENT AND CORRECTED IT. It sat in http-admin.ts and said
// "this file is over the 51,200 B transpiler-cache threshold" — the reason that
// file mattered to #131: it was the only importer both cached AND crossing the
// package boundary, and the only one that ever hit the intermittent link
// failure. This module is a fraction of that size, so the CACHED half no longer
// applies. The rule does, and the rule is the load-bearing half: a server-side
// reader reaches the constant through wire-version.ts. The size is printed by
// the #131 walker in border.test.ts and deliberately not repeated here, because
// the figure once written here went stale by 300 B within a generation.
//
// (Deliberately not naming the client path in prose: a comment containing the
// literal import string makes this file register as a cross-package importer to
// any grep that does not strip comments — the false positive that turned up
// while verifying the invariant.)
//
// The constant still has exactly ONE definition. That, and the specifier every
// reader uses, are pinned by border.test.ts, so the obvious tidy-up reds rather
// than silently reinstating the edge.
import {
  PEER_PROTOCOL_VERSION,
} from './wire-version.ts';
import type { AdminCtx } from './admin-ctx.ts';
import { readBody } from './admin-ctx.ts';

export function publicPeerKeyFields(db: Database, key: PeerKey) {
  const peer = getPeerByAlias(db, key.alias);
  return {
    id: key.id,
    alias: key.alias,
    kinds: JSON.parse(key.kinds) as string[],
    rate_per_min: key.rate_per_min,
    expires_at: key.expires_at,
    revoked_at: key.revoked_at,
    rotates: key.rotates,
    note: key.note,
    created_at: key.created_at,
    // Per-alias live state, so an operator can see whether the key was used
    // without joining two listings by hand.
    registered: peer !== null,
    peer_disabled: peer === null ? null : peer.disabled === 1,
  };
}

export async function handlePeerKeyPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' })); return;
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
    // 'mesh' names THIS mesh in every remote id. A peer holding it would make
    // its traffic indistinguishable from local traffic — refused at mint, the
    // only point where refusing is cheap.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `alias '${alias}' is reserved` })); return;
  }
  if (getAgentById(db, alias) !== null) {
    // A peer alias and a local agent id share one id space at the point of
    // address resolution, so a collision makes routing ambiguous.
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'alias collides with an existing local agent id' })); return;
  }

  const now = Date.now();
  if (getLivePeerKeyForAlias(db, alias, now) !== null) {
    // One live key per alias: two would mean two secrets can register the same
    // peer, so revoking one would leave a door open that the operator believes
    // they closed.
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'a live key already exists for this alias' })); return;
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

  let expires_at: number | null = null;
  if (body.expires_at !== undefined && body.expires_at !== null) {
    if (typeof body.expires_at !== 'number' || !Number.isInteger(body.expires_at)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'expires_at must be an integer ms timestamp' })); return;
    }
    expires_at = body.expires_at;
  }

  // #113: a ROTATION declares the key it replaces. Absent means rebind, which
  // is the safe default — the alias's inbound edges are dropped at registration.
  // Validated as a string only; whether it MATCHES the peer row's current key
  // is decided at registration, where the row is the authority.
  let rotates: string | null = null;
  if (body.rotates !== undefined && body.rotates !== null) {
    if (typeof body.rotates !== 'string' || body.rotates.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'rotates must be a key id' })); return;
    }
    rotates = body.rotates;
  }

  const secret = generateToken();
  const key = insertPeerKey(db, {
    id: crypto.randomUUID(),
    key_hash: hashToken(secret),
    alias,
    kinds: JSON.stringify(kinds),
    rate_per_min,
    expires_at,
    note: typeof body.note === 'string' ? body.note : null,
    created_at: now,
    rotates,
  });

  console.log(JSON.stringify({
    evt: 'peer_key.minted', key_id: key.id, alias, kinds, rate_per_min, expires_at, at: now,
  }));

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ...publicPeerKeyFields(db, key),
    key: secret, // shown ONCE, never stored in the clear, never listed
  }));
}

export function handlePeerKeyGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ keys: listPeerKeys(db).map(k => publicPeerKeyFields(db, k)) }));
}

/** Public shape of a registered inbound peer. NEVER includes `token_hash`
 *  (C7): it is the stored verifier for a live credential, and an admin read
 *  that returned it would make every registered peer offline-crackable from
 *  one GET — the same argument publicPeerKeyFields makes for `key_hash`.
 *
 *  `minted_by_key` IS included and is not a secret: it is the key's id, the
 *  same value `GET /peer-keys` already lists, and it is what ties a registered
 *  peer back to the key to revoke — which is the operator question this route
 *  exists to answer.
 *
 *  NO socket-derived `connected` field, though `peerIndex` is in scope. That
 *  is a second liveness reading placed beside a durable one, and #133 is the
 *  record of what happens when two readings of "alive" sit on one row without
 *  the difference being stated. This route lists the REGISTRY; if a live-socket
 *  reading is wanted it should arrive named for what it is. */
export function publicPeerFields(row: Peer) {
  return {
    alias: row.alias,
    minted_by_key: row.minted_by_key,
    kinds: JSON.parse(row.kinds) as string[],
    rate_per_min: row.rate_per_min,
    registered_at: row.registered_at,
    last_seen: row.last_seen,
    disabled: row.disabled === 1,
  };
}

/**
 * F4 §5 — every subscription one peered mesh holds here.
 *
 * The operator-facing answer to "why is that pod not receiving?". It is the
 * diagnostic the subscribe path deliberately withholds from the PEER: a peer
 * learns only that its frame was refused, while the operator of THIS mesh can
 * see exactly which of its agents are subscribed to what. That split is the
 * design — uniform refusals outward, full visibility inward.
 *
 * 404 on an unregistered alias, which is not a disclosure: the caller holds the
 * admin token and can list the peers anyway.
 */
export function handlePeerSubscriptionsGet(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  // `idMatch` names its single capture `id`; the route reads
  // /peers/:alias/subscriptions to a human, and `alias` is what it means.
  const alias = params.id as string;
  if (getPeerByAlias(db, alias) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such peer' })); return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ alias, subscriptions: listPeerSubscriptions(db, alias) }));
}

/**
 * #153 — the inbound counterpart to `GET /outbound-peers`.
 *
 * `listPeers` has existed in db.ts since F0b with no HTTP consumer, so an
 * operator could mint keys and revoke them but could not enumerate who had
 * actually registered, or was disabled, or what kinds and rate each holds —
 * except by reading the boot log or opening the database.
 *
 * THE GUIDE ALREADY PROMISED THIS ROUTE. docs/FEDERATION.md §4 has listed
 * `GET /peers` in its read-API table since 6db50f9, and it 404'd — verified
 * against a live admin server before this was written. That row is the only
 * one in the table with no `file.ts` + symbol citation next to it, which is
 * exactly the tell: the rows derived from the code were true, the row derived
 * from what the surface OUGHT to contain was not.
 *
 * Admin-authenticated, so listing is not a disclosure (C9): the caller already
 * holds the admin token. The secret bytes are still withheld, because the
 * threat here is not the operator but the copy of this response that ends up
 * in a shell history, a ticket, or a log.
 */
export function handlePeerGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ peers: listPeers(db).map(publicPeerFields) }));
}

/**
 * Close a peer's live socket, if it has one. F1a: the ACTION half of
 * revocation — the cleanup sweep is the STATE half and runs regardless, so a
 * missed close here costs at most PEER_SWEEP_INTERVAL_MS rather than leaving a
 * revoked peer connected indefinitely. Best-effort by design; a socket that
 * cannot be closed is exactly what the sweep exists for.
 */
export function closePeerSocket(ctx: AdminCtx, alias: string, code: string, message: string): void {
  const sock = ctx.peerIndex.get(alias);
  if (sock === undefined) return;
  try { sock.send(JSON.stringify({ type: 'error', code, message })); } catch { /* ignore */ }
  try { sock.close(1008, message); } catch { /* ignore */ }
}

export function handlePeerKeyDelete(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id as string;
  if (!revokePeerKey(db, id)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'no such live peer key' })); return;
  }
  // F1a: close the live socket NOW. revokePeerKey already set disabled=1 in its
  // transaction, so the sweep would close it within 15 s regardless — this is
  // the fast path, not the guarantee.
  const revokedKey = getPeerKeyById(db, id);
  if (revokedKey !== null) closePeerSocket(ctx, revokedKey.alias, 'AUTH_FAILED', 'invalid token');

  console.log(JSON.stringify({ evt: 'peer_key.revoked', key_id: id, at: Date.now() }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ revoked: true, id }));
}

/** UNIFORM PER C9 — one 403 body for every cause, the reason to the LOG only.
 *  This door is reached by a caller outside the trust boundary presenting a
 *  secret, so distinguishing "unknown key" from "revoked" from "expired" would
 *  make it an oracle for which keys exist. The operator still gets the reason,
 *  because a structured log is not the prober-reachable surface.
 *
 *  Every registration refusal returns THIS — one body, one status, no detail.
 *  A peer presenting a wrong, revoked, expired, or nonexistent key learns only
 *  that it was refused. */
/** Why a presented key was not live, FOR THE LOG LINE ONLY. Reads the columns
 *  directly and deliberately: it feeds a diagnostic string and never a branch,
 *  so it cannot become a second authority on liveness. The 403 body is uniform
 *  regardless (§6) — this changes what the OPERATOR sees, never the peer. */
export function describeDeadKey(db: Database, secret: string): string {
  const row = db.prepare('SELECT revoked_at, expires_at FROM peer_keys WHERE key_hash = ? LIMIT 2')
    .all(hashToken(secret)) as { revoked_at: number | null; expires_at: number | null }[];
  if (row.length !== 1) return 'unknown_key';
  const k = row[0]!;
  if (k.revoked_at !== null) return 'revoked_key';
  if (k.expires_at !== null && k.expires_at <= Date.now()) return 'expired_key';
  return 'unknown_key';
}

export function refusePeerRegistration(res: http.ServerResponse, reason: string, alias: string | null): void {
  console.log(JSON.stringify({ evt: 'peer.register_refused', reason, alias, at: Date.now() }));
  res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'registration refused' }));
}

export async function handlePeerRegister(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  // auth:'handler' — the dispatcher checked NOTHING. This handler is the only
  // authentication on this route, and ctx.auth is 'unauthenticated' by
  // construction so nothing it was handed can act as a grant.
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try { body = JSON.parse(raw); } catch {
    refusePeerRegistration(res, 'invalid_json', null); return;
  }

  const presented = body.key;
  if (typeof presented !== 'string' || presented.length === 0) {
    refusePeerRegistration(res, 'missing_key', null); return;
  }

  const key = getPeerKeyBySecret(db, presented);
  if (key === null) {
    // DIAGNOSTIC ONLY — never a branch. The refusal has already been decided
    // above; this reads the columns solely to say WHY in the log, so an
    // operator can tell a revoked key from an expired one from a wrong one.
    // It must not become a condition: a second reader of these columns is how
    // the third authority appeared in the first place.
    refusePeerRegistration(res, describeDeadKey(db, presented), null);
    return;
  }
  // No liveness branch here. getPeerKeyBySecret returns null for a key that is
  // not live, by the SAME definition the mint gate and the boot report use — so
  // this handler has no opinion of its own to drift from theirs. It used to
  // read revoked_at and expires_at itself and agree by coincidence, which is
  // the property #103 exists to remove, on the highest-stakes consumer: this is
  // the call that decides whether a peer obtains a live token.

  // Defence in depth, at the moment the collision becomes REAL rather than
  // latent: the mint-side and agent-side gates should have made this
  // impossible, but a key minted before those gates existed — or any future
  // path that writes peer_keys without them — would otherwise create a second
  // identity for an id that already names a local agent.
  if (getAgentById(db, key.alias) !== null) {
    console.error(JSON.stringify({
      evt: 'peer.register_alias_collision', alias: key.alias, key_id: key.id, at: Date.now(),
    }));
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'alias collides with an existing local agent id' }));
    return;
  }

  const token = generateToken();
  const peer = upsertPeer(db, {
    alias: key.alias,
    token_hash: hashToken(token),
    minted_by_key: key.id,
    kinds: key.kinds,
    rate_per_min: key.rate_per_min,
    // #113: the lineage the operator declared when minting this key. upsertPeer
    // decides whether it matches the row's current key; this handler carries it
    // rather than interpreting it.
    rotates: key.rotates,
  });

  // §6: re-registration ROTATED the token (upsertPeer), so any socket holding
  // the old one is authenticated with a credential that no longer exists.
  // Closing it makes the rotation effective immediately rather than whenever
  // that socket happens to drop.
  closePeerSocket(ctx, peer.alias, 'AUTH_FAILED', 'invalid token');

  console.log(JSON.stringify({
    evt: 'peer.registered', alias: peer.alias, key_id: key.id, at: Date.now(),
  }));

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    alias: peer.alias,
    token, // shown ONCE
    kinds: JSON.parse(peer.kinds) as string[],
    rate_per_min: peer.rate_per_min,
    // The ONE constant. A literal here advertises a version auth may not
    // accept — registration succeeds, authentication always fails, and it
    // looks like a peer-side fault.
    protocol: PEER_PROTOCOL_VERSION,
  }));
}

// ─── Outbound peerings (F2a — §4, §5.3, §5.6, §6) ───────────────────────────
//
// C9 SCOPE, stated per door: these are ADMIN-authenticated. C9 binds refusals
// reachable from OUTSIDE the trust boundary; an admin holding the token can
// already enumerate agents, peers, keys and peerings, so distinguishable
// refusals here teach nothing and their diagnostic value is real. Uniform
// errors on this door would be the #107 mistake — applying a property of the
// prober-reachable surface to the system.
//
// Every refusal below is therefore SPECIFIC on purpose. That is a decision, not
// an omission.

