// Tenant and agent-name grammar — ONE validator, applied at every surface that
// writes a tenant name or an agent id (DESIGN_FEDERATION §4 + PR #77's §7
// amendment).
//
// WHY ONE FUNCTION AND NOT THREE CHECKS: "reserved" is not a property of a
// word, it is a property of every writing surface refusing it. §3/§5.1 already
// said `home` was reserved while `POST /agents` would happily create it — a
// reserved word that one door accepts is not reserved, it is documented. The
// lane's finding, and the reason this ships in Phase 1 rather than Phase 2:
// Phase 2's cross-tenant ACL refusal resolves an agent's tenant from its id
// prefix, so a tenant literally named `home` would make every home-scoped
// grant ambiguous between "the fleet" and "that tenant". The refusal cannot be
// correct unless the name could never have been minted.

/** Reserved tenant words, with the reason stated AT the validator so a future
    reader adding one knows what breaks if they don't. */
export const RESERVED_TENANT_NAMES: ReadonlySet<string> = new Set([
  // The home tenant: `namespace = NULL` at the row level, but addressable as a
  // SCOPE word (#77 amendment — a `home`-scoped observer grant sees home
  // traffic). A tenant of this name would make that scope ambiguous.
  'home',
  // The system sender (§6). A tenant called `mesh` could mint `mesh:<name>`
  // ids, and system-originated deliveries are exempt from the admit rule —
  // so the collision is with an exemption, not merely with a label.
  'mesh',
]);

/** Tenant names and agent short-names share one grammar: lowercase alnum with
    inner dashes, 1–63 chars. Deliberately no colon, no uppercase, no dot —
    the colon because FQ ids are `<tenant>:<name>` and a colon in either half
    would make that split ambiguous. */
export const TENANT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type NameRefusal = { ok: false; reason: string };
export type NameOk = { ok: true };
export type NameCheck = NameOk | NameRefusal;

/**
 * Validate a TENANT name (a registration key's namespace, or an agent's
 * namespace on a write). Refuses reserved words and anything outside the
 * grammar.
 */
export function checkTenantName(name: unknown): NameCheck {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'tenant name must be a non-empty string' };
  }
  if (!TENANT_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `tenant name must match ${TENANT_NAME_RE.source} (lowercase letters, digits and dashes; 1-63 chars; no colon)`,
    };
  }
  if (RESERVED_TENANT_NAMES.has(name)) {
    return {
      ok: false,
      reason: `'${name}' is a reserved scope word and cannot be a tenant — it would make scope grants ambiguous between the fleet and that tenant`,
    };
  }
  return { ok: true };
}

/**
 * Validate an agent SHORT name (the tenant-relative half of an FQ id, and the
 * whole id for a home agent minted through /register).
 *
 * Note the asymmetry with POST /agents, which is deliberate: that route keeps
 * its permissive grammar for home/admin-minted agents (§4 — the bus has no id
 * grammar today and tightening it would break existing fleet ids), and gains
 * only the two refusals that protect the FQ split. A minted agent, by
 * contrast, is new and can be held to the full grammar from the start.
 */
export function checkAgentShortName(name: unknown): NameCheck {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, reason: 'agent name must be a non-empty string' };
  }
  if (!TENANT_NAME_RE.test(name)) {
    return {
      ok: false,
      reason: `agent name must match ${TENANT_NAME_RE.source} (lowercase letters, digits and dashes; 1-63 chars; no colon)`,
    };
  }
  if (RESERVED_TENANT_NAMES.has(name)) {
    return { ok: false, reason: `'${name}' is reserved and cannot be an agent name` };
  }
  return { ok: true };
}

/**
 * The two refusals POST /agents gains (§4). It keeps its permissive grammar
 * otherwise — an existing fleet id like `spawner-backend` or one with an
 * underscore must keep working — but it must never mint:
 *   - an id containing ':', which would forge an FQ id and let a home agent
 *     claim membership of a tenant it was never minted into;
 *   - the bare reserved words, for the scope-ambiguity reason above.
 */
export function checkHomeAgentId(id: unknown): NameCheck {
  if (typeof id !== 'string' || id.length === 0) {
    return { ok: false, reason: 'agent id must be a non-empty string' };
  }
  if (id.includes(':')) {
    return {
      ok: false,
      reason: "agent id must not contain ':' — that separator is reserved for fully-qualified tenant ids (<tenant>:<name>)",
    };
  }
  if (RESERVED_TENANT_NAMES.has(id)) {
    return { ok: false, reason: `'${id}' is a reserved word and cannot be an agent id` };
  }
  return { ok: true };
}

/** Compose an FQ id. One place, so the separator is never spelled inline. */
export function fqId(tenant: string, shortName: string): string {
  return `${tenant}:${shortName}`;
}
