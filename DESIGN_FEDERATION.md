# DESIGN: Federated Access

Status: **PLAN — nothing here is implemented.** Per the owner's instruction this is a
plan-only PR; implementation starts only on his explicit approval, and then as separate
PRs (see §11 Phasing).

Author: mesh-planner, 2026-09-05. Grounded in a full code read at HEAD `1f0d793`; every
file:line below was verified against that commit. Reviewed by the mesh-agent builder
(F1-F3, folded) and by an independent plan evaluator against the code on disk
(**GO-with-amendments**; all ten amendments folded — the notable ones: the admin-port
exposure model for remote tenants (§8-P2b), the topic-ownership rule (§6), admission-
time-only enforcement semantics (§6), and re-registration state purge (§5.2)).

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
- **Terminology guard** *(consumer-review amendment)*: in this design,
  `agents.namespace` means **tenant** — and "tenant" is the word to use in every
  builder brief. mesh-chat's codebase already uses "namespace" for something else
  (the `granted_by` *prefix* convention, `mesh-chat:group:*`); briefs that say
  "namespace" near mesh-chat or its reconciler will get the wrong field filtered.

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
`ns` has fully-qualified (FQ) id `ns:<name>`, server-enforced at registration. **The
bus has no id grammar today** (`POST /agents` accepts any non-empty string,
`server/http-admin.ts:392-396`), so this plan defines one for the paths it adds: bare
names and namespaces both match `^[a-z0-9][a-z0-9-]{0,62}$` (lowercase alphanumeric +
hyphen, ≤ 63 chars — the mesh-agent runtime's grammar, minus the colon we add between
them). Enforced at `POST /register` and `POST /registration-keys`; `POST /agents`
(admin) keeps its permissive grammar for home agents but refuses ids containing `:`
and the reserved bare names `mesh` and `home` (an admin-minted agent literally named
`mesh` would collide with the system sender, §6). This prevents an external tenant
from claiming fleet-meaningful names (`deploy-helper`, …) — id squatting is refused at
mint time, and a colon-prefixed id is immediately legible in logs and provenance.

**Namespace is frozen for minted agents**: `PATCH /agents/:id` refuses `namespace`
changes when `minted_by_key IS NOT NULL` — a minted agent's tenant is its key's tenant
forever (else the `ns:` prefix ↔ `namespace` column correspondence that short-name
resolution depends on desyncs, and a PATCH could silently promote a foreign agent into
the home tenant).

**Short-name resolution (tenant-relative addressing).** The tenant prefix must never
leak into agent-visible text: the mesh-agent runtime validates ids against
`^[a-z0-9-]+$` (a colon fails outright), personas reference bare ids literally, and a
tenant-dependent prompt prefix destroys the byte-identical cross-org prompt caching the
runtime depends on. So:

- A sender in tenant `ns` addressing bare `dana` resolves server-side to `ns:dana` —
  and ONLY that. On miss: `AGENT_NOT_FOUND`. Bare names never resolve cross-tenant and
  never fall through to home (C2: no ambiguity, no squat leverage). **NULL branch,
  explicit:** for a home-tenant sender (`ns = NULL`) resolution is the identity
  function — the presented id is looked up literally, exactly today's behaviour.
  Resolution executes wherever a sender-supplied target id enters the server:
  `routeDirect`'s `frame.to`, `routeFile`'s target, `handleFilePost`'s `to_agent`,
  and the MCP `mesh_send`/`mesh_broadcast` paths (which flow into the same router
  functions).
- Cross-tenant sends use the FQ form (`other-ns:name`, or the bare home id for linked
  home targets) and still pass the full admit rule (§6).
- Same-tenant deliveries present **short** names; cross-tenant deliveries present FQ
  names. Home-tenant agents (NULL) see today's behaviour byte-for-byte.
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
- Every agent-facing emission is tenant-relative. One normalization point server-side
  (strip-own-ns on egress to a tenant socket), not per-surface special cases — and
  "every" is enumerated so no surface is missed *(evaluator amendment)*: `deliver`
  frames from ALL producers (live `routeDirect`, **`drainQueue` replays of stored FQ
  rows** — `server/router.ts:181` — `routePublish`, and the reminder scheduler's
  frames, `server/reminder-scheduler.ts:58`), all three `file_deliver` builders
  (`server/router.ts:421-434, 469-482`, `server/http-admin.ts:773-785`),
  `agent_status` (`server/ws-server.ts:418`) and `presence_list`
  (`server/ws-server.ts:366`) frames, error/ack strings that interpolate ids
  (`server/router.ts:86, 93, 363, 370` — today they'd leak the raw FQ id into
  agent-visible text), and `GET /messages` rows served to an agent-scoped token
  (`server/http-admin.ts:577-587` — an agent reading its own scrollback must not see
  its prefix). The egress-normalization function is applied at frame/response build
  time for whichever agent the bytes are going to.
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

