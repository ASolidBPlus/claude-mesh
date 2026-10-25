// The published format (docs/declare.md) as schemas, for whoever reads it: a client listing an
// app's actions, a tool that checks an app serves the format, or an app written without this
// library. They describe the wire, nothing more; each is strict, so a field the spec doesn't
// name is refused rather than ignored.
import { z } from 'zod';
import { MESH_KIND_RE } from './actions.ts';
import { ID_RE } from './repeats.ts';
import { ACTION_RE, SYSTEM_RE } from './vouch.ts';

const JsonSchema = z.record(z.string(), z.unknown());
const ActionName = z.string().regex(ACTION_RE).refine((n) => !n.includes('__'), 'an action name has no "__"');

export const ViaFormat = z.union([
  z.object({ mesh: z.object({ to: z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/), kind: z.string().regex(MESH_KIND_RE) }).strict() }).strict(),
  z.object({ http: z.object({ url: z.string().url() }).strict() }).strict(),
]);

export const DeclarationFormat = z
  .object({
    v: z.literal(1),
    system: z.string().regex(SYSTEM_RE),
    actions: z.array(
      z
        .object({
          name: ActionName,
          description: z.string().min(1).max(200).regex(/^[^\r\n]*$/),
          read_only: z.boolean(),
          via: ViaFormat,
          input: JsonSchema,
          output: JsonSchema,
          job: z.object({ result: JsonSchema }).strict().optional(),
        })
        .strict(),
    ),
    /** The actions the reading caller may call. */
    allowed: z.array(ActionName),
  })
  .strict()
  .refine((d) => new Set(d.actions.map((a) => a.name)).size === d.actions.length, 'action names are unique')
  .refine((d) => d.allowed.every((n) => d.actions.some((a) => a.name === n)), 'allowed names only declared actions');

const ErrorFormat = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{2,47}$/), message: z.string() }).strict();

/** A call's answer over HTTP: the body of the response. */
export const AnswerFormat = z.union([
  z.object({ ok: z.literal(true), output: z.unknown(), repeat: z.literal(true).optional() }).strict(),
  z.object({ ok: z.literal(false), error: ErrorFormat, repeat: z.literal(true).optional() }).strict(),
]);

const Corr = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const MeshRequestFormat = z.object({ v: z.literal(1), kind: z.string().regex(MESH_KIND_RE), action: z.string(), input: z.unknown().optional(), corr: Corr }).strict();

export const MeshReplyFormat = z.union([
  z.object({ v: z.literal(1), kind: z.string(), corr: Corr, ok: z.literal(true), output: z.unknown(), repeat: z.literal(true).optional() }).strict(),
  z.object({ v: z.literal(1), kind: z.string(), corr: Corr, ok: z.literal(false), error: ErrorFormat, repeat: z.literal(true).optional() }).strict(),
  // the declaration, read over the mesh
  z.object({ v: z.literal(1), kind: z.string(), corr: Corr, system: z.string(), actions: z.array(z.unknown()), allowed: z.array(z.string()) }).strict(),
]);

export const JobMessageFormat = z.union([
  z.object({ v: z.literal(1), kind: z.string(), job_id: z.string().regex(ID_RE), action: ActionName, ok: z.literal(true), output: z.unknown() }).strict(),
  z.object({ v: z.literal(1), kind: z.string(), job_id: z.string().regex(ID_RE), action: ActionName, ok: z.literal(false), error: ErrorFormat }).strict(),
]);
