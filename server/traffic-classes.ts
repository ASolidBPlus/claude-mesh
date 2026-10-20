import { readFileSync } from 'fs';

// Configurable traffic classes for mesh_messages_sent_total and
// mesh_messages_received_total (R-311). The server itself knows only the
// neutral `kind` of a message; which traffic a deployment wants told apart
// (its heartbeat feeds, say) is the deployment's to declare, in
// MESH_METRICS_CLASSES. server.ts parses it at boot, metrics.ts applies it and
// classifies every counted message against it.

export type TrafficKind = 'direct' | 'topic' | 'file' | 'reminder';
export const TRAFFIC_KINDS: readonly TrafficKind[] = ['direct', 'topic', 'file', 'reminder'];

/** What a counter call knows about one message. `to` is null for a topic post
 *  (it has no single recipient); `topic` is null for everything but topics. */
export interface Traffic {
  kind: TrafficKind;
  from: string;
  to: string | null;
  topic: string | null;
}

export interface ClassRule {
  class: string;
  kind?: TrafficKind[];
  topic?: string;
  from?: string;
  to?: string;
}

export const MAX_CLASS_RULES = 32;
export const MAX_GLOB_LENGTH = 128;
export const CLASS_NAME = /^[a-z][a-z0-9_]{0,31}$/;
/** The class of traffic no rule matched. Reserved, so a rule can't merge
 *  configured traffic into the unmatched bucket by naming it. */
export const UNMATCHED_CLASS = 'other';

const RULE_FIELDS = new Set(['class', 'kind', 'topic', 'from', 'to']);

export type ClassesParse = { ok: true; rules: ClassRule[] } | { ok: false; error: string };

/**
 * MESH_METRICS_CLASSES: inline JSON (starts with `[`) or a path to a JSON file.
 * Unset or empty is no rules, which means no `class` label at all.
 *
 * Every refusal names the rule by its 1-based position, since the label values
 * are the point of the config and a rule silently dropped would move traffic
 * between classes without anyone seeing it.
 */
