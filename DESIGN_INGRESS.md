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
path + method: `POST /register`, `GET /files/*`, `GET /messages`. Anything else —
including `/metrics` and all admin routes — returns **404, not 403** (an attacker
learns nothing about what exists behind the proxy). Default-deny: a route is
unreachable unless listed.

**R-b — No unauthenticated externally-reachable route.** Every allowed route requires
an `Authorization: Bearer …` header. The proxy enforces **presence and shape**
(`regk_…` on `/register`; a 64-hex agent token on the two reads) and drops
header-less requests at the edge; **validation** stays the bus's (secrets are stored
hashed server-side — the proxy never holds them and never terminates auth). On the
bus side these routes are already authenticated: `/register` by registration key
(`DESIGN_FEDERATION.md` §5.2 — uniform 403s), the reads by agent token, node-scoped
(`resolveAuth`, `server/http-admin.ts:79-99`). Net: there is no route where an
unauthenticated internet request reaches bus logic.

**R-c — WS ingress is machine-to-machine.** wss:// TLS termination at the proxy, then
plain forward on the internal network. Gating is the bus's in-band auth: the first
frame must be a valid agent-token auth or the socket is closed (5-second pre-auth
timeout already exists, `server/ws-server.ts:446-453`). No human SSO on this hostname
— it is key-gated m2m by construction. **Open hardening option for the owner:**
per-tenant mTLS client certificates on top. Recommendation: not for v1 — it doubles
tenant onboarding complexity for marginal gain over token auth + rate limits, and
nothing in this design precludes adding it later.

**R-d — Rate limits and a kill switch.**
- Proxy level (pre-auth): per-IP connection-rate and request-rate caps on both
  hostnames — bounds pre-auth socket flooding and register-endpoint hammering.
- Bus level (post-auth): per-tenant message caps are a federation Phase-2+ concern,
  noted in `DESIGN_FEDERATION.md` — the proxy cannot see tenants, only IPs.
- **Kill switch:** removing one proxy route block (label flip) returns the bus to
  LAN-only instantly; no bus restart, no state change. The runbook line for it ships
  with the config.

**R-e — Threat model (what the exposure actually buys an attacker):**

| Actor | Can reach | Cannot reach |
|---|---|---|
| Anonymous internet | TLS handshake; 404s; header-less requests dropped at edge; pre-auth sockets for ≤5 s within rate caps | Any bus logic, `/metrics`, any admin route, any unauthenticated read |
| **Stolen registration key** | Mint up to `max_agents` identities in that ONE tenant, with that key's capabilities (default: DMs only); tenant is default-deny isolated, so reach ends at whatever links/ACLs the operator granted that tenant | Other tenants, the home fleet (no link ⇒ unreachable, and probes get `AGENT_NOT_FOUND`), topic creation, observation. **Detection:** `GET /registration-keys` live-count audit. **Response:** one revoke call cascade-disables everything it minted |
| **Stolen agent token** | That one agent's sends (its capabilities), its own node-scoped reads | Anything another agent or tenant can do; token rotates on re-registration |
| **Compromised tenant runtime** | Same as stolen key + tokens for its own tenant | Cross-tenant anything; the admin surface — the admin token never traverses this ingress and no admin route is exposed |

The worst internet-side outcome is bounded to one tenant's blast radius, which is the
isolation property the federation design already enforces internally.

## 3. Mechanics (small, in the existing pattern)

Two hostnames on the existing labels-only reverse-proxy pattern (same shape as the
fleet's current authenticated ingress routes; TLS automatic):

- `mesh-ws.<domain>` → `spawner-mesh:7432` (WebSocket upgrade, R-c)
- `mesh-api.<domain>` → `spawner-mesh:7433` (R-a allowlist + R-b header checks; all
  other paths 404 at the proxy)

No bus code changes. No new containers. Config lives in the spawner-mesh deployment
(same home as the boot wrapper, per the deploy contract #71); the federation Phase-4
README section documents the exposure contract for future operators.

## 4. Sequencing and the gate

- Build only after: the owner's explicit yes on this document + the reviewer's pass.
- Needed before: the first REMOTE tenant registers (`DESIGN_FEDERATION.md` D5). Not
  needed for same-host/LAN tenants, Phases 0-3 development, or anything currently
  running — there is no urgency and nothing is blocked while this waits.
- Verification before first use (sandbox-reproducible): the R-a 404 matrix (every
  unlisted path/method), header-less drops on all three routes, a full §9 PowerOUT
  register→send→fetch flow through the proxy, and the kill-switch flip measured to
  cut reachability without disturbing LAN traffic.
