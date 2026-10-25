// Declaring an app's actions and answering calls to them. An app lists its actions with
// declareAction, then serves them over HTTP (serveActions, below) or over the mesh
// (serveMeshActions, mesh.ts), or both. Each action says how it is reached (`via`), and the app
// publishes a declaration of them all: name, description, schemas, road. The format is a plain
// spec (docs/declare.md), so an app can serve it without this library too.
//
// Every call goes through the same steps, whatever the road:
//   who is calling (the app's caller check) -> the action exists -> `may` -> the input against
//   its schema -> the repeat gate (repeats.ts) -> the handler -> the output against its schema.
import { z } from 'zod';
import { readBody } from './body.ts';
import type { CallerCheck } from './callers.ts';
import { ID_RE, RepeatGate, memoryRepeats, type Answer, type RepeatStore } from './repeats.ts';
import { CALLER_RE, DECLARATION_ACTION, SYSTEM_RE, isActionName } from './vouch.ts';

export const ROUTE_PREFIX = '/actions/v1';
export const MAX_BODY_BYTES = 64 * 1024;
const MAX_DESCRIPTION = 200;

/** The codes this library answers with; a handler's own refusals use other codes. */
export const STANDARD_CODES = ['NOT_A_CALLER', 'NO_ACCESS', 'UNKNOWN_ACTION', 'BAD_INPUT', 'ID_REUSED', 'INTERNAL'] as const;
const REFUSAL_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;

/** An app's answer to "may this caller do this action": anything but 'allow' is a refusal. */
export type Verdict = 'allow' | 'deny' | 'unknown';

/** Who is calling, as the caller check established it. */
export interface Call {
  /** The id access is asked by. */
  caller: string;
  /** The caller's name: what to show. */
  callerName: string;
  /** Where to answer, and where a job's result goes on the mesh: the address that sent the call
   *  (on the mesh, an alias such as `name+mcp`), or the caller's name over HTTP. */
  replyTo: string;
  /** The mesh alias the call came through, if any: for the app's logs, never for access. */
  alias?: string | undefined;
  system: string;
  action: string;
}

/** Who a call is from, once the caller check has passed. */
export interface Who {
  caller: string;
  callerName: string;
  replyTo: string;
  alias?: string | undefined;
}

/** How an action is reached: a mesh participant and the request kind it answers, or a base URL. */
export type Via = { mesh: { to: string; kind: string } } | { http: { url: string } };
const MESH_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const MESH_KIND_RE = /^[a-z][a-z0-9._-]{0,63}$/;

export function checkVia(v: Via, where: string): Via {
  const keys = v !== null && typeof v === 'object' ? Object.keys(v) : [];
  if (keys.length !== 1) throw new Error(`${where}: via must be exactly one of {mesh} or {http}`);
  if ('mesh' in v) {
    const m = v.mesh;
    if (!MESH_ID_RE.test(m?.to ?? '') || !MESH_KIND_RE.test(m?.kind ?? '') || Object.keys(m).length !== 2) throw new Error(`${where}: via.mesh needs {to: a mesh id, kind: ${MESH_KIND_RE}}`);
    return { mesh: { to: m.to, kind: m.kind } };
  }
  if ('http' in v) {
    let u: URL;
    try {
      u = new URL(v.http?.url ?? '');
    } catch {
      throw new Error(`${where}: via.http.url does not parse`);
    }
    const local = u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost');
    if ((u.protocol !== 'https:' && !local) || u.username || u.password || u.search || u.hash || Object.keys(v.http).length !== 1) {
      throw new Error(`${where}: via.http.url must be an https base URL (plain http only on 127.0.0.1), with no credentials, query or fragment`);
    }
    return { http: { url: u.href.replace(/\/$/, '') } };
  }
  throw new Error(`${where}: via must be exactly one of {mesh} or {http}`);
}

const REFUSAL = Symbol('refusal');
export interface Refusal {
  [REFUSAL]: true;
  code: string;
  message: string;
  status: number;
}

