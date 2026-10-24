/**
 * #143 — Admin routes for file transfer (`/files`), and the authorisation rule
that decides who may read one.
 *
 * MOVED FROM `http-admin.ts`, unchanged. That file held every admin route in
 * one 100 KB module; this is a mechanical split along URL families, with no
 * behaviour change and no comment dropped — the reasoning that sat at each
 * site moved with it.
 */
import { createReadStream, writeFileSync, openSync } from 'fs';
import {
  aclCheck, addressExists, getAgentById, getFile, identityOf, insertFile, markFileDelivered, ownsAddress,
} from './db.ts';
import type { AuthResult, AdminCtx } from './admin-ctx.ts';
import { incReceived } from './metrics.ts';

/**
 * RFC 6266/5987 Content-Disposition for an untrusted filename.
 *
 * WHY THIS EXISTS (2026-08-01 incident): filenames are agent-supplied and were
 * interpolated raw into a header. Node/Bun validate header values as latin1 —
 * one em-dash (U+2014) in a stored filename made writeHead throw
 * ERR_INVALID_CHAR, which killed the WHOLE server process. The container
 * stayed "Up" (sleep-style PID 1), so only mesh presence saw it — and the
 * recipient's inbox auto-refetch turned it into a crash LOOP on every
 * restart. One filename, whole-mesh DoS, invisible to container health.
 *
 * Shape: an ASCII-only `filename="…"` fallback (non-printables and the two
 * quote-breakers replaced), plus `filename*=UTF-8''…` carrying the real name
 * percent-encoded per RFC 5987 (encodeURIComponent, then the four chars it
 * leaves bare that are NOT attr-chars). Every modern client prefers the
 * starred form, so unicode names round-trip; the fallback cannot contain a
 * byte writeHead rejects.
 */
