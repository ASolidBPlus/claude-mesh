# F4 CODE EVAL — PR #172, `feat/f4-topics-across-peerings` @ f62fca6

Fresh Code Evaluator. Contract: `design/F4_PLAN.md` (§16 overrides §1–§15). Worktree
`/home/coder/project/wt-eval172` (detached at f62fca6, left clean). Nine commits on `da79361`.
PR body not consulted; everything below was measured.

## VERDICT: **PASS with one documented gap** — see §5.

Every §10/§16 success criterion PASS. All fifteen mutants RED. One plan requirement is
absent: §16 L's *test* (the doc sentence is present). It is a missing pin, not a defect in
shipped behaviour; recorded as failure (1) below so the merge decision is the planner's.

---

## 1. §10 + §16 success criteria

### 1.1 Whole server suite — PASS
```
$ cd /home/coder/project/wt-eval172/server && bun test
 940 pass
 0 fail
 2571 expect() calls
Ran 940 tests across 54 files. [117.44s]
```

### 1.2 `topic-federation.test.ts` — PASS
```
$ bun test __tests__/topic-federation.test.ts
 55 pass
 0 fail
Ran 55 tests across 1 file. [866.00ms]
```

### 1.3 The four named suites — PASS
```
$ bun test __tests__/guide-citations.test.ts __tests__/observer-cross-border.test.ts \
           __tests__/border.test.ts __tests__/relay.test.ts
 64 pass
 0 fail
Ran 64 tests across 4 files. [8.94s]
```

### 1.4 §16's five additional suites — PASS
```
$ bun test __tests__/duplicate-msgid-crash.test.ts __tests__/migration-chain.test.ts \
           __tests__/peer-keys.test.ts __tests__/outbound-peers.test.ts __tests__/http-admin-topics.test.ts
 95 pass
 0 fail
Ran 95 tests across 5 files. [10.77s]
```

### 1.5 Client suite — PASS
```
$ cd /home/coder/project/wt-eval172/client && bun test
 62 pass
 0 fail
Ran 62 tests across 11 files. [48.18s]
```

