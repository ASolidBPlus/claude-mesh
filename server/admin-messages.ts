/**
 * #143 — The admin message query route (`/messages`).
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import {
  queryMessages, queryPairMessages, pairCounterparts, ownsAddress, LOCAL_ID_RE, PEER_ALIAS_RE, ALIAS_SUFFIX_RE,
} from './db.ts';
import type { AdminCtx } from './admin-ctx.ts';

/** R-313: a `with` value is a local agent id or a remote `alias:agent`.
 *  Grammar only: an id nobody has used is well-formed and simply has no rows,
 *  so the answer never says whether an agent exists. */
function counterpartRefusal(id: string): string | null {
  if (LOCAL_ID_RE.test(id)) return null;
  // R-377: an alias, fred+<suffix>.
  const plus = id.indexOf('+');
  if (plus > 0 && LOCAL_ID_RE.test(id.slice(0, plus)) && ALIAS_SUFFIX_RE.test(id.slice(plus + 1))) return null;
  const colon = id.indexOf(':');
  if (colon > 0 && PEER_ALIAS_RE.test(id.slice(0, colon)) && LOCAL_ID_RE.test(id.slice(colon + 1))) return null;
  return 'invalid with (expected an agent id, agent+alias, or alias:agent for a remote one)';
}

export function handleMessagesGet(ctx: AdminCtx): void {
  const { res, db, url, auth } = ctx;
  const agentParam = url.searchParams.get('agent') || undefined;
  const topicParam = url.searchParams.get('topic') || undefined;
  const withParam = url.searchParams.get('with');
  const sinceRaw = url.searchParams.get('since');
  const limitRaw = url.searchParams.get('limit');
  // Optional kind filter (#38-family): `kinds=direct,request,response,file` lets
  // a DM/scrollback scan skip high-volume 'topic' beat rows. Whitelisted so an
  // arbitrary value can't reach the SQL; empty after filtering = no constraint.
  const KNOWN_KINDS = ['direct', 'topic', 'request', 'response', 'file', 'reminder'];
  const kindsRaw = url.searchParams.get('kinds');
  const kinds = kindsRaw
    ? kindsRaw.split(',').map(k => k.trim()).filter(k => KNOWN_KINDS.includes(k))
    : undefined;

  const since = sinceRaw !== null ? parseInt(sinceRaw, 10) : undefined;
  const limit = limitRaw !== null ? parseInt(limitRaw, 10) : undefined;

  // Backward pagination (#36): opaque `before` cursor = "<sent_at>:<id>",
  // derived by the client from the oldest row of the previous page. Rows
  // strictly older than the cursor are returned (stable sent_at,id tie-break),
  // so "load older" tiles without duplicates or gaps even across equal sent_at.
  let before: { sentAt: number; id: string } | undefined;
  const beforeRaw = url.searchParams.get('before');
  if (beforeRaw !== null) {
    const sep = beforeRaw.indexOf(':');
    const sentAt = sep > 0 ? parseInt(beforeRaw.slice(0, sep), 10) : NaN;
    const id = sep > 0 ? beforeRaw.slice(sep + 1) : '';
    if (Number.isNaN(sentAt) || id === '') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid before cursor (expected "<sent_at>:<id>")' }));
      return;
    }
    before = { sentAt, id };
  }

  // Node-scoped read (#35): a non-admin agent only ever sees traffic it is a
  // party to. The (from_agent = X OR to_agent = X) scope covers direct, topic
  // (persisted as per-subscriber copies with to_agent = subscriber), and
  // request/response rows. Requesting another agent's scope is a hard 403;
  // admin is unconstrained (behaves exactly as before).
  // 'unauthenticated' must never reach here — this route is not handler-mode,
  // so the dispatcher already refused. If it ever does, that is a routing bug,
  // and the safe reading is NOT "unconstrained like admin": refuse rather than
  // fall through to the admin path below.
  if (auth.mode === 'unauthenticated') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden' }));
    return;
  }

  let effectiveAgent = agentParam;
  if (auth.mode === 'agent') {
    // R-377: `agent=fred+x` is fred's own alias, read with fred's token.
    if (agentParam !== undefined && !ownsAddress(auth.agentId, agentParam)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden: cannot query another agent' }));
      return;
    }
    effectiveAgent = agentParam ?? auth.agentId;
  }

  // R-313: the rows between the caller and one counterpart. The caller is the
  // authenticated agent (already pinned above), or, for the admin token, the
  // `agent=` it names: an admin has no side of its own to be the caller.
  if (withParam !== null) {
    const fail = (error: string) => {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error }));
    };
    const refusal = counterpartRefusal(withParam);
    if (refusal !== null) return fail(refusal);
    if (effectiveAgent === undefined) return fail('with needs agent=<id> when called with the admin token');
    // `with` reads only non-topic rows, so a topic filter beside it could
    // only ever return nothing; refused rather than silently empty.
    if (topicParam !== undefined) return fail('with and topic cannot be combined');
    const pair = queryPairMessages(db, effectiveAgent, pairCounterparts(effectiveAgent, withParam), {
      since: Number.isNaN(since) ? undefined : since,
      limit: Number.isNaN(limit) ? undefined : limit,
      before,
      kinds,
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(pair));
    return;
  }

  const messages = queryMessages(db, {
    agent: effectiveAgent,
    topic: topicParam,
    since: Number.isNaN(since) ? undefined : since,
    limit: Number.isNaN(limit) ? undefined : limit,
    before,
    kinds,
  });

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(messages));
}