export function contentDispositionFor(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/**
 * Content-Type is the SAME injection vector one line up: it is stored from
 * whatever the sender's SDK passed as contentType, and a non-latin1 byte in it
 * kills writeHead identically. A well-formed type/subtype (with optional
 * parameters, printable-ASCII only) passes through; anything else serves as
 * octet-stream rather than 500ing a file whose bytes are fine.
 */
// #70: the grammar and the helper live in file-hygiene.ts, so INGEST and
// SERVING share one authority.
//
// #143: the PUBLIC re-export stays in `http-admin.ts`, not here — existing
// importers name that path, and the split moved the definition without moving
// the surface. This module only imports what it uses.
// ...and imported, not only re-exported: `export { x } from` forwards the name
// to importers WITHOUT binding it in this module's scope, so the serving path
// below saw an undefined identifier. Caught by the #68 tests going 500.
import { safeContentType } from './file-hygiene.ts';

/**
 * R-271 — CONCURRENT DOWNLOADS ARE BOUNDED, per agent and in total. Since
 * R-267 any authenticated agent can start downloads from anywhere that
 * reaches the agent port, and each one holds a file descriptor and a socket
 * for as long as the client takes to read it. Past a cap the answer is a
 * typed 429 (`DOWNLOAD_BUSY`, Retry-After), not a queue. The admin token
 * counts against the global cap only: it is one operator, not a fleet.
 *
 * Set once at boot from MESH_DOWNLOAD_MAX / MESH_DOWNLOAD_PER_AGENT
 * (server.ts); tests set them directly.
 */
export const DOWNLOAD_LIMITS = { global: 64, perAgent: 4, stallMs: 60_000 };
let downloadLimits = { ...DOWNLOAD_LIMITS };
let downloadsInFlight = 0;
const downloadsByAgent = new Map<string, number>();

export function setDownloadLimits(l: { global: number; perAgent: number; stallMs?: number }): void {
  downloadLimits = { ...DOWNLOAD_LIMITS, ...l };
}

/** A slot for one download, or null at a cap. Released exactly once, from the response's single 'close'. */
function acquireDownload(agentId: string | null): (() => void) | null {
  const mine = agentId === null ? 0 : downloadsByAgent.get(agentId) ?? 0;
  if (downloadsInFlight >= downloadLimits.global) return null;
  if (agentId !== null && mine >= downloadLimits.perAgent) return null;
  downloadsInFlight++;
  if (agentId !== null) downloadsByAgent.set(agentId, mine + 1);
  return () => {
    downloadsInFlight--;
    if (agentId !== null) {
      const left = (downloadsByAgent.get(agentId) ?? 1) - 1;
      if (left <= 0) downloadsByAgent.delete(agentId); else downloadsByAgent.set(agentId, left);
    }
  };
}

export async function handleFileById(ctx: AdminCtx): Promise<void> {
  const { res, db, params, auth } = ctx;
  const id = params.id;
  const file = getFile(db, id);

  // Node-scoped read (#57): an AGENT may fetch a file only if it is that file's
  // sender or recipient; admin has full access. Deny-by-default returns the
  // SAME 404 as a missing file — an agent cannot distinguish "no such file"
  // from "exists but not yours", so it can't enumerate/probe file_ids across
  // nodes (no existence oracle). from_agent/to_agent are already stored.
  const authorized = file !== null && fileAccessAuthorized(auth, file);
  if (!authorized) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file not found' }));
    return;
  }

  const bunFile = Bun.file(file.file_path);
  if (!await bunFile.exists()) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file not found' }));
    return;
  }

  // The slot is taken only for a request that is authorised AND has bytes to
  // send — a 404 holds nothing — and released when the response CLOSES: the
  // one event that fires for completion, a client abort, an error and a stall.
  //
  // THE BOUND, stated because it is not zero: a client can have the whole body
  // a few ms before the server's 'close' fires (measured, Bun 1.4.2 and 1.4.3),
  // so a client that fires its next request in that instant is briefly counted
  // twice. Releasing at end-of-file narrows the window but cannot close it (the
  // next request can beat that event too), so it is not done. A client fetching
  // one file at a time therefore holds at most TWO slots — under the default
  // per-agent cap of 4 it is never refused.
  const release = acquireDownload(auth.mode === 'agent' ? auth.agentId : null);
  if (release === null) {
    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    res.end(JSON.stringify({ error: 'too many concurrent downloads; retry shortly', code: 'DOWNLOAD_BUSY' }));
    return;
  }
  // OPENED BEFORE THE HEADERS. A file that exists but cannot be read (a
  // permission or I/O error) must not become a 200: once headers are out, a
  // destroyed response reads on the client as a COMPLETE, EMPTY body (measured
  // with Bun's fetch) — an agent would store zero bytes as the file.
  let fd: number;
  try {
    // A plain descriptor, owned by the stream below (autoClose). Not
    // fs/promises open(): a FileHandle dropped after taking its .fd is closed
    // by the garbage collector, which Bun now throws on (measured).
    fd = openSync(file.file_path, 'r');
  } catch {
    release();
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'file could not be read', code: 'FILE_UNREADABLE' }));
    return;
  }
  // STREAMED, not read into memory (it used to be arrayBuffer(): up to
  // maxFileBytes resident per download). Same headers as before.
  const stream = createReadStream(file.file_path, { fd, autoClose: true });
  // NO PROGRESS, NO SLOT. A client that reads a chunk and then stops holds its
  // slot through TCP backpressure for as long as it likes; the cap would then
  // be a count of stalled clients. The timer restarts on every chunk read from
  // disk — which stops when the client stops — and ends the response when it
  // runs out.
  let stall: ReturnType<typeof setTimeout> | null = null;
  const arm = (): void => {
    if (stall !== null) clearTimeout(stall);
    stall = setTimeout(() => res.destroy(), downloadLimits.stallMs);
  };
  res.once('close', () => { if (stall !== null) clearTimeout(stall); stream.destroy(); release(); });
  // A read error AFTER the headers are out (rare once the open succeeded)
  // cannot become an error response; the connection is ended rather than left
  // hanging. Without a listener an 'error' would be thrown at the process.
  stream.once('error', () => { res.destroy(); });
  stream.on('data', arm);
  arm();
  res.writeHead(200, {
    'Content-Type': safeContentType(file.content_type),
    'Content-Disposition': contentDispositionFor(file.filename),
    'Content-Length': String(bunFile.size),
  });
  stream.pipe(res);
}

