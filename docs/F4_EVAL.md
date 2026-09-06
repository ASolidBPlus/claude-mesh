# F4 plan-eval — "topics across peerings" (brief v0, 2026-09-06 14:20Z)

Evaluated against `origin/main` @ **7988f0f**, read from disk, not from the brief. All citations are
`file:line` at that SHA.

## 1. CLAIM CHECK

| # | Claim (brief) | Verdict | Evidence |
|---|---|---|---|
| 1 | `routeRelay` is at router.ts:199 | **FALSE (stale)** | `export function routeRelay(` is `server/router.ts:232`. Every line number in the brief's "What exists" is stale by 30–50 lines. |
| 2 | `routeRelay` refuses `kind !== 'direct'` "at :220" | **TRUE, wrong line** | `server/router.ts:253` — `if (kind !== 'direct') return refuse('bad_kind');` |
| 3 | one hop: `from`/`to` bare, colon refused | **TRUE** | `server/router.ts:258-259` — `if (Buffer.byteLength(from,'utf8') > 256 \|\| from.includes(':')) return refuse('from_not_one_hop');` and the `to` twin. |
| 4 | rate bucket BEFORE cheaper checks | **TRUE** | `server/router.ts:276` `if (!withinRate(alias, peer.rate_per_min, now))`, above kinds (285) and dedupe (291). |
| 5 | `peers.kinds` must include kind (":250-252") | **TRUE, wrong line** | `server/router.ts:285` — `if (!Array.isArray(allowedKinds) \|\| !allowedKinds.includes(kind)) return refuse('kind_not_permitted');` |
| 6 | dedupe on `(peer_alias, remote_msg_id)`; `to` must be local; inbound edge `aclCheck(alias:from,to)` | **TRUE** | `server/router.ts:291`, `:298`, `:299-300`. |
| 7 | `withinRate` counts EVERY relay | **TRUE** | `server/router.ts:172-181`; the doc comment at `:169-171` states it, and `b.count += 1` precedes the `<= limitPerMin` test. |
| 8 | `routeDirect` remote branch: ACL first, then `outbound_peers.kinds` must include `'direct'` | **TRUE** | `server/router.ts:374` (`const colon = frame.to.indexOf(':')`), ACL at `:400`, kinds at `:409-412`. Range in brief (336-428) is stale; actual 374-478. |
| 9 | row inserted with the FQ remote id; `borderEvents.emit('enqueued', alias)` | **TRUE** | `server/router.ts:446-455` (`to_agent: frame.to, // the FQ remote id`), emit at `:472`. |
| 10 | the forwarder "ranges rows by `to_agent` prefix" | **TRUE** | `server/db.ts:1293-1300` `DRAIN_OUTBOUND_SQL`: `WHERE to_agent >= ? AND to_agent < ?` bound with `` `${alias}:` ``/`` `${alias};` `` at `db.ts:1310`. |
| 11 | `routePublish` at :534, `getOrCreateTopic`, subscribers from `subscriptions`, publisher excluded, per-subscriber `aclCheck`, per-subscriber copy `to_agent = subscriber`, online→deliver, offline→queue, ttl 0→dropped | **TRUE, wrong line** | `server/router.ts:581` (def), `:600`, `:603`, `:639`, `:659-668` (online insert), `:690-702` (offline insert), `:692` (`ttl===0` → dropped). |
| 12 | filtered drops counted in `mesh_topic_fanout_total{outcome=filtered}`, no party label | **TRUE** | `server/router.ts:640`; `server/metrics.ts:100-102`, `:232-234`. |
| 13 | peerings are DIRECTIONAL; drive P1 reply edge = 409 | **TRUE** | `server/db.ts:864-871` (`hasInboundPeer` for a remote `from`, `hasOutboundPeer` for a remote `to`); `f2-verify/run-fe317e8.jsonl` `p1_reply_edge_at_A","status":409`. |
| 14 | `aclGrant` refuses edges naming remote ids without a live peering / accepts them when one exists | **TRUE** | `server/db.ts:896-903` calls `assertPeeringAllowed` (`:853-871`); `hasInboundPeer` requires `disabled = 0` (`db.ts:1206-1209`). |
| 15 | `getTopicSubscribers` returns rows with colon agent_ids | **PARTLY — the query would, the schema forbids the rows** | `server/db.ts:1801-1804` is `SELECT agent_id FROM subscriptions WHERE topic = ?` with no filter, so it *would* return `a:sub`. But `subscriptions.agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE` (`db.ts:336`) with `PRAGMA foreign_keys = ON` (`db.ts:202`) makes the INSERT throw. See HOLE H1. |
| 16 | `endOutboundPeering` deletes ACL edges | **TRUE** | `server/db.ts:1402` `const edges = deletePeeringEdges(db, alias, 'outbound');` (`:1442-1448`). |
| 17 | "remote subscriptions on B … deleted with the inbound peering row (mirrors #113)" | **FALSE as stated — no such hook exists** | The only inbound edge deletion is in `upsertPeer` on a NON-rotation re-registration (`db.ts:1507`). `revokePeerKey` (`db.ts:1153-1162`) sets `peers.disabled = 1` and deletes **nothing**. There is no `endInboundPeering` and no `DELETE /peers/:alias` route (`http-admin.ts:1930-1940`). |
| 18 | topic names may contain `':'` today | **TRUE** | No topic-name validation exists anywhere: `routeSubscribe` (`router.ts:716-724`) and `routePublish` (`router.ts:581`) validate nothing; `handleMeshSubscribe` (`mcp-server.ts:377-380`) passes the string through; the only `':'` gate in the tree is `POST /agents` (`http-admin.ts:530`). |
| 19 | "`peers.kinds`/`outbound_peers.kinds` gain two values" is a schema/validation change | **PARTLY — no code change needed** | Both columns are free-form JSON string arrays with **no allowlist**: `http-admin.ts:1386-1392` (`POST /peer-keys`) and `:1794-1800` (`POST /outbound-peers`) accept any `string[]`. Minting `["direct","topic"]` works on main today. The change is docs + the two new `routeRelay` branches only. |
| 20 | `mesh_peer_relays_total{direction,outcome}` gains no label | **TRUE, but see H8** | `server/metrics.ts:376-396`. Per-alias series only appear when `MESH_METRICS_IDENTITY_LABELS=1`; the default renders `{direction,outcome}` aggregated. `direction` values today are asymmetric: `'in'` (`router.ts:333`) vs `'outbound'` (`border.ts:230`). |

