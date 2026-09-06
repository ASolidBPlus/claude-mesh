# F4 PLAN — topics across peerings (hub-and-spoke). Implementer's contract.
<!-- Design is CLOSED. Everything below is decided. Do not re-open a decision; if a fact
     here contradicts the code, stop and report — do not choose. Verified at origin/main 04b242c
     (main is b861e82 at hand-off; #168 touched ws-server.ts only). -->

## 1. Scope (five lines)
1. The operator's five decisions: (1) an agent on a spoke may subscribe to a topic on another mesh; (2) a publish crosses each peering ONCE and counts once against that peering's rate; (3) the RECEIVING mesh fans out locally with its own per-subscriber ACL; (4) the SENDING mesh decides whether the topic may leave (the publisher must hold an edge to the topic principal); (5) topic traffic uses the SAME directional model — spoke→hub carries `topic-subscribe`/`topic-unsubscribe`/`topic-publish`, hub→spoke carries `topic`, so a peered pair needs BOTH peerings, each admin granting kinds on their own row.
2. Topology (`design/F4_topology_2026-09-06.png`): an ORCHESTRATOR mesh ("hub") owns the topics (Analytics, Game State, Troll Box, Dark Net Updates); POD 1 / POD 2 meshes host the chat agents; each pod peers with the hub in both directions and with the other pod for direct traffic only. Hub-and-spoke for topics; pod↔pod stays `['direct']` (F1–F3 as shipped).
3. A post crosses at most TWO borders (spoke→hub, hub→spoke) and only through the hub that owns the topic; a received `topic` delivery is never re-originated.
4. Grants come in two enumerable classes per hub topic: RIGHT TO POST (spoke `publisher → orch:trollbox`; hub `pod1:publisher → topic:trollbox`) and RIGHT TO HEAR (hub `topic:trollbox → pod1:sub`; spoke `orch:trollbox → sub`). Read-only hub topics (Game State, Analytics) = the hub withholds the inbound post edge.
5. Out of scope, stated up front: per-kind rate buckets, transitive topics, wildcard subscriptions, a dynamic subscribe tool, `DELETE /topics`.

## 2. Vocabulary (fixed spellings — do not invent variants)
- Local topic principal: `topic:<name>` (one colon, reserved prefix). Remote topic principal: `<alias>:<name>`.
- The mapping between them is `stampedFrom` (`server/router.ts:299`): a hub→spoke frame with bare `from = trollbox` becomes `orch:trollbox` on arrival. No new convention.
- `isHomeTopic(db, t)` := `topicExists(db,t) && !(t.includes(':') && hasOutboundPeer(db, t.slice(0, t.indexOf(':'))))`. Home-ness is the PREFIX test, never row existence (`routeSubscribe` creates a local `topics` row named `orch:trollbox` on the spoke).
- Relay kinds, closed set of five: `direct` · `topic` (hub→spoke delivery) · `topic-subscribe` · `topic-unsubscribe` · `topic-publish` (spoke→hub post). Grantable kinds in `peers.kinds`/`outbound_peers.kinds`: `direct`, `topic`, `topic-subscribe`, `topic-publish` — `topic-unsubscribe` is NOT grantable and is accepted whenever the peering exists (teardown is always allowed). No `kinds` validation change: both columns are free-form `string[]` (`http-admin.ts:1519-1525`, `:1927-1933`).
- `origin`: opaque display-only string, ≤256 bytes, ATTACKER-SUPPLIED. Never routed on, never an ACL principal, never a metric label.

## 3. Wire shapes (literal JSON)
```jsonc
// spoke → hub. payload/content_type/ttl_ms ABSENT.
{"type":"relay","kind":"topic-subscribe","msg_id":"9f1c…","from":"alice","topic":"trollbox"}
{"type":"relay","kind":"topic-unsubscribe","msg_id":"9f1d…","from":"alice","topic":"trollbox"}
// spoke → hub POST. `to` ABSENT. `from` bare. `origin` ABSENT (the hub sets it).
{"type":"relay","kind":"topic-publish","msg_id":"a2b3…","from":"alice","topic":"trollbox",
 "payload":"hi","content_type":"text/plain","ttl_ms":300000}
// hub → spoke DELIVERY. `to` ABSENT. `from` is the BARE TOPIC NAME (the principal).
{"type":"relay","kind":"topic","msg_id":"c4d5…","from":"trollbox","topic":"trollbox",
 "origin":"pod1:alice","payload":"hi","content_type":"text/plain","ttl_ms":298431}
// deliver frame to a local agent (11th key `origin`, null for every non-topic-federation path)
{"type":"deliver","msg_id":"…","kind":"topic","from":"orch:trollbox","to":null,
 "topic":"orch:trollbox","correlation_id":null,"payload":"hi","content_type":"text/plain",
 "sent_at":1788000000000,"origin":"pod1:alice"}
```

## 4. DB shapes
```sql
-- Additive migration, repo idiom (db.ts:415-450). Runs on every boot; second boot is a no-op.
try { db.exec('ALTER TABLE messages ADD COLUMN origin TEXT'); } catch {}

-- rebuildSubscriptionsFkLess: DROP ONLY the agent_id FK. KEEP topic's FK+cascade (C11).
CREATE TABLE subscriptions_new (
  agent_id      TEXT NOT NULL,                                   -- FK GONE: may name 'pod1:alice'
  topic         TEXT NOT NULL REFERENCES topics(name) ON DELETE CASCADE,
  subscribed_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, topic)
);
INSERT INTO subscriptions_new SELECT agent_id, topic, subscribed_at FROM subscriptions;
DROP TABLE subscriptions; ALTER TABLE subscriptions_new RENAME TO subscriptions;
-- then replay every captured index DDL.
```
Row shapes in `messages` (no new table — the drain range `to_agent >= 'a:' AND < 'a;'` selects a bare-alias row, and expiry/revocation sweep it):

| purpose | to_agent | kind | topic | from_agent | origin | payload | expires_at |
|---|---|---|---|---|---|---|---|
| spoke→hub subscribe/unsubscribe | `orch:` | `topic-subscribe` / `topic-unsubscribe` | `trollbox` | `alice` | NULL | `''` | `now + MAX_TTL_MS` |
| spoke→hub post | `orch:` | `topic-publish` | `trollbox` | `alice` | NULL | the payload | `now + ttl` |
| hub→spoke delivery | `pod1:` | `topic` | `trollbox` | `topic:trollbox` | `pod1:alice` or the hub publisher's bare id | the payload | `now + ttl` |

Subscribe rows get `MAX_TTL_MS` (7 days = the dedupe window), not the 5-minute default: subscription state is not time-sensitive traffic and must survive a peering outage; a longer wait is diagnosed with `GET /peers/:alias/subscriptions`.

## 5. Admin API (new)
```
GET /peers/:alias/subscriptions        (admin auth, like every other /peers route)
200 {"alias":"pod1","subscriptions":[{"agent_id":"pod1:alice","topic":"trollbox","subscribed_at":1788000000000}]}
404 {"error":"no such peer"}           // getPeerByAlias(db, alias) === null
```
Route entry, placed after `exact('/peers')` (which cannot swallow it):
`{ method:'GET', match: idMatch(/^\/peers\/([^/]+)\/subscriptions$/), handler: handlePeerSubscriptionsGet }`.

## 6. Refusal codes (exact, and where uniformity binds)
Precedent: `routeDirect`'s remote branch (`router.ts:374-478`) — every cause answers `AGENT_NOT_FOUND` with `unknown agent: <what the caller supplied>`; `KIND_NOT_ALLOWED` is the ONE exception and sits **behind** the ACL check, justified by reachability (#123).

| door | causes that MUST answer as a PURE FUNCTION OF THE INPUT (same input → same bytes regardless of cause) | code / message |
|---|---|---|
| `routeSubscribe` (local agent) | no outbound peering for the prefix (falls through to local, then the new-name ':' rule refuses) · peering lacks kind `topic-subscribe` · empty remainder · second ':' · name >256 bytes | `AGENT_NOT_FOUND`, `unknown topic: ${frame.topic}` |
| `routePublish` remote branch | no peering · malformed address · **no RIGHT-TO-POST edge** `publisher → orch:trollbox` | `AGENT_NOT_FOUND`, `unknown topic: ${frame.topic}` |
| `routePublish` remote branch, AFTER the ACL passes | outbound peering lacks kind `topic-publish` | `KIND_NOT_ALLOWED`, `kind not permitted to ${alias}` |
| `routeRelay`, every topic kind | bad shape · unknown/absent topic · not a home topic · no return peering · kind not permitted · no post edge · bad origin · disabled peer · dedupe-miss | `RELAY_REFUSED` (reason only to the log, `evt:'peer.relay_refused'`) |
| `routeRelay` rate | bucket empty | `RATE_LIMITED` (unchanged, the one actionable refusal) |

`routeSubscribe` emits **no** `KIND_NOT_ALLOWED`: subscribe has no ACL gate in front of it, so a distinct code there would be a free topology oracle for any authenticated agent. `routeUnsubscribe` KEEPS its no-refusal contract (#129) — it never returns an error, for any cause.
A6's "remote subscribe to a nonexistent topic is refused" is enforced at the HUB (`RELAY_REFUSED`); the spoke's local ack means "accepted for the border" (D8) and the subscriber learns the outcome via the forwarder's existing `{type:'error',code:'REMOTE_REFUSED',ref:row.id}` (border.ts `onSendError`).

## 7. Files, exports, signatures

### `server/db.ts`
- `export function rebuildSubscriptionsFkLess(db: Database): void` — modelled EXACTLY on `rebuildAclFkLess` (`db.ts:118-192`): `db.inTransaction` guard that throws; early return when `PRAGMA foreign_key_list(subscriptions)` shows only the `topic` FK; capture index DDL from `sqlite_master`; `PRAGMA foreign_keys = OFF` OUTSIDE the transaction, four DDL statements + index replay INSIDE; `PRAGMA foreign_keys = ON` in `finally`; `console.log({evt:'db.subscriptions_rebuilt_fkless',…})`; fatal on error. Called from `openDb` immediately after `rebuildAclFkLess`.
- `try { db.exec('ALTER TABLE messages ADD COLUMN origin TEXT'); } catch {}` beside the other migrations; `interface Message` gains `origin: string | null`; `insertMessage`'s param gains `origin?: string | null` (defaults null) and the INSERT gains the column.
- `export function isRemoteEndpoint(db: Database, endpoint: string): boolean` — the ONE definition of `endpoint.includes(':') && getAgentById(db, endpoint) === null`, exempting `topic:`; `assertPeeringAllowed`'s local closure is deleted and calls this.
- `export const TOPIC_PRINCIPAL_PREFIX = 'topic:'` — `isRemoteEndpoint` returns false for anything starting with it: a local topic principal is neither remote nor required to be an agent.
- `export function topicNameRefusal(db: Database, name: string): string | null` — returns a reason iff `name` names a **new** topic (no `topics` row) that contains ':' or exceeds 256 bytes UTF-8; null otherwise. Pre-existing names are never rejected (F0b rule).
- `export function findInvalidTopicNames(db: Database): string[]` — boot report; `SELECT name FROM topics WHERE (name LIKE '%:%' AND substr(name,1,instr(name,':')-1) NOT IN (SELECT alias FROM outbound_peers)) OR length(CAST(name AS BLOB)) > 256`.
- `export function findTopicPrefixAgents(db: Database): string[]` — `SELECT id FROM agents WHERE id >= 'topic:' AND id < 'topic;'`; boot report only.
- `export function topicExists(db: Database, name: string): boolean`.
- `export function subscribeCreated(db, agent_id: string, topic: string): boolean` / `export function unsubscribeRemoved(db, agent_id: string, topic: string): boolean` — the `INSERT OR IGNORE` / `DELETE` become single-writer here and return `changes === 1`; existing `subscribe`/`unsubscribe` keep their signatures and delegate.
- `export function listRemoteSubscribers(db, alias: string, topic: string): string[]` — `SELECT agent_id FROM subscriptions WHERE topic = ? AND agent_id >= ? AND agent_id < ?` bound `` `${alias}:` ``/`` `${alias};` ``.
- `export function listPeerSubscriptions(db, alias: string): {agent_id:string;topic:string;subscribed_at:number}[]` — same prefix range, all topics, `ORDER BY topic, agent_id`.
- `export function deleteRemoteSubscriptions(db, alias: string): number` — prefix-range DELETE. Called (a) in `upsertPeer`'s non-rotation rebind, in the same block as `deletePeeringEdges(db, peer.alias, 'inbound')`, logged with `removed_subscriptions`; (b) inside `revokePeerKey`'s transaction, after the `UPDATE peers SET disabled = 1`, for every alias from `SELECT alias FROM peers WHERE minted_by_key = ?`. Edge deletion on revoke is NOT moved by F4.
- `deleteAgent`: add `db.prepare('DELETE FROM subscriptions WHERE agent_id = ?').run(id)` inside the transaction, beside the `acl` delete, replacing the cascade the rebuild drops.

### `server/router.ts`
- `export function fanOutTopicLocal(db, agentIndex, m: { topic: string; from_agent: string; origin: string | null; payload: string; content_type: string; sent_at: number; expires_at: number | null; ephemeral: boolean; aclPrincipal: string; payloadBytes: number }): void` — extracted from `router.ts:602-711`. Subscribers = `getTopicSubscribers(db, m.topic)` minus `m.from_agent` minus every id for which `isRemoteEndpoint(db, id)` is true; per subscriber `aclCheck(db, m.aclPrincipal, sub)` → `incTopicFanout('filtered'|'allowed')`; fresh `crypto.randomUUID()` per copy; online → insert (unless ephemeral) + `buildDeliverFrame` + `markDelivered` + `incMsgStatus/incReceived/incBytes`; offline → drop if ephemeral else insert + `incMsgStatus('topic','queued')`. **Contains no `emitTap` and no call to `enqueueOutboundTopicRows`.**
- `export function enqueueOutboundTopicRows(db, m: {topic: string; origin: string | null; payload: string; content_type: string; sent_at: number; expires_at: number | null}): {alias: string; id: string}[]` — for each `listEnabledOutboundPeers(db)` whose `kinds` include `'topic'` and for which `listRemoteSubscribers(db, alias, m.topic)` contains ≥1 id with `aclCheck(db, 'topic:'+m.topic, id)` true: insert ONE row (`to_agent = alias+':'`, `kind='topic'`, `from_agent='topic:'+m.topic`), `borderEvents.emit('enqueued', alias)`, collect `{alias,id}`. **EXACTLY ONE CALL SITE, EVER** (below).
- `function fanOutHomeTopicPublish(db, agentIndex, m): {alias:string;id:string}[]` — `fanOutTopicLocal(...)` then `return enqueueOutboundTopicRows(...)`. This is the single call site of `enqueueOutboundTopicRows`. Called from `routePublish` (home-topic branch) and from `routeRelay`'s `topic-publish` arm only.
- `export function isHomeTopic(db, t: string): boolean` — as §2.
- `routeRelay`: shape validation is restructured — `msg_id`/`from`/`payload-type` checks, then **kind dispatch BEFORE the `to` check**. `to` is required (bare, ≤256 B, no ':') for `direct` and must be ABSENT for every topic kind (`refuse('to_not_permitted')`); `topic` is required for topic kinds (string, non-empty, ≤256 bytes, no ':' → `refuse('bad_topic')`); `payload` required for `direct`/`topic`/`topic-publish` only; `origin`, if present, must be a string ≤256 bytes (`refuse('bad_origin')`). Unknown kind → `refuse('bad_kind')`. `topic-unsubscribe` SKIPS the `allowedKinds.includes(kind)` check; every other kind keeps it. Rate → kinds → dedupe order is unchanged. Then:
  - `topic-subscribe`: require `hasOutboundPeer(db, alias)` AND that peering's kinds include `'topic'` (the A3 same-alias return rule) → else `refuse('no_return_peering')`; `isHomeTopic(db, topic)` → else `refuse('not_home_topic')`; `subscribeCreated(db, `${alias}:${from}`, topic)`. No `getOrCreateTopic` — remote callers never create topics.
  - `topic-unsubscribe`: `unsubscribeRemoved(db, `${alias}:${from}`, topic)`; always `{ok:true}` if the shape and peer checks passed.
  - `topic-publish`: `isHomeTopic(db, topic)` → else `refuse('not_home_topic')`; `aclCheck(db, `${alias}:${from}`, 'topic:'+topic)` → else `refuse('no_post_edge')`; then `fanOutHomeTopicPublish(db, agentIndex, {topic, from_agent:'topic:'+topic, origin: `${alias}:${from}`, aclPrincipal:'topic:'+topic, expires_at/ephemeral derived from THIS frame's clamped ttl (`router.ts:309-313`), sent_at: now, …})`.
  - `topic`: `fanOutTopicLocal` with `topic = `${alias}:${frame.topic}``, `from_agent = stampedFrom` (= `orch:trollbox`), `aclPrincipal = stampedFrom`, `origin = frame.origin ?? null`. **And nothing else.**
  - All four arms: the `relays` dedupe row is inserted exactly as today; one `emitTap` per BORDER FRAME (not per fanned-out copy) with `crossBorderAudience`, `to: null`, `topic` set; `incPeerRelay(alias,'in','delivered',kind)`. `('in','delivered')` means *accepted at the border*, even when the fan-out filtered everyone.
- `routePublish`: (a) local fan-out goes through `fanOutTopicLocal` (which applies the `isRemoteEndpoint` filter — A2); (b) **remote-topic branch first**, mirroring `routeDirect:374-378`: if `frame.topic` has a colon at index >0 and `hasOutboundPeer(db, prefix)`, then validate the remainder, `aclCheck(db, from_agent, frame.topic)` → `AGENT_NOT_FOUND`, kinds include `topic-publish` → else `KIND_NOT_ALLOWED`, insert ONE `topic-publish` row, `borderEvents.emit('enqueued', alias)`, one cross-border `emitTap`, return `{ok:true, msg_id}`. **A remote publish does NOT fan out locally** — local subscribers hear it when the hub's `topic` delivery returns (C7 echo); the hub is the ordering authority. (c) otherwise the local fall-through is UNCHANGED except: `topicNameRefusal` is consulted before `getOrCreateTopic` (→ `AGENT_NOT_FOUND`, `unknown topic: …`), and the home-topic path calls `fanOutHomeTopicPublish`, emitting one cross-border tap per returned outbound row plus today's `LOCAL_ONLY` tap.
- `routeSubscribe(db, agent_id, frame)`: gains a refusal arm. Remote branch (`hasOutboundPeer` on the prefix FIRST): validate remainder; peering kinds include `topic-subscribe` else `AGENT_NOT_FOUND`; `getOrCreateTopic(db, frame.topic, agent_id)` with the FULL `orch:trollbox` string (created_by is a local agent — FK satisfied); `if (subscribeCreated(...))` insert the `topic-subscribe` row + `borderEvents.emit`. **Gated on `changes === 1`**: the SDK replays every subscription on reconnect (`client/src/client.ts:915-919`) and must not burn the peering bucket for no state change. Local branch: `topicNameRefusal` then unchanged.
- `routeUnsubscribe`: unchanged contract (always `ok`). If `unsubscribeRemoved(...)` returned true and the prefix has an enabled outbound peering, enqueue a `topic-unsubscribe` row — regardless of that peering's `kinds` (teardown is always allowed).
- **`emitTap` appears only in `routeDirect`, `routeRelay`, `routePublish`, `routeFile`.** `observer-cross-border.test.ts`'s SCAN asserts the set of tap-emitting router function names equals its DRIVEN list; a tap inside `fanOutTopicLocal` or `enqueueOutboundTopicRows` reds it.
- `interface RelayFrameIn` gains `topic?: unknown; origin?: unknown`. `buildDeliverFrame`'s param and output gain `origin: string | null` (11th key), fed from `Message.origin` so `drainQueue` carries it for free.

### `server/border.ts`
`Forwarder.send` branches on `row.kind`:
```ts
const base = { type:'relay', msg_id: row.id, ...(ttl!==undefined?{ttl_ms:ttl}:{}) };
switch (row.kind) {
  case 'topic':            frame = {...base, kind:'topic', from: row.topic!, topic: row.topic!,
                                    ...(row.origin!==null?{origin:row.origin}:{}),
                                    payload: row.payload, content_type: row.content_type}; break;
  case 'topic-publish':    frame = {...base, kind:'topic-publish', from: row.from_agent, topic: row.topic!,
                                    payload: row.payload, content_type: row.content_type}; break;
  case 'topic-subscribe':
  case 'topic-unsubscribe':frame = {...base, kind: row.kind, from: row.from_agent, topic: row.topic!}; break;
  default:                 frame = {...base, kind:'direct', from: row.from_agent,
                                    to: row.to_agent!.slice(row.to_agent!.indexOf(':')+1),
                                    payload: row.payload, content_type: row.content_type};
}
```
The `topic` frame's `from` is the BARE topic name and `to` is omitted; the sliced remote is computed only in the `direct` arm. `msg_id` is `row.id` — a FRESH `crypto.randomUUID()` per hub outbound row. Every `incPeerRelay` call in this file passes `row.kind` as the 4th argument.

### `server/http-admin.ts`
- Reserve the alias `topic` at BOTH doors — `handlePeerKeyPost` (beside the `RESERVED_ALIAS` check, ~:1496) and `handleOutboundPeerPost` (~:1889): `if (alias === RESERVED_ALIAS || alias === 'topic')` → 400 `alias 'topic' is reserved`. Reason in a comment: a peering aliased `topic` would reinterpret every local topic principal as remote and `deletePeeringEdges('topic', …)` would delete them all.
- `POST /agents` already refuses ANY ':' (`:632-637`), so no new agent can be born in the `topic:` range; add a one-line comment there naming the topic-principal prefix as a second reason, and DO NOT add a redundant guard. Pre-existing `topic:*` agents are handled by the boot report.
- `handleTopicPost`: call `topicNameRefusal(db, name)` before `getOrCreateTopic`; non-null → 400 `{ "error": <reason> }`.
- `async function handlePeerSubscriptionsGet(ctx: AdminCtx): Promise<void>` — 404 when `getPeerByAlias` is null, else 200 with §5's body. Register in `ROUTES`.

### `server/metrics.ts`
`export function incPeerRelay(alias: string, direction: string, outcome: string, kind = 'unknown'): void` (DEFAULTED — a required 4th param adds two TS errors over the 116 baseline at `border.test.ts:269` and `:339` and fails the ratchet; those two calls stay three-argument and render `kind="unknown"`) — key becomes `alias\0direction\0outcome\0kind`; both render arms emit `kind="…"` **last** (`{alias,direction,outcome,kind}` / `{direction,outcome,kind}`). **Clamp at the emitter:** `kind` from a peer frame is attacker-controlled, so `routeRelay` passes a validated member of the five-kind set or the literal `'unknown'`. `PARTY_FREE_LABELS` already contains `kind` and is NOT edited (its canary pin stays green).

### `server/server.ts`
Two boot reports beside the existing two (same shape, same `try {} catch { /* never block boot */ }`): `topics.invalid_names` from `findInvalidTopicNames` and `agents.topic_prefix_ids` from `findTopicPrefixAgents`.

### `client/src/protocol.ts` / `client/src/client.ts`
`DeliverFrame` gains `origin?: string | null`; `Inbound` gains `origin?: string | null`; `normalizeDeliver` (`client.ts:1085`) copies `origin: f.origin ?? null`. No behaviour change for any other kind.

### Mesh plugin (NOT in this repo)
`/opt/claude-spawner-marketplace/plugins/mesh/server.ts` — `inboundToChannelNotification` at **:307**, the `case 'topic':` arm at **:323-324**. Add `if (m.origin) meta.origin = String(m.origin)` in that arm, and bump the SDK pin in that package's `package.json` (`"@claude-mesh/client": "github:ASolidBPlus/claude-mesh#<F4 merge SHA>"`, currently `#1071b61…`). This is a SEPARATE repo: do not edit it from the claude-mesh work tree; record the two edits in the PR body as a follow-up hand-off.

### `docs/FEDERATION.md`
- §2 Step 4: add the same-alias rule — "**To carry topics, name the peer the SAME alias in both tables.** `peers` and `outbound_peers` share no column, so on an inbound `topic-subscribe` from `pod1` the hub looks for an *outbound* peering also called `pod1` and refuses uniformly if there is none (`server/router.ts` `routeRelay`)."
- §3: new subsection "Hub and spoke: topics across a border", containing (a) the kinds table (`direct` · `topic` · `topic-subscribe` · `topic-publish`, with the pod→orch / orch→pod / pod↔pod rows from the topology); (b) the two grant classes with `curl` examples for all four edges; (c) the echo rule — "one frame per peering cannot exclude the publisher, so an agent subscribed to a hub topic sees its own post come back, exactly as a chat shows your own message; suppression would mean routing on `origin`, which is forbidden"; (d) the shared-bucket rule — "one rate bucket per peering, shared by every kind and counted before the kind check, so a busy Troll Box rate-limits that peering's direct traffic; size `rate_per_min` for topic volume. Per-kind buckets are out of scope"; (e) N-pod arithmetic — "N pods cost the hub 2N peering rows plus N(N−1) pod↔pod direct rows; the worked example uses N=2"; (f) "`origin` is display only. It is set by the sending mesh's server, is never routed on and never an ACL principal; treat it as untrusted text."
- §4 Read APIs table: a row for `GET /peers/:alias/subscriptions` citing `` `server/http-admin.ts` `` `` `handlePeerSubscriptionsGet` ``. (The §4 row parser only binds rows whose path has no `:` placeholder, so this row is checked by the general citation walk, not the ROUTES equality check.)
- §4 Metrics bullet: `mesh_peer_relays_total{direction,outcome}` → `{direction,outcome,kind}`, and one sentence that `('in','delivered')` means *accepted at the border*, even when the fan-out filtered everyone.
- §6: DELETE the row "Topics across a border | Federated pub/sub raises ownership and fan-out questions that are not answered; topics stay local"; replace with "**Transitive topics** | A post crosses at most two borders and only through the topic's home mesh; a received `topic` delivery is never re-originated (`server/router.ts` `routeRelay`)", plus "**Per-kind rate buckets**", "**Wildcard subscriptions**", "**`DELETE /topics`**".
- EVERY new row must contain `` `path/to/file.ts` `` immediately followed by `` `symbol` `` where the symbol is DEFINED at line start in that file — `guide-citations.test.ts` (`definesIn`, anchored `^\s*`) reds otherwise. A comment mentioning the name does not satisfy it.

## 8. Ordered commits (each: red first, green after)
1. **db: subscriptions FK-less + `messages.origin` + explicit teardown.** RED: new cases in `migration-chain.test.ts` (an old FK-ful `subscriptions` table upgrades and then accepts `('pod1:alice','news')`; two opens in a row), `delete-agent-purge.test.ts` (deleting a subscribed agent leaves no `subscriptions` row), `db.test.ts` (`origin` round-trips through `insertMessage`/`getMessage`; the `topic` FK still cascades when the creator's agent is deleted — C11).
2. **acl + naming: `topic:` principal, reserved alias, name validation, boot reports.** RED: `peering-edges.test.ts`/`db.test.ts` (`aclGrant(db,'topic:trollbox','pod1:alice')` succeeds with an outbound peering and `aclCheck` honours it; `aclGrant(db,'topic:x','local')` needs no peering), `http-admin.test.ts` (alias `topic` → 400 at both doors; `POST /topics {"name":"a:b"}` → 400; an existing colon topic is untouched), `server.test.ts` or `db.test.ts` (`findInvalidTopicNames` ignores `orch:news` when an outbound peering `orch` exists).
3. **router: extract `fanOutTopicLocal` + the remote-id filter (A2).** Pure refactor + one behaviour change. RED: `topic-federation.test.ts` case "a `pod1:alice` subscription row produces no `messages` row with `to_agent='pod1:alice'` on a local publish". GREEN and unchanged: `router-topic.test.ts`, `topic-fanout-counting.test.ts`, `observer-cross-border.test.ts`.
4. **hub→spoke: outbound `topic` rows, `Forwarder.send` kind branching, `routeRelay` kind dispatch + the `topic` arm, `origin`.** RED: the three-mesh fixture's "one frame per peering" (`COUNT(*) FROM messages WHERE to_agent='pod1:' AND kind='topic'` === 1 with three permitted subscribers), "receiver-side ACL with the topic principal", "origin is carried and changes nothing", "a `topic` delivery is never re-originated".
5. **spoke→hub: subscribe/unsubscribe.** RED: uniform-refusal set test at `routeSubscribe`; `changes===1` gating; the same-alias return rule; teardown on rebind and on `revokePeerKey`.
6. **spoke→hub: `topic-publish` + `isHomeTopic` + the transit invariant.** RED: end-to-end pod1→orch→pod2; the `pod3:*` control; the `isHomeTopic` mutant control; the ttl-derivation test.
7. **metrics `kind` label.** RED: a new assertion in `relay.test.ts`; UPDATE `relay.test.ts:257-258` to the four-label strings; docs metric row in the same commit.
8. **admin `GET /peers/:alias/subscriptions`.** RED: `peers-listing.test.ts` additions (200 shape, 404, prefix isolation between two aliases).
9. **client `origin` + docs rewrite.** RED: `client/__tests__/client.test.ts` (a deliver frame with `origin` surfaces it on `Inbound`; one without leaves it null); `guide-citations.test.ts`.

## 9. Tests
`server/__tests__/topic-federation.test.ts` — a three-mesh in-process fixture per C13: **pod1 router-only** (module-level db + `routeSubscribe`/`routePublish` + `startBorder`), **orch live** (`startWsServer` + `startBorder`), **pod2 live** (`startWsServer`). Fixture rules, all mandatory:
- every alias in the file is globally unique in the process (`forwarders`, `borderEvents` and `relayBuckets` are module-global maps keyed by alias only);
- `afterEach` = `border?.stopAll()` + `forwarders.clear()` + `borderEvents.removeAllListeners()` + `resetRelayBuckets()` + close every db;
- ports use a base distinct from `border.test.ts:673`'s `23500 + Date.now()%400` — use `23900 + Date.now()%50` and `23960 + Date.now()%50`.
Cases: once-at-the-border · receiver-side ACL on the topic principal (with the unrelated-topic control) · sender-side gate (no RIGHT-TO-HEAR grant ⇒ no frame leaves) · one-hop (`from` with a colon ⇒ `RELAY_REFUSED`) · transit pod1→orch→pod2 exactly once · the `pod3:*` no-outbound-row control · a `topic` delivery is never re-originated · echo (the pod1 publisher receives its own post back) · `origin` forgery changes no ACL outcome and no `from_agent` · fresh msg_id at the hub · ttl never exceeds the arriving frame's · replayed subscribe enqueues no second row · uniform refusals at `routeSubscribe` asserted as a SET, byte for byte, with a literal-equality pin on the refusal count · a STRUCTURAL case that reads `server/router.ts` and asserts `enqueueOutboundTopicRows` is called from exactly one place and that neither `fanOutTopicLocal`'s body nor the `topic` arm mentions it.
Additions to existing suites: `migration-chain.test.ts`, `delete-agent-purge.test.ts`, `db.test.ts`, `http-admin.test.ts`, `peers-listing.test.ts`, `relay.test.ts` (kind label), `observer-cross-border.test.ts` (a cross-border topic case in both directions; DRIVEN list unchanged), `client/__tests__/client.test.ts`.

## 10. Success criteria (runnable)
```bash
cd /path/to/claude-mesh/server && bun test                       # whole server suite green
cd /path/to/claude-mesh/server && bun test __tests__/topic-federation.test.ts
cd /path/to/claude-mesh/server && bun test __tests__/guide-citations.test.ts \
    __tests__/observer-cross-border.test.ts __tests__/border.test.ts __tests__/relay.test.ts
cd /path/to/claude-mesh/client && bun test
# single call site, as a shell check (the test above is the CI-enforced version):
grep -n 'enqueueOutboundTopicRows' server/router.ts        # exactly 2 hits: 1 definition, 1 call
grep -n 'emitTap(' server/router.ts                        # every hit inside routeDirect/routeRelay/routePublish/routeFile
# ratchet: server baseline 116 in .github/typecheck-baseline-server.txt — new code must add ZERO
# type errors. NEVER edit the baseline or the identity file; a count that goes UP fails CI.
bash .github/scripts/typecheck-ratchet.sh                  # requires `bun install` in server/ and client/
```

## 11. Mutants (each = the exact edit, and the test that must go red)
| # | edit | red test |
|---|---|---|
| M1 | delete the `isRemoteEndpoint` filter from `fanOutTopicLocal`'s subscriber list | "no direct row for a remote subscriber" + one-frame-per-peering |
| M2 | move the `enqueueOutboundTopicRows` call into `fanOutTopicLocal` | the `pod3:*` control + the structural single-call-site case |
| M3 | delete the `isHomeTopic` guard in the `topic-publish` arm | "a `topic-publish` naming `pod2:games` at the hub yields no outbound row" |
| M4 | emit one outbound row per remote subscriber instead of per peering | `COUNT(*) … to_agent='pod1:' AND kind='topic'` === 1 |
| M5 | use `frame.origin` as `from_agent` or as the ACL principal | the origin-forgery case |
| M6 | suppress the echo by comparing `origin` to a local agent id | the echo case |
| M7 | reuse the incoming `msg_id` for the hub's outbound rows | "the hub's outbound row id differs from the arriving msg_id, and pod2's `relays` row records the hub's id" |
| M8 | drop the `topic` FK as well as `agent_id` in the rebuild | "deleting the topic's creator removes the remote subscription rows" |
| M9 | enqueue the `topic-subscribe` row unconditionally | "a replayed subscribe enqueues no second row" |
| M10 | allow a ':' in a relayed `from` for topic kinds | `from_not_one_hop` |
| M11 | label `mesh_peer_relays_total` with the raw frame `kind` | "an unknown kind renders `kind=\"unknown\"`" |
| M12 | allow ':' in a NEW local topic name | `POST /topics {"name":"a:b"}` → 400, and subscribe-with-no-peering refusal |
| M13 | skip `deleteRemoteSubscriptions` in `revokePeerKey` | the revocation case |
| M14 | derive `expires_at` from `?? 300_000` instead of the arriving frame's clamped ttl | "a transited post's `expires_at` never exceeds the arriving frame's budget" |
| M15 | gate the hub's local fan-out on `aclCheck(db,'pod1:alice',sub)` instead of `aclCheck(db,'topic:trollbox',sub)` | "a hub subscriber holding only `topic:trollbox → sub` receives the post" |

## 12. f2-verify drive notes (P13–P18)
Three-node sandbox: pod1 `7432/7433`, orch `7442/7443`, pod2 `7452/7453` (`sandbox_up` with a third mesh service; the current driver has two). New pinned checkout `f2-verify/mesh-<F4 SHA>` — `drive2.ts:4` pins `./mesh-c27ebbc/client/src/index.ts`; P13–P18 import the new pin. Metrics assertions read the **aggregate** `mesh_peer_relays_total{direction="in",outcome="delivered"}` — identity labels are off (`drive2.ts:51`) — and use the real strings `direction="in"` (receive) vs `direction="outbound"` (send); do NOT fix that asymmetry in F4.
- **P13** mint the topology: 2N peering rows + N(N−1) direct rows for N=2; pod→orch `["direct","topic-subscribe","topic-publish"]`, orch→pod `["direct","topic"]`, pod↔pod `["direct"]`; same local alias in both tables for each pair. Assert the kinds arrays come back from `GET /peers` and `GET /outbound-peers`.
- **P14** subscribe pod1 and pod2 to `orch:trollbox`; assert `GET /peers/pod1/subscriptions` on orch lists `pod1:*`; drive the three C9 causes (non-peered alias, peering without the kind, nonexistent topic) and assert IDENTICAL response bytes.
- **P15** hub publishes `trollbox` with 3 spoke subscribers of which 1 lacks the RIGHT TO HEAR: 2 deliveries, 1 `mesh_topic_fanout_total{outcome="filtered"}`, `{direction="in",outcome="delivered"}` +1 per pod (not +3), one outbound row per pod with a permitted subscriber.
- **P16** pause orch→pod2 (`PATCH {"enabled":false}`): the hub publisher is acked locally, rows queue, pod2 receives nothing; re-enable → the backlog is delivered once each (dedupe).
- **P17** pod1 posts to `orch:trollbox`: pod2's granted subscriber receives it exactly once; pod1's own subscriber receives the echo; a `pod3:*` subscription row on pod2 yields no outbound row; pod2's `msg_id` differs from pod1's.
- **P18** withhold the hub's inbound edge `pod1:alice → topic:analytics`: the post is refused at the border and pod1's agent sees exactly one `REMOTE_REFUSED`; then, with a raw `PeerClient`, send orch→pod2 a `topic` frame carrying `origin:"orch:admin"` and assert no ACL outcome and no `from_agent` changed.

## 13. Out of scope
Per-kind rate buckets · transitive topics (A subscribing through B to C) · wildcard/pattern subscriptions · a dynamic `mesh_subscribe` TOOL in mesh-agent (the scenario author owns the communication graph; a self-subscribing persona breaks run reproducibility — if ever wanted, gated as `meshTools:['subscribe']`, default off) · `DELETE /topics` · a `paired_alias` column (the same-alias rule is v1; the column is not precluded) · per-topic rate limits · reverse frames on a single socket. The arena's `subscribe: []` passthrough (`arena/scenario.ts:231`, `AgentSchema`) is mesh-agent-builder's lane, not this change.

## 14. Do NOT
- Do **not** call `routePublish` from `routeRelay`, ever, in any arm.
- Do **not** preserve a msg_id across the hub — outbound rows take a fresh `crypto.randomUUID()`; reuse destroys the hub's retry idempotency.
- Do **not** route on, ACL on, log-as-identity, or metric-label `origin`. It is display only.
- Do **not** add a `topic_relays` table; do **not** add a topic-name label to any metric; do **not** widen `PARTY_FREE_LABELS`.
- Do **not** move ACL-edge deletion into `revokePeerKey` as a side effect of F4.
- Do **not** edit `.github/typecheck-baseline-*.txt` or `.github/typecheck-identities-*.txt`.
- Do **not** write the operator's name into any code, comment, doc, commit message or PR body — write "the operator".
- Do **not** add `Co-Authored-By` trailers. Commit as the configured git user, on a branch, never directly on `main`.

## 15. Two planner notes (why the plan is shaped this way)
1. `enqueueOutboundTopicRows` serves two publish paths (a hub agent publishing a home topic, and a re-originated `topic-publish`), so C5's "exactly one call site" is preserved by routing BOTH through `fanOutHomeTopicPublish` — the single call site lives there, and the C5 mutant (moving it into code shared with the `topic` delivery arm) still reds the `pod3:*` control.
2. `emitTap` stays out of the extracted helpers because `observer-cross-border.test.ts` scans `router.ts` for the set of function names containing an `emitTap(` call and asserts equality with its DRIVEN list; that is why `enqueueOutboundTopicRows` returns `{alias,id}[]` instead of emitting taps.


## 16. BINDING AMENDMENTS (from the plan evaluation at main b861e82; these override §1–§15 where they differ)

A. **`messages.id` for EVERY border row is a fresh `crypto.randomUUID()`** — the spoke's `topic-publish`, `topic-subscribe`, `topic-unsubscribe` rows and the hub's outbound `topic` rows alike. NEVER `frame.msg_id`: `routePublish` has no duplicate check (unlike `routeDirect:415`), so a reused id throws a bare SQLite constraint error (#94, `duplicate-msgid-crash.test.ts`). `routePublish`'s remote branch still returns `{ok:true, msg_id: frame.msg_id}` to the caller; the `topic-subscribe` relay's `msg_id` on the wire is the row id.
B. **Base DDL:** also drop `REFERENCES agents(id) ON DELETE CASCADE` from `agent_id` in `CREATE TABLE IF NOT EXISTS subscriptions` (`db.ts:335-340`), keeping the `topic` FK — exactly as the acl precedent (`db.ts:304-310` is FK-less; `rebuildAclFkLess` handles upgrades only). Without this every fresh database would rebuild on its first open. `rebuildSubscriptionsFkLess`'s early return ("only the `topic` FK present") is what makes the second open a no-op.
C. **`buildDeliverFrame`'s `origin: string | null` is a REQUIRED param field.** Update `router.ts:113` (`origin: null`), the extracted fan-out call (was `router.ts:671`), and `__tests__/router.test.ts:238`'s `sample`. `router.ts:572` and `reminder-scheduler.ts:58` pass a whole `Message` and need no change.
D. **`routePublish` remote-topic branch placement:** it sits AFTER the size check (`:589-593`) and BEFORE the local metrics at `:595-597`; inside the branch, count `incSent`/`incBytes('in')`/`observePayloadBytes` only after every refusal check has passed — mirroring `routeDirect`, which counts inside its remote branch after the checks. A refused remote publish counts nothing.
E. **`topic-unsubscribe` skips ONLY the `allowedKinds.includes(kind)` test.** The JSON parse of the kinds column (`bad_kinds_column`, `:283-284`) still runs and still refuses on a malformed column.
F. **Fixture aliases are unique across MESHES too:** pod1 names the hub `orcha`, pod2 names it `orchb`, because `relayBuckets` is keyed by alias alone and both pods would otherwise share one inbound rate bucket in-process. The same-alias rule (A3) binds the two tables ON ONE MESH (the hub's `peers.pod1` ↔ `outbound_peers.pod1`), never across meshes.
G. **Fixture ports:** `border.test.ts:910` already uses `23900 + Date.now()%90`. Use `24100 + Date.now()%50`, `24160 + Date.now()%50`, `24220 + Date.now()%50` (three servers, three bases).
H. **Test placements (commit 2 RED list and §9):** alias `topic` at the mint door → `peer-keys.test.ts` (beside `:83`); at the outbound door → `outbound-peers.test.ts` (beside `:442`); `POST /topics {"name":"a:b"}` → 400 and an existing colon topic untouched → `http-admin-topics.test.ts`. Not `http-admin.test.ts`.
I. **§6 precedent, reworded:** `routeDirect`'s remote branch has TWO non-uniform codes behind the ACL — `KIND_NOT_ALLOWED` (`:409-412`) and `DUPLICATE_MSG_ID` (`:415-418`). `KIND_NOT_ALLOWED` is the one TOPOLOGY-bearing exception; `DUPLICATE_MSG_ID` is about the caller's own id, not the topology. The topic doors add no new non-uniform code.
J. **`handlePeerSubscriptionsGet` reads the alias from `ctx.params.id`** — `idMatch` names its single capture `id` (`http-admin.ts:323-326`); the route path in docs is written `/peers/:alias/subscriptions` for readers only.
K. **Commit 1's migration-chain case:** `preFederationDb` (`migration-chain.test.ts:53-95`) creates neither `topics` nor `subscriptions`. The legacy fixture for this case must create BOTH — `topics` (with `created_by` FK) and the FK-ful `subscriptions` — then `openDb` must rebuild it FK-less on `agent_id`, keep the `topic` FK, and accept `('pod1:alice','news')` afterwards; a second `openDb` must log no rebuild.
L. **Paused-peering consequence, stated for the docs and pinned:** `hasOutboundPeer` is enabled-only (`db.ts:1226`), so while a spoke's outbound peering is PATCH-disabled, `isHomeTopic(db,'orch:trollbox')` is true on that spoke and `routePublish` fans the post out LOCALLY instead of queueing for the border. Accepted for v1; `topic-publish` rows already queued still drain on re-enable. One sentence in FEDERATION.md §3 (d) and one test asserting the local fan-out while disabled.
M. **Boot-report SQL precision:** `findInvalidTopicNames` must not flag `orch:trollbox`-style names whose prefix is an outbound alias in ANY state (enabled or disabled) — use `SELECT alias FROM outbound_peers` without an `enabled` filter, so a paused peering does not turn its topics into boot noise.

Success-criteria additions: `bun test __tests__/duplicate-msgid-crash.test.ts __tests__/migration-chain.test.ts __tests__/peer-keys.test.ts __tests__/outbound-peers.test.ts __tests__/http-admin-topics.test.ts` green; `bash .github/scripts/typecheck-ratchet.sh` exits 0 with the baseline UNCHANGED at 116/37.
N. **Uniformity is "pure function of the input", not "byte-identical across causes"** (builder finding, commit 5): the refusal message echoes what the caller supplied, so five different inputs cannot and must not produce identical bytes. Test shape: per cause, assert the answer depends only on the input; then drive ONE input through TWO causes (e.g. `orch:` as an empty remainder, then as an unpeered prefix after deleting the peering) and assert identical bytes — that comparison is the only one that can detect a cause leaking. §9's "asserted as a SET, byte for byte" is read this way.
O. **Return-peering check must be pinned by the PAUSED case** (builder finding, commit 5): with no row, `JSON.parse(returnPeering.kinds)` throws and the kinds catch converts it into the same refusal, so deleting the explicit `null || enabled !== 1` check leaves every no-row case green. Keep the explicit check and pin it with a row that exists with `enabled = 0`.
