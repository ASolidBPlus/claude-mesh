# DESIGN: Internet Ingress for Federated Tenants

Status: **SPEC — nothing here is built.** This is the D5/P2b prerequisite from
`DESIGN_FEDERATION.md`, written at the fleet operator's request. **It changes the
bus's exposure class permanently** (today nothing of the mesh is internet-reachable),
so per the operator's requirement it needs the owner's explicit yes, with the reviewer
in the loop, before anything is configured. The mechanical build is small (a
labels-only reverse-proxy route in the existing pattern, TLS automatic); the decision
is the deliverable here.

Author: mesh-planner, 2026-09-05. Companion to `DESIGN_FEDERATION.md` @ `cad4c9b`.

---

## 1. What changes and why it's a posture decision

Today the bus (WS `:7432`, admin `:7433`) is reachable only on the internal fleet
network. Federation with remote tenants (owner: "potentially over the internet")
requires, for the first time, internet-reachable routes to the bus. The standing
fleet rule — never route the internet at an unauthenticated control surface — is the
constraint this whole spec is built to satisfy.

Exactly two surfaces need exposure, and nothing else:

| Surface | Why a tenant needs it |
|---|---|
| WS (wss://) | The agent connection itself — auth is in-band (first-frame token) |
| Admin port, 3 routes | `POST /register` (key-gated minting), `GET /files/:id` + `GET /messages` (agent-token-gated, node-scoped — file delivery hands agents a `fetch_url` on this port) |

Explicitly **never** exposed: `/metrics` (unauthenticated, full fleet topology — #9),
every ACL/agents/observers/registration-keys admin route, and the MCP plane.

## 2. Requirements (operator's, held as hard)

**R-a — Exact allowlist, default-deny, no fingerprint.** The proxy routes by exact
path + method: `POST /register`, `GET /files/:id`, `GET /messages`. Anything else —
including `/metrics` and all admin routes — returns **404, not 403** (an attacker
learns nothing about what exists behind the proxy). Default-deny: a route is
unreachable unless listed. Two named non-routes, because a miss on them is a write
primitive or a topology read, not a nuisance *(reviewer finding)*: **`POST /files`**
(the upload endpoint — one method qualifier away from the allowed `GET /files/:id`;
a prefix-without-method proxy rule, the common shorthand, would expose it) and
**`GET /metrics`**. Neither exists on the tenant listener (R-b2) — the proxy rule is
belt, the listener is braces.

**R-b — No unauthenticated externally-reachable route.** Every allowed route requires
an `Authorization: Bearer …` header. The proxy enforces **presence and shape**
(`regk_…` on `/register`; a 64-hex agent token on the two reads) and drops
header-less requests at the edge; **validation** stays the bus's (secrets are stored
hashed server-side — the proxy never holds them and never terminates auth). The
shape-check makes the token format a **two-authority fact** *(reviewer finding)*: the
format lives in the bus and in proxy config with nothing pinning them, so a future
token-format change silently rejects valid credentials at the edge — fails closed
(outage, not breach) but presents as "federation is broken". The runbook that ships
with the config states where the second copy lives and that token-format changes must
touch both. On the
bus side these routes are already authenticated: `/register` by registration key
(`DESIGN_FEDERATION.md` §5.2 — uniform 403s), the reads by agent token, node-scoped
(`resolveAuth`, `server/http-admin.ts:79-99`). Net: there is no route where an
unauthenticated internet request reaches bus logic.

**R-b2 — The exposed surface must refuse the admin credential. BLOCKER — bus code,
not proxy config.** `resolveAuth` checks the **admin token first**
(`server/http-admin.ts:88-90`): as the bus stands, an internet-exposed `/messages`
or `/files/:id` is an unconstrained-read route for anyone holding or guessing
`MESH_ADMIN_TOKEN`. "No unauthenticated route" does not cover "admin credential
honoured on an exposed route", and the proxy cannot see inside the bearer. Required
change (lands with federation Phase 1, since it pairs with `/register`): a
**dedicated tenant listener** — a third HTTP listener on its own port serving
*exactly* the three tenant routes. Its auth **derives from `resolveAuth` with the
admin branch omitted** — shared code path, not a reimplementation, so the verified
properties (hashed lookup, timing-safe compare, uniform 401 fallthrough) are
*inherited* rather than re-earned, and a future token-handling fix lands in one place.
**The listener has no admin branch** — a structural absence, not a check: an admin
bearer simply falls through to `getAgentByToken`, matches nothing, and receives the
same 401 as any unknown token — uniform by construction, with **no comparison against
the admin secret ever performed on the internet-facing path**. (A detect-and-reject
implementation — "is this the admin token? → 401" — would itself be the oracle this
section removes; do not build it that way.) The proxy targets this listener; the
admin port (`:7433`) is never proxied at all. This also gives the R-a allowlist defense-in-depth: even a
misconfigured proxy route can only reach the three tenant routes. (A per-Host flag on
the existing listener was considered and rejected: Host is client-influenced unless
the proxy pins it, and a separate listener is the same amount of code with none of
the trust analysis.) **The ingress must not be built until this listener exists.**

The listener also settles the `/metrics` question the right way round *(reviewer
finding)*: the code's safety argument — `http-admin.ts:1121`, "`/metrics` is
unauthenticated by design — this listener binds to the admin port" — is premised on
the admin port being unreachable. Proxying the admin port would have invalidated that
premise and left a proxy rule as the only control. With the tenant listener, the
admin port (and `/metrics` on it) is **never proxied**, so the premise is *preserved*
by construction, not compensated for. The Phase-1 builder brief includes extending
that comment to say the admin port must never be exposed via any ingress — so the
invariant is written where the next maintainer will read it.

**R-c — WS ingress is machine-to-machine.** wss:// TLS termination at the proxy, then
plain forward on the internal network. Gating is the bus's in-band auth: the first
frame must be a valid agent-token auth or the socket is closed (5-second pre-auth
timeout already exists, `server/ws-server.ts:446-453`). No human SSO on this hostname
— it is key-gated m2m by construction. **Open hardening option for the owner:**
per-tenant mTLS client certificates on top. Recommendation (operator concurs; not
pre-clearance — the reviewer may still push back, and their position wins unless the
owner overrules): not for v1 — it doubles tenant onboarding complexity for marginal
gain over token auth + rate limits. The triggers that make it worth revisiting:
tenant count grows past a handful, or the first credential incident. Nothing in this
design precludes adding it then.

**R-d — Rate limits and a kill switch.**
- Proxy level (pre-auth): per-IP connection-rate and request-rate caps on both
  hostnames — bounds pre-auth socket flooding and register-endpoint hammering.
  `/register` is the credential-guessing target and gets the tightest cap, **per
  source IP, not per key** — a guesser doesn't hold a valid key, so per-key limiting
  would never trigger; D4's uniform 403s stay (no oracle about why a guess failed).
- **Numbers are set at config time and recorded in the config PR** *(reviewer
  finding: an unquantified limit bounds nothing)*. Starting points to be tuned with
  measurements: WS ≤ 10 new connections/min/IP; `/register` ≤ 5 req/min/IP; reads
  ≤ 120 req/min/IP. Stated limitation, not implied away: per-IP caps are the weakest
  form against a *distributed* source — they bound a noisy single origin, and the
  kill switch is the answer to a distributed one.
- Bus level (post-auth): per-tenant message caps are a federation Phase-2+ concern,
  noted in `DESIGN_FEDERATION.md` — the proxy cannot see tenants, only IPs.
- **Kill switch:** removing one proxy route block (label flip) returns the bus to
  LAN-only instantly; no bus restart, no state change. The runbook line for it ships
  with the config.

**R-e — Threat model (what the exposure actually buys an attacker):**

| Actor | Can reach | Cannot reach |
|---|---|---|
| Anonymous internet | TLS handshake; 404s; header-less requests dropped at edge; pre-auth sockets for ≤5 s within rate caps | Any bus logic, `/metrics`, any admin route, any unauthenticated read |
| **Stolen registration key** | Mint up to `max_agents` identities in that ONE tenant, with that key's capabilities (default: DMs only); tenant is default-deny isolated, so reach ends at whatever links/ACLs the operator granted that tenant | Other tenants, the home fleet (no link ⇒ unreachable, and probes get `AGENT_NOT_FOUND`), topic creation, observation. **Detection** *(reviewer finding: a polled count with no baseline detects nothing — nobody polls until they already suspect)*: every successful `/register` — including re-registrations — writes a structured log line and increments a per-key mint counter on `/metrics` (internal-only, so this leaks nothing), giving the operator's existing scrape an alertable **delta** against the expected population per key. **Response:** one revoke call cascade-disables everything it minted |
| **Stolen agent token** | That one agent's sends (its capabilities), its own node-scoped reads | Anything another agent or tenant can do; token rotates on re-registration |
| **Stolen/guessed admin token, from the internet** | **Nothing** — the tenant listener (R-b2) has no admin branch, so an admin bearer is indistinguishable from any unknown token, and no admin route is proxied. Without R-b2 this row would read "unconstrained read of all messages/files", which is why R-b2 is a blocker | The admin surface in any form; the admin token is never compared against on the exposed path |
| **Compromised tenant runtime** | Same as stolen key + tokens for its own tenant | Cross-tenant anything; the admin surface |

**Disclosure owed to real third-party tenants** (not an attacker row, but it belongs
in the trust picture): the host operator can observe all bus traffic — a global
observer tap exists by design (`DESIGN_FEDERATION.md` §7), and topic *names* are
globally visible. Any external org onboarding must be told both; neither is hidden
nor hideable.

The worst internet-side outcome is bounded to one tenant's blast radius, which is the
isolation property the federation design already enforces internally.

## 3. Mechanics (small, in the existing pattern)

Two hostnames on the existing labels-only reverse-proxy pattern (same shape as the
fleet's current authenticated ingress routes; TLS automatic):

- `mesh-ws.<domain>` → `spawner-mesh:7432` (WebSocket upgrade, R-c)
- `mesh-api.<domain>` → `spawner-mesh:<tenant listener port>` (R-a allowlist + R-b
  header checks; all other paths 404 at the proxy; the admin port `:7433` is never
  proxied — R-b2)

One bus code change (the R-b2 tenant listener, federation Phase 1). No new containers. Config lives in the spawner-mesh deployment
(same home as the boot wrapper, per the deploy contract #71); the federation Phase-4
README section documents the exposure contract for future operators.

## 4. Sequencing and the gate

- Build only after: the owner's explicit yes on this document + the reviewer's pass
  **+ the R-b2 tenant listener merged** (the operator holds all three gates).
- Needed before: the first REMOTE tenant registers (`DESIGN_FEDERATION.md` D5). Not
  needed for same-host/LAN tenants, Phases 0-3 development, or anything currently
  running — there is no urgency and nothing is blocked while this waits.
- Verification before first use (sandbox-reproducible): the R-a 404 matrix (every
  unlisted path/method), header-less drops on all three routes, a full §9 PowerOUT
  register→send→fetch flow through the proxy, and the kill-switch flip measured to
  cut reachability without disturbing LAN traffic.