---

## 2. THE OPEN ITEMS

### 2.1 Does the forwarder tolerate `to_agent = 'a:'` with `kind='topic'`?

**The range query: YES. The send path: NO.**

`server/db.ts:1293` — `SELECT * FROM messages WHERE to_agent >= ? AND to_agent < ? AND
delivered_at IS NULL AND failed_code IS NULL AND (expires_at IS NULL OR expires_at >= ?) AND
sent_at >= ? ORDER BY sent_at LIMIT ?`, bound with `` `${alias}:` `` and `` `${alias};` `` (`db.ts:1310`). `'a:' >= 'a:'` is true, so a
bare-alias row **is in range** and is selected, and the `idx_messages_to_agent` plan assertion
(`server/__tests__/border.test.ts:143-154`) is unaffected. `expireStaleOutbound` (`db.ts:1316-1326`)
and `endOutboundPeering` (`db.ts:1396-1402`) use the identical bounds, so expiry and revocation
sweep the row too — that is the property that makes the bare-alias shape attractive.

What breaks is `Forwarder.send`: `const remote = row.to_agent!.slice(row.to_agent!.indexOf(':') + 1)`
(`border.ts:218`) yields `''` for `to_agent='a:'`, which the receiver refuses at `router.ts:251`
(`bad_to`); and the relay frame hard-codes `kind: 'direct'` (`border.ts:225`) while never reading
`row.topic`.

