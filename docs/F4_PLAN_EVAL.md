# F4_PLAN_EVAL — plan evaluation (fresh evaluator, read-only against `origin/main` = b861e82)

Method: detached worktree at `origin/main`. Every line/symbol below re-read at that tree.
`04b242c..b861e82` touches only `ws-server.ts` + `auth-seam.test.ts`, so the plan's
"verified at 04b242c" line numbers should hold for every other file — and mostly do.
Design not re-litigated; this is a correctness/completeness check on the PLAN.

## 1. CLAIM TABLE

| # | plan claim | verdict | evidence |
|---|---|---|---|
| 1 | `stampedFrom` at `router.ts:299` | TRUE | `router.ts:299` `const stampedFrom = \`${alias}:${from}\`` |
| 2 | `routeRelay` shape checks: msg_id/from/to/payload/kind, `to` currently required, `kind !== 'direct'` refused | TRUE | `router.ts:248-253`; one-hop checks `:258-259` |
| 3 | order rate → kinds → dedupe is as described | TRUE | disabled `:275`, rate `:276-279`, kinds parse+includes `:283-285`, dedupe `:290-295` |
| 4 | `routeDirect` remote branch at `:374-478` | TRUE | `const colon` at `:374`, branch closes `:475-479` |
| 5 | every remote-branch cause answers `AGENT_NOT_FOUND` / `unknown agent: …`, `KIND_NOT_ALLOWED` the ONE exception behind the ACL | **PARTLY** | ACL→kind order confirmed (`:400-414`), but `DUPLICATE_MSG_ID` at `:415-418` is a **second** non-uniform code, also behind the ACL |
| 6 | ttl clamp idiom at `router.ts:309-313` | TRUE | `rawTtl`/`Number.isFinite`/`Math.min(...,MAX_TTL_MS)` at `:310-312` |
| 7 | local topic fan-out is `router.ts:602-711` | TRUE | `:602` `// 3. Get subscribers` … `:704` loop end; tap at `:707` stays outside |
| 8 | `routeUnsubscribe` never refuses (#129) | TRUE | `router.ts:726-748`, unconditional `return { ok: true }` |
| 9 | `rebuildAclFkLess` structure (txn guard, zero-FK early return, index capture, pragma outside/DDL inside, finally ON, log, fatal) | TRUE | `db.ts:118-192` exactly as described |
| 10 | migration idiom at `db.ts:415-450` | TRUE | try/catch ALTERs at `:414-460`; `failed_code` at `:460` |
| 11 | `insertMessage` param + INSERT column list | TRUE | `db.ts:1562-1589` |
| 12 | `deleteAgent` deletes acl explicitly inside a txn | TRUE | `db.ts:776-799`, acl delete `:791` |
| 13 | `upsertPeer` non-rotation rebind block with `deletePeeringEdges(...,'inbound')` + log | TRUE | `db.ts:1503-1513` |
| 14 | `revokePeerKey` txn with `UPDATE peers SET disabled = 1 WHERE minted_by_key = ?` | TRUE | `db.ts:1153-1162` |
| 15 | `hasOutboundPeer` / `hasInboundPeer` exist | TRUE | `db.ts:1220-1228` / `:1206-1209`; **both are enabled-only / disabled=0** |
| 16 | `listEnabledOutboundPeers` exists under that name | TRUE | `db.ts:1331-1333` |
| 17 | `getPeerByAlias` exists | TRUE | `db.ts:1164` |
| 18 | `idMatch` / `exact` route helpers; `exact('/peers')` cannot swallow the new path | TRUE | `http-admin.ts:321-326`, ROUTES `:2072`. Capture is named **`id`**, not `alias` |
| 19 | `RESERVED_ALIAS` at both doors ~`:1496` / ~`:1889` | TRUE | `http-admin.ts:1496-1502`, `:1889-1892`; const at `db.ts:1039` |
| 20 | `POST /agents` refuses any ':' at `:632-637` | TRUE | `http-admin.ts:632-637` |
| 21 | kinds free-form, "no validation change (`http-admin.ts:1386-1392`, `:1794-1800`)" | **FALSE (citation)** | conclusion right, lines wrong: kinds validation is `:1519-1525` and `:1927-1933`; `:1386-1392` is `fileAccessAuthorized` |
| 22 | `handleTopicPost` exists, `getOrCreateTopic` after the body checks | TRUE | `http-admin.ts:535-570` |
| 23 | `incPeerRelay(alias,direction,outcome)` + two render arms | TRUE | `metrics.ts:63-65`, `:404-425` |
| 24 | `PARTY_FREE_LABELS` already contains `kind`; canary pin stays green | TRUE | `metrics.ts:240-242`; pin `border.test.ts:313-315` |
| 25 | two boot reports in `server.ts`, same try/catch shape | TRUE | `server.ts:147-156`, `:162-171` |
| 26 | `buildDeliverFrame` emits exactly ten keys | TRUE | `router.ts:50-72`; no test pins the key set (`router.test.ts:224-250` asserts field-by-field) |
| 27 | `DeliverFrame` / `Inbound` / `normalizeDeliver` locations | TRUE | `client/src/protocol.ts:107-121`; `client/src/client.ts:111-130`; `normalizeDeliver` at `client.ts:1085` |
| 28 | SDK replays subscriptions on reconnect (`client.ts:915-919`) | TRUE | `client/src/client.ts:912-920` |
| 29 | `Forwarder.send` shape + emits `{type:'error',code:'REMOTE_REFUSED',ref:row.id}` | TRUE | `border.ts:213-238`; refusal path `:265-282` |
| 30 | `forwarders` / `borderEvents` / `relayBuckets` / `resetRelayBuckets` are module-global | TRUE | `border.ts:31,303`; `router.ts:161,165` |
| 31 | drain range `to_agent >= 'a:' AND < 'a;'` selects a bare-alias row | TRUE | `DRAIN_OUTBOUND_SQL` `db.ts:1293-1300`; `'pod1:' >= 'pod1:'` |
| 32 | `border.test.ts:673` port formula `23500 + Date.now()%400` | TRUE | verbatim. **But `border.test.ts:910` already uses `23900 + Date.now()%90`** — the plan's proposed `23900 + …%50` overlaps it |
| 33 | `observer-cross-border.test.ts` SCAN = set of tap-emitting fn names vs DRIVEN | TRUE | `:109` DRIVEN, `:144-174` SCAN; declaration regexes are line-anchored, so top-level helpers with no `emitTap` are inert |
| 34 | `guide-citations.test.ts` `definesIn` is `^\s*`-anchored; §4 row parser cannot bind a `:`-placeholder path | TRUE | `definesIn` `:60-65`; path regex `` /`GET (\/[A-Za-z0-9_\-/]+)`/ `` excludes `:` and needs a closing backtick, so `` `GET /peers/:alias/subscriptions` `` yields `path === null` and the row is dropped before the ROUTES equality check |
| 35 | FEDERATION.md §2 Step 4 / §3 / §4 Read APIs+Metrics / §6 row exist as described | TRUE | `docs/FEDERATION.md:121,129,172,193,417-427`; the row to delete is `:422` |
| 36 | `relay.test.ts:257-258` are the two `mesh_peer_relays_total{alias=…}` pins | TRUE | verbatim; they are the ONLY such assertions in the repo |
| 37 | plugin `…/plugins/mesh/server.ts` `inboundToChannelNotification` at `:307`, `case 'topic':` at `:323-324` | TRUE (±1) | `case 'topic':` is `:322`, body `:323`, `break` `:324`; pin `#1071b61…` confirmed in that `package.json:13` |
| 38 | ratchet `.github/scripts/typecheck-ratchet.sh`, baseline files, server baseline 116 | TRUE | files present; `typecheck-baseline-server.txt` = `116` |
| 39 | "a remote publish does NOT fan out locally" contradicts nothing on main | TRUE | `router-topic.test.ts` colon topics (`game:moves`) are pre-created via `getOrCreateTopic` and have no outbound peering, so both the remote branch and `topicNameRefusal` are inert there |
| 40 | `topic-unsubscribe` skipping `allowedKinds.includes` is consistent with check order | TRUE | the JSON parse (`bad_kinds_column`, `:283-284`) still runs; only the `includes` is skipped |
| 41 | the 11th deliver key breaks no test | TRUE | no `Object.keys` / `toEqual` pin on a deliver frame or on `Inbound` (`server/__tests__`, `client/__tests__` swept) |
| 42 | a 4th `incPeerRelay` arg breaks no existing caller | **FALSE** | 8 production call sites (`border.ts:247,271,290,297`; `router.ts:242,277,293,333`) **and two test call sites** `border.test.ts:269`, `:339`. A *required* 4th param adds 2 TS errors over baseline 116 → ratchet fails |
| 43 | migration-chain framework supports the FK-ful→FK-less subscriptions case | **PARTLY** | the framework (hand-built legacy DB then `openDb`) supports it, but `preFederationDb` (`migration-chain.test.ts:53-95`) creates **no `topics` and no `subscriptions` table** — the builder must author that legacy DDL, including `topics`, or the `topic` FK has nothing to resolve |
| 44 | fixture: router-only + two live ws servers + two borders in one bun process | PARTLY | two live servers are precedented (`border.test.ts` starts one per describe; `auth-seam.test.ts` starts nine sequentially); **no three-server precedent exists**. Mechanically fine — ports differ, dbs differ |
| 45 | `borderEvents.removeAllListeners()` is safe for other tests | TRUE | exact precedent at `border.test.ts:34-35` (`forwarders.clear(); borderEvents.removeAllListeners()`); `startBorder` re-registers per call (`border.ts:332`) |
| 46 | every named existing test file exists | TRUE for files, **FALSE for two placements** | `POST /topics` is tested in `http-admin-topics.test.ts` (not `http-admin.test.ts`); reserved-alias doors in `peer-keys.test.ts:83` and `outbound-peers.test.ts:442` |
| 47 | `aclGrant('topic:x', …)` needs no peering once `isRemoteEndpoint` exempts `topic:` | TRUE | `assertLocalEndpointExists` returns early on any ':' (`db.ts:876`); `assertPeeringAllowed`'s local `isRemote` closure is at `db.ts:861` and is the only gate |
| 48 | FK enforcement is on, so the retained `topic` FK still cascades | TRUE | `db.ts:202` `PRAGMA foreign_keys = ON;`; cascade asserted at `delete-agent-purge.test.ts:292-305` |
| 49 | commit 3's extraction alone keeps `observer-cross-border` green | TRUE | helper contains no `emitTap`; SCAN only collects names of functions containing one |
| 50 | `grep -n 'enqueueOutboundTopicRows' server/router.ts` → exactly 2 | TRUE (as specified) | definition + the single call inside `fanOutHomeTopicPublish` |

## 2. DECISIONS THE BUILDER WOULD BE FORCED TO MAKE

1. **`messages.id` for every new border row.** §7 fixes it only for the hub's outbound rows ("a FRESH `crypto.randomUUID()` per hub outbound row"). Unspecified for the spoke's `topic-publish` row, the `topic-subscribe` row and the `topic-unsubscribe` row. Picking `frame.msg_id` for the `topic-publish` row is the natural reading of "insert ONE topic-publish row … return `{ok:true, msg_id}`" and reintroduces the #94 crash: `routePublish` has **no** duplicate check (unlike `routeDirect:415`), so a repeated publish msg_id throws a bare SQLite constraint error.
2. **Where the remote-topic branch sits relative to the metrics.** §7 says "remote-topic branch **first**", but `routePublish` counts `incSent`/`incBytes`/`observePayloadBytes` at `:595-597`, *before* topic handling — unlike `routeDirect`, which counts inside the branch after every check. First-before-metrics, or first-after-metrics (double-counting nothing but refusing after a count)? #96 pins metric ordering elsewhere; the builder must choose.
3. **Whether `CREATE TABLE IF NOT EXISTS subscriptions` (`db.ts:335-340`) also loses the `agent_id` FK.** The acl precedent did exactly that (`db.ts:304-310` is FK-less; the rebuild is upgrade-only). Silent in the plan.
4. **Is `buildDeliverFrame`'s new `origin` required or optional?** If required, `router.ts:113`, `router.ts:671` and `__tests__/router.test.ts:238`'s `sample` must be updated (`router.ts:572` and `reminder-scheduler.ts:58` pass a whole `Message` and get it free).
5. **Which alias each pod uses for the hub in the fixture** — see amendment 7.
6. **`handlePeerSubscriptionsGet` reads `ctx.params.id`** (idMatch names the capture `id`); the plan writes the route as `:alias`.
7. **Home-ness of a topic while its peering is PAUSED.** `hasOutboundPeer` is enabled-only, so `isHomeTopic(db,'orch:trollbox')` flips to **true** on a spoke the moment the admin PATCHes the peering `enabled:false`, and `routePublish`'s remote branch is skipped — the post fans out locally instead of queueing. P16 only exercises the hub→spoke pause.
8. **Legacy DDL for the migration-chain case** (which tables, which rows) — see claim 43.
9. **Whether `topic-unsubscribe` also skips the `bad_kinds_column` refusal** (the plan's wording implies no; worth saying).

## 3. VERDICT — **GO with amendments** (12, all mechanical; no design question re-opened)

1. §7 `metrics.ts`: change the signature to `export function incPeerRelay(alias: string, direction: string, outcome: string, kind = 'unknown'): void`, and add to §8 commit 7: "`border.test.ts:269` and `:339` keep their three-argument calls and render `kind=\"unknown\"`; do not edit them." (A required 4th param adds two TS errors over the 116 baseline and fails the ratchet.)
2. §4 / §7 `db.ts`: add "Also drop `REFERENCES agents(id) ON DELETE CASCADE` from `agent_id` in `CREATE TABLE IF NOT EXISTS subscriptions` (`db.ts:335-340`), keeping the `topic` FK — the acl precedent (`db.ts:304-310`) is FK-less in the base DDL and `rebuildAclFkLess` handles upgrades only. Without this every fresh database rebuilds on its first open."
3. §7 / §14: add "Every row enqueued for a border — the spoke's `topic-publish`, `topic-subscribe`, `topic-unsubscribe`, and the hub's outbound `topic` rows — takes a fresh `crypto.randomUUID()` as `messages.id`. NEVER `frame.msg_id`: `routePublish` has no duplicate check and a reused id throws (#94, `duplicate-msgid-crash.test.ts`). `routePublish`'s remote branch still returns `{ok:true, msg_id: frame.msg_id}` to the caller."
4. §2 fix the citation: `http-admin.ts:1386-1392, :1794-1800` → **`http-admin.ts:1519-1525`, `:1927-1933`** (`:1386-1392` is `fileAccessAuthorized`).
5. §8 commit 2 RED list: replace `http-admin.test.ts` with **`peer-keys.test.ts`** (alias `topic` at the mint door, beside `:83`), **`outbound-peers.test.ts`** (alias `topic` at the outbound door, beside `:442`) and **`http-admin-topics.test.ts`** (`POST /topics {"name":"a:b"}` → 400; an existing colon topic untouched). Mirror the same names in §9's "additions to existing suites".
6. §7 `router.ts`: state "`buildDeliverFrame`'s param gains `origin: string | null` as a REQUIRED field; update `router.ts:113` (`origin: null`), the extracted fan-out call at `router.ts:671`, and `__tests__/router.test.ts:238`'s `sample`. `router.ts:572` and `reminder-scheduler.ts:58` pass a whole `Message` and need no change."
7. §9 fixture rules: replace "every alias in the file is globally unique in the process" with "every alias is globally unique in the process — **including across meshes**: pod1 names the hub `orcha` and pod2 names it `orchb`, because `relayBuckets` is keyed by alias alone and both pods would otherwise share one inbound rate bucket. The same-alias rule binds the two tables ON ONE MESH (the hub's `peers.pod1` and `outbound_peers.pod1`), not across meshes."
8. §9 ports: `border.test.ts:910` already uses `23900 + Date.now()%90`. Change the plan's bases to **`24100 + Date.now()%50`, `24160 + Date.now()%50`, `24220 + Date.now()%50`** (three servers, three bases — the plan names only two).
9. §6 precedent sentence: `routeDirect`'s remote branch has a second non-uniform code, `DUPLICATE_MSG_ID` (`router.ts:415-418`). Reword to "`KIND_NOT_ALLOWED` is the one **topology-bearing** exception and sits behind the ACL check (`DUPLICATE_MSG_ID` is about the caller's own id, not the topology)."
10. §5: add "the alias is `ctx.params.id` — `idMatch` names its single capture `id` (`http-admin.ts:323-326`)."
11. §8 commit 1: add "`migration-chain.test.ts`'s legacy fixture must create BOTH `topics` and the FK-ful `subscriptions` (the `topic` FK needs a `topics` table to resolve); `preFederationDb` (`:53`) has neither today."
12. §2 / §7: add one sentence on the paused-peering case — "`hasOutboundPeer` is enabled-only (`db.ts:1226`), so while a peering is PATCH-disabled a spoke treats `orch:trollbox` as a home topic and `routePublish` fans it out locally instead of queueing for the border. That is accepted for v1; the `topic-publish` rows already queued still drain on re-enable."

Nothing else blocks. `routeSubscribe`'s new `topicNameRefusal` and the `isRemoteEndpoint` subscriber filter were checked against every colon-bearing topic on main (`router-topic.test.ts`'s `game:moves` is always pre-created via `getOrCreateTopic`, and every existing subscriber id is a registered local agent), so commits 2 and 3 leave the suite green.
