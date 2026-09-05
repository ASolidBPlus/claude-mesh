# DESIGN v2: Mesh-to-Mesh Federation

**Status: PLAN — nothing here is implemented.** Plan-only PR; implementation starts only on the owner's explicit approval, then as separate PRs (§10). **Supersedes `DESIGN_FEDERATION.md`** (single-bus multi-tenant, merged 2026-09-05 as cad4c9b/414d3df), which the owner scrapped the same day: *"Federated means multiple tenants… why else would we do this if it's all on one bus?"*

**The shape, in one paragraph, because the previous doc's approval never said it plainly:** every organisation runs **its own claude-mesh instance with its own admin token**. Meshes **peer with each other directly and pairwise** — no hub, no shared bus, no shared registry. A mesh joins a peering by **presenting a key the other mesh's admin minted**; after that, agents on one mesh can address and message agents on the peer mesh. **Each admin controls what crosses their own border and which message types** — the sending side decides what may leave, the receiving side decides what may enter, and neither trusts the other's check. Your mesh stays yours; theirs stays theirs.

Author: mesh-planner, 2026-09-05. Grounded in the code at main `74771ee` (functions cited by name; line numbers drift). Inputs folded: the consumer census (mesh-chat's four ACL writers), the runtime's requirements, and what #84 taught about which pieces transfer.

---

## 1. The trust join — read this section first

The hard question moved. On one bus it was *"which namespace may write to which."* Between buses it is: **what does mesh A accept from mesh B, and on whose authority?** The well-known failure mode is each side assuming the other validated, so nobody owns the join. This design names an owner for every check.

| Check | Owner | Consults | On failure |
|---|---|---|---|
| May this mesh (B) connect to my border at all? | **Receiver A** | A's `peers` row for B (minted by A's admin, presented by B) — token, not-disabled, not-expired | socket closed with `AUTH_FAILED`; identical to a bad agent token (no oracle) |
| May this local agent send to a remote id at all? | **Sender B** | B's outbound peering for the alias (B holds a token minted by A) + B's outbound ACL edge `local → A:agent` | `AGENT_NOT_FOUND` — identical to a nonexistent local id (anti-enumeration) |
| May this remote sender reach this local agent? | **Receiver A** | A's inbound ACL edge `B:sender → local` | relay refused with `ACL_DENIED` **to the peer** (the peer is a trusted-enough party to be told), nothing to the remote agent |
| Is this message type allowed across this border? | **Both**, independently | the direction's peering row `kinds` | refused on whichever side finds it; v1 = `direct` only |
| Is this a one-hop message? | **Receiver A** | relay `from` and `to` must be bare local ids (no `:`) | refused; no transit |
| May anyone grant an ACL edge naming a remote id? | **The bus holding the edge** | the peering in that direction must exist | `aclGrant` refuses — whoever writes it (see §5) |

Rules that follow: **every check runs on the side that would suffer if it were wrong; no check is delegated across the border; all checks fail closed.** A peer is authenticated (we know which mesh is talking) but never *trusted* beyond what our own ACL says.

---

## 2. Constraints

- **C1 — One admin per mesh, never shared.** Each mesh keeps its own `MESH_ADMIN_TOKEN`. Peers never hold each other's admin token; a peering key grants registration only.
- **C2 — Naming must not grant.** Addressing a peer alias or remote agent grants nothing until this mesh's admin has (a) registered the peering in that direction and (b) written the ACL edge. Unknown peers/agents are refused, never created.
- **C3 — Pure-bus rule.** Cross-bus routing is bus work; analytics stay outside.
- **C4 — Compose over the existing per-pair ACL.** Remote ids are ordinary endpoints in the existing `acl` table; the peering is an outer gate over them, never a replacement.
- **C5 — Zero behaviour change until a peer key is minted.** Every phase is inert on a mesh with no `peers` rows. Existing suite green with zero modified tests.
- **C6 — Directional independence.** A→B and B→A are separate registrations, separate connections, separate ACL, separately revocable. "Peered" is never a single fact; every API and status names the direction (this is the decision the builder asked to be explicit — see D2 for why the alternative was rejected).

---

## 3. Concepts

