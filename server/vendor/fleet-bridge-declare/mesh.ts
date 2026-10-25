// The mesh road: an app that lives on the mesh answers its declared actions as mesh messages,
// over its own mesh connection. The library holds no mesh client: the app hands each delivery
// it receives to the handler serveMeshActions returns, and sends the reply text back to `from`.
// The caller is the identity the mesh stamps on each delivery (R-377), set from the authenticated
// connection, so there is nothing to sign. An alias address (`name+mcp`) acts as its identity
// (`name`): attribute to the identity, reply to `from`.
//
//   request  {v:1, kind, action, input, corr}             (action ".declaration" reads the declaration)
//   reply    {v:1, kind, corr, ok:true, output}  or  {v:1, kind, corr, ok:false, error:{code, message}}
//   job      {v:1, kind, job_id, action, ok, output | error}  sent later to the caller (jobResult)
import { z } from 'zod';
import { MAX_BODY_BYTES, MESH_KIND_RE, actionCore, type Action, type CoreOptions } from './actions.ts';
import type { CallerCheck } from './callers.ts';
import { ID_RE } from './repeats.ts';
import { CALLER_RE, DECLARATION_ACTION, isActionName } from './vouch.ts';

const CORR_RE = /^[A-Za-z0-9_-]{8,64}$/;
/** A sender: a bare id, or an alias address `<id>+<alias>`. A federated or topic sender
 *  (`topic:...`, `peer/agent`) is never a caller. */
const MESH_SENDER_RE = /^([a-z0-9][a-z0-9-]{0,62})(?:\+[A-Za-z0-9_.-]{1,64})?$/;

/**
 * The identity behind a delivery, or why it is refused. The mesh stamps `identity` from the
 * connection; an alias sender must carry it, and its part before `+` must be that identity. A
 * plain sender with no stamp (a mesh from before aliases) is itself. The mesh SDK fills a
 * missing stamp with `from`, so a `+` sender whose identity equals `from` had no stamp: refused.
 */
export function meshIdentity(d: { from: string; identity?: string | undefined }): { ok: true; identity: string } | { ok: false; reason: string } {
  const m = MESH_SENDER_RE.exec(d.from);
  if (!m) return { ok: false, reason: 'not a mesh id or alias address' };
  const base = m[1]!;
  const isAlias = base !== d.from;
  if (d.identity === undefined) return isAlias ? { ok: false, reason: 'an alias sender with no identity stamp' } : { ok: true, identity: base };
  if (d.identity !== base) return { ok: false, reason: `the identity stamp ${d.identity} is not ${d.from}'s` };
  return { ok: true, identity: d.identity };
}

/** Mesh mode: the caller is the mesh's stamped sender. Only serveMeshActions takes it. */
export function meshCallers(): CallerCheck {
  return {
    mode: 'mesh',
    check: () => ({ ok: false, reason: 'the mesh stamp is checked by serveMeshActions, not over HTTP' }),
  };
}

const Request = z.object({ v: z.literal(1), kind: z.string(), action: z.string(), input: z.unknown().optional(), corr: z.string() }).strict();

/** One delivery as the app's mesh client reports it (the SDK's Inbound): `from` is the address
 *  that sent it, `identity` the mesh's stamp of who is behind it, `alias` the alias session. */
export interface MeshDelivery {
  from: string;
  identity?: string | undefined;
  alias?: string | undefined;
  payload: string;
}

export interface MeshServeOptions extends CoreOptions {
  /** Must be meshCallers(): explicit, like every caller mode. */
  callers: CallerCheck;
}

/**
 * The handler for the app's mesh deliveries. It answers with the reply text to send back to
 * `from`, or null when the delivery isn't a request of this app's kind (not ours: ignore it).
 */
export function serveMeshActions(opts: MeshServeOptions, actions: Action[]): (d: MeshDelivery) => Promise<string | null> {
  if (opts.callers?.mode !== 'mesh') throw new Error('serveMeshActions: callers must be meshCallers()');
  if (!('mesh' in (opts.via ?? {}))) throw new Error('serveMeshActions: via must be {mesh: {to, kind}}');
  const core = actionCore(opts, actions);
  const kind = (opts.via as { mesh: { kind: string } }).mesh.kind;

  return async (d: MeshDelivery): Promise<string | null> => {
    if (d.payload.length > MAX_BODY_BYTES) return null;
    let parsed: z.infer<typeof Request>;
    try {
      const r = Request.safeParse(JSON.parse(d.payload));
      if (!r.success) return null;
      parsed = r.data;
    } catch {
      return null;
    }
    if (parsed.kind !== kind || !CORR_RE.test(parsed.corr)) return null;
    const reply = (body: unknown) => JSON.stringify({ v: 1, kind, corr: parsed.corr, ...(body as object) });
    const id = meshIdentity(d);
    if (!id.ok || !CALLER_RE.test(id.identity)) {
      core.log(`refused a mesh request from ${JSON.stringify(d.from)}: NOT_A_CALLER (${id.ok ? 'an identity outside the caller form' : id.reason})`);
      return null;
    }
    const alias = d.from !== id.identity ? d.from : d.alias;
    const who = { caller: id.identity, callerName: id.identity, replyTo: d.from, alias };
    if (parsed.action === DECLARATION_ACTION) return reply((await core.declarationFor(who)).body);
    if (!isActionName(parsed.action)) return reply({ ok: false, error: { code: 'UNKNOWN_ACTION', message: 'that is not an action name' } });
    const answer = await core.call(parsed.action, who, parsed.input === undefined ? '' : JSON.stringify(parsed.input));
    return reply(answer.body);
  };
}

/**
 * The message that carries a job's result to its caller: send it on the mesh to call.replyTo.
 * Throws if the result is outside the action's declared result shape, so a bad result is never sent.
 */
export function jobResult(a: Action, kind: string, job: { job_id: string } & ({ ok: true; output: unknown } | { ok: false; code: string; message: string })): string {
  if (a.jobResult === null) throw new Error(`jobResult: ${a.name} is not a job`);
  if (!MESH_KIND_RE.test(kind)) throw new Error(`jobResult: kind is not of the form ${MESH_KIND_RE}`);
  if (!ID_RE.test(job.job_id)) throw new Error(`jobResult: job_id is not of the form ${ID_RE}`);
  const base = { v: 1, kind, job_id: job.job_id, action: a.name };
  if (!job.ok) return JSON.stringify({ ...base, ok: false, error: { code: job.code, message: job.message } });
  const out = a.jobResult.safeParse(job.output);
  if (!out.success) throw new Error(`jobResult: ${a.name}'s result is outside its declared shape: ${out.error.message}`);
  return JSON.stringify({ ...base, ok: true, output: out.data });
}
