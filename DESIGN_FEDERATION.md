# DESIGN: Federated Access

Status: **PLAN — nothing here is implemented.** Per the owner's instruction this is a
plan-only PR; implementation starts only on his explicit approval, and then as separate
PRs (see §11 Phasing).

Author: mesh-planner, 2026-09-05. Grounded in a full code read at HEAD `1f0d793`; every
file:line below was verified against that commit.

---

## 1. What this is and why

A general capability for the bus: let **another project's nodes join this mesh under
server-enforced limits** — key-based registration, tenant isolation, and explicit
action/message-type restrictions — instead of either (a) full fleet membership or
(b) no access at all.

The owner's requirements, verbatim from the originating discussion:

- federation "presents keys for registration and then they're used in future comms,
  so it isn't a freeforall"
- "clear limitations on actions/message types/etc"
- "some nice authn and authz, not just a simple 'hi now we join together'"
- it is **general**: the worked example (Operation PowerOUT, §9) is one use, not the
  target. The two concrete patterns it must serve: **inter-org messaging** and
  **backend → orchestrator messaging**.

### Shape decision

Three shapes were considered (per the fleet's prior analysis): (1) external nodes join
THIS bus under scoped identity; (2) a bridge node relaying between meshes; (3) native
bus-to-bus federation. **This plan is shape 1.** It matches the owner's stated model
(keys → registration → limited comms), requires no new wire protocol, and keeps a single
trust root. Shapes 2 and 3 are non-goals (§10) and nothing below precludes them later.

---

## 2. Constraints this design is built under

- **C1 — Server-side scope binding.** Agents cannot hold admin credentials (removed
  fleet-wide, spawner PR #140) and must never self-declare their tenant. Scope is bound
  to the identity **by the server at registration time**; afterwards the agent presents
  only its normal token and the server enforces. A design where the runtime asserts its
  own scope does not survive the fleet's container model.
- **C2 — Naming must not grant.** A request that names a tenant, agent, or namespace
  grants nothing until an operator-created grant exists. Unknown targets are refused,
  never auto-created.
- **C3 — Pure-bus rule.** Tenant routing/enforcement is legitimately bus work (it decides
  whether a message moves). Anything analytic stays outside.
- **C4 — Compose, don't replace.** Tenant scoping is an **outer gate over the existing
  per-pair ACL** (`aclCheck`, `server/db.ts:387`), not a substitute. Intra-tenant
  pair-level control keeps working exactly as today.
- **C5 — Zero behaviour change until used.** The fleet currently runs with every agent's
  `namespace = NULL` and no registration keys. Everything below must be inert in that
  state. (This also respects the production deploy model: any merge to `main` goes live
  on the next container restart — see #71.)

### Non-preclusion requirements (from the runtime side)

Captured from the mesh-agent builder so the same primitive can later serve org/scenario
concurrency (#41's consumer) without a second isolation mechanism:

| R | Requirement | Where satisfied |
|---|---|---|
| R1 | Many identities per tenant (an org = N agents + human seats) | Keys mint up to `max_agents` identities into one namespace (§4) |
| R2 | Default-deny across tenants, even knowing the exact id | Tenant gate (§6) |
| R3 | Compose with per-pair ACL, not replace it | C4; admit rule (§6) |
| R4 | Topics gated too, or publishes leak across orgs | Tenant gate applied at the per-subscriber delivery check (§6) |
| R5 | Observation scoped to one tenant (no admin cred re-entry for per-org tooling) | Namespace-scoped observers (§7) |
| R6 | Cheap mint AND revoke — hot-path ops, not admin ceremony | One call each; key revocation cascades (§5) |

---

## 3. Concepts

- **Tenant = namespace.** We make the existing, deliberately-inert `agents.namespace`
  column (#41; `server/http-admin.ts:410-420`, `server/db.ts:219`) mean something. Every
  agent belongs to exactly one tenant. `namespace = NULL` **is** the home tenant — the
  current fleet, unchanged.
- **`home` is a reserved word.** For tables that need to name the home tenant (links,
  §5.3), the literal `home` refers to it. Registration keys can never mint into `home`
  (C2: naming a tenant must not grant fleet membership), and `POST /agents` refuses
  `namespace: "home"` (use `null`).
- **Registration key.** An admin-minted, shown-once secret that lets a holder register
  agent identities into ONE named tenant, under limits (count, capabilities, expiry).
  The key authenticates *registration only*; minted agents get normal agent tokens.
- **Federation link.** An admin-created, directional edge between two tenants
  (`from_ns → to_ns`, optionally restricted by kind) that makes cross-tenant delivery
  *possible*. Per-pair ACL is still required on top (C4).
- **Capabilities.** A per-key (inherited per-agent) allowlist of bus operations:
  `send:direct`, `send:file`, `publish`, `subscribe`. Home-tenant agents
  (`minted_by_key IS NULL`) are unrestricted, as today.

---

## 4. Data model (all additive)

```sql
-- New table
CREATE TABLE registration_keys (
  id           TEXT PRIMARY KEY,             -- "regk_" + 8 hex (public id, loggable)
  key_hash     TEXT NOT NULL,                -- sha256 of raw secret; raw shown once
  namespace    TEXT NOT NULL,                -- tenant it mints into; never 'home'
  capabilities TEXT NOT NULL DEFAULT '["send:direct"]',  -- JSON array, §3
  max_agents   INTEGER NOT NULL DEFAULT 16,  -- cap on LIVE (enabled) minted agents, not lifetime (F2)
  expires_at   INTEGER,                      -- gates future REGISTRATIONS only
  revoked_at   INTEGER,                      -- kills the key AND its minted agents (§5.4)
  note         TEXT,
  created_at   INTEGER NOT NULL
);

-- New table
CREATE TABLE federation_links (
  from_ns    TEXT NOT NULL,                  -- namespace or 'home'
  to_ns      TEXT NOT NULL,
  kinds      TEXT NOT NULL DEFAULT '["direct"]',  -- JSON subset of ["direct","file","topic"]
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL,                  -- provenance, same convention as acl.granted_by
  PRIMARY KEY (from_ns, to_ns)
);

-- agents: two additive columns (migration style follows db.ts:208-243)
ALTER TABLE agents ADD COLUMN minted_by_key TEXT;   -- registration_keys.id, NULL = home/admin-minted
ALTER TABLE agents ADD COLUMN disabled INTEGER NOT NULL DEFAULT 0;

-- observers: one additive column (see §7)
ALTER TABLE observers ADD COLUMN namespace TEXT;    -- NULL = global (today's behaviour)
```

Key secrets are generated and hashed exactly like agent tokens
(`generateToken`/`hashToken`, `server/auth.ts:6-17`): 256-bit random, SHA-256 stored,
raw value returned once in the creation response.

**Federated agent ids are namespace-prefixed at the bus level, tenant-relative in
use** *(amended after runtime review — F1)*: an agent minted by a key for namespace
`ns` has fully-qualified (FQ) id `ns:<name>` (server-enforced at registration;
`<name>` follows the existing bare-id grammar). This prevents an external tenant from
claiming fleet-meaningful names (`deploy-helper`, …) — id squatting is refused at mint
time, and a colon-prefixed id is immediately legible in logs and provenance. Existing
home ids contain no `:`; `POST /agents` (admin) additionally refuses new ids containing
`:` unless they match the agent's declared namespace.

**Short-name resolution (tenant-relative addressing).** The tenant prefix must never
leak into agent-visible text: the mesh-agent runtime validates ids against
`^[a-z0-9-]+$` (a colon fails outright), personas reference bare ids literally, and a
tenant-dependent prompt prefix destroys the byte-identical cross-org prompt caching the
runtime depends on. So:

- A sender in tenant `ns` addressing bare `dana` resolves server-side to `ns:dana` —
  and ONLY that. On miss: `AGENT_NOT_FOUND`. Bare names never resolve cross-tenant and
  never fall through to home (C2: no ambiguity, no squat leverage).
- Cross-tenant sends use the FQ form (`other-ns:name`, or the bare home id for linked
  home targets) and still pass the full admit rule (§6).
- Same-tenant deliveries present **short** names in the deliver frame (shared prefix
  stripped from `from`/`to`); cross-tenant deliveries present FQ names. Home-tenant
  agents (NULL) see today's behaviour byte-for-byte.
- The FQ form is canonical everywhere operator-facing: DB rows, admin API, observer
  tap, logs, metrics.

**Own identity is short too** *(F1 follow-up)*. The invariant is: **a tenant agent
never sees a tenant prefix on ANY agent-facing wire surface — its own id included.**
Concretely:

- `POST /register` returns both forms (`{ id: "dana", fq_id: "po-red:dana", token }`);
  the runtime is provisioned with the **short** id as its own name.
- WS auth accepts the short form: the server resolves the agent **by token** (unique
  per agent; the hash-indexed lookup from §5.5 makes this the natural primary key)
  and verifies the presented `agent_id` matches the resolved agent's short or FQ form.
  `auth_ok` echoes the short form.
- Every agent-facing emission is tenant-relative: deliver frames both directions,
  presence events, acks/errors that echo ids, and reminder deliveries. One
  normalization point server-side (strip-own-ns on egress to a tenant socket), not
  per-surface special cases.
- Cross-tenant peers are the single exception: they arrive FQ (`other-ns:name`) by
  design — a distinct grammar is *correct* there, since they are a different kind of
  correspondent and per-tenant runtimes may need to widen their id validation only if
  they opt into cross-tenant contact.

Net effect: the same authored scenario spins up unchanged for N orgs, a tenant's
agents never see their own prefix, and self-loop guards / per-peer keying in consumers
(which compare their configured id against inbound `from`) keep working because both
sides of the comparison live in the same short grammar.

---

## 5. API surface (admin port, same auth conventions as today)

### 5.1 `POST /registration-keys` — admin only
Body: `{ namespace, capabilities?, max_agents?, expires_at?, note? }`.
Refuses `namespace: "home"` (C2) and malformed capability strings.
201 → `{ id, key: "<raw shown once>", namespace, capabilities, max_agents, expires_at }`.

### 5.2 `POST /register` — **authenticates with a registration key**, not admin
`Authorization: Bearer <raw key>`. Body: `{ id, hostname }` (`id` is the bare name;
the server prefixes it — the key holder never writes its own namespace).
Server-side checks, in order: key exists (hash lookup) → not revoked → not expired →
live-population check (`COUNT(*)` of enabled agents with `minted_by_key = key.id` `<
max_agents` — a count, not a counter, so it cannot drift; F2) → resulting FQ id free
*or previously minted by this same key*.
On success: creates the agent with `namespace = key.namespace`,
`minted_by_key = key.id`, and returns the standard one-time agent token (same shape as
`POST /agents`, `server/http-admin.ts:422-427`).

**Re-registration is idempotent per key** *(F2)*: presenting the same key for an FQ id
that key already minted rotates the agent's token (old token invalidated) and clears
`disabled`. This is the scenario-reset path — spin-down/spin-up cycles on the same ids
cost nothing and never exhaust the key; only *distinct live* identities count against
`max_agents`. An id minted by a *different* key is `403` (no cross-key capture).

**The key holder never chooses its namespace or capabilities — they come from the key
(C1).** Failures are uniform 403s (no oracle distinguishing "revoked" from "expired"
to an unauthenticated caller; details go to the server log).

### 5.3 `POST /federation-links` / `DELETE /federation-links` / `GET /federation-links` — admin only
Mirror the `/acl` handlers' conventions (`server/http-admin.ts:162-289`): both
namespaces must exist (at least one registered agent, or `home`) — unknown names are
refused, never created (C2). `granted_by` recorded as provenance, queryable exact/prefix
like ACL. Links are directional; inter-org A↔B needs two.

### 5.4 `DELETE /registration-keys/:id` — admin only — **revocation, R6**
Sets `revoked_at` and, in the same transaction, `disabled = 1` on every agent with
`minted_by_key = :id`. One call tears down a tenant's whole minted population. Key
revocation is **terminal** — it is the kill switch, not the routine teardown. Routine
scenario churn uses per-agent disable + idempotent re-registration (§5.2), which keeps
the key alive across unlimited cycles (F2/R6).
`PATCH /agents/:id {disabled}` (admin) covers single-agent revocation.
Enforcement of `disabled`: refused at WS auth (`server/ws-server.ts:500-515`, alongside
the existing `getAgentById`/`validateToken` checks — and the server closes any live
socket for an agent at the moment it becomes disabled) and at HTTP `resolveAuth`
(`server/http-admin.ts:79-99`).

### 5.5 Performance prerequisite
`getAgentByToken` is a full-table scan with per-row timing-safe compare
(`server/db.ts:278-291`), and WS auth does an id lookup + hash compare. Federation
multiplies identity count (R1/R6), so **#45/#13 (index/lookup by `token_hash`) becomes
a Phase-1 item**, not a someday-perf ticket. (Hash-indexed lookup is standard practice;
the timing-safe compare stays for the final equality check.)

---

## 6. Enforcement — the admit rule

One rule, applied at every point where the server decides "may a message/event from
**agent** A reach B":

**System-originated deliveries are exempt** *(amended after runtime review — F3)*. The
reminder scheduler bypasses the router entirely: it inserts and delivers directly with
the synthetic sender `from_agent = 'mesh'`, which has no agent row
(`server/reminder-scheduler.ts:33-45` — "trusted system sender", delivery at :55-66,
queued drain via `drainQueue`). `ns('mesh')` is therefore *undefined*, and the admit
rule below applies **only to traffic between registered agents**. Explicit rule for
implementers: deliveries whose `from_agent` is the reserved system sender (`'mesh'` —
reminders today, any future system notices) are never tenant-gated, capability-gated,
or ACL-gated; they are addressed to exactly one agent by the server itself. If message
delivery is ever centralized behind one choke point, this exemption must move with it —
a federated tenant silently losing its durable reminders is the failure mode this
paragraph exists to prevent. (`'mesh'` is accordingly a reserved id: registration of
an agent named `mesh`, or any FQ id whose bare name is `mesh`, is refused.)

```
admit(A → B, kind):
  tenant_gate:  ns(A) == ns(B)                    # NULL == NULL ⇒ home; same-tenant passes
                OR link(ns(A) → ns(B)) exists AND kind ∈ link.kinds
  capability:   A.minted_by_key IS NULL           # home agents unrestricted
                OR operation ∈ key.capabilities   # send:direct / send:file / publish / subscribe
  pair_acl:     aclCheck(A, B)                    # unchanged, server/db.ts:387
  admit ⇔ tenant_gate AND capability AND pair_acl
```

Applied at the four existing admit sites found in the code read — these are the only
places a delivery decision is made today, and the tenant gate composes at exactly the
same call sites:

| Site | Today | Change |
|---|---|---|
| Direct send | `server/router.ts:90-94` (`aclCheck` → `ACL_DENIED`) | prepend tenant gate + capability; new error codes `TENANT_DENIED` / `CAPABILITY_DENIED` |
| Topic fan-out | `server/router.ts:229-233` (per-subscriber `aclCheck`, silent skip) | same composition per subscriber — this is what closes R4; publisher also needs `publish` capability at `routePublish` entry (`server/router.ts:190`) |
| WS file send | `server/router.ts:367-371` | same composition; `send:file` capability |
| HTTP file upload | `server/http-admin.ts:725-729` | same composition |

Plus two adjacent surfaces the code read showed carry cross-agent information:

- **Presence**: presence events fan out to `aclRelated` peers (`server/db.ts:393-398`).
  The tenant gate applies to presence delivery too — an org must not observe another
  org's agents flapping (R2's spirit; an admin-created stray cross-tenant ACL edge
  without a link must not leak presence).
- **Subscribe**: `routeSubscribe` (`server/router.ts:303`) checks the `subscribe`
  capability. Topic *names* remain global (pure-bus; a name is not a secret); content
  is protected by the per-subscriber gate above.

Message `kind` needs no new vocabulary: producers hard-code `direct`/`topic`/`file`
(`server/router.ts:119,153,248,281`; files via the `files` table) and `insertMessage`
accepts what producers write (`server/db.ts:428-455`). The capability check happens at
the producer entry points above, so no central kind validator is required — though
adding one at `insertMessage` would be harmless hardening.

---

## 7. Scoped observation (R5)

The observer tap (`observers` table, `server/db.ts:201-205`; admin-granted, bypasses
ACL) is currently all-or-nothing — which would force per-tenant tooling (e.g. a
scenario scorer) to hold what amounts to a global-visibility credential.

Additive change: `observers.namespace TEXT` — `NULL` keeps today's global behaviour;
a non-NULL value delivers only events where **both** endpoints (or the single endpoint,
for presence/registration events) are in that namespace. Cross-tenant traffic (link
traffic) is visible to the **global** tap only — neither tenant's scoped tap sees the
other side's… actually both endpoints' namespaces differ, so link traffic appears in
neither scoped tap; if a tenant tap should see its own agents' cross-tenant traffic,
that is a one-line policy choice (`from ∈ ns OR to ∈ ns`) — **recommended**, since a
tenant watching its own agents is the point. Decision recorded in §12 as D3 with the
recommended default.

Grant surface: `POST /observers` gains an optional `namespace` field. Admin-only, as
today (`server/http-admin.ts` observer routes).

---

## 8. Transport & trust prerequisites (facts from the code read, stated so the plan is honest)

- **P1 — MCP stdio plane (#8).** The stdio MCP server is wired unconditionally
  (`server/server.ts:186-188`) with **no authentication**, and its tools take a
  caller-chosen `as_agent` — including `mesh_acl_allow`/`mesh_acl_deny`
  (`server/mcp-server.ts:205-210, 267-272`), which call `aclGrant`/`aclRevoke`
  directly. This contradicts the README's "a node can't grant itself access" and
  bypasses every guarantee in §6 for anyone with process-stdio access. Today that's
  de-facto "the container operator", i.e. trusted — but this plan's guarantees should
  not ship while that plane is wider than the new front door. **Phase 0 includes the
  decision on #8** (minimum: drop the two ACL tools or gate them on `MESH_ADMIN_TOKEN`;
  `as_agent` impersonation for *sends* is a separate, explicit operator-plane choice).
- **P2 — Transport (#21).** The bus is plaintext `ws://`/`http` (`server/ws-server.ts:401`,
  `server/http-admin.ts:1120`). Registration keys and agent tokens are bearer secrets.
  If a federated project's nodes connect from **outside the Docker host**, a
  TLS-terminating ingress (`wss://` reverse proxy — ops-level, no in-bus TLS work) is a
  hard prerequisite for the first remote tenant. If they run on the same host/network,
  it isn't. **This is open question Q1 (§12).**
- **P3 — Deploy model.** Merge-to-main goes live on the next spawner-mesh restart (#71),
  and a mesh restart flaps every fleet agent's channel. All phases below are inert-until-
  used (C5) precisely so merging is safe and the *restart* is the only scheduling
  decision (owner: spawner-v2).

---

## 9. Worked example — Operation PowerOUT (illustrative only; the capability is general)

PowerOUT: a purple-team workshop where student "organisations" attack/defend each other;
a game backend orchestrates; in-game persona agents (service-desk bots, internal-chat
NPCs) run on the mesh-agent runtime.

| PowerOUT need | Federation mapping |
|---|---|
| Each student org isolated | One tenant per org: keys `regk_…` minted for `po-red`, `po-blue`, … — orgs cannot reach each other or the fleet at all by default (R2) |
| Org's NPCs + tooling | Backend registers N agents per org with its org key (R1), e.g. `po-red:helpdesk-bot` |
| Inter-org play (Darknet chat, attacks) | Links `po-red → po-blue` + `po-blue → po-red`, kinds `["direct"]`, plus per-pair ACL for exactly the personas that should be reachable (C4) |
| Backend → orchestrator | Tenant `po-core`; link `po-core → home`, kinds `["direct"]`; ACL edge `po-core:backend → <orchestrator id>`. The fleet's own agents remain unreachable from every `po-*` tenant (no link) |
| Per-org scoring/monitoring | Scoped observer per org namespace (R5) — no admin credential in game infrastructure |
| Round teardown | One `DELETE /registration-keys/:id` per org (R6) |

Two runtime-side notes on the inter-org row (from the mesh-agent builder's review, so
a phase plan doesn't assume more than exists):

- Cross-org persona contact means those personas **do** see FQ peer ids
  (`po-blue:helpdesk`) — the §4 cross-tenant exception applies to them. This is fine
  for the runtime (inbound `from` is unconstrained and per-peer history keeps the
  cached prompt prefix tenant-agnostic), but it is a fact of the wire, not hidden.
- Cross-tenant contact is **reactive-only** for authored personas as things stand: a
  persona can reply to an FQ peer (it copies the id from the inbound tag) but cannot
  *initiate* contact, because tenants are minted at runtime and authored persona text
  cannot contain a not-yet-existing FQ id. NPC-initiated cross-org contact needs a
  runtime-side mechanism (e.g. scenario-level peer aliases bound at spin-up — mesh-agent
  lane, planned alongside org-concurrency), and must not be assumed working in any
  PowerOUT phasing.

This mapping is also, deliberately, the shape the mesh-agent runtime's org/scenario
concurrency needs (#41's consumer): mint a namespace per scenario org and let this
layer do the isolation. One primitive, two consumers.

---

## 10. Non-goals

- Bus-to-bus federation (shape 3) and relay bridges (shape 2). Nothing here precludes
  them; `federation_links` deliberately names namespaces, not hosts.
- In-bus TLS (#21 stands on its own; §8-P2 is an ops prerequisite, not bus code).
- Delivery-status/expiry semantics (the retention-vs-TTL work, #39 + fleet "#99") —
  related but separate track; federation must not wait on it.
- Any analytics/dashboards (C3). Scoped observers emit raw events; scoring lives outside.
- Per-scenario game logic (objectives, win conditions) — explicitly cut by the owner on
  the runtime side; the bus knows nothing of it.

## 11. Phasing (implementation PRs, each independently mergeable & inert, C5)

| Phase | Content | Depends on |
|---|---|---|
| 0 | #18 (tsc as a gate — cheap, protects everything after), #45/#13 (token-hash lookup), #8 decision (P1) | — |
| 1 | Migrations (§4) + `POST /registration-keys` + `POST /register` + revocation (§5.4) + `disabled` checks at both auth sites. **No enforcement change** — minted agents can exist but namespaces don't gate yet | 0 |
| 2 | `federation_links` API + the admit rule at the four sites + presence + capabilities (§6). Inert while no non-NULL-namespace agent has ever been minted | 1 |
| 3 | Scoped observers (§7) | 1 |
| 4 | README §federation + deploy-contract cross-ref (#71); worked example | 2,3 |

Builder briefs will be functionality-framed per fleet convention, cite this doc + ticket
numbers, and go through the normal review lane; I do not implement.

## 12. Decisions taken (D) and open questions (Q)

- **D1** Tenant = namespace; `home` reserved; NULL = home. (Reuses #41's column; zero
  migration for the fleet.)
- **D2** Keys mint identities; identities keep normal tokens; keys never appear after
  registration. (Owner's stated model.)
- **D3** Scoped tap sees its own agents' cross-tenant traffic (`from ∈ ns OR to ∈ ns`),
  recommended in §7.
- **D4** Registration failures are uniform 403s; detail only in server logs.
- **D5** *(was Q1 — answered by the owner 2026-09-05: "potentially over the
  internet")*: remote tenants are in scope ⇒ the `wss://` TLS-terminating ingress
  (§8-P2) is a **hard prerequisite before the first real tenant connects**. Ops-level
  work (reverse proxy in front of the WS port), not bus code; joins Phase 0.
- **D6** *(was Q2 — answered by the owner 2026-09-05: "yes, direct messages only")*:
  new keys default to `["send:direct"]`; file sending, publish, and subscribe are
  opt-in per key at mint time (or via an admin `PATCH` later).

## 13. Success criteria (runnable once implemented; per-phase)

Phase 1: `bun test server/__tests__/registration-keys.test.ts` — mint/register/limits/
revoke-cascade paths; plus: register with revoked key → 403; 17th *live* mint on max 16
→ 403, but disable one then mint → succeeds (live-count, not lifetime — F2);
re-register an id minted by the same key → new token, old token dead, `disabled`
cleared; re-register an id minted by a different key → 403; registering bare name
`mesh` → 403 (reserved); disabled agent WS auth → `AUTH_FAILED`.

Phase 2: `bun test server/__tests__/tenant-gate.test.ts` — cross-tenant direct without
link → `TENANT_DENIED`; with link but no ACL → `ACL_DENIED`; with both → delivered;
same-tenant unaffected; home↔home (NULL) completely unchanged against the existing
suite (`bun test` green with zero modified existing tests — the regression criterion
for C5); topic publish crosses tenants only via link (R4); capability-stripped agent
`publish` → `CAPABILITY_DENIED`; presence does not cross unlinked tenants; bare-name
send within a tenant resolves and delivers with short names in the frame, bare-name
send to another tenant's agent → `AGENT_NOT_FOUND` even when a link + ACL exist (F1);
a reminder set by a federated agent fires and is delivered to it with no link to home
(F3 — the system-sender exemption regression test).

Phase 3: scoped observer receives own-tenant + own-agents' link traffic, and nothing
else (`server/__tests__/observer-scope.test.ts`).

All phases: `curl` transcripts for §9's PowerOUT flow in the PR description, executed
against a locally-run server.
