# F4 plan-eval #2 — the v2 section only (B1–B4)

Against `origin/main` @ **7717d16** (main MOVED since F4_EVAL.md's 7988f0f; every line below re-read at 7717d16). v1's
A1–A14 taken as given, not re-verified. Topology image read.

## 1. B1 re-origination — reuse / skip, and `from_agent`
**No recursion risk exists and none is needed.** `routePublish` (`router.ts:581`) and `routeRelay` (`router.ts:232`)
do not call each other on main; the hazard appears only if the Generator calls `routePublish` from the relay path.
**Factoring for PLAN.md:** extract `router.ts:602-711` as `fanOutTopicLocal(db, agentIndex, {topic, from_agent,
payload, content_type, sent_at, expires_at, ephemeral, aclPrincipal})`, call it from both, never call `routePublish`
from `routeRelay` — that makes "does this re-relay?" a *call-site* fact (§5), not a runtime flag.

| routePublish step | re-originated publish |
|---|---|
| size check `:589-593` | **SKIP** — `routeRelay:262` already refused >1 MB |
| `incSent`/`incBytes('in')`/`observePayloadBytes` `:595-597` | **SKIP** — the direct relay path deliberately attributes no local "sent" to a remote id; it counts `incPeerRelay` (`:333`) and `incReceived` inside `deliverOrQueue` (`:117`) |
| `getOrCreateTopic` `:600` | **SKIP** — A6 + `topics.created_by REFERENCES agents(id)` (`db.ts:330`) |
| subscribers + publisher exclusion `:603` | **REUSE**, with the A2/A5 `isRemote` split (`db.ts:860`) |
| per-subscriber `aclCheck` `:639` | **REUSE the mechanism, CHANGE the principal** — H-v2-3 |
| `incTopicFanout` `:640,:646`; copy rows + deliver/queue + `incMsgStatus` `:649-703` | **REUSE** |
| ttl default `:605-611` | **SKIP** — use the `expires_at`/`ephemeral` `routeRelay` derived at `:309-313` (clamps `MAX_TTL_MS`, refuses negatives; `frame.ttl_ms ?? 300_000` loses both) |
| tap `:711` `LOCAL_ONLY` | **SKIP** — must be `crossBorderAudience(db, observerIndex)` (`router.ts:225`) |
| v1 outbound fan-out (A4) | **REUSE — the one step the `topic` DELIVERY arm must NOT have** |

**`from_agent='pod1:publisher'` is storable.** `messages` (`db.ts:312-325`) declares `from_agent TEXT NOT NULL` with
**no FK and no CHECK**; `insertMessage` (`db.ts:1562-1589`) binds it raw. Precedent is live: `routeRelay` stores
`stampedFrom = \`${alias}:${from}\`` (`:299`) through `deliverOrQueue` (`:315-317` → `:125-130`). No schema work.

## 2. B1 `origin` — no headers column exists; use a column
**`messages` has no JSON/headers column** (`db.ts:312-325`); `agents.metadata` (`:210`) and `topics.metadata` (`:332`)
exist, `messages` has none. `buildDeliverFrame` (`router.ts:50-71`) emits exactly ten keys: `type, msg_id, kind, from,
to, topic, correlation_id, payload, content_type, sent_at`. **An extra `origin` breaks nothing and is invisible.** The
SDK does `JSON.parse` (`client.ts:816`) → `switch (frame.type)` (`:877`) → `normalizeDeliver` (`:1085-1097`), which
copies *named* fields and drops unknown keys; `DeliverFrame` (`protocol.ts:107-121`) is compile-time only; the plugin
consumes the SDK's `Inbound` (mesh plugin `0.1.0/server.ts:25,309-332`) so it never sees `origin`. Making it visible
costs three coordinated edits: `protocol.ts DeliverFrame`, `client.ts Inbound` + `normalizeDeliver:1085`, plugin
`meta` (`server.ts:320-332`) — PLAN.md must say whether v1 ships `origin` on the wire only or all the way to agents;
shipping it invisibly is worse than not shipping it. **Recommend a COLUMN**, `messages.origin TEXT` nullable: the
repo's additive-migration idiom is `try { db.exec('ALTER TABLE x ADD COLUMN y'); } catch {}` (`db.ts:415-450`), one
line. A headers column is a bigger change *and* invites non-display use of an attacker-supplied string.

## 3. B2 topic-as-principal — the remote spelling works today; the LOCAL one does not
**Remote target `orch:trollbox` on pod1: ACCEPTED TODAY, no code change.** `aclGrant` (`db.ts:899-901`):
`assertLocalEndpointExists` returns early on any `':'` (`db.ts:821`); `assertPeeringAllowed` (`db.ts:853`) computes
`isRemote` (`:860`) — true, no `agents` row — and requires `hasOutboundPeer('orch')` (`db.ts:1220`). Symmetrically
`orch:trollbox → S` on pod2 requires `hasInboundPeer('orch')` (`db.ts:1206`, `disabled=0`). **Bonus already earned:**
`deletePeeringEdges` (`db.ts:1442-1448`) ranges `'orch:'..'orch;'` on `to_agent` (outbound) / `from_agent` (inbound),
so topic-principal edges die with the peering like agent edges. **`aclCheck` is a pure `(from,to)` SELECT**
(`db.ts:934-938`) with no agent lookup, so a non-agent principal works at check time; the gate is grant-time only.

**BLOCKING: a LOCAL principal spelled `topic:trollbox` is REFUSED by main.** `isRemote('topic:trollbox')` is **true**
(contains `':'`, no `agents` row), so `assertPeeringAllowed` demands a peering aliased `topic` and throws `NO_PEERING`
→ `POST /acl` 409 (`http-admin.ts:375-378`). B2's own recommended spelling cannot be granted. Two further hazards on
that name: `PEER_ALIAS_RE = /^[a-z0-9][a-z0-9-]{0,62}$/` (`db.ts:1035`) admits `topic` and `RESERVED_ALIAS` is only
`'mesh'` (`db.ts:1039`), so an operator minting a peering aliased `topic` reinterprets every local topic principal as
remote — and `deletePeeringEdges('topic', …)` would then delete them all; and if a legacy agent literally named
`topic:trollbox` exists (`POST /agents` has refused `':'` since F0b, `http-admin.ts:632-637`, but `db.ts:835-841`
preserves the old population), `isRemote` flips to false and the topic edge silently becomes an agent edge — the exact
shadowing class the outbound-alias gate at `http-admin.ts:1894-1904` prevents, with **no equivalent gate for a
`topic:` prefix**.

**Recommended spelling.** Remote `<alias>:<topic>` unchanged. Local `topic:<name>` is the right *shape*, but PLAN.md
must ship four edits to make it legal: (1) a `TOPIC_PRINCIPAL_PREFIX='topic:'` exemption inside
`assertPeeringAllowed`'s `isRemote` (`db.ts:860`) so it is neither remote nor required to be an agent; (2) reserve
`topic` at both alias doors (`http-admin.ts:1496`, `:1889`) beside `RESERVED_ALIAS`; (3) refuse a new agent id in the
`topic:` prefix range, mirroring `http-admin.ts:1894-1904`; (4) an F0b-style boot report for pre-existing `topic:*`
agents. Do **not** adopt B2's `orch:topic:trollbox` remote form — a two-colon id, while `docs/FEDERATION.md`
troubleshooting tells operators a remote id has exactly one `':'`. The mapping between the two spellings is
`stampedFrom` (§4), not a shared string.

## 4. One-hop restatement — the bare-`from` check admits a topic principal
`router.ts:258` tests only `Buffer.byteLength(from) > 256 || from.includes(':')`, so `from='trollbox'` passes.
**TRUE.** **Consequence worth pinning:** the receiver already computes `stampedFrom = \`${alias}:${from}\`` (`:299`);
with `from` = the bare topic name, `stampedFrom` **is** `orch:trollbox` — B2's remote principal falls out of existing
code rather than being a new convention. That is why the design is cheap; say so. `aclCheck(stampedFrom, to)` (`:300`)
and `getAgentById(db, to)` (`:298`) are **skipped** for topic kinds (no `to`), replaced by per-subscriber
`aclCheck(stampedFrom, sub)`; the `bad_to` shape check (`:251`) moves behind the kind dispatch (already A4). The
**cross-border tap** (`:327-335`) sets `to = null` and `topic`, and fires **once per border frame**, not once per
fanned-out copy — state that or someone "fixes" the 1-vs-N mismatch later. `incPeerRelay` (`metrics.ts:63-65`) carries
no id of `from`/`to`, so a topic principal cannot leak through it; PLAN.md must state that `('in','delivered')`
(`:333`) means *the frame was accepted at the border*, even when the fan-out filtered everyone. **GAP:** no topic-name
length or charset validation exists anywhere (`routeSubscribe:716-724`, `routePublish:581` validate nothing; the only
`':'` gate in the tree is `POST /agents:632`), so a topic named >256 bytes makes the hub emit a frame its own peer's
`:258` check refuses — silently undeliverable. **A7's "refuse `':'` in new topic names" must also bound length ≤256
bytes.**

## 5. The transit guard, in code terms
```
case 'topic-publish':                       // spoke → hub POST
  if (!isHomeTopic(db, topic)) return refuse(<uniform code>);
  fanOutTopicLocal(...); enqueueOutboundTopicRows(db, topic, …);  // ← ONLY CALL SITE, EVER
  break;
case 'topic':                               // hub → spoke DELIVERY
  fanOutTopicLocal(...); break;             // and nothing else
isHomeTopic(db,t) := topicExists(db,t) && !(t.includes(':') && hasOutboundPeer(db, t.slice(0,t.indexOf(':'))))
```
The predicate is **"`enqueueOutboundTopicRows` has exactly one call site and it is inside the `topic-publish` arm"** —
a static property, checkable by reading, not a boolean threaded through helpers. **BLOCKING wording fix:** B1's "the
mesh where the topic row is local" is **not computable on main** — `routeSubscribe` calls `getOrCreateTopic(db,
frame.topic, agent_id)` unconditionally (`router.ts:721`) with the *full* string, so a spoke subscribed to
`orch:trollbox` **has a local `topics` row named `orch:trollbox`**. Home-ness must be the `hasOutboundPeer`-prefix
test above (A7's rule), not row existence. **Mutants that must red.** (a) Move `enqueueOutboundTopicRows` into code
shared by both arms → the control "a `topic` delivery on pod2 with a `pod3:*` subscriber row produces no `messages`
row with `to_agent='pod3:'`" fails. (b) Delete the `isHomeTopic` guard → a `topic-publish` naming `pod2:games` on the
hub must not produce an outbound row toward pod2.

## 6. Three-mesh in-process fixture — feasible, with three module-global hazards
`border.test.ts:666-800` ("F2b: end to end over two servers") is **one live ws server + one router-only side**: B is
`startWsServer` (`:675`); A is the plain module-level `db` driven by `routeDirect` + `startBorder` (`:707`).
`f2-verify` has no in-process fixture (it drives real checkouts). A third mesh is cheap in shape — the hub needs a
live ws server *and* a border, pod2 needs a live ws server, pod1 stays router-only: **2 live servers + 1 router-only
side** vs today's 1+1. Fixture rules PLAN.md must name:
1. `forwarders` is a **module-global** `Map` keyed by alias only (`border.ts:303`), shared by every
   `startBorder` in the process — two meshes using the same outbound alias overwrite each other.
2. `borderEvents` is a module-global emitter (`border.ts:332-338`); each `startBorder` adds a listener that
   resolves the alias against that **shared** map, so an enqueue on pod1 can drain the hub's forwarder.
   `border.test.ts:33-35` already clears both in `afterEach`.
3. `relayBuckets` (`router.ts:161`) is keyed by alias only, not by db — two receivers with the same inbound
   alias share one rate bucket; `resetRelayBuckets()` (`:165`) exists for exactly this.

→ **Every alias in the fixture must be globally unique**; `afterEach` calls `stopAll()` +
`forwarders.clear()` + `resetRelayBuckets()`; and the second and third servers need port offsets distinct from
`border.test.ts:673`'s `23500 + Date.now()%400`.

## 7. HOLES beyond the questions
- **H-v2-1 (BLOCKING)** — local principal `topic:trollbox` is ungrantable on main (§3).
- **H-v2-2 (BLOCKING)** — "the topic row is local" is not computable (§5).
- **H-v2-3 (BLOCKING) — B1 contradicts B2 on the hub's own fan-out.** B1 says the re-originated publish uses
  "existing per-subscriber ACL, publisher id = `'pod1:publisher'`" (`router.ts:639`) — i.e. the *hub's* admin
  must hold an edge from every remote publisher to every hub subscriber, the per-remote-publisher grant B2
  declares unworkable one mesh over. Fix: the hub's local fan-out gates on the **local topic principal**
  (`aclCheck(db,'topic:trollbox',sub)`); the per-publisher edge
  (`aclCheck(db,'pod1:publisher','topic:trollbox')`) governs only the spoke's *right to post* — two
  enumerable grant classes per topic, and the hub never names a remote agent it cannot see.
- **H-v2-4 — echo.** The outbound fan-out is ONE frame per peering (A4), so it cannot exclude the publisher
  as `router.ts:603` does locally: a pod1 agent subscribed to `orch:trollbox` gets its own post back. Document
  it, or state a suppression rule; do not leave it undecided.
- **H-v2-5 — rate accounting for the hub's fan-out.** One bucket per peering, shared by all kinds, counted
  *before* the kind and dedupe checks (`:276` above `:285`, `:291`) — a busy Troll Box rate-limits that
  peering's **direct** traffic; and the hub's outbound cost is O(pods) per post against an inbound cost of 1,
  an amplification no peering limit bounds. State "size `rate_per_min` for topic volume", or declare per-kind
  buckets out of scope, explicitly.
- **H-v2-6 — dedupe keys.** Safe as designed: hub outbound rows take fresh `crypto.randomUUID()` ids and
  `Forwarder.send` relays `msg_id: row.id` (`border.ts:224`), so pod2 dedupes on `('orch',<new id>)`, disjoint
  from pod1's msg_id. PLAN.md must forbid "preserve the original msg_id across the hub" — it destroys the
  hub's own retry idempotency, for the reason at `router.ts:301-303`.
- **H-v2-7 — topic death takes the remote subscriptions silently.** `deleteAgent` runs `DELETE FROM topics
  WHERE created_by = ?` (`db.ts:788`) and `subscriptions.topic REFERENCES topics(name) ON DELETE CASCADE`
  (`db.ts:337`) under `PRAGMA foreign_keys = ON` (`db.ts:202`): deleting the hub agent that created
  `trollbox` destroys the topic **and every pod's remote subscription row**, while the pods keep their local
  `orch:trollbox` subscriptions and just go quiet. No `DELETE /topics` route exists
  (`http-admin.ts:2082-2083`), so this is the only path — but it is reachable. **A1's FK-less rebuild must
  state which of `subscriptions`' TWO FKs it drops**: only `agent_id` keeps this cascade, both leaves orphan
  rows. Pick, and pin with a test.
- **H-v2-8 — ttl restarts at the hub.** `Forwarder.send` recomputes `ttl = max(1, expires_at - now)`
  (`border.ts:219-220`) and `routeRelay` re-clamps (`:309-313`), so a transited post gets a fresh budget — up
  to 2× total lifetime. Harmless *if* the re-origination derives `expires_at` from the ARRIVING frame's ttl
  (`:313`) rather than `routePublish`'s `?? 300_000` default (`:605-611`); state it.
- **H-v2-9 — metrics.** `incPeerRelay` (`metrics.ts:63-65`) has no `kind` label, so with three relay kinds on
  one peering an operator cannot separate a Troll Box flood from direct traffic — the number H-v2-5 needs.
  `kind` is a **closed set of four** (not agent-chosen, unlike topic names — #136's actual lesson) and is
  **already in `PARTY_FREE_LABELS`** (`metrics.ts:240-242`), so the walker sanctions it today. Add `kind` to
  `mesh_peer_relays_total`; rewrite the brief's "kind is NOT a label" as "topic NAMES are never a label".
- **H-v2-10 — `origin` is attacker-supplied**, from the spoke's server, display-only by decree only. Cap
  ≤256 bytes at the shape check, never route or ACL on it, and pin a test that a `topic` frame carrying
  `origin:'orch:admin'` changes no ACL outcome and no `from_agent`.
- **H-v2-11 — peering count.** A3's same-alias rule plus B3's kinds means N pods cost the hub 2N peering rows
  plus N(N−1) pod↔pod direct rows — arithmetic for FEDERATION.md's example, minted in the drive.
- **H-v2-12 — the unconfirmed assumption is load-bearing.** Kinds are per-**peering**, not per-topic, so
  `topic-publish` on pod→orch lets that pod post to ANY hub topic. "Analytics is read-only for pods" is then
  expressible **only** by withholding `publisher → orch:analytics` on the *spoke* — the wrong side of the
  border. Under H-v2-3's correction the hub's `aclCheck('pod1:publisher','topic:analytics')` is the authority
  and read-only hub topics become a hub-side decision. Strongest argument for B2; make it the sentence that
  sells it to the operator.

## 8. VERDICT
**GO-with-amendments.** The hub-and-spoke shape is right, cheap, and largely falls out of existing code (`stampedFrom`
*is* the remote topic principal; `deletePeeringEdges` already revokes topic edges; the bare-`from` check already
admits a topic name; `messages.from_agent` already stores stamped remote ids). Three items **block on PLAN.md**, not
on the Generator:
1. **Make `topic:<name>` grantable** — `isRemote` (`db.ts:860`) calls it remote and `aclGrant` throws
   `NO_PEERING`. Ship §3's four edits, or pick another local spelling; do not hand the Generator a principal
   the ACL door refuses. (H-v2-1)
2. **Replace "the topic row is local" with the `hasOutboundPeer`-prefix test** — `routeSubscribe:721` creates
   a local `topics` row for `orch:trollbox` on the spoke, so row existence is true everywhere. (H-v2-2)
3. **Resolve B1 vs B2 on the hub's local fan-out** — gate on the local topic principal, not on
   `pod1:publisher → each hub subscriber`, or the hub inherits the enumeration problem B2 exists to remove
   and read-only hub topics become unenforceable. (H-v2-3, H-v2-12)

Then, each a sentence in PLAN.md: extract `fanOutTopicLocal`, never call `routePublish` from `routeRelay`, per §1's
table; `messages.origin TEXT` via the `try { ALTER TABLE … } catch {}` idiom, saying whether `origin` reaches agents
(three edits) or stops at the admin API; bound new topic names to ≤256 bytes as well as no `':'`; state the echo rule
(H-v2-4), shared-bucket cost (H-v2-5), fresh-msg_id rule (H-v2-6), which `subscriptions` FK survives (H-v2-7),
second-hop ttl (H-v2-8), the `kind` label (H-v2-9) and `origin` as untrusted (H-v2-10); plus §6's fixture rules. No
amendment re-decides the operator's topology. B3's kinds table and B4's test list survive intact.