**Recommendation: keep the bare-alias `messages` row; do NOT add a `topic_relays` table.**
The row shape already carries `kind` and `topic` columns (`db.ts:313,316`) and inherits drain,
expiry, revocation-expiry, retention and the ORDER BY for free. PLAN.md must specify:
1. `Forwarder.send` branches on `row.kind`: for `'topic'` emit
   `{type:'relay', kind:'topic', msg_id: row.id, from: row.from_agent, topic: row.topic, payload, content_type, ttl_ms}`
   and **omit `to`**.
2. `routeRelay`'s shape validation (`router.ts:248-253`) moves the `to` check **behind** the kind
   dispatch, so `to` is required for `direct`/absent for `topic`/`topic-subscribe`, and `topic` is
   required (non-empty, no `':'`) for the two topic kinds.
3. `to_agent` for a topic row is exactly `` `${alias}:` `` — one row per peering per publish (the
   "once at the border" invariant is then a `COUNT(*) FROM messages WHERE to_agent = 'a:'` assertion).

### 2.2 Does `topic-subscribe` need an ack beyond the relay ack?

**Recommend: NO new ack frame in v0 — but `routeSubscribe` must gain a failure path.**
Today `routeSubscribe` (`router.ts:716-724`) has no error branch at all and `handleSubscribe`
acks with `ref: f.topic` (`ws-server.ts:191-192`); the SDK keys its ack waiter by topic
(`client/src/client.ts:200`). A remote subscribe is asynchronous by construction (it is queued for
the border like any other row), so the local ack must mean "accepted for the border", exactly as
D8 already means for `routeDirect` (`router.ts:465-470`). What C9 requires is that the **refusals**
be uniform and synchronous: no peering / peering without the `topic-subscribe` kind / malformed
`alias:topic` all answer one code. `routeSubscribe` currently cannot return one — `RouterResult`'s
error arm is unused there. PLAN.md must give it the `AGENT_NOT_FOUND`-shaped refusal and specify the
`KIND_NOT_ALLOWED` exception sits *behind* whatever reachability gate it chooses (mirroring
`router.ts:395-412`).

### 2.3 Can B's admin see remote subscribers?