/** A handler's own refusal, e.g. refuse('NOTE_NOT_FOUND', 'no note with that id', 404). */
export function refuse(code: string, message: string, status = 409): Refusal {
  if (!REFUSAL_CODE_RE.test(code)) throw new Error(`refuse: code "${code}" is not of the form ${REFUSAL_CODE_RE}`);
  if ((STANDARD_CODES as readonly string[]).includes(code)) throw new Error(`refuse: ${code} is one of the library's own codes`);
  if (!Number.isInteger(status) || status < 400 || status > 499) throw new Error('refuse: status must be a 4xx');
  return { [REFUSAL]: true, code, message, status };
}

const isRefusal = (v: unknown): v is Refusal => typeof v === 'object' && v !== null && (v as Refusal)[REFUSAL] === true;

const JOB_OUTPUT = z.object({ job_id: z.string().regex(ID_RE) }).strict();

export interface Action {
  readonly name: string;
  readonly description: string;
  /** True for an action that changes nothing: it needs no `id` and is never repeat-gated. */
  readonly readOnly: boolean;
  readonly input: z.ZodObject;
  readonly output: z.ZodType;
  /** For a job: the shape of the result that arrives later on the mesh (jobResult, mesh.ts). */
  readonly jobResult: z.ZodType | null;
  readonly via: Via | null;
  readonly handler: (input: never, call: Call) => unknown;
}

/** A changing action's handler also gets the repeat-safe `id`; a read-only one gets none. */
type Handler<In, O> = (input: In, call: Call) => O | Refusal | Promise<O | Refusal>;
type WithId<I extends z.ZodObject> = z.output<I> & { id: string };

/**
 * One action. An action changes something unless it says `readOnly: true`; a changing action
 * takes a repeat-safe `id` in its input (added to the schema if the app's schema has none). A
 * job (`job: {result}`) answers `{job_id}` at once and sends its result later.
 */
export function declareAction<I extends z.ZodObject, O extends z.ZodType>(
  name: string,
  spec: { description: string; input: I; output: O; readOnly: true; via?: Via },
  handler: Handler<z.output<I>, z.input<O>>,
): Action;
export function declareAction<I extends z.ZodObject, O extends z.ZodType>(
  name: string,
  spec: { description: string; input: I; output: O; readOnly?: false; via?: Via },
  handler: Handler<WithId<I>, z.input<O>>,
): Action;
export function declareAction<I extends z.ZodObject, R extends z.ZodType>(
  name: string,
  spec: { description: string; input: I; job: { result: R }; readOnly?: false; via?: Via },
  handler: Handler<WithId<I>, { job_id: string }>,
): Action;
export function declareAction(
  name: string,
  spec: { description: string; input: z.ZodObject; output?: z.ZodType; job?: { result: z.ZodType }; readOnly?: boolean; via?: Via },
  handler: (input: never, call: Call) => unknown,
): Action {
  if (!isActionName(name)) throw new Error(`declareAction: "${name}" is not an action name (lowercase, digits, single underscores, at most 38)`);
  const d = spec.description;
  if (typeof d !== 'string' || d.trim() === '' || d.length > MAX_DESCRIPTION || /[\r\n]/.test(d)) {
    throw new Error(`declareAction ${name}: the description must be one line of 1-${MAX_DESCRIPTION} characters`);
  }
  if (!(spec.input instanceof z.ZodObject)) throw new Error(`declareAction ${name}: the input must be a z.object`);
  if (spec.readOnly !== undefined && typeof spec.readOnly !== 'boolean') throw new Error(`declareAction ${name}: readOnly must be true or false`);
  const isJob = spec.job !== undefined;
  if (isJob === (spec.output !== undefined)) throw new Error(`declareAction ${name}: give exactly one of output or job`);
  if (isJob && !(spec.job!.result instanceof z.ZodType)) throw new Error(`declareAction ${name}: job.result must be a zod schema`);
  if (!isJob && !(spec.output instanceof z.ZodType)) throw new Error(`declareAction ${name}: the output must be a zod schema`);
  const readOnly = spec.readOnly === true;
  let input = spec.input;
  if (!readOnly && !('id' in input.shape)) input = input.extend({ id: z.string().regex(ID_RE) });
  return {
    name,
    description: d,
    readOnly,
    input,
    output: isJob ? JOB_OUTPUT : spec.output!,
    jobResult: isJob ? spec.job!.result : null,
    via: spec.via === undefined ? null : checkVia(spec.via, `declareAction ${name}`),
    handler,
  };
}

