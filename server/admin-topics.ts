/**
 * #143 — Admin routes for topics (`/topics`).
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import {
  getAgentById, getOrCreateTopic, listTopics, topicNameRefusal,
} from './db.ts';
import type { AdminCtx } from './admin-ctx.ts';
import { readBody } from './admin-ctx.ts';

export async function handleTopicPost(ctx: AdminCtx): Promise<void> {
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

  const name = body.name;
  const created_by = body.created_by;

  if (typeof name !== 'string' || !name) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'name is required' }));
    return;
  }

  if (typeof created_by !== 'string' || !created_by) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'created_by is required' }));
    return;
  }

  // F4: NEW names only — an existing topic is never rejected by its own name
  // (the F0b rule). Consulted before getOrCreateTopic, which would otherwise
  // create the row this refuses.
  const nameRefusal = topicNameRefusal(db, name);
  if (nameRefusal !== null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: nameRefusal }));
    return;
  }

  if (getAgentById(db, created_by) === null) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'created_by agent not found' }));
    return;
  }

  const description = typeof body.description === 'string' ? body.description : '';
  const metadata = body.metadata !== undefined ? JSON.stringify(body.metadata) : '{}';
  const topic = getOrCreateTopic(db, name, created_by, description, metadata);

  res.writeHead(201, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(topic));
}

export function handleTopicGet(ctx: AdminCtx): void {
  const { res, db } = ctx;
  const topics = listTopics(db);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(topics));
}

