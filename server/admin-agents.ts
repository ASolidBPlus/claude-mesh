/**
 * #143 — Admin routes for agents (`/agents`).
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
// #143: this comment travelled from http-admin.ts with the code it explains.
// The only filesystem call in this module. File BYTES are written and read
// through Bun.write/Bun.file; this is the delete side, and it matches
// cleanup.ts's unlink so the two behave identically on a missing path.
import { unlinkSync } from 'fs';
import {
  generateToken, hashToken,
} from './auth.ts';
import {
  Agent, RESERVED_ALIAS, agentIdRefusal, deleteAgent, getAgentById, getLivePeerKeyForAlias, getPeerByAlias, listAgents, registerAgent, updateAgent,
} from './db.ts';
import type { AdminCtx } from './admin-ctx.ts';
import { readBody, formatAgent } from './admin-ctx.ts';

export async function handleAgentPost(ctx: AdminCtx): Promise<void> {
  const { req, res, db } = ctx;
  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  const id = body.id;
  const hostname = body.hostname;

  if (typeof id !== 'string' || !id) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'id is required' }));
    return;
  }

  if (typeof hostname !== 'string' || !hostname) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'hostname is required' }));
    return;
  }

  if (getAgentById(db, id) !== null) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent already exists' }));
    return;
  }

  // Optional namespace (#41): a string sets it, absent leaves it null. The bus
  // attaches no semantics to the value.
  let namespace: string | null = null;
  if (Object.prototype.hasOwnProperty.call(body, 'namespace')) {
    if (body.namespace !== null && typeof body.namespace !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'namespace must be a string or null' }));
      return;
    }
    namespace = body.namespace as string | null;
  }

  // F0b (§6) — id rules that only bind NEW agents. Existing ids are untouched:
  // a validation change must not make a live agent unable to re-register, so
  // legacy ':' ids are reported at boot instead (see server.ts) rather than
  // being retroactively rejected here.
  if (id.includes(':')) {
    // ':' separates mesh from agent in a remote id. A local id containing one
    // would be indistinguishable from a remote address.
    //
    // F4 adds a SECOND reason and deliberately no second guard: `topic:` is the
    // local topic-principal prefix, so an agent born in that range would be an
    // ACL principal two different subsystems disagree about. This check already
    // refuses every such id; a `topic:`-specific guard beside it would be a
    // second rule for one question, which is how the two drift apart.
    // Pre-existing `topic:*` ids are reported at boot (server.ts), never
    // retroactively rejected.
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: "agent id must not contain ':'" }));
    return;
  }
  // #187 — the CHARACTER GRAMMAR, read from `agentIdRefusal` rather than
  // restated. `registerAgent` enforces the same rule and THROWS, which would
  // reach the dispatcher as a 500; this door exists so a malformed id is
  // answered as the 400 it is. The ':' check above stays where it is because
  // its message names the specific reason, and the grammar would otherwise
  // answer it with a less useful one.
  const grammarRefusal = agentIdRefusal(id);
  if (grammarRefusal !== null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: grammarRefusal }));
    return;
  }
  if (id === RESERVED_ALIAS) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `agent id '${RESERVED_ALIAS}' is reserved` }));
    return;
  }
  // Same collision as the mint-side check, from the other direction: whichever
  // is created second is the one refused.
  //
  // TABLES READ, and why their union covers the state space: `peers` (a peer
  // that has registered) and `peer_keys` (one that has been minted but not yet
  // registered). A peer alias can only exist in those two states, so together
  // they are total. The mint-side gate reads `agents` and `peer_keys`, which is
  // the same argument from the other side.
  //
  // The gap this closes was NOT an unpinned gate — both gates were pinned. It
  // was two pinned gates whose union missed a state, which mutation cannot
  // find: every mutant of either gate died correctly while the hole stayed
  // open. It was found by asking what tables each gate reads.
  //
  // BOTH tables are consulted, and the peer_keys half is the one that matters:
  // a MINTED-but-not-yet-registered key lives only in peer_keys, so a gate that
  // looked at `peers` alone let this sequence through —
  //   mint key "x" -> register agent "x" (gate passes, peers is empty)
  //     -> peer registers with its key -> upsertPeer("x") succeeds
  // producing ONE id with TWO identities and no error at any step. Minting IS a
  // creation, so under the rule above the agent is the one refused.
  if (getPeerByAlias(db, id) !== null || getLivePeerKeyForAlias(db, id, Date.now()) !== null) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent id collides with an existing peer alias' }));
    return;
  }

  const rawToken = generateToken();
  const token_hash = hashToken(rawToken);
  const agent = registerAgent(db, { id, token_hash, hostname, namespace });

  // #161: names the agent created, and NOTHING about the token minted for it —
  // not the token, not its hash, not its length. This response body is the one
  // place the secret exists; the audit line beside it must not become a second.
  console.log(JSON.stringify({
    evt: 'agent.registered', agent_id: id, hostname, namespace, at: Date.now(),
  }));
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ...formatAgent(agent), token: rawToken }));
}

export function handleAgentGet(ctx: AdminCtx): void {
  const { res, db, url } = ctx;
  const onlineOnly = url.searchParams.get('online') === 'true';
  const agents = listAgents(db, onlineOnly);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(agents.map(formatAgent)));
}

export function handleAgentById(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id;
  const agent = getAgentById(db, id);
  if (agent === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(formatAgent(agent)));
}

export function handleAgentDelete(ctx: AdminCtx): void {
  const { res, db, params } = ctx;
  const id = params.id;
  const agent = getAgentById(db, id);
  if (agent === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }
  let purgedPaths: string[];
  try {
    // #161 + #91: ONE agent.deleted event, emitted below after the unlink so it
    // can carry the purge counts too. #161 added one here and #91 added one
    // there; the fields merge rather than the events multiplying — two events
    // with one name is how a log stops being countable.
    purgedPaths = deleteAgent(db, id);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'delete failed', detail: msg }));
    return;
  }
  // #91/#85: unlink AFTER the rows are gone, never before — a crash between
  // the two leaves an orphan file, never a row pointing at missing bytes. An
  // unlink failure is logged, never fatal: leaked bytes are recoverable, a
  // half-finished delete reported as a 409 is not (the identity is already
  // gone by the time we get here).
  let unlinked = 0;
  for (const p of purgedPaths) {
    try { unlinkSync(p); unlinked++; } catch (err) {
      console.warn(`[admin] file bytes not unlinked (row already removed): ${p}: ${(err as Error).message}`);
    }
  }
  console.log(JSON.stringify({
    evt: 'agent.deleted', agent_id: id,
    purged_files: purgedPaths.length, unlinked, at: Date.now(),
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

export async function handleAgentPatch(ctx: AdminCtx): Promise<void> {
  const { req, res, db, params } = ctx;
  const id = params.id as string; // idMatch always populates :id
  if (getAgentById(db, id) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not found' }));
    return;
  }

  const raw = await readBody(req);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid JSON' }));
    return;
  }

  // Genuine PARTIAL update: only fields PRESENT in the body are touched. An
  // omitted field is left exactly as-is (never nulled). metadata is REPLACE
  // (not merge) — consumers do read-modify-write.
  const fields: { metadata?: string; namespace?: string | null } = {};

  if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
    const metadata = body.metadata;
    if (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'metadata must be a JSON object' }));
      return;
    }
    const serialized = JSON.stringify(metadata);
    if (Buffer.byteLength(serialized, 'utf8') > 4096) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'metadata exceeds 4096 bytes' }));
      return;
    }
    fields.metadata = serialized;
  }

  if (Object.prototype.hasOwnProperty.call(body, 'namespace')) {
    if (body.namespace !== null && typeof body.namespace !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'namespace must be a string or null' }));
      return;
    }
    fields.namespace = body.namespace as string | null;
  }

  const updated = updateAgent(db, id, fields);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(formatAgent(updated as Agent)));
}