export function parseTrafficClasses(
  raw: string | undefined,
  readFile: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ClassesParse {
  if (raw === undefined || raw === '') return { ok: true, rules: [] };

  let text = raw;
  if (!raw.trimStart().startsWith('[')) {
    try { text = readFile(raw); } catch (err) {
      return { ok: false, error: `not inline JSON (no leading "[") and the file ${JSON.stringify(raw)} can't be read: ${(err as Error).message}` };
    }
  }

  let doc: unknown;
  try { doc = JSON.parse(text); } catch (err) {
    return { ok: false, error: `not valid JSON: ${(err as Error).message}` };
  }
  if (!Array.isArray(doc)) return { ok: false, error: 'must be a JSON array of rules' };
  if (doc.length > MAX_CLASS_RULES) return { ok: false, error: `${doc.length} rules; at most ${MAX_CLASS_RULES} are allowed` };

  const rules: ClassRule[] = [];
  for (let i = 0; i < doc.length; i++) {
    const r = doc[i] as Record<string, unknown>;
    const refuse = (reason: string): ClassesParse =>
      ({ ok: false, error: `rule ${i + 1} ${JSON.stringify(r).slice(0, 200)}: ${reason}` });

    if (r === null || typeof r !== 'object' || Array.isArray(r)) return refuse('must be an object');
    const unknown = Object.keys(r).filter((k) => !RULE_FIELDS.has(k));
    if (unknown.length > 0) return refuse(`unknown field ${JSON.stringify(unknown[0])}; allowed: class, kind, topic, from, to`);

    if (typeof r.class !== 'string' || !CLASS_NAME.test(r.class)) return refuse(`"class" must match ${CLASS_NAME.source}`);
    if (r.class === UNMATCHED_CLASS) return refuse(`"class" may not be "${UNMATCHED_CLASS}", which is the class of unmatched traffic`);
    const rule: ClassRule = { class: r.class };

    if (r.kind !== undefined) {
      if (!Array.isArray(r.kind) || r.kind.length === 0) return refuse(`"kind" must be a non-empty array of ${TRAFFIC_KINDS.join('|')}`);
      for (const k of r.kind) {
        if (!TRAFFIC_KINDS.includes(k as TrafficKind)) return refuse(`"kind" value ${JSON.stringify(k)} is not one of ${TRAFFIC_KINDS.join('|')}`);
      }
      rule.kind = [...new Set(r.kind as TrafficKind[])];
    }

    for (const field of ['topic', 'from', 'to'] as const) {
      const g = r[field];
      if (g === undefined) continue;
      if (typeof g !== 'string' || g.length === 0 || g.length > MAX_GLOB_LENGTH) {
        return refuse(`"${field}" must be a glob of 1-${MAX_GLOB_LENGTH} characters`);
      }
      // eslint-disable-next-line no-control-regex -- the control set is the point
      if (/[\x00-\x1f\x7f]/.test(g)) return refuse(`"${field}" contains a control character`);
      rule[field] = g;
    }
    rules.push(rule);
  }
  return { ok: true, rules };
}

/**
 * A `*`-only glob, split once at boot into the literal pieces between stars.
 * Matching is anchored prefix + suffix + leftmost indexOf for each middle
 * piece: linear in the subject per piece, with no backtracking, so an operator
 * glob like `*a*a*a*` can't be made slow by an agent-chosen topic name. A
 * regex would be the obvious build, and is exactly the one that can be.
 */
interface Glob { exact: string | null; head: string; tail: string; middle: string[] }

function compileGlob(g: string): Glob {
  const parts = g.split('*');
  if (parts.length === 1) return { exact: g, head: '', tail: '', middle: [] };
  return { exact: null, head: parts[0]!, tail: parts[parts.length - 1]!, middle: parts.slice(1, -1).filter((p) => p !== '') };
}

function globMatch(g: Glob, s: string): boolean {
  if (g.exact !== null) return s === g.exact;
  if (s.length < g.head.length + g.tail.length || !s.startsWith(g.head) || !s.endsWith(g.tail)) return false;
  let pos = g.head.length;
  const end = s.length - g.tail.length;
  for (const piece of g.middle) {
    const at = s.indexOf(piece, pos);
    if (at === -1 || at + piece.length > end) return false;
    pos = at + piece.length;
  }
  return true;
}

export interface CompiledClassRule {
  class: string;
  kinds: ReadonlySet<TrafficKind> | null;
  topic: Glob | null;
  from: Glob | null;
  to: Glob | null;
}

export function compileTrafficClasses(rules: readonly ClassRule[]): CompiledClassRule[] {
  return rules.map((r) => ({
    class: r.class,
    kinds: r.kind ? new Set(r.kind) : null,
    topic: r.topic !== undefined ? compileGlob(r.topic) : null,
    from: r.from !== undefined ? compileGlob(r.from) : null,
    to: r.to !== undefined ? compileGlob(r.to) : null,
  }));
}

/** A remote topic (`alias:<name>`) is another mesh's topic relayed here, so a
 *  topic glob is tried against the part after the alias too. */
function topicMatch(g: Glob, topic: string): boolean {
  if (globMatch(g, topic)) return true;
  const colon = topic.indexOf(':');
  return colon > 0 && globMatch(g, topic.slice(colon + 1));
}

/**
 * The class of one message: the first rule whose every present field matches,
 * else UNMATCHED_CLASS. A field the message doesn't have (a topic glob on a
 * direct send, a `to` glob on a topic post) doesn't match. The result is
 * always a configured class name or UNMATCHED_CLASS, never anything taken
 * from the message, which is what keeps the label's values bounded.
 */
export function classifyTraffic(rules: readonly CompiledClassRule[], t: Traffic): string {
  for (const r of rules) {
    if (r.kinds !== null && !r.kinds.has(t.kind)) continue;
    if (r.topic !== null && (t.topic === null || !topicMatch(r.topic, t.topic))) continue;
    if (r.from !== null && !globMatch(r.from, t.from)) continue;
    if (r.to !== null && (t.to === null || !globMatch(r.to, t.to))) continue;
    return r.class;
  }
  return UNMATCHED_CLASS;
}

/** The label values a rule set can produce, in rule order, `other` last. */
export function classNames(rules: readonly ClassRule[]): string[] {
  return rules.length === 0 ? [] : [...new Set(rules.map((r) => r.class)), UNMATCHED_CLASS];
}