- **Peer alias.** The name **this** mesh uses for a remote mesh (`po-red`). Local to the assigning mesh — A may call a mesh `po-red` while that mesh calls A `hq`. No global namespace, so no uniqueness authority is needed (the previous design's reservation logic dies with it). Grammar: `^[a-z0-9][a-z0-9-]{0,62}$`; `mesh` reserved (system sender).
- **Remote id.** `<peer-alias>:<agent>`. The `:` is the structural discriminator: **local agent ids may never contain `:`** (validated at `POST /agents` and `/register`), so any consumer can tell remote from local by syntax, not lookup.
- **Peer key.** Minted by the *receiving* mesh's admin for a named alias; shown once; SHA-256 stored; expiry; revocable. Presented once by the remote mesh's admin to register; never used again (the registration returns a peer token).
- **Peering (directional).** On the receiver: a `peers` row (alias, token hash, kinds, rate cap, disabled). On the sender: an `outbound_peers` row (alias, the receiver's URL, the token the receiver issued). One socket per outbound peering, opened by the **sender**, authenticated as the peer.
- **Relay.** The only frame a peer connection may send: carries the original local sender id and the local target id on the receiver. The receiver stamps `from = <alias>:<sender>` and then treats it as an ordinary direct message.

---

## 4. Data model (each mesh, additive)

```sql
CREATE TABLE peer_keys (          -- minted by THIS mesh's admin for a remote mesh to present
  id TEXT PRIMARY KEY, key_hash TEXT NOT NULL, alias TEXT NOT NULL,
  kinds TEXT NOT NULL DEFAULT '["direct"]', rate_per_min INTEGER NOT NULL DEFAULT 600,
  expires_at INTEGER, revoked_at INTEGER, note TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE peers (              -- inbound peerings: remote meshes allowed to connect to THIS border
  alias TEXT PRIMARY KEY, token_hash TEXT NOT NULL, key_id TEXT NOT NULL,
  kinds TEXT NOT NULL, rate_per_min INTEGER NOT NULL, disabled INTEGER NOT NULL DEFAULT 0,
  registered_at INTEGER NOT NULL, last_alive INTEGER, remote_version INTEGER NOT NULL
);
CREATE TABLE outbound_peers (     -- outbound peerings: remote meshes THIS mesh may send into
  alias TEXT PRIMARY KEY, url TEXT NOT NULL, token TEXT NOT NULL,   -- the receiver-issued token (a secret; this row is the sender's credential)
  kinds TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL, last_alive INTEGER
);
-- messages: no schema change. to_agent / from_agent are TEXT with no FK, so remote ids store as-is.
```
Key secrets: `generateToken`/`hashToken` (auth.ts), exactly as agent tokens. `peers`/`peer_keys` are the receiver's state; `outbound_peers` is the sender's. A mesh that is both (the normal case) has all three.

---

## 5. Enforcement and wire

**5.1 Border listener (receiver side)** — the existing WS server. A peer authenticates with `{type:'auth', agent_id: '<alias>', token, protocol: 1}` — the one addition to the auth frame is the **protocol version**, and the receiver refuses a mismatch loudly (`PROTOCOL_MISMATCH`, logged with both versions) before anything else; `auth_ok` echoes the receiver's version. Peering compatibility is therefore "both sides on a protocol-compatible release", checked at the handshake, not discovered mid-relay. The server resolves the token and the server resolves the token against `peers` *before* `agents` (peers are few; a hash-indexed lookup like #75's, fail-closed on ambiguity, final timing-safe compare — the #75 pattern, duplicated not shared). A peer socket is marked as such in the registry; **a peer connection may send only `relay` frames** — `send`/`publish`/`file_send`/`subscribe`/reminders from a peer socket are refused (`NOT_ALLOWED`), and `relay` from a non-peer socket is refused identically. A `disabled` peer fails auth like a bad token; an already-connected peer that becomes disabled is closed by a sweep on its own fixed timer (the #84 state-backstop rule: a security step never rides the housekeeping tick).

**5.2 Relay frame** — `{type:'relay', v:1, msg_id, from:'<bare local id on sender>', to:'<bare local id on receiver>', kind:'direct', payload, content_type, ttl_ms?}`. Receiver checks, in order, each fail-closed: peer not disabled → `v` supported → `from` and `to` contain no `:` (one hop) → `kind ∈ peers.kinds` → rate cap → `to` exists locally (`getAgentById`) → **inbound ACL** `aclCheck('<alias>:'+from, to)`. On success it becomes an ordinary direct message with `from_agent = '<alias>:<from>'` and is delivered/queued with today's semantics (queue, TTL, drain, retention untouched). The peer receives an `ack` or an `error` per relay; the receiver never contacts the remote *agent*.

**5.3 Outbound (sender side)** — in `routeDirect`, before the existing recipient lookup: if `frame.to` contains `:`, split at the first `:` → alias must have an enabled `outbound_peers` row (else `AGENT_NOT_FOUND`, identical to a nonexistent local id — anti-enumeration and C2) → `kind ∈ outbound kinds` → **outbound ACL** `aclCheck(sender, frame.to)` (the edge names the remote id) → capability of the sender as today. Then the message is stored with `to_agent = frame.to` (remote) and handed to the **border forwarder**: one `MeshClient`-based connection per outbound peering (the SDK already gives reconnect, re-auth, heartbeat, half-open detection — #67), which sends a `relay` and marks the row delivered on the peer's `ack`; on `error` the row is marked failed and the error is surfaced to the local sender as an `error` frame (`REMOTE_REFUSED`, no detail beyond the code — the remote's reason is the remote's business). While the peering socket is down, rows queue exactly like messages to an offline local agent (same TTL, same cleanup, same silent-expiry caveat as fleet "#99" — a known gap, not widened here).

**5.4 The ACL chokepoint for remote ids** — `aclGrant` (the only `INSERT INTO acl`, reached from `POST /acl` and the MCP tool) refuses any edge where either endpoint contains `:` unless the alias has a peering **in the direction the edge implies**: `local → alias:x` requires an enabled `outbound_peers` row; `alias:x → local` requires a non-disabled `peers` row. Whoever writes it — reconciler, consent flow, mirror, admin — this is the one enforcement point (the consumer census: four mesh-chat writers, one of which multiplies edges). Tenancy is never read from a client-supplied field.

**5.5 Replies and addressing.** A local agent receiving `from: 'po-red:helpdesk'` replies to that string; §5.3 routes it. Agents see remote ids exactly as the FQ form; local ids stay bare (the previous design's egress-normalization machinery is not needed: there is no shared prefix to strip). Presence, topics, files, reminders do **not** cross borders in v1 (§9).

**5.6 Revocation.** Receiver: `DELETE /peer-keys/:id` → `peers.disabled=1` in the same transaction; socket closed immediately AND by the sweep (action + state). Sender: `DELETE /outbound-peers/:alias` → forwarder stopped, queued rows to that alias expire normally. Neither side needs the other's cooperation to cut its direction.

---

## 6. Admin API (each mesh, admin port, admin token unless stated)

- `POST /peer-keys {alias, kinds?, rate_per_min?, expires_at?, note?}` → `{id, key (shown once), …}`; `GET /peer-keys` (no hashes); `DELETE /peer-keys/:id` (revoke + disable the peer).
- `POST /peers/register` — **authenticated by a peer key**, `auth: 'handler'` with `{mode:'unauthenticated'}` at the dispatcher (the #84 pattern, retargeted). Body `{remote_version}`. Returns `{alias, token (shown once)}`. Uniform 403 on any failure; structured server log with the discriminator. Idempotent per key (re-register = token rotation).
- `GET /peers` — inbound peerings, state per row (`disabled`, `last_alive`, connected?).
- `POST /outbound-peers {alias, url, token, kinds?}` / `DELETE /outbound-peers/:alias` / `GET /outbound-peers` — the sender-side credential store; `token` is the secret the receiver returned and is never returned by GET.
- `POST /acl` unchanged in shape; gains the §5.4 refusal.

A peering setup, end to end, is therefore: A's admin mints a key for alias `B` → hands it out of band → B's admin `POST A/peers/register` with it → B's admin `POST B/outbound-peers {alias:'A', url:A, token}` → both admins write ACL edges on their own side. Reverse direction: the same four steps with roles swapped.

---

## 7. What transfers from #84 (held) and what does not

Transfers: key mint-once/show-once, SHA-256 storage, expiry, single-transaction revoke ("a secret that authorises a registration" — holder-agnostic); `auth:'handler'` + `resolveRouteAuth` + `{mode:'unauthenticated'}` (exactly the peer-registration case); the migration-chain test (already carved out as #90); the #75 lookup pattern. Does not transfer: `max_agents` (peer limits are kinds + rate, not population); per-agent `disabled` and `closeAgentSocket` (peers get their own link state and their own sweep — right idea, right granularity now); tenant names/reservation (no shared registry to be reserved in; only the grammar and the `:` exclusion survive).

## 8. Worked example — PowerOUT (illustrative; the capability is general)

Each student org = its own mesh (the published image, one container). The orchestrator lives on the host mesh. Inter-org play = pairwise peerings the game backend sets up via each org mesh's admin API as the scenario dictates (org-red mints a key for org-blue and vice versa; each writes edges only for the personas that should be reachable). Backend → orchestrator = org mesh → host mesh registration, host-side inbound edge `org-red:backend → orchestrator`, nothing else from that org can reach the fleet. Round teardown = revoke the peer keys; each org's mesh is otherwise untouched.

**Runtime-side note (mesh-agent builder):** this shape fits the arena *better* than tenants did — `arena/run.sh` already boots one local claude-mesh per arena instance, so org-per-scenario becomes "N mesh instances on distinct ports, peered as the scenario dictates", with no in-bus gating. Three things the previous design cost dissolve (tenant id grammar and egress normalization; an intra-tenant grant capability — a per-org mesh admin is scoped by construction; slug/namespace alignment). What remains theirs: cross-org NPC *initiation* still needs a runtime-side peer-alias mechanism binding an authored name to a runtime `<alias>:<agent>` address — same shape as before, different target.

## 9. Non-goals (v1)

Transit/multi-hop; topics, files, presence, reminders across borders; a global directory of meshes; a negotiated bidirectional link (D2); public-internet exposure of the border (peers reach each other over a network the operators trust — LAN or a tunnel; public exposure is #74's territory, parked as written); analytics.

## 10. Phasing (each PR inert without a peer key; each through the review lane; owner approves this doc first)

| Phase | Content | Depends |
|---|---|---|
| F0 | Retarget #84's salvageable core: `peer_keys` + `peers` tables, `POST /peer-keys` (+list/revoke), `POST /peers/register` (handler-auth), local-id `:` exclusion. No wire change | #90 merged |
| F1 | Inbound border: peer auth on the WS server, `relay` frame + §5.2 checks, §5.4 `aclGrant` refusal, peer-disabled sweep, per-peer metrics | F0 |
| F2 | Outbound border: `outbound_peers` API, `routeDirect` remote branch + outbound ACL, border forwarder on the SDK, ack/error surfacing, queue drain per peering | F1 |
| F3 | Docs (README §federation) and the **release artifact**: peer orgs run a semver-tagged ghcr image cut from a git tag (never `:main`/`:latest`), with the protocol version stated in the tag's release notes; this mesh plans to move from "restart = git checkout" to running the same tagged image once mesh-to-mesh lands, so the #73 deploy contract becomes the peer contract rather than a second one (operator position, spawner-v2). Then the coordinated spawner-mesh redeploy (operator-scheduled) | F2 |

## 11. Decisions and open questions

- **D1** Remote id = `<alias>:<agent>`; local ids may not contain `:`. Aliases are per-mesh.
- **D2** Peering is **two independent directional registrations**, not one negotiated link. Rejected alternative: a negotiated bidirectional link is simpler to display but requires both admins to agree state atomically across two databases nobody jointly owns — the asymmetric case (A accepts B while B has revoked A) is *legitimate*, so the model must represent it; the cost is that every status names its direction, which the API does.
- **D3** The sender opens the socket; the receiver authenticates it with a key it minted. One socket per direction (a single socket carrying both directions is a later optimisation, not v1).
- **D4** v1 crosses the border with `direct` only; kinds are a per-peering allowlist for later widening.
- **D5** Remote refusals reach the local sender as a code only (`REMOTE_REFUSED`), never the remote's reason.
- **Q1 (owner):** v1 = direct messages only across a border — confirm, or name a second kind needed on day one.
- **Q2 (owner):** v1 assumes peers reach each other over a trusted network (LAN/tunnel); public-internet peering waits on #74 — confirm.

## 12. Success criteria (runnable, per phase)

F0: `bun test server/__tests__/peer-keys.test.ts` — mint/list(no hashes)/register/rotate/revoke; revoked/expired/unknown → byte-identical 403; alias grammar; local id with `:` refused at `POST /agents`; existing suite unmodified.
F1: `peer-border.test.ts` — peer auth succeeds/disabled fails identically to bad token; `send` from a peer socket → `NOT_ALLOWED`; `relay` from an agent socket → `NOT_ALLOWED`; relay with `:` in from/to → refused (one hop); kind not in kinds → refused; rate cap → refused; no inbound edge → `ACL_DENIED` to the peer, nothing delivered; with edge → delivered with `from = alias:sender`, queued if offline, drains on reconnect; `aclGrant` naming `alias:x` with no peering → refused, with peering → written, from both HTTP and MCP; disabled peer's socket closed by the sweep driven through the real timer entry point.
F2: `peer-outbound.test.ts` — two real servers in one process; `to = alias:agent` with no outbound peering → `AGENT_NOT_FOUND` identical to unknown local; with peering but no outbound edge → `AGENT_NOT_FOUND`; with both → relayed, acked, marked delivered; remote refusal → local `REMOTE_REFUSED`; peering socket down → row queues and delivers on reconnect; reply from the remote agent arrives with the FQ `from`. And the C5 criterion at every phase: the entire existing suite green with zero modified tests.
