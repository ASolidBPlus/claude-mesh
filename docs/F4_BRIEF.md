# F4 — topics across peerings (brief, v3 = v0 + A1–A14 + B1–B4 + C1–C14; each later section overrides earlier text where they differ; v1, 2026-09-06 14:40Z — v0 + plan-eval amendments folded; F4_EVAL.md is the record, this file is self-contained)

Scoped by the operator 14:13Z: remote SUBSCRIBE allowed; a publish crosses the border ONCE and
counts once against the peering rate; the receiving mesh fans out locally and filters per
subscriber. Not needed for PowerOUT-on-one-mesh; needed the day two operators peer.

## What exists (read from main 7988f0f, not from memory)
- `routePublish` (router.ts:534): `getOrCreateTopic`, subscribers from `subscriptions`
  (agent_id, topic), publisher excluded, per-subscriber `aclCheck(from, subscriber)`,
  per-subscriber copy row (`to_agent = subscriber`), online → deliver + markDelivered,
  offline → queue (ttl 0 → dropped). Filter drops count in
  `mesh_topic_fanout_total{outcome=filtered}` (#142), no party label.
- `routeDirect` remote branch (router.ts:336-428): `to` = `alias:agent`, `hasOutboundPeer`
  (enabled-only), ACL FIRST then `outbound_peers.kinds` must include `'direct'`
  (KIND_NOT_ALLOWED only behind the ACL — reachability, #123), row inserted with the FQ
  remote id, `borderEvents.emit('enqueued', alias)`; the forwarder (border.ts, F2b) ranges
  rows by `to_agent` prefix, relays over the peering socket, marks delivered_at or
  failed_code.
- `routeRelay` (router.ts:199): receiver side; `kind !== 'direct'` → RELAY_REFUSED
  (:220); one hop (`from`/`to` bare); rate bucket BEFORE cheaper checks; `peers.kinds` must
  include kind (:250-252); dedupe on (peer_alias, remote_msg_id); `to` must be a local
  agent; inbound edge `aclCheck(alias:from, to)`; then `deliverOrQueue`.
- Peerings are DIRECTIONAL: an outbound peering A→B carries A's sends; B answering A
  needs its own B→A peering (drive: P1 reply edge 409 "reply direction requires B→A").
- `aclGrant` refuses edges naming remote ids without a live peering.

## Decisions taken (operator) and the ones this brief takes (reversible at plan-eval)
1. Remote subscribe: an agent on A may subscribe to a topic on B.
2. A publish on B crosses each peering ONCE (one relay frame per peering that has at least
   one permitted remote subscriber); it counts once against that peering's rate.
3. The receiving mesh (A) fans out to its local subscribers of that remote topic with its own
   per-subscriber inbound edge check — `aclCheck('b:publisher', subscriber)` — so the
   receiving admin's border decides who on A hears B's topic, exactly as for direct relays.
4. The sending mesh (B) decides whether the topic may leave at all: the publisher must hold
   an edge to the REMOTE SUBSCRIBER GROUP for that peering. Interface choice (below):
   reuse per-pair edges to `a:agent` targets (already representable; `aclGrant` accepts
   remote ids when a peering exists), and the outbound decision is "at least one remote
   subscriber on peering `a` holds an edge from the publisher" → send one frame.
5. Direction: topic traffic uses the SAME directional model. A's subscribe request travels
   over A's outbound peering to B (kind `topic-subscribe` on A→B); B's publishes travel over
   B's outbound peering to A (kind `topic` on B→A). So remote subscribe across a pair needs
   BOTH peerings to exist, each admin granting the kind on their own row. This reuses every
   existing mechanism (sockets, rate, dedupe, kinds column) and keeps the "my admin's border
   decision covers this peer, not the reverse" property. The alternative — reverse frames on
   the receiver's end of an outbound socket — is cheaper to set up and rejected here because
   it makes one row govern traffic in both directions.

## Wire and storage
- `peers.kinds` / `outbound_peers.kinds` gain two values: `topic` (publishes may cross) and
  `topic-subscribe` (subscribe/unsubscribe requests may cross). Existing rows unchanged
  (`['direct']`); minting keys with the new kinds is an operator act.
- New relay frame kinds over the peer socket (validated in `routeRelay` before any lookup):
  - `{kind:'topic-subscribe', msg_id, from, topic}` / `'topic-unsubscribe'` — `from` bare
    (one hop); receiver stores a REMOTE subscription `subscriptions(agent_id='a:from',
    topic)` (colon in agent_id is the remote-id grammar; `getTopicSubscribers` returns it).
  - `{kind:'topic', msg_id, from, topic, payload, content_type, ttl_ms}` — one per publish
    per peering; receiver (A) looks up LOCAL subscribers of `b:topic`… see naming below.
- Topic naming across the border: on A, a remote topic is addressed as `b:topicname`
  (alias-prefixed, same grammar as remote agents; local topic names may not contain ':' —
  new validation, mirrors #98's collision gate). `subscribe('b:news')` on A → local row
  `subscriptions('agentA','b:news')` + a `topic-subscribe` relay to B naming `news`.
- On B, the publisher's fan-out (routePublish) gains step 5e: for each outbound peering
  with kind `topic` and ≥1 remote subscriber row `a:*` for this topic where
  `aclCheck(publisher, 'a:sub')` holds → insert ONE row `to_agent = 'a:__topic__:news'`?
  NO — simpler and consistent with the forwarder: insert one row per peering with
  `kind='topic'`, `to_agent='a:'` (alias only) and `topic='news'`; the forwarder ranges on
  the prefix as today and emits the `topic` relay frame. (Plan-eval to confirm the
  forwarder's range query tolerates the bare-alias target; if not, a `topic_relays` table.)
- On A, `routeRelay` kind `topic`: rate, kinds, dedupe as today; then fan out to local
  subscribers of `b:news` (`getTopicSubscribers`) with `aclCheck('b:from', subscriber)`,
  per-subscriber copies, `incTopicFanout` outcomes, `from_agent='b:from'`, `topic='b:news'`.
  Delivered/dropped/queued semantics identical to local publishes.
- Rate: the single frame per peering is what `withinRate` counts (decision 2).
- Dedupe: `relays(peer_alias, remote_msg_id)` covers topic frames unchanged.

## Invariants (each becomes a test with a control)
- C9: a subscribe to a topic on a non-peered alias, a peered alias without the kind, and a
  nonexistent topic answer the SAME refusal to the local agent (AGENT_NOT_FOUND-shaped,
  uniform); KIND_NOT_ALLOWED only behind the ACL, as for direct.
- One hop: `from` in a topic frame is bare; a colon → RELAY_REFUSED; a subscriber on A can
  never cause B to relay onward to C.
- Once at the border: N remote subscribers on A ⇒ exactly ONE relay frame B→A per publish;
  `withinRate` consumed once; mutant "one frame per subscriber" reds the count test.
- Receiver-side ACL: with `aclCheck('b:pub', subA)` false, subA receives nothing and
  `filtered` increments; with it true, delivered; control: a local subscriber of an
  unrelated topic unaffected.
- Sender-side gate: with no edge from the publisher to any `a:*` subscriber, NO frame leaves
  B (and nothing on B's side names a remote subscriber to the publisher — uniform).
- Revocation: `endOutboundPeering` deletes outbound ACL edges (existing) — remote
  subscriptions on B for `a:*` are deleted with the inbound peering row (new; mirrors "an
  alias's edges end with the peering that created them", #113); on A, local subscriptions
  to `b:*` topics stay (they are the local agent's history) and a paused/ended peering
  simply delivers nothing.
- Metrics: no party label anywhere new; `mesh_peer_relays_total{direction,outcome}` gains
  no label; `kind` is NOT a label (topic names are agent-chosen).
- Loop: A's fan-out of a relayed publish must never re-relay (a relayed publish is not a
  local publish: `routeRelay`'s fan-out is a distinct path and does not call routePublish).

## Success criteria (runnable)
- `bun test` server: new `topic-federation.test.ts` covering every invariant above with
  the named controls; ratchets held; `border.test.ts` walkers unaffected.
- Sandbox drive (drive2.ts P13–P16): subscribe from A to `b:news` with both peerings and
  both kinds; publish on B with 3 A-subscribers of which 1 lacks the inbound edge → 2
  deliveries on A, 1 filtered, `mesh_peer_relays_total{in,delivered}` +1 on A (not +3), B's
  bucket −1; pause B→A → publishes refused uniformly to B's publisher? NO — the publisher
  is acked locally (D8); the frame queues and expires; A receives nothing; resume → backlog
  delivered once each (dedupe).
- Docs: FEDERATION.md §4 gains the kinds, the `alias:topic` grammar, the "once at the
  border" rule and the two-peerings requirement, each row citing its handler (#160's test
  enforces the citations).

## Out of scope / not precluded
- Transitive topics (A subscribing through B to C): refused by one-hop, by design.
- Wildcard or pattern subscriptions across the border.
- Per-topic rate limits (the peering's limit is the instrument).
- Reverse frames on a single socket (rejected above; not precluded by the storage shape).

## Open for plan-eval (must be settled in PLAN.md, not by the Generator)
- The forwarder's range query and the bare-alias `to_agent` row vs a `topic_relays` table.
- Whether `topic-subscribe` needs an ack semantics beyond the relay ack (subscriber wants
  to know it took effect on B; today a local subscribe acks locally).
- Whether B's admin can see remote subscribers (`GET /peers/:alias/subscriptions`?) —
  operator visibility, same class as #153.


---
# v1 AMENDMENTS (folded from the plan-eval at main 7988f0f; each overrides the v0 text above where they differ)

Line numbers in "What exists" are stale by 30–50 lines; the behaviours are verified TRUE. Use symbols,
not lines: `routeRelay` (router.ts:232, kind check :253, one-hop :258-259, rate :276, kinds :285,
dedupe :291), `routeDirect` remote branch (:374-478), `routePublish` (:581; offline insert :690-702),
`routeSubscribe` (:716-724), `DRAIN_OUTBOUND_SQL` (db.ts:1293-1310), `Forwarder.send` (border.ts:218-226).

A1. **Schema: `subscriptions.agent_id REFERENCES agents(id)` (db.ts:336) and `topics.created_by
    REFERENCES agents(id)` (db.ts:330) under `PRAGMA foreign_keys = ON` (db.ts:202).** A remote
    subscriber row `('a:sub','news')` throws today. F4 adds `rebuildSubscriptionsFkLess` modelled
    exactly on `rebuildAclFkLess` (db.ts:126-192: pragma outside the transaction, DDL inside, index
    replay, `db.inTransaction` guard, migration-chain test). The lost `ON DELETE CASCADE` is replaced
    by an explicit `DELETE FROM subscriptions WHERE agent_id = ?` inside `deleteAgent`'s transaction
    (db.ts:694ff), pinned by a test that deletes a subscribed agent and reads the table. `topics.created_by`
    keeps its FK (see A6).
A2. **`routePublish` local fan-out excludes remote ids** using the `isRemote` predicate at db.ts:860
    (`endpoint.includes(':') && getAgentById(db, endpoint) === null`) — grammar alone is wrong because
    of the preserved legacy-colon agents (db.ts:835-841). Without this filter the offline branch inserts
    `to_agent='a:sub'`, the forwarder drains it and relays it as a DIRECT message — N frames per publish,
    wrong kind, unsolicited. Mutant (remove the filter) must red the "one frame per peering" test.
A3. **Return direction.** `peers` and `outbound_peers` share no column; B cannot otherwise find the
    outbound peering that carries publishes back to A. Decision: SAME LOCAL ALIAS FOR BOTH DIRECTIONS.
    On an inbound `topic-subscribe` from peer alias `a`, B checks `hasOutboundPeer(db,'a')` (enabled,
    kind `topic`) and refuses uniformly otherwise; FEDERATION.md §2 Step 4 documents "to carry topics,
    name the peer the same in both tables". A `paired_alias` column is the honest alternative and is not
    precluded; it is not v1.
A4. **Storage of the outbound publish: one `messages` row per peering, `to_agent = 'a:'` (bare alias),
    `kind='topic'`, `topic='news'`.** The drain range (`to_agent >= 'a:' AND < 'a;'`) selects it, and
    expiry (db.ts:1316-1326) and revocation (db.ts:1396-1402) sweep it — no `topic_relays` table.
    Two code changes: `Forwarder.send` branches on `row.kind` (topic frame carries `topic`, omits `to`,
    no sliced remote); `routeRelay`'s shape validation dispatches on `kind` BEFORE the `to` check
    (`to` required for direct, absent for topic kinds; `topic` required, non-empty, no ':').
    The once-at-the-border test is `COUNT(*) FROM messages WHERE to_agent='a:' AND kind='topic'` == 1
    after one publish with three A-subscribers.
A5. **Loop invariant restated: the fan-out of a RELAYED publish considers LOCAL subscribers only** (same
    `isRemote` filter as A2). Control test: a `c:sub` row on A for topic `b:news` produces no outbound
    row for alias `c` after a relayed publish (otherwise A forwards B's publish to C past one-hop).
A6. **Remote subscribe to a nonexistent topic is REFUSED**, with the same uniform code as a non-peered
    alias (C9). This keeps `topics.created_by`'s FK and `deleteAgent`'s reliance on it (db.ts:724-728)
    intact. Consequence to document: a topic must exist on B (some local agent subscribed or published)
    before A can subscribe to it.
A7. **Topic-name ':' validation scoped like F0b:** refuse ':' in NEWLY created topic names only; report
    pre-existing colon topics at boot; the remote/local decision on `subscribe('b:news')` is
    `hasOutboundPeer('b')` FIRST with an unchanged local fall-through, exactly as `routeDirect`
    (router.ts:376-378, :476-478). Grammar is never decisive.
A8. **Cross-border taps** (F3) fire for topic frames both ways, mirroring router.ts:325-332 (inbound)
    and :459-464 (outbound); `observer-cross-border.test.ts` gains a topic case.
A9. **`routeSubscribe` gains a refusal path** (today it has none; `handleSubscribe` acks with
    `ref: topic`, ws-server.ts:191-192). Local ack = "accepted for the border" (D8). The
    `topic-subscribe` relay row is enqueued ONLY when `subscribe()`'s `INSERT OR IGNORE` (db.ts:1788)
    reports `changes === 1` — the SDK replays every subscription on reconnect (client.ts:915-919) and must
    not burn the peering bucket for no state change. Same for unsubscribe (`changes === 1` on delete).
A10. **Where remote subscriptions die.** There is no inbound-peering teardown hook; `revokePeerKey`
    (db.ts:1153-1162) only sets `disabled=1` (and `routeRelay` refuses a disabled peer, :270). v1: delete
    `subscriptions` rows prefixed `a:` at the one existing inbound teardown site (`upsertPeer` non-rotation
    rebind, db.ts:1503-1512) AND in `revokePeerKey`'s transaction. Edge deletion on revoke is NOT moved by
    F4. On A, local subscriptions to `b:*` stay.
A11. **Success criteria corrected:** tests in `server/__tests__/topic-federation.test.ts`; metrics read
    from the AGGREGATE `mesh_peer_relays_total{direction="in",outcome="delivered"}` (identity labels are
    off in the drive, drive2.ts:51; the send side says `direction="outbound"` — use the real strings, do
    not fix the asymmetry in F4); docs rows go to FEDERATION.md §3 "Sending across a border", §6's row
    "Topics across a border | … topics stay local" (:400) is rewritten, every row cites `path.ts` +
    `symbol` defined at line start (guide-citations.test.ts:34,59). Drive: P13–P16 in a new pinned
    checkout at the F4 SHA (drive2.ts pins mesh-c27ebbc).
A12. **Runtime side (corrected by mesh-agent-builder 14:30Z):** config-declared subscriptions already
    work end to end in mesh-agent (`src/index.ts:115-116` loops `cfg.mesh.subscribe` → `client.subscribe`;
    the SDK replays on reconnect, client.ts:508-510). The real gaps: (1) the arena hardcodes
    `subscribe: []` (`arena/scenario.ts:231`) — F4 needs only a passthrough (`subscribe?: string[]` in
    `AgentSchema`), small, mesh-agent-builder's lane; (2) no dynamic subscribe TOOL — deliberately: the
    scenario author owns the communication graph (same as the ACL matrix) and a self-subscribing persona
    breaks run reproducibility and puts volatile state into the cached prefix. If ever wanted: gated as
    `meshTools: ['subscribe']`, default off. Passthrough first; tool only on a concrete scenario need.
A13. **No `kinds` validation change**: both kinds columns are free-form `string[]` with no allowlist
    (http-admin.ts:1386-1392, :1794-1800); minting `["direct","topic","topic-subscribe"]` works on main.
    Docs only.
A14. **Operator visibility:** `GET /peers/:alias/subscriptions` (remote subscriber rows for an inbound
    peering) — one prefix-range query; in scope for v1 because it is the only answer to "why is this
    peering carrying traffic".

Still open for PLAN.md (design settled; mechanics to state): exact refusal code name for A6/A9 (reuse
the AGENT_NOT_FOUND-shaped code the direct path uses), and whether `topic-unsubscribe` on a peering
whose kind was later removed is accepted (recommend: yes, teardown is always allowed).

---
# v2 (2026-09-06 14:40Z) — the operator's topology (design/F4_topology_2026-09-06.png) drives two additions

the operator's diagram: an ORCHESTRATOR mesh owns the topics (Analytics, Game State, Troll Box, Dark Net Updates);
POD 1 / POD 2 meshes host the chat agents (support chat, employees, web-sniffing red/blue, email client,
red-team email sender); pods peer with the orchestrator AND with each other (direct traffic = F1–F3 as
shipped). Hub-and-spoke for topics. v1 assumed publishes originate on the topic's home mesh only; the
diagram needs pod agents posting INTO hub topics (Troll Box, Dark Net Updates at least). Assumption to
confirm with the operator: Game State / Analytics are hub-published, pods listen; Troll Box / Dark Net take pod posts.

## B1. Remote publish (new relay kind `topic-publish`)
- Agent on pod1 publishes to `orch:trollbox`. `routePublish` routes on `hasOutboundPeer('orch')` FIRST
  (A7 grammar rule), checks the outbound peering has kind `topic-publish`, checks the outbound edge
  `aclCheck(publisher, 'orch:trollbox')` — a TOPIC-AS-PRINCIPAL edge (see B2), inserts ONE `messages` row
  `to_agent='orch:'`, `kind='topic-publish'`, `topic='trollbox'`, `from_agent=publisher`. Forwarder emits
  `{kind:'topic-publish', msg_id, from, topic, payload, content_type, ttl_ms}`. Refusals uniform (C9).
- On orch, `routeRelay` kind `topic-publish`: rate, kinds, dedupe as today; the topic must EXIST (A6: no
  creation by remote); inbound edge `aclCheck('pod1:from', 'trollbox')`?? — NO: inbound gate is the
  topic-as-principal edge `aclCheck('pod1:publisher', TOPIC_PRINCIPAL('trollbox'))` (B2). Then the frame is
  RE-ORIGINATED as a native publish on orch with `from_agent='pod1:publisher'` and `origin` preserved:
  local fan-out per subscriber (existing per-subscriber ACL, publisher id = 'pod1:publisher'), PLUS the
  v1 outbound fan-out to remote subscribers: one `kind='topic'` row per peering that has ≥1 remote
  subscriber (A4). The hub therefore transits pod1 → orch → pod2 BY DESIGN.
- One-hop rule restated (supersedes A5's wording, keeps its guarantee): a `topic-publish` relay may be
  re-originated ONLY on the topic's HOME mesh (the mesh where the topic row is local); a received `topic`
  DELIVERY frame fans out to LOCAL subscribers only and is never re-originated. So a post crosses at most
  two borders (spoke→hub, hub→spoke), and only through a hub whose admin created the topic and holds both
  peerings. pod2's admin opted in by holding the orch→pod2 peering with kind `topic` and granting B2 edges.
  Control test: a `topic` delivery arriving on pod2 with a `pod3:*` subscriber row produces no outbound row.
- Counting: pod1→orch one frame against pod1's outbound / orch's inbound rate; orch→podN one frame per pod.
- `from` in the hub→pod2 delivery frame is the HUB's local view of the publisher: `pod1:publisher` has a
  colon → violates the bare-`from` one-hop check. Resolution: the `topic` delivery frame's `from` is the
  TOPIC PRINCIPAL (bare, e.g. `trollbox`), and a new field `origin` (opaque string, ≤256 bytes, display
  only, never used for routing or ACL) carries `pod1:publisher`. `from_agent` on pod2's copy rows =
  `orch:trollbox`; `origin` stored in a new nullable column `origin` (or in headers if the row already has
  a JSON headers column — PLAN.md decides after reading the schema).

## B2. Topic-as-principal for cross-border ACL
- Receiving side (v1 A-invariants said `aclCheck('b:publisher', subscriber)`): pod2's admin cannot
  enumerate pod1's agents, so per-publisher grants are unworkable. Replace with: delivery of hub topic T to
  local subscriber S requires edge `orch:T → S` where `orch:T` is the topic principal id
  (`<alias>:<topic>`, same remote-id grammar; a topic principal is not an agent row, so `aclGrant`'s
  remote-id check accepts it when the peering exists — it already does not require the remote agent to
  exist). One grant per (topic, subscriber). The brief's receiver-side ACL invariant becomes:
  `aclCheck('orch:trollbox', sub)` false → filtered, true → delivered.
- Sending side for remote publish (B1): edge `publisher → orch:trollbox` on pod1 (topic principal as the
  TARGET), and on the hub the inbound edge `pod1:publisher → trollbox` (a local topic principal; PLAN.md
  must state how a local topic principal is written in the acl table without colliding with agent ids —
  recommend the reserved form `topic:trollbox` locally and `orch:topic:trollbox` remotely, which reuses
  the alias prefix and keeps `isRemote` honest; ':' in topic names stays refused per A7).
- Local publishes and local subscriptions keep today's per-subscriber publisher→subscriber semantics; B2
  applies only where a border is crossed.
- Metrics: no topic-name labels (agent-chosen strings, #136 lesson); the identity-label knob governs the
  principal label exactly as it governs `from_agent`.

## B3. Kinds, final set
`direct` (shipped) · `topic` (hub→spoke deliveries) · `topic-subscribe` (spoke→hub subscribe/unsubscribe)
· `topic-publish` (spoke→hub posts). the operator's topology needs: pod→orch `['direct','topic-subscribe',
'topic-publish']`, orch→pod `['direct','topic']`, pod↔pod `['direct']`. No validation change (A13).

## B4. Success criteria additions
- `topic-federation.test.ts`: remote publish end to end on a three-mesh fixture (pod1, orch, pod2) with the
  transit invariant (post from pod1 arrives at pod2's granted subscriber exactly once; a `pod3:*`
  subscriber on pod2 yields no outbound row; a `topic` delivery is never re-originated — mutant that calls
  the re-origination path on delivery reds).
- Drive P13–P18 on a THREE-node sandbox (`sandbox_up` with a third mesh service) — the driver has two.
- Docs: FEDERATION.md §3 gains the hub-and-spoke section with the operator's diagram as the worked example.

## Still open (operator): which topics take pod posts. (PLAN.md): origin storage column vs headers; local topic
principal spelling in the acl table; whether a spoke may subscribe AND publish over one peering with only
`topic-subscribe` granted (recommend: no — kinds are independent, publish needs its own kind).


---
# v3 (2026-09-06 15:00Z) — decisions folded from plan-eval #2 (F4_EVAL2.md, read at main 7717d16; main is now 04b242c)

C1. **Local topic principal is `topic:<name>`; remote is `<alias>:<name>` (one colon, unchanged).** Main refuses the
    local form today (`isRemote` at db.ts:860 calls any colon id without an agents row remote → `aclGrant` throws
    NO_PEERING → POST /acl 409). Four edits make it legal, all in scope: (1) `TOPIC_PRINCIPAL_PREFIX = 'topic:'`
    exemption inside `assertPeeringAllowed`'s isRemote — neither remote nor required to be an agent; (2) reserve the
    alias `topic` at both alias doors (http-admin.ts:1496 and :1889) beside RESERVED_ALIAS; (3) refuse new agent ids in
    the `topic:` prefix range, mirroring http-admin.ts:1894-1904; (4) an F0b-style boot report for pre-existing
    `topic:*` agents. The mapping between spellings is `stampedFrom` (router.ts:299): a hub→spoke frame with bare
    `from = trollbox` is stamped `orch:trollbox` on arrival — the remote principal falls out of existing code.
    Drop B2's `orch:topic:trollbox` (two colons contradicts FEDERATION.md troubleshooting).
C2. **Home-ness is the prefix test, not row existence.** `routeSubscribe` (router.ts:721) creates a local `topics` row
    for `orch:trollbox` on the spoke, so "the topic row is local" is true everywhere. Define
    `isHomeTopic(db,t) := topicExists(db,t) && !(t.includes(':') && hasOutboundPeer(db, t.slice(0, t.indexOf(':'))))`.
C3. **Two grant classes per hub topic, both enumerable by the hub admin** (resolves B1 vs B2):
    - RIGHT TO POST: at the spoke, outbound edge `publisher → orch:trollbox`; at the hub, inbound edge
      `pod1:publisher → topic:trollbox`. Read-only hub topics (Game State, Analytics) are a HUB-side decision:
      withhold the inbound edge. This is the sentence that sells B2.
    - RIGHT TO HEAR: at the hub, local fan-out gates on `aclCheck(db, 'topic:trollbox', sub)` — NEVER
      `pod1:publisher → sub`; at each spoke, `aclCheck(db, 'orch:trollbox', sub)` (A-invariant, unchanged).
    Local (non-federated) topics keep today's publisher→subscriber per-pair semantics untouched.
C4. **Factoring.** Extract router.ts:602-711 as `fanOutTopicLocal(db, agentIndex, {topic, from_agent, origin, payload,
    content_type, sent_at, expires_at, ephemeral, aclPrincipal})`; called from `routePublish` (principal = publisher,
    as today) and from both topic arms of `routeRelay` (principal = `topic:<name>`). `routeRelay` NEVER calls
    `routePublish`. Per-step reuse/skip table is EVAL2 §1 and is binding: skip the size check (relay already
    refused >1 MB), skip incSent/incBytes('in')/observePayloadBytes (remote ids get no local "sent"), skip
    getOrCreateTopic (A6), derive expires_at/ephemeral from the ARRIVING frame's ttl via routeRelay:309-313 (never
    routePublish's `?? 300_000` — otherwise a transited post gets up to 2× lifetime), tap audience =
    `crossBorderAudience` not LOCAL_ONLY; reuse subscribers minus remote (A2/A5), per-subscriber aclCheck with the
    C3 principal, copy rows, deliver/queue, incTopicFanout, incMsgStatus.
C5. **Transit guard is a static property:** `enqueueOutboundTopicRows` has exactly ONE call site, inside the
    `topic-publish` arm, after `isHomeTopic` (C2) passed. The `topic` DELIVERY arm calls `fanOutTopicLocal` and
    nothing else. Mutants that must red: (a) move `enqueueOutboundTopicRows` into shared code → the control "a
    `topic` delivery on pod2 with a `pod3:*` subscriber row yields no messages row with to_agent='pod3:'" fails;
    (b) delete the isHomeTopic guard → a `topic-publish` naming `pod2:games` at the hub must yield no outbound row.
C6. **`origin`:** new nullable column `messages.origin TEXT` via the repo's `try { db.exec('ALTER TABLE …') } catch {}`
    idiom (db.ts:415-450). Wire: `buildDeliverFrame` adds `origin` (11th key). It SHIPS ALL THE WAY to agents in v1
    (mesh-chat renders by `from` and will prefer `origin` for hub topics — chat-planner 14:54Z): three coordinated
    client-side edits — `protocol.ts DeliverFrame`, `client.ts Inbound` + `normalizeDeliver` (:1085), plugin `meta`
    (server.ts:320-332) — plus the SDK pin bump noted in the plan. `origin` is ATTACKER-SUPPLIED (from the spoke's
    server): ≤256 bytes at the shape check, never routed or ACL'd on; pinned test: a `topic` frame carrying
    `origin:'orch:admin'` changes no ACL outcome and no `from_agent`.
C7. **Echo rule:** one frame per peering cannot exclude the publisher, so an agent subscribed to a hub topic receives
    its own post back (as a chat shows your own message). Documented behaviour, not suppressed — suppression would
    route on `origin`, which C6 forbids. Test pins it.
C8. **Rate:** one bucket per peering, shared by all kinds, counted before kind/dedupe (router.ts:276/285/291) — a busy
    Troll Box rate-limits that peering's DIRECT traffic, and the hub's outbound cost is O(pods) per post. v1 rule:
    size `rate_per_min` for topic volume; per-kind buckets are OUT OF SCOPE (stated in FEDERATION.md). Observability
    for it: C9.
C9. **Metrics:** add `kind` label to `mesh_peer_relays_total` (closed set of four, already in PARTY_FREE_LABELS,
    metrics.ts:240-242 — the walker sanctions it). Rewrite the v0 sentence to "topic NAMES are never a label".
    `('in','delivered')` means "accepted at the border", even when the fan-out filtered everyone; state it in the doc.
C10. **Dedupe:** hub outbound rows take fresh `crypto.randomUUID()` ids; `Forwarder.send` relays `msg_id: row.id`.
    FORBIDDEN: preserving the original msg_id across the hub (destroys the hub's retry idempotency, router.ts:301-303).
C11. **A1 precision — which `subscriptions` FK survives:** drop ONLY `agent_id`'s FK. Keep `topic REFERENCES
    topics(name) ON DELETE CASCADE`. Consequence, documented and pinned: deleting the hub agent that created a topic
    (`deleteAgent` → `DELETE FROM topics WHERE created_by = ?`, db.ts:788) destroys the topic and every spoke's remote
    subscription row on the hub; spokes keep their local `orch:trollbox` rows and go quiet. Operators create hub
    topics from a long-lived agent; `GET /peers/:alias/subscriptions` (A14) is how a spoke's silence is diagnosed.
C12. **Topic-name validation (A7 completed):** new names refuse ':' AND are bounded to ≤256 bytes (a longer name makes
    the hub emit a frame its own peer's :258 check refuses — silently undeliverable). Pre-existing names reported at
    boot, never rejected.
C13. **Three-mesh in-process fixture rules** (border.test.ts:666-800 is 1 live server + 1 router-only side; F4 needs
    2 live + 1 router-only): every alias globally unique in the process (`forwarders` Map keyed by alias, border.ts:303;
    `borderEvents` shared, :332-338; `relayBuckets` keyed by alias, router.ts:161); afterEach = `stopAll()` +
    `forwarders.clear()` + `resetRelayBuckets()`; port offsets distinct from border.test.ts:673's `23500+Date.now()%400`.
C14. **Peering arithmetic for the docs:** N pods cost the hub 2N peering rows + N(N−1) pod↔pod direct rows; minted in
    the drive; FEDERATION.md example uses N=2 (the operator's diagram).

Superseded by this section: B2's `orch:topic:` remote spelling; B1's "per-subscriber ACL with publisher id
'pod1:publisher'" on the hub; v0's "kind is NOT a label"; B1's "the mesh where the topic row is local".
Unchanged: the operator's decisions 1–5, the topology, B3's kinds set, A1–A14 except as refined by C11/C12.

---
# DRIVE RESULT — 2026-09-06 17:55Z — sandbox at 332de94 (== merged tree of #172, main a3a75aa)
f2-verify/drive3.ts (three-mesh sandbox: pod1 7432/7433, orch 7442/7443, pod2 7452/7453; identity labels off).
SUMMARY: PASS — 61 checks, 0 failed, 14 controls, 67.6 s, first run. Steps: setup 3, P13 mint 15, P14 registry+C9 12, P15 hub publish 7, P16 pause 6, P17 spoke post/transit/echo 8, P18a refused post 4, P18b forged origin 6.
Plan-vs-code settled by the drive: P16 — a PAUSED hub→spoke peering gets NO row (drop, not queue); plan §12 was wrong; decision = drop (consistent with direct's paused refusal); doc+test in the follow-up PR.
Run log: f2-verify/run-f4-332de94.jsonl. Caveat: observes a sandbox built from the PR head, not production.