export interface CoreOptions {
  /** This app's name, as the declaration names it. */
  system: string;
  /** How the app's actions are reached, unless an action says otherwise. */
  via: Via;
  /** The app's own access check: its own rules, or an access service. Required, with no default. */
  may: (q: Call) => Verdict | Promise<Verdict>;
  /** Where repeat-safe answers are kept. Default: memoryRepeats(). */
  repeats?: RepeatStore | undefined;
  now?: (() => number) | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface ServeOptions extends CoreOptions {
  /** Who may call: agentKeyCallers, bearerCallers or bridgeCallers. Required, with no default. */
  callers: CallerCheck;
}

/** The declaration as it is published: the same for every caller, except `allowed`. */
export function declaration(system: string, via: Via, actions: Action[]) {
  return {
    v: 1 as const,
    system,
    actions: actions.map((a) => ({
      name: a.name,
      description: a.description,
      read_only: a.readOnly,
      via: a.via ?? via,
      input: z.toJSONSchema(a.input, { io: 'input' }),
      output: z.toJSONSchema(a.output, { io: 'output' }),
      ...(a.jobResult === null ? {} : { job: { result: z.toJSONSchema(a.jobResult, { io: 'output' }) } }),
    })),
  };
}

const fail = (status: number, code: string, message: string): Answer => ({ status, body: { ok: false, error: { code, message } } });

/** The road-neutral part of an app's door: everything after the caller is known. Throws at startup on a bad setup. */
export function actionCore(opts: CoreOptions, actions: Action[]) {
  if (!SYSTEM_RE.test(opts.system)) throw new Error(`serve: system "${opts.system}" is not of the form ${SYSTEM_RE}`);
  if (typeof opts.may !== 'function') throw new Error('serve: may is required');
  const via = checkVia(opts.via, 'serve');
  const byName = new Map<string, Action>();
  for (const a of actions) {
    if (byName.has(a.name)) throw new Error(`serve: action ${a.name} is declared twice`);
    byName.set(a.name, a);
  }
  const declared = declaration(opts.system, via, actions);
  const log = opts.log ?? ((line: string) => console.error(line));
  const gate = new RepeatGate(opts.repeats ?? memoryRepeats({ now: opts.now }));

  async function verdictOf(call: Call): Promise<unknown> {
    try {
      return await opts.may(call);
    } catch (e) {
      log(`may threw for ${call.caller} on ${call.action}: ${(e as Error).message}`);
      return 'unknown';
    }
  }

  async function run(a: Action, input: unknown, call: Call): Promise<Answer> {
    let result: unknown;
    try {
      result = await a.handler(input as never, call);
    } catch (e) {
      log(`action ${a.name} threw: ${(e as Error).stack ?? e}`);
      return fail(500, 'INTERNAL', 'internal error; look at the service log');
    }
    if (isRefusal(result)) return fail(result.status, result.code, result.message);
    const output = a.output.safeParse(result);
    if (!output.success) {
      log(`action ${a.name} returned output outside its schema: ${output.error.message}`);
      return fail(500, 'INTERNAL', 'internal error; look at the service log');
    }
    return { status: 200, body: { ok: true, output: output.data } };
  }

  return {
    log,
    actions: byName,
    /** The declaration for this caller, with the actions its `may` allows. */
    async declarationFor(who: Who): Promise<Answer> {
      const allowed = new Set<string>();
      await Promise.all(
        actions.map(async (a) => {
          if ((await verdictOf({ ...who, system: opts.system, action: a.name })) === 'allow') allowed.add(a.name);
        }),
      );
      return { status: 200, body: { ...declared, allowed: actions.map((a) => a.name).filter((n) => allowed.has(n)) } };
    },
    /** One call, from a known caller, with its body as JSON text. */
    async call(action: string, who: Who, bodyText: string): Promise<Answer> {
      const a = byName.get(action);
      if (!a) return fail(404, 'UNKNOWN_ACTION', `${opts.system} has no action ${action}`);
      const call: Call = { ...who, system: opts.system, action };
      const verdict = await verdictOf(call);
      if (verdict !== 'allow') {
        const why = verdict === 'deny' ? 'is not allowed' : 'could not be checked, so it is refused';
        return fail(403, 'NO_ACCESS', `${call.callerName} ${why} to call ${opts.system} ${action}`);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(bodyText);
      } catch {
        return fail(400, 'BAD_INPUT', 'the body is not JSON');
      }
      const input = a.input.safeParse(raw);
      if (!input.success) {
        const issues = input.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || '(input)'}: ${i.message}`);
        return fail(400, 'BAD_INPUT', issues.join('; '));
      }
      if (a.readOnly) return run(a, input.data, call);
      const id = (input.data as { id?: unknown }).id;
      if (typeof id !== 'string' || !ID_RE.test(id)) return fail(400, 'BAD_INPUT', `id: a changing action needs an id of the form ${ID_RE}`);
      const claim = await gate.claim(call.caller, action, id, input.data);
      if (claim.kind === 'reused') return fail(409, 'ID_REUSED', `id ${id} was already used for ${action} with different input; use a new id`);
      if (claim.kind === 'repeat') return { status: claim.answer.status, body: { ...(claim.answer.body as object), repeat: true } };
      const answer = await run(a, input.data, call);
      await claim.finish(answer);
      return answer;
    },
  };
}

const json = (a: Answer) => new Response(JSON.stringify(a.body), { status: a.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/**
 * The HTTP road: one fetch handler for two routes.
 *   GET  /actions/v1           the declaration
 *   POST /actions/v1/<action>  a call; the body is the input JSON
 */
export function serveActions(opts: ServeOptions, actions: Action[]): (req: Request) => Promise<Response> {
  if (typeof opts.callers?.check !== 'function') throw new Error('serveActions: callers is required: agentKeyCallers, bearerCallers or bridgeCallers');
  if (opts.callers.mode === 'mesh') throw new Error('serveActions: meshCallers() checks the mesh stamp, which HTTP has none of; use serveMeshActions');
  const core = actionCore(opts, actions);
  const now = opts.now ?? Date.now;

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const path = url.pathname;
    let action: string;
    if (path === ROUTE_PREFIX && req.method === 'GET') action = DECLARATION_ACTION;
    else if (path.startsWith(`${ROUTE_PREFIX}/`) && req.method === 'POST') action = path.slice(ROUTE_PREFIX.length + 1);
    else return json(fail(404, 'UNKNOWN_ACTION', `no route ${req.method} ${path}; use GET ${ROUTE_PREFIX} or POST ${ROUTE_PREFIX}/<action>`));
    if (action !== DECLARATION_ACTION && !isActionName(action)) return json(fail(404, 'UNKNOWN_ACTION', 'that is not an action name'));

    const body = await readBody(req, MAX_BODY_BYTES);
    if (body === null) return json(fail(413, 'BAD_INPUT', `the body is over ${MAX_BODY_BYTES} bytes`));

    let who: ReturnType<CallerCheck['check']>;
    try {
      who = opts.callers.check({ system: opts.system, action, method: req.method, path, query: url.search.slice(1), headers: req.headers, body, nowMs: now() });
    } catch (e) {
      who = { ok: false, reason: `the caller check threw: ${(e as Error).message}` };
    }
    if (who.ok === true && !(CALLER_RE.test(who.caller) && CALLER_RE.test(who.callerName))) who = { ok: false, reason: 'the caller check named a caller outside its form' };
    if (who.ok !== true) {
      core.log(`refused ${req.method} ${path}: NOT_A_CALLER (${who.reason})`);
      return json(fail(401, 'NOT_A_CALLER', `not a caller this app accepts (${opts.callers.mode} mode)`));
    }
    const caller: Who = { caller: who.caller, callerName: who.callerName, replyTo: who.callerName };
    if (action === DECLARATION_ACTION) return json(await core.declarationFor(caller));

    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      text = '';
    }
    return json(await core.call(action, caller, text));
  };
}
