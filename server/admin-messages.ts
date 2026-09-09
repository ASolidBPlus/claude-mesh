/**
 * #143 — The admin message query route (`/messages`).
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import {
  queryMessages,
} from './db.ts';
import type { AdminCtx } from './admin-ctx.ts';

export function handleMessagesGet(ctx: AdminCtx): void {
  const { res, db, url, auth } = ctx;
  const agentParam = url.searchParams.get('agent') || undefined;
  const topicParam = url.searchParams.get('topic') || undefined;
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
    if (agentParam !== undefined && agentParam !== auth.agentId) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden: cannot query another agent' }));
      return;
    }
    effectiveAgent = auth.agentId;
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