### 5.1 `POST /registration-keys` / `GET /registration-keys` — admin only
Create: body `{ namespace, capabilities?, max_agents?, expires_at?, note? }`.
Refuses `namespace: "home"` (C2) and malformed capability strings.
201 → `{ id, key: "<raw shown once>", namespace, capabilities, max_agents, expires_at }`.
List (audit surface — operators must be able to enumerate keys after creation): returns
every key's public fields + live-minted count, **never** hashes or raw secrets.

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

**Re-registration purges conversation state, keeps topology** *(evaluator amendment —
without this, a re-minted identity inherits its predecessor's mailbox)*: in the same
transaction as the token rotation, the server deletes the agent's **undelivered queued
messages and files, its pending reminders, and its topic subscriptions**. Queued
reminders never expire (`expires_at = null`, `server/reminder-scheduler.ts:44`), so
without the purge a "fresh" scenario incarnation would drain its predecessor's backlog
on first connect — cross-run information leakage. **ACL edges are kept**: they are
admin-granted tenant topology, not conversation state, and purging them would make
every reset an admin ceremony again (R6). If a fresh-ACL reset is wanted, that is key
revocation + a new key — the terminal path.

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

**Enforcement is admission-time only** *(evaluator amendment — stated explicitly so
nobody assumes otherwise)*: `drainQueue` (`server/router.ts:174-188`) and
`drainFileQueue` (:454-488) replay already-admitted rows with no re-check, and that
stays true. A message admitted while a link/ACL existed still delivers after the
link/ACL is removed, on the recipient's next connect. This matches today's ACL
semantics exactly (a revoke does not claw back queued mail) and is the cheap, honest
rule. The compensations are: `disabled` blocks connection (so a disabled agent drains
nothing), and re-registration purges the queue (§5.2). If claw-back semantics are ever
wanted, that is a separate design, not an implicit property.

**Unlinked cross-tenant targets are indistinguishable from nonexistent ones**
*(evaluator amendment — closes an enumeration oracle)*: the existence check runs before
the ACL check today (`server/router.ts:84-87` then :90-94), so a naive "prepend the
tenant gate" would let a prober in tenant A distinguish `AGENT_NOT_FOUND` (id free)
from `TENANT_DENIED` (id exists in tenant B) and enumerate another org's roster.
Rule: when the tenant gate fails **and no link exists** between the tenants, the
response is `AGENT_NOT_FOUND` — identical to a nonexistent target. `TENANT_DENIED`
is returned only when a link exists but the *kind* is not in `link.kinds` (the
requester already legitimately knows of the peer tenant; the error is then a useful
diagnostic, not an oracle).

Applied at the four existing **admission points** found in the code read — the only
places a message is *admitted* today (delivery replays are covered by the
admission-time rule above), and the tenant gate composes at exactly the same call
sites:

| Site | Today | Change |
|---|---|---|
| Direct send | `server/router.ts:90-94` (`aclCheck` → `ACL_DENIED`) | prepend tenant gate + capability; new error codes `TENANT_DENIED` / `CAPABILITY_DENIED` |
| Topic fan-out | `server/router.ts:229-233` (per-subscriber `aclCheck`, silent skip) | same composition per subscriber — this is what closes R4; publisher also needs `publish` capability at `routePublish` entry (`server/router.ts:190`) |
| WS file send | `server/router.ts:367-371` | same composition; `send:file` capability |
| HTTP file upload | `server/http-admin.ts:725-729` | same composition |

In the topic row, "same composition per subscriber" means: the **publisher's**
`publish` capability is checked once at `routePublish` entry; per subscriber, the
composition is tenant gate + the existing per-subscriber `aclCheck` (the subscriber's
own capabilities are not consulted at delivery — capabilities restrict what an agent
*does*, not what it may *receive*).

Plus two adjacent surfaces the code read showed carry cross-agent information:

- **Presence — both surfaces** *(evaluator amendment)*: presence reaches agents on two
  paths, and both get the tenant gate: the `broadcastStatus` fan-out to `aclRelated`
  peers (`server/ws-server.ts:417-425`, helper `server/db.ts:393-398`) **and** the
  on-demand `list_presence` roster (`server/ws-server.ts:356-372`), which builds from
  the same `aclRelated` over all agents and would otherwise leak through a stray
  admin-created cross-tenant ACL edge exactly the way the broadcast would. An org must
  not observe another org's agents flapping — on either path.
- **Subscribe / topic creation** *(evaluator amendment — closes a cross-tenant DoS)*:
  `routeSubscribe` checks the `subscribe` capability. But both `routeSubscribe` and
  `routePublish` call `getOrCreateTopic` (`server/router.ts:209, 308`) — subscribe
  today implicitly **creates** topics, and `topics.created_by` ownership means
  `deleteAgent` cascades the topic and every subscription to it away
  (`server/db.ts:357-360, 150-155`). A federated agent that first-subscribes to a
  not-yet-created home topic would own it, and its teardown would destroy home
  subscriptions. Rule: **for capability-scoped agents (`minted_by_key IS NOT NULL`),
  `getOrCreateTopic` becomes get-or-refuse** (`TOPIC_NOT_FOUND`) — federated agents
  never create or own topics; topic creation stays a home/admin act. Topic *names*
  remain global (pure-bus; a name is not a secret); content is protected by the
  per-subscriber gate above.

Message `kind` needs no new vocabulary: producers hard-code `direct`/`topic`/`file`
(`server/router.ts:120,154,248,281`; files via the `files` table) and `insertMessage`
accepts what producers write (`server/db.ts:428-455`). The capability check happens at
the producer entry points above, so no central kind validator is required — though
adding one at `insertMessage` would be harmless hardening.

---

## 7. Scoped observation (R5)

The observer tap (`observers` table, `server/db.ts:201-205`; admin-granted, bypasses
ACL) is currently all-or-nothing — which would force per-tenant tooling (e.g. a
scenario scorer) to hold what amounts to a global-visibility credential.

Additive change: `observers.namespace TEXT` — `NULL` keeps today's global behaviour;
a non-NULL value delivers a tapped frame iff `ns(from) ∈ ns OR ns(to) ∈ ns` — a
scoped tap sees all of its own tenant's traffic, **including its agents' cross-tenant
(link) traffic in both directions** (D3: a tenant watching its own agents is the
point). Facts of the tap today, so the mechanism is specified against what exists:
the tap emits only `direct|topic|file` message frames (`server/tap.ts:13`) — there
are no presence or registration tap events, and this plan adds none — and `emitTap`
receives ids only, no namespaces (`server/tap.ts:32`). The namespace test uses the
same in-memory id→namespace lookup the router's tenant gate needs anyway (one map,
maintained at register/patch time, shared by both consumers — not a per-emit DB
query).