export async function handleFilePost(ctx: AdminCtx): Promise<void> {
  const { req, res, db, agentIndex, maxFileBytes, filesDir } = ctx;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    const rawBody = Buffer.concat(chunks);

    const bunReq = new Request(`http://localhost${req.url}`, {
      method: 'POST',
      headers: req.headers as Record<string, string>,
      body: rawBody,
    });

    // Typed FROM THE CALL, not as the global `FormData`: under @types/bun
    // `Request.formData()` returns undici's FormData, which is not assignable
    // to the global one, so a consumer type-checking this file with that
    // config (the plugin) got TS2322 here. The value was always fine.
    let formData: Awaited<ReturnType<typeof bunReq.formData>>;
    try {
      formData = await bunReq.formData();
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid form data' }));
      return;
    }

    const fileBlob = formData.get('file');
    const from_agent = formData.get('from_agent');
    const to_agent = formData.get('to_agent');
    const caption = formData.get('caption');
    const reply_to_msg_id = formData.get('reply_to_msg_id');
    const ttl_ms_str = formData.get('ttl_ms');

    if (!fileBlob || typeof fileBlob === 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'file is required and must be a file upload' }));
      return;
    }

    if (typeof from_agent !== 'string' || !from_agent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'from_agent is required' }));
      return;
    }

    if (typeof to_agent !== 'string' || !to_agent) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'to_agent is required' }));
      return;
    }

  // DELIBERATELY LOCAL-ONLY, and NOT part of the acl chokepoint migration
  // (F0a). File delivery has no remote endpoint in F0 — cross-mesh transfer is
  // later work — so these two gates are load-bearing here rather than a
  // leftover copy of the idiom aclGrant now owns. The next "one rule at the
  // chokepoint" sweep must skip them.
    if (getAgentById(db, from_agent) === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'from_agent not found' }));
      return;
    }

    if (!addressExists(db, to_agent)) {   // R-377: an agent or an alias of one
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'to_agent not found' }));
      return;
    }

    if (!aclCheck(db, from_agent, to_agent)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ACL denied' }));
      return;
    }

    const fileBlobObj = fileBlob as File;
    const size_bytes = fileBlobObj.size;
    if (size_bytes > maxFileBytes) {
      res.writeHead(413, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `file exceeds ${maxFileBytes} byte limit` }));
      return;
    }

    if (caption !== null && typeof caption === 'string' && Buffer.byteLength(caption, 'utf8') > 4096) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'caption exceeds 4096 byte limit' }));
      return;
    }

    const file_id = crypto.randomUUID();
    const filePath = `${filesDir}/${file_id}`;
    // R-271: CREATED 0600 — an attachment is one party's data. Bun.write takes
    // no mode, and narrowing afterwards leaves the file 0666 for a moment under
    // a permissive umask; writing with the mode leaves no such window.
    writeFileSync(filePath, Buffer.from(await fileBlobObj.arrayBuffer()), { mode: 0o600 });

    const ttl_ms_val = ttl_ms_str ? parseInt(ttl_ms_str as string, 10) : 300_000;
    const ttl = isNaN(ttl_ms_val) ? 300_000 : ttl_ms_val;
    const expires_at = ttl === 0 ? null : Date.now() + ttl;

    const filename = fileBlobObj.name || 'upload';
    const content_type = fileBlobObj.type || 'application/octet-stream';
    const sent_at = Date.now();

    insertFile(db, {
      id: file_id,
      from_agent,
      to_agent,
      filename,
      content_type,
      size_bytes,
      file_path: filePath,
      sent_at,
      expires_at,
      caption: (caption as string) ?? null,
      reply_to_msg_id: (reply_to_msg_id as string) ?? null,
    });

    const recipientWs = agentIndex.get(to_agent);
    if (recipientWs !== undefined) {
      const deliverFrame = JSON.stringify({
        type: 'file_deliver',
        file_id,
        from: from_agent,
        identity: identityOf(from_agent),   // R-377
        to: to_agent,
        filename,
        content_type,
        size_bytes,
        sent_at,
        fetch_url: `/files/${file_id}`,
        caption: (caption as string) ?? null,
        reply_to_msg_id: (reply_to_msg_id as string) ?? null,
      });
      recipientWs.send(deliverFrame);
      markFileDelivered(db, file_id);
      incReceived(to_agent, { kind: 'file', from: from_agent, to: to_agent, topic: null });
    }

    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      file_id,
      from_agent,
      to_agent,
      filename,
      content_type,
      size_bytes,
      caption: (caption as string) ?? null,
      sent_at,
    }));
    return;
  } catch (err) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid form data' }));
    return;
  }
}

/**
 * Who may read a file's bytes (#57): admin unconditionally, an agent only if it
 * is the file's sender or recipient.
 *
 * Exhaustive over AuthResult BY CONSTRUCTION — a switch with a `never` arm, so
 * adding a fourth mode is a compile error here rather than a silent grant.
 * Written as a POSITIVE test per mode, never "not X ⇒ allow".
 */
export function fileAccessAuthorized(
  auth: AuthResult,
  file: { from_agent: string; to_agent: string }
): boolean {
  switch (auth.mode) {
    case 'admin':
      return true;
    case 'agent':
      // R-377: and its aliases' files, which the same token logs in as.
      return ownsAddress(auth.agentId, file.from_agent) || ownsAddress(auth.agentId, file.to_agent);
    case 'unauthenticated':
      return false; // the dispatcher checked no credential. Never a grant.
    default: {
      const exhaustive: never = auth;
      return exhaustive;
    }
  }
}

