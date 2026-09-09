/**
 * #143 — Admin routes for ACL edges (`/acl`).
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import {
  aclGrant, aclRevoke, listAclByGrantedBy, listAclByGrantedByPrefix, listInboundAcl, listOutboundAcl,
} from './db.ts';
import type { AdminCtx } from './admin-ctx.ts';
import { readBody } from './admin-ctx.ts';

export async function handleAclPost(ctx: AdminCtx): Promise<void> {
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

  const from_agent = body.from_agent;
  const to_agent = body.to_agent;

  if (typeof from_agent !== 'string' || !from_agent || typeof to_agent !== 'string' || !to_agent) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'from_agent and to_agent are required' }));
    return;
  }

  const granted_by = typeof body.granted_by === 'string' ? body.granted_by : 'system';
  // F0a: local-endpoint existence is enforced by aclGrant — ONE rule at the
  // chokepoint, not a copy per door.
  //
  // This route used to pre-check both endpoints with getAgentById and 404 on
  // null. Those gates are DELETED rather than given their own ':' exemption:
  // with them in place the HTTP door 404'd a remote id while the MCP door
  // accepted it, which is two doors with two rules on the pair #82 pinned for
  // exactly that. A second exemption would have kept the duplication and made
  // the rules agree only for as long as someone maintained both.
  //
  // The refusal a caller sees is unchanged for a bare unknown id: aclGrant
  // throws AGENT_NOT_FOUND and it maps to the same 404 below.
  let row;
  try {
    row = aclGrant(db, from_agent, to_agent, granted_by);
  } catch (err) {
    if ((err as { code?: string }).code === 'AGENT_NOT_FOUND') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'agent not found' }));
      return;
    }
    // F1b (§5.4): the peering rule lives in aclGrant, so this door only MAPS
    // its refusal. 409, not 404: the endpoint may well exist on the far mesh —
    // what is missing is the peering, which is a conflict with our state rather
    // than a claim about theirs.
    if ((err as { code?: string }).code === 'NO_PEERING') {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no peering' }));
      return;
    }
    throw err; // anything else is a real fault — let the dispatcher guard log it
  }

  // #161: the ACL is the most consequential thing the admin token confers, and
  // it was one of the four routes that emitted nothing. Names the EDGE — never
  // the credential that authorised it, which this handler never sees.
  console.log(JSON.stringify({
    evt: 'acl.granted', from_agent, to_agent, granted_by, at: Date.now(),
  }));
  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(row));
}

export async function handleAclDelete(ctx: AdminCtx): Promise<void> {
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

  const from_agent = body.from_agent;
  const to_agent = body.to_agent;

  if (typeof from_agent !== 'string' || !from_agent || typeof to_agent !== 'string' || !to_agent) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'from_agent and to_agent are required' }));
    return;
  }

  // F0a: the rule for revoke is EDGE existence, not endpoint existence.
  //
  // These two gates used to 404 on an endpoint that was not a local agent —
  // which since aclGrant accepts remote ids would leave THIS door unable to
  // revoke what the MCP door could: mesh_acl_deny has no such gate, so the edge
  // was always withdrawable there. Each door was internally consistent; the
  // defect was the gap between them, and a revoke one door cannot perform is
  // worse than one that reports nothing to do.
  //
  // 404 now means what it should have meant here all along — no such edge.
  const removed = aclRevoke(db, from_agent, to_agent);
  if (removed === 0) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'edge not found' }));
    return;
  }

  console.log(JSON.stringify({
    evt: 'acl.revoked', from_agent, to_agent, removed, at: Date.now(),
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

export function handleAclGet(ctx: AdminCtx): void {
  const { res, db, url } = ctx;
  const agent = url.searchParams.get('agent');
  const grantedBy = url.searchParams.get('granted_by');            // exact
  const grantedByPrefix = url.searchParams.get('granted_by_prefix'); // prefix

  // At most one granted_by mode (exact vs prefix are mutually exclusive).
  if (grantedBy !== null && grantedByPrefix !== null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'provide at most one of granted_by, granted_by_prefix' }));
    return;
  }

  // At least one selector is required (matches the original agent-required rule).
  if (!agent && grantedBy === null && grantedByPrefix === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'one of agent, granted_by, or granted_by_prefix is required' }));
    return;
  }

  // Agent-scoped (back-compat): {inbound, outbound}, optionally narrowed by
  // granted_by/prefix (JS filter — an agent's ACL set is small).
  if (agent) {
    // F1b: the local-existence gate that used to sit here is GONE — one rule
    // at the chokepoint, and F0a's sweep missed this third site. Listing for an
    // unknown or REMOTE id now returns an empty list rather than 404. No oracle
    // is opened: this route is admin-authenticated, so the caller may already
    // enumerate agents.
    let inbound = listInboundAcl(db, agent);
    let outbound = listOutboundAcl(db, agent);
    if (grantedBy !== null) {
      inbound = inbound.filter((r) => r.granted_by === grantedBy);
      outbound = outbound.filter((r) => r.granted_by === grantedBy);
    } else if (grantedByPrefix !== null) {
      inbound = inbound.filter((r) => r.granted_by.startsWith(grantedByPrefix));
      outbound = outbound.filter((r) => r.granted_by.startsWith(grantedByPrefix));
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ inbound, outbound }));
    return;
  }

  // Global provenance query (no agent): flat {matches} list — the reconciler
  // path ("every edge I stamped under <namespace>").
  const matches = grantedBy !== null
    ? listAclByGrantedBy(db, grantedBy)
    : listAclByGrantedByPrefix(db, grantedByPrefix as string);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ matches }));
}