**The home tenant is scopable too** *(consumer-review amendment)*: `namespace` may be
the reserved word `home`, scoping a tap to home-tenant traffic (`ns = NULL` endpoints)
under the same D3 rule. Without this, `NULL` = global is the *only* way to observe the
fleet — meaning the fleet god view necessarily sees every tenant's intra-org traffic.
With it, the operator chooses per grant: `home`-scoped for fleet observability,
global (`NULL`) only where cross-tenant visibility is actually wanted.

**And "reserved" must be enforced, not asserted** *(lane finding)*: §3/§5.1 already
refuse `home` at `POST /agents` and key minting, but a reserved word is only reserved
if **one validator** refuses it at **every** namespace-writing surface. Rule: a
single tenant-name validator — rejecting `home`, `mesh`, and any future reserved
scope word, with the reason stated at the validator — applied at `POST /agents`,
`PATCH /agents/:id` (the previously-unguarded surface: an admin PATCH could have
minted a tenant literally named `home`, making every `home`-scoped observer grant
ambiguous between fleet scope and that tenant's traffic), and
`POST /registration-keys`.

**Disclosure owed to third-party tenants** — stated here because it is a property of
the design, not a bug: a **global tap exists** and the host operator can hold one, so
the operator *can* observe all bus traffic, including a tenant's intra-org messages;
and **topic names are globally visible** (any consumer that lists topics — e.g. a
channel directory — shows every tenant's topic names; content is gated, names are
not; never encode secrets in a topic name). Any real external org must be told both
at onboarding.

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
  The decision must also cover `mesh_discover`/`mesh_status`, which return the full
  roster — acceptable only while the stdio plane is operator-only.
- **P2 — Transport (#21).** The bus is plaintext `ws://`/`http` (`server/ws-server.ts:401`,
  `server/http-admin.ts:1120`). Registration keys and agent tokens are bearer secrets.
  Remote tenants are in scope (D5), so a TLS-terminating ingress (`wss://` reverse
  proxy — ops-level, no in-bus TLS work) is a hard prerequisite before the first real
  tenant connects.
- **P2b — Admin-port exposure model** *(evaluator amendment — this was a hole)*.
  Federated tenants need more than the WS port: `POST /register` lives on the admin
  port, and file delivery hands agents a `fetch_url` of `/files/<id>` on the admin
  port (fetched with the agent token — `client/src/client.ts:419-433`), as does
  node-scoped `GET /messages`. But the admin port also serves **unauthenticated
  `/metrics`** (`server/http-admin.ts:1121-1132`) exposing every agent id, per-agent
  traffic counters, and ACL-denied counts — the full fleet topology, no credential
  (#9). Rule: the ingress in front of the admin port for tenants is a **route
  allowlist** — exactly `/register`, `/files/:id`, `/messages` — and everything else
  (`/metrics`, all admin routes) is not routed. This is ingress configuration, not bus
  code, but it is part of the D5 prerequisite and the Phase-4 docs must state it.
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

**Tenant-grant refusal** *(consumer-review amendment, upgraded from an obligation to
a bus-side refusal after lane review — this class of hazard would silently defeat
C4)*: consumers that hold the admin token and write ACL edges in bulk can
auto-satisfy the "per-pair ACL on top" layer for a whole tenant the moment a link
exists. The known instance: mesh-chat's ACL reconciler expands orchestrator-role
groups against the entire `GET /agents` roster and grants bidirectional user↔agent
edges — tenant-minted agents would be auto-granted to every orchestrator-tier user.

The first version of this gate read "no link until *every* bulk `granted_by` writer
filters to the home tenant" — a universal quantifier over an unenumerated set,
spanning repositories the link-creator cannot read, held by a person, with no
mechanism. It could only ever be believed released, not proven released. **The bus
owns the ACL table, so the rule is a refusal instead** (lands in Phase 2, before the
links API): **the shared grant path (`aclGrant` — reached from both `POST /acl` and
the MCP grant tool) refuses any edge whose endpoint is a non-home-tenant agent
unless the request carries an explicit `tenant_grant: true` field.** A writer that
doesn't know about tenants — today's reconciler, any spawner:lifecycle-class writer,
any future bulk granter — physically cannot grant into one; a deliberate tenant
grant says so in the request, which is the "explicit, reviewed intent" made a field
instead of a convention. The release condition collapses from "all writers
everywhere comply" to "the refusal is deployed" — verifiable from this repo alone.
The tenancy test reads the bus's own `agents` row (authoritative — never a
client-supplied field, so no absent-field-read-as-null fail-open), and **fails
closed**: an endpoint whose tenant cannot be resolved is refused, not defaulted to
`home`.

The terminology guard (§3) is part of the same finding, not a tidiness item: the
obligation version required every writer to filter by a field whose name means
something *else* in the very codebase holding the known instance — compliance was
fragile by construction; the refusal is immune to the vocabulary. mesh-chat's
reconciler filter (Dinfra/mesh-chat #77, in flight — merge SHA + deploy confirmation
to follow from chat-planner) remains worth shipping as defense-in-depth and hygiene,
but **it is no longer the gate**.

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
revoke-cascade paths; plus: register with revoked key → 403; register with **expired**
key → 403; 17th *live* mint on max 16 → 403, but disable one then mint → succeeds
(live-count, not lifetime — F2); re-register an id minted by the same key → new token,
old token dead, `disabled` cleared, **and predecessor state purged**: queued
messages/files gone, pending reminders gone, subscriptions gone, ACL edges kept
(§5.2); re-register an id minted by a different key → 403; registering bare name
`mesh` → 403 (reserved); id/namespace outside the grammar → 400; `PATCH` namespace on
a minted agent → 403 (frozen); disabled agent WS auth → `AUTH_FAILED` **and** disabled
agent `GET /messages` with its token → 401.

Phase 2: `bun test server/__tests__/tenant-gate.test.ts` — cross-tenant direct without
link → `TENANT_DENIED`; with link but no ACL → `ACL_DENIED`; with both → delivered;
same-tenant unaffected; home↔home (NULL) completely unchanged against the existing
suite (`bun test` green with zero modified existing tests — the regression criterion
for C5); **cross-tenant send with no link → `AGENT_NOT_FOUND` whether or not the
target exists** (the anti-enumeration rule; `TENANT_DENIED` only for kind-not-in-link);
topic publish crosses tenants only via link (R4); capability-stripped agent `publish`
→ `CAPABILITY_DENIED`; **file sends gated at both sites** — WS `routeFile` and HTTP
upload each: cross-tenant without link refused, sender without `send:file` →
`CAPABILITY_DENIED`; federated agent subscribe to a nonexistent topic →
`TOPIC_NOT_FOUND` (never creates — the ownership/DoS rule); presence does not cross
unlinked tenants **on either surface** (`broadcastStatus` fan-out AND the
`list_presence` roster); a message queued while a link existed still delivers after
link removal on next connect (admission-time semantics, explicit); bare-name send
within a tenant resolves and delivers with short names in the frame, bare-name send to
another tenant's agent → `AGENT_NOT_FOUND` even when a link + ACL exist (F1); a
reminder set by a federated agent fires and is delivered to it with no link to home
(F3 — the system-sender exemption regression test).

Phase 3: scoped observer receives own-tenant + own-agents' link traffic, and nothing
else (`server/__tests__/observer-scope.test.ts`).

All phases: `curl` transcripts for §9's PowerOUT flow in the PR description, executed
against a locally-run server.