**Recommend: yes, `GET /peers/:alias/subscriptions`, and it is cheap.** The inbound listing
`GET /peers` already exists (#153, routes at `http-admin.ts:1930-1940`); the data is B's own border
state, not the peer's secret, and it is the operator's only way to answer "why is this peering
carrying traffic". One prefix-range query over `subscriptions`. Not blocking — but if deferred, say
so in PLAN.md rather than leaving it open.

---

## 3. HOLES

**H1 — BLOCKING: `subscriptions` and `topics` have FOREIGN KEYs to `agents(id)`.**
`server/db.ts:330` — `created_by TEXT NOT NULL REFERENCES agents(id),` and `server/db.ts:336-338` —
`agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, topic TEXT NOT NULL REFERENCES
topics(name) ON DELETE CASCADE, … PRIMARY KEY (agent_id, topic)`,
with `db.exec('PRAGMA foreign_keys = ON;')` at `db.ts:202`. Inserting
`subscriptions('a:sub','news')` throws `SQLITE_CONSTRAINT_FOREIGNKEY`. The brief's central storage
claim ("receiver stores `subscriptions(agent_id='a:from', topic)`") **does not work on main**. Only
`acl` was rebuilt FK-less, deliberately and with a migration (`rebuildAclFkLess`, `db.ts:126-192`,
and the comment at `db.ts:296-300`: "an acl endpoint will soon be able to name a REMOTE id … a
foreign key would make the mesh unable to express the thing it exists to express"). F4 needs the
same treatment for `subscriptions.agent_id` — a `rebuildSubscriptionsFkLess` following the
identical pattern (pragma outside the transaction, DDL inside, index replay, `db.inTransaction`
guard) — **plus** a decision about what replaces the lost `ON DELETE CASCADE` on agent delete
(`deleteAgent`, `db.ts:694ff`, relies on it). `topics.created_by` is the same problem for 2.4 below.
The composite PK `(agent_id, topic)` itself is fine: `('a:sub','news')` is a distinct key.

**H2 — B fans out to remote subscribers as DIRECT messages, silently, today.**
If an `a:sub` row ever lands in `subscriptions`, `routePublish` includes it (`router.ts:603` — no
locality filter), `agentIndex.get('a:sub')` is undefined, and the offline branch inserts
`to_agent = 'a:sub'` (`router.ts:690-702`). That row is then in the forwarder's drain range
(`db.ts:1310`) and `Forwarder.send` relays it as `kind:'direct'` to `sub` (`border.ts:218-226`).
Result: N frames per publish instead of 1, the wrong kind, and the receiving agent gets a direct
message it never subscribed to. PLAN.md must make `routePublish` filter remote subscribers out of
the local loop explicitly, with the `isRemote` predicate already used at `db.ts:860`
(`endpoint.includes(':') && getAgentById(db, endpoint) === null` — grammar alone is wrong because of
the preserved legacy-colon population, `db.ts:835-841`), and pin it with a mutant test.

**H3 — the return direction is unrepresentable.** Decision 5 requires both peerings, but nothing
links B's inbound `peers.alias` for A to B's outbound `outbound_peers.alias` for A. The two tables
share no column (`db.ts:226-236` vs `db.ts:272-281`); each side names the other locally, and
`assigned_alias` is the name the *far* side uses. In the drive, A's outbound alias is `b<RUN>`
while B's inbound alias is `a<RUN>` (`f2-verify/drive2.ts:36-41`). So on receiving a
`topic-subscribe` from peer `a<RUN>`, B has **no way to know** which outbound peering carries the
publishes back. PLAN.md must pick one and write it down: (a) require the operator to use the same
local alias for both directions, check `hasOutboundPeer(db, peer.alias)` on the inbound
`topic-subscribe`, refuse otherwise, and document it in FEDERATION.md §2 Step 4; or (b) add a
`paired_alias` column. (a) is cheaper and testable; (b) is honest but is schema work. Without one,
a subscribe succeeds on B and nothing is ever delivered — the worst failure shape.

**H4 — the loop invariant as written is insufficient.** "routeRelay's fan-out does not call
routePublish" closes only self-recursion. The real transitive hole is a *third* mesh: if A holds
`subscriptions('c:sub','b:news')`, A's fan-out of a relayed publish inserts `to_agent='c:sub'`,
which C's forwarder relays onward — transitive federation that the one-hop check never sees,
because that check only inspects a frame's `from`/`to` (`router.ts:258-259`). PLAN.md must state:
**the fan-out of a relayed publish considers LOCAL subscribers only** (same `isRemote` filter as H2),
and the control test is "a `c:*` subscriber row on A produces no outbound row for alias `c`".

**H5 — `getOrCreateTopic` for a remote-only topic violates an FK.** `routeSubscribe` calls
`getOrCreateTopic(db, frame.topic, agent_id)` unconditionally (`router.ts:721`), and
`getOrCreateTopic` inserts `created_by` (`db.ts:1766-1769`) into a column with
`REFERENCES agents(id)` and no `ON DELETE` clause (`db.ts:330`). On B, a `topic-subscribe` for a
topic that does not exist yet would insert `created_by='a:sub'` and throw. PLAN.md must choose:
(i) refuse a remote subscribe to a nonexistent topic (which C9 says must answer the same uniform
refusal as a non-peered alias — this is the cheapest and matches the brief's C9 wording), or
(ii) drop the `topics.created_by` FK too. Note (i) is *also* required to keep `deleteAgent` working,
which depends on that FK having no cascade (`db.ts:724-728`).

**H6 — a new "topic names may not contain `':'`" validation is a breaking change unless scoped
like F0b.** No such validation exists (claim 18). Existing databases may hold colon topics, exactly
as they hold legacy colon agent ids — the population F0b "deliberately preserved… REPORTED at boot
and never rejected" (`db.ts:835-841`). PLAN.md must mirror that: refuse `':'` on **newly created**
topic names only, report pre-existing ones at boot, and make the "is this remote?" decision
`hasOutboundPeer(alias)`-first with an unchanged local fall-through, exactly as `routeDirect` does
(`router.ts:376-378`, `:476-478`). Grammar must not be decisive.

**H7 — cross-border taps go blind.** `routeRelay` emits a `cross_border`-scoped tap for every
inbound direct frame (`router.ts:325-332`, `crossBorderAudience` at `router.ts:225-231`) and
`routeDirect` does the same outbound (`router.ts:459-464`). The brief mentions taps nowhere, so an
F3 cross-border observer would see zero federated topic traffic — a silent regression in the
instrument built to answer "what crossed the border" (`server/__tests__/observer-cross-border.test.ts`).
Specify tap emission for both the outbound topic row and the inbound topic frame.

**H8 — metrics detail the success criteria get wrong.** `mesh_peer_relays_total` renders per-alias
series **only** with `MESH_METRICS_IDENTITY_LABELS=1` (`metrics.ts:375-381`); the default is the
aggregate at `metrics.ts:383-396`, and the drive asserts identity labels are absent
(`f2-verify/drive2.ts:51`). The drive's P13–P16 assertions must read
`mesh_peer_relays_total{direction="in",outcome="delivered"}` from the aggregate. Also `direction`
is `'in'` on the receive path (`router.ts:333`) but `'outbound'` on the send path (`border.ts:230`)
— do not "fix" that asymmetry inside F4; just use the real strings.

**H9 — subscription replay burns the peering's rate.** `MeshClient` re-sends every subscribed topic
on each reconnect (`client/src/client.ts:915-919`). If `subscribe('b:news')` enqueues a
`topic-subscribe` relay each time, a flapping agent consumes the peering bucket for no state change.
PLAN.md should specify: enqueue the relay only when the local `subscriptions` row is newly created
(`subscribe()` uses `INSERT OR IGNORE`, `db.ts:1788-1791`, so `changes` is the signal — it is
currently discarded).

**H10 — revocation has no inbound hook (claim 17).** With no `endInboundPeering`, PLAN.md must say
where remote subscription rows die. The one existing inbound-teardown site is `upsertPeer`'s
non-rotation rebind (`db.ts:1503-1512`); `revokePeerKey` only sets `disabled=1`
(`db.ts:1153-1162`), and `routeRelay` already refuses a disabled peer (`router.ts:270`). Cheapest
consistent answer: delete `subscriptions` rows prefixed `` `${alias}:` `` in the **same** place the
inbound ACL edges are deleted (`db.ts:1507`), and additionally in `revokePeerKey`'s transaction if
F4 also moves edge deletion there — but do not move edge deletion as a side effect of F4.

**H11 — the mesh-agent runtime cannot subscribe at all.** No `mesh_subscribe` tool exists in
`/home/coder/project/mesh-agent/src/` (only publish/broadcast, `mesh-tools.ts:35`). The addressing
path does exist in the SDK (`client.ts:386-390` takes an unvalidated string, so `subscribe('b:news')`
works today) and over MCP (`mcp-server.ts:52`, `:377-380`) — so F4 ships invisible to persona agents
until mesh-agent-builder adds the tool. A known gap, not a dependency.

**H12 — small ones.** (a) Tests live in `server/__tests__/`, not `server/`. (b) FEDERATION.md §4 is
"What an admin can see"
(`docs/FEDERATION.md:170`); the new rows belong in §3 "Sending across a border"
(`docs/FEDERATION.md:129`), and §6's row **"Topics across a border | … topics stay local"**
(`docs/FEDERATION.md:400`) must be deleted or rewritten. (c) Every new doc row must cite
`` `path.ts` `` + `` `symbol` `` where the symbol is defined at line start in that file, or
`guide-citations.test.ts:34,59` reds. (d) `f2-verify/drive2.ts` ends at P11 and pins the client at
`./mesh-c27ebbc/client/src/index.ts` (`drive2.ts:4`) — P13–P16 need a new pinned checkout at the F4
SHA and topic helpers the drive does not have.

---

## 4. VERDICT

**GO-with-amendments.** The design's *shape* is right: one frame per peering, receiver-side
per-subscriber ACL, both peerings required, no new table. But the brief's storage claim is
contradicted by the schema (H1), and one hazard (H2) is a live mis-delivery the moment a remote
subscription row exists. Amendments, each blocking on PLAN.md, not on the Generator:

1. **Add the `subscriptions` FK-less migration.** `subscriptions.agent_id REFERENCES agents(id)`
   (`db.ts:336`) under `PRAGMA foreign_keys = ON` (`db.ts:202`) rejects `'a:sub'`. Model it on
   `rebuildAclFkLess` (`db.ts:126-192`) including the `db.inTransaction` guard, index replay and the
   migration-chain test. State what replaces the lost `ON DELETE CASCADE` for `deleteAgent`
   (`db.ts:694ff`). (H1)
2. **Filter remote ids out of `routePublish`'s local fan-out** with the `isRemote` predicate at
   `db.ts:860`, not by grammar. Without it, `router.ts:690-702` + `db.ts:1310` + `border.ts:225`
   deliver N direct messages per publish. Pin with a mutant. (H2)
3. **Specify how B finds its return peering.** `peers` (`db.ts:272`) and `outbound_peers`
   (`db.ts:226`) share no column. Choose same-alias-both-directions + a
   `hasOutboundPeer(db, peer.alias)` check on the inbound `topic-subscribe`, or a `paired_alias`
   column. Document in FEDERATION.md §2 Step 4 (`docs/FEDERATION.md:121`). (H3)
4. **Keep the bare-alias `messages` row; do not add `topic_relays`.** The drain range tolerates
   `'a:'` (`db.ts:1293-1310`). Specify the two changes it needs: `Forwarder.send` branches on
   `row.kind` and carries `row.topic` instead of the hard-coded `kind:'direct'`/sliced `to`
   (`border.ts:218-226`); `routeRelay`'s shape validation dispatches on kind before the `to` check
   (`router.ts:248-253`). (§2.1)
5. **Restate the loop invariant as "local subscribers only".** The relayed fan-out must exclude any
   remote subscriber, or A relays B's publish onward to C past the one-hop check
   (`router.ts:258-259`). (H4)
6. **Decide the remote-subscribe-to-a-nonexistent-topic case.** `routeSubscribe`'s unconditional
   `getOrCreateTopic` (`router.ts:721`) would write `created_by='a:sub'` into a column with
   `REFERENCES agents(id)` (`db.ts:330`). Recommend refusing, uniformly, per C9. (H5)
7. **Scope the topic-name `':'` validation like F0b.** New names only; report pre-existing colon
   topics at boot; route on `hasOutboundPeer` first with an unchanged local fall-through
   (`router.ts:376-378`). (H6)
8. **Emit cross-border taps for topic frames**, both directions, mirroring `router.ts:325-332` and
   `router.ts:459-464`. (H7)
9. **Give `routeSubscribe` a refusal path**; keep the local ack meaning "accepted for the border"
   (D8, `router.ts:465-470`) and enqueue the relay only when the `INSERT OR IGNORE` at
   `db.ts:1788` actually inserted. (§2.2, H9)
10. **Name where remote subscriptions die on revocation** — claim 17 is false as written; the only
    inbound teardown site is `db.ts:1503-1512`. (H10)
11. **Fix the success criteria:** test path `server/__tests__/topic-federation.test.ts`; metrics read
    from the aggregated `mesh_peer_relays_total{direction,outcome}` (`metrics.ts:383-396`) with
    `direction="in"`; docs go to §3 and delete §6's "Topics across a border" row
    (`docs/FEDERATION.md:400`) with citations shaped for `guide-citations.test.ts:34`. (H8, H12)
12. **Note, do not block on, the runtime gap:** mesh-agent has no subscribe tool
    (`mesh-agent/src/mesh-tools.ts`), so F4 ships reachable from the SDK and MCP only. (H11)

No amendment requires re-deciding the operator's five decisions. `kinds` needs no validation change (claim
19), which removes one item the brief treated as work.