### 1.6 Single call site — PASS (3 raw hits, 2 non-comment)
```
$ grep -n 'enqueueOutboundTopicRows' server/router.ts
431:export function enqueueOutboundTopicRows(          <- definition
472: * F4 §15 note 1 — the ONE call site of `enqueueOutboundTopicRows`.   <- doc comment
486:  return enqueueOutboundTopicRows(db, {            <- the one call, in fanOutHomeTopicPublish
```
The builder's report of 3 hits is correct and benign. The CI-enforced version strips comments
before counting — `server/__tests__/topic-federation.test.ts:284` (*"Comments are stripped: this
function is DISCUSSED in several of them…"*). Non-comment hits = 2, exactly as §10 requires.
The call site is `fanOutHomeTopicPublish` (`router.ts:481-495`), per §15 note 1.

### 1.7 `emitTap` containment — PASS
```
$ grep -n 'emitTap(' server/router.ts   # then enclosing function per hit
709 routeRelay · 752 routeRelay · 789 routeRelay · 921 routeDirect · 1018 routeDirect
1108 routePublish · 1168 routePublish · 1175 routePublish · 1432 routeFile
(282, 429 are comment lines)
```
Set = {routeDirect, routeRelay, routePublish, routeFile}. No `emitTap` in `fanOutTopicLocal`
or `enqueueOutboundTopicRows`.

### 1.8 Typecheck ratchet, baselines byte-identical to main — PASS
```
$ git diff da79361 -- .github/typecheck-baseline-server.txt .github/typecheck-baseline-client.txt \
                      .github/typecheck-identities-server.txt .github/typecheck-identities-client.txt
(empty)
$ bash .github/scripts/typecheck-ratchet.sh
server: 116 (baseline 116) ✅ held
client: 37 (baseline 37) ✅ held
EXIT=0
```

---

## 2. Mutants M1–M15 — all RED

Each applied as the exact edit at the site in the worktree, red suite run, then `git checkout -- .`.

| # | site of edit | result | failing test |
|---|---|---|---|
| M1 | `router.ts:308` drop `.filter(id => !isRemoteEndpoint(db, id))` | **RED** 54p/1f | `F4 local fan-out skips remote subscribers > a remote subscription row produces no local delivery row` |
| M2 | move enqueue into `fanOutTopicLocal`; `fanOutHomeTopicPublish` returns `[]` | **RED** 54p/1f | `F4 the enqueue has exactly one call site > the ONE call is inside fanOutHomeTopicPublish, not the local fan-out or the topic arm` |
| M3 | `router.ts:681` delete `if (!isHomeTopic(db, topicName)) return refuse('not_home_topic')` in the `topic-publish` arm | **RED** 54p/1f | `F4 guards the mutant sweep found unpinned > M3: a post edge for a topic that does not exist is still refused, and writes nothing` |
| M4 | `enqueueOutboundTopicRows`: one row **per permitted subscriber** instead of per peering | **RED** 54p/1f | `F4 hub → spoke: one frame per peering > three permitted subscribers on one pod cost exactly ONE outbound row` |
| M5 | `topic` arm: `from_agent`/`aclPrincipal` = `origin ?? stampedFrom` | **RED** 52p/3f | `…carries origin through to the row and the deliver frame, and changes nothing else`; + 2 echo cases |
| M6 | `fanOutTopicLocal`: filter out the subscriber named by `origin`'s remainder | **RED** 53p/2f | `F4 the spoke does not suppress its own agents' echoes > a delivery whose origin names a LOCAL agent is still delivered to that agent` (+ forged-origin case) |
| M7 | thread `frame.msg_id` through as the hub's outbound row id | **RED** 49p/6f | `…the hub's outbound ids are fresh, and differ from the arriving msg_id` (+5 transit cases) |
| M8 | `db.ts:249` drop the `topics` FK in `subscriptions_new` too | **RED** 137p/2f | `migration chain … > ★ a pre-F4 database rebuilds subscriptions FK-less and accepts a remote subscriber`; `★ the second open is a no-op` |
| M9 | `routeSubscribe`: enqueue the `topic-subscribe` row unconditionally | **RED** 54p/1f | `F4 routeSubscribe… > a replayed subscribe enqueues NO second row` |
| M10 | `router.ts:583` allow `':'` in `from` when `isTopicKind` | **RED** 54p/1f | `F4 guards… > M10: a relayed \`from\` containing a colon is refused on every topic kind` |
| M11 | `metricKind = String(frame.kind)` (raw wire kind) | **RED** 73p/1f | `F4 mesh_peer_relays_total carries the relay kind > M11: an unknown kind renders as kind="unknown", not as the peer's string` |
| M12 | `topicNameRefusal`: drop the `':'` rule | **RED** 66p/3f | `F4 POST /topics name validation > refuses a NEW topic name containing ':'`; `…every refusal cause is byte-identical`; `…a NEW local topic name with a colon and no peering is refused` |
| M13 | `db.ts:1302` remove `deleteRemoteSubscriptions` from `revokePeerKey` | **RED** 173p/1f | `F4 remote subscriptions end with the peering > REVOKING the key drops them, and leaves the local subscriber alone` |
| M14 | `topic-publish` arm: `expires_at: now + 300_000` | **RED** 54p/1f | `…expires_at comes from the arriving frame's ttl, never a default` |
| M15 | `topic-publish` arm: `aclPrincipal: \`${alias}:${from}\`` | **RED** 53p/2f | `…M15: a hub subscriber holding only the TOPIC edge receives the post`; `F4 guards… > M5: the re-originated row is FROM the topic principal, with origin beside it` |

Two notes on mutants whose *named* red test was not the one that fired (the mutant is still
killed in each case):

- **M2** — the structural case fired; the `pod3:*` behavioural control stayed green. §15 note 1
  predicts the control reds; measured, it does not. The structural case is the load-bearing one
  and it is CI-enforced, so the guarantee holds, but the plan's second pin is weaker than stated.
- **M8** — `db.test.ts`'s "deleting the topic's creator removes the remote subscription rows"
  stayed green; `migration-chain.test.ts` reds instead. That is correct behaviour, not a gap:
  under §16 B the base DDL is already FK-less on `agent_id`, so a fresh database never runs the
  rebuild (early return), and only an upgraded legacy database can observe the rebuild's DDL.
  The plan named the wrong suite for this mutant; the mutant is killed.

---

## 3. Plan conformance spot-checks

| | check | result |
|---|---|---|
| a | `routeRelay` (`router.ts:511-798`) never calls `routePublish` — the only occurrences are comments at `:263`, `:419`, the definition at `:1043` and a comment at `:1273` | **PASS** |
| b | every border row id is a fresh `crypto.randomUUID()` (§16 A): `topic` `router.ts:451`, `topic-publish` `:1094`, `topic-subscribe` `:1236`, `topic-unsubscribe` `:1300`. No `frame.msg_id` reaches `messages.id` anywhere | **PASS** |
| c | `buildDeliverFrame` (`router.ts:57-87`) emits `origin` as the 11th key, and it is a REQUIRED param field (§16 C); `client/src/client.ts:1104` does `origin: f.origin ?? null` | **PASS** |
| d | `metrics.ts:79` `incPeerRelay(alias, direction, outcome, kind = 'unknown')`; `border.test.ts:269`/`:339` still three-arg — and `git diff da79361 -- server/__tests__/border.test.ts` is **empty**, the whole file is untouched | **PASS** |
| e | `rebuildSubscriptionsFkLess` (`db.ts:~230-262`) early-returns when `foreign_key_list` shows only `topics`, and `subscriptions_new` keeps the `topic` FK + cascade; base DDL `db.ts:423-428` is FK-less on `agent_id`, FK on `topic` (§16 B) | **PASS** |
| f | alias `topic` reserved at both doors: `http-admin.ts:1520` (mint) and `:1943` (outbound), both `400 alias 'topic' is reserved` | **PASS** |
| g | `handlePeerSubscriptionsGet` (`http-admin.ts:1652-1663`) reads `params.id` (§16 J); route registered at `:2129` after `exact('/peers')` | **PASS** |
| h | `docs/FEDERATION.md:157` `### Hub and spoke: topics across a border` — kinds table (pod→orch / orch→pod / pod↔pod), two grant classes with four `curl` edges, echo rule, shared-bucket rule, N-pod arithmetic (2N + N(N−1)), and "`origin` is display only … treat it as untrusted text". §6's old "Topics across a border" row is **gone**, replaced by Transitive topics / Per-kind rate buckets / Wildcard subscriptions / `DELETE /topics`. `guide-citations.test.ts` green (§1.3), which is the enforcement of the `path.ts` + line-start-defined-symbol rule; new §4 row at `:258` cites `` `server/http-admin.ts` `` `` `handlePeerSubscriptionsGet` `` (defined at line start, `:1652`) | **PASS** |
| i | §16 L: **doc present** (`FEDERATION.md:217-220`, "While a spoke's outbound peering is PAUSED…") and the rationale is at `router.ts:250-253`. **Test ABSENT** — see §5(1) | **PARTIAL** |
| j | §16 N uniformity shape present: `topic-federation.test.ts:463-496` asserts the answer is a pure function of the input for five causes, then drives ONE input (`orch:`) through TWO causes (empty remainder, then unpeered prefix after deleting the peering) and asserts identical bytes | **PASS** |
| k | `client/src/peer-client.ts` diff: `to` and `payload` widened to optional, `topic?` and `origin?` added, plus a doc comment. No logic touched | **PASS** |
| l | four boot reports pinned by `server/__tests__/boot-reports.test.ts` (new, commit 9): `findPeerAliasCollisions`/`agents.peer_alias_collision`, `findInvalidTopicNames`/`topics.invalid_names`, `findTopicPrefixAgents`/`agents.topic_prefix_ids`, plus the inline `agents.legacy_colon_ids`; with a negative control and a "never blocks boot" case | **PASS** |
| m | `git log da79361..HEAD --format='%B' \| grep -i 'co-authored\|signed-off'` → none | **PASS** |
| n | operator's name: no occurrence in the tree (excluding `.git`/`node_modules`) and none in the nine commit messages | **PASS** |

---

## 4. Required-and-absent / forbidden-and-present

**Absent (required):**

1. §16 L's test — "one test asserting the local fan-out while disabled". No test anywhere
   publishes to a home topic while its outbound peering is `enabled = 0`. The only
   disabled-peering case in `server/__tests__/topic-federation.test.ts:605` ("refuses when the
   return peering is PAUSED") is §16 O's return-peering pin, a different claim. Searched
   `server/__tests__/*.test.ts` for `enabled = 0`: `border.test.ts:233` (drain skips disabled),
   `outbound-peers.test.ts:279`/`:502` (pre-F4), `topic-federation.test.ts:607` (§16 O).

**Forbidden and present:** none found.

- `routeRelay` → `routePublish`: absent (§3a).
- msg_id preserved across the hub: absent (§3b); M7 confirms it is pinned.
- `origin` routed on / ACL'd on / metric-labelled: absent. `grep 'origin' server/router.ts` shows
  no `origin` operand to `aclCheck`, `getAgentById`, `deliverOrQueue` or any `inc*` call.
- `topic_relays` table: does not exist.
- `PARTY_FREE_LABELS`: `git diff da79361..HEAD -- server/metrics.ts` shows no edit to it.
- Topic-name metric label: none; the only new metrics text is the `mesh_peer_relays_total` HELP line.
- ACL-edge deletion moved into `revokePeerKey`: not moved — `db.ts:1296-1298` states it explicitly
  and only `deleteRemoteSubscriptions` was added inside the transaction.
- `.github/typecheck-*` files: byte-identical to `da79361` (§1.8).

Also verified in passing (§16 D): `routePublish`'s remote-topic branch (`router.ts:1060-1096`)
sits after the size check and counts `incSent`/`incBytes('in')`/`observePayloadBytes` only after
every refusal check, and `KIND_NOT_ALLOWED` sits behind the ACL check.

---

## 5. Numbered failures

1. **§16 L is documented but not tested.** The amendment requires "One sentence in
   FEDERATION.md §3 (d) **and one test** asserting the local fan-out while disabled". The
   sentence is at `docs/FEDERATION.md:217`; the test does not exist. The behaviour itself is
   correct (`isHomeTopic` uses the enabled-only `hasOutboundPeer`, `db.ts:1369`), so this is an
   unpinned accepted-consequence, not a regression: nothing would go red if someone later made
   `hasOutboundPeer` enabled-agnostic here, which is precisely the change §16 L anticipates.

Nothing else fails. Recommend merge conditional on adding that one test (a ~10-line case in
`topic-federation.test.ts`: outbound `orch` peering `enabled = 0`, publish `orch:trollbox`,
assert a local delivery row and zero `to_agent='orch:'` rows).

*Worktree left at f62fca6 with a clean tree (`git status --porcelain` empty).*
