# claude-mesh

A lightweight message bus for autonomous nodes. Nodes connect over a WebSocket, authenticate, and exchange messages — direct, pub/sub topics, and files — with server-enforced access control, durable history, scheduled reminders, and live observability.

It's brain-agnostic: a node can be an AI agent, a scripted bot, a backend service, or a human at a UI. The bus moves messages; what a node does with them is yours.

Where to go from here:

- **Sending messages?** [Quickstart](#quickstart) → [the SDK](#41-with-the-sdk).
- **Writing a client in another language?** [Frame protocol](#3-frame-protocol-reference).
- **Running the bus?** [Admin API](#7-http-admin-api) · [Build / run](#9-build--run--deploy).
- **Extending the server?** [What it is](#1-what-it-is) — read the pure-bus rule first.

---

## Quickstart

Two nodes exchanging a message, end to end.

```bash
# 1. Run the bus — MESH_ADMIN_TOKEN is the only required variable
cd server && bun install && MESH_ADMIN_TOKEN=secret bun server.ts     # WS :7384, admin :7385

# 2. Register two agents — each response includes a one-time raw token; save it
curl -sX POST localhost:7385/agents -H 'Authorization: Bearer secret' \
     -H 'content-type: application/json' -d '{"id":"alice","hostname":"dev"}'
curl -sX POST localhost:7385/agents -H 'Authorization: Bearer secret' \
     -H 'content-type: application/json' -d '{"id":"bob","hostname":"dev"}'

# 3. Allow alice → bob
curl -sX POST localhost:7385/acl -H 'Authorization: Bearer secret' \
     -H 'content-type: application/json' -d '{"from_agent":"alice","to_agent":"bob"}'
```

```ts
// bun add github:ASolidBPlus/claude-mesh
import { MeshClient, type Inbound } from '@claude-mesh/client';

const bob = new MeshClient({ serverUrl: 'ws://localhost:7384', agentId: 'bob', agentToken: BOB_TOKEN });
bob.onMessage((m: Inbound) => console.log(`bob got "${m.text}" from ${m.from}`));
await bob.connect();

const alice = new MeshClient({ serverUrl: 'ws://localhost:7384', agentId: 'alice', agentToken: ALICE_TOKEN });
await alice.connect();
await alice.send('bob', 'hello');      // → bob logs: bob got "hello" from alice
```

Register, allow, connect, send. Everything below is detail.

---

## 1. What it is

claude-mesh is a *pure bus*. It does two things: it **moves messages** between nodes (direct, topic, files — with ACL and durable persistence), and it **exposes raw observability** (a Prometheus `/metrics` endpoint and a live event tap). That's all it does.

> **The pure-bus rule.** All analytics, dashboards, graphs, scoring, and views are *consumers* that live outside the bus — they read its raw outputs; they're never baked into the core. When extending the server, if you're about to add a table or metric that answers an analytic question ("who talks to whom", "what's the trend"), stop — it belongs in a consumer. This is what keeps the bus small and correct.

A consumer has three raw surfaces to build on:

| Surface | What it is | Answers |
|---|---|---|
| `GET /metrics` | aggregate counters/gauges/histograms (Prometheus) | how much / how healthy |
| The event tap | live, ACL-gated copy of every message | what's flowing right now |
| The message store | every message in SQLite, via `GET /messages` | what happened (history) |

---

## 2. Core concepts

**Nodes are WebSocket clients.** A node (the code calls it an *agent*) is any process that opens a WS to the bus and authenticates. AI agent, scripted bot, human UI, or service — all look identical to the bus: connect, auth, receive `deliver` frames, send frames back.

**Auth is a hashed bearer token.** Each node has an `id` and a secret token. The server stores only the token's SHA-256 hash (compared timing-safely); the raw token is shown once, at registration (`POST /agents`), and never again. A node authenticates by sending its `id` + raw token as the first WS frame.

**ACL gates delivery.** An ACL entry `from → to` permits `from` to send to `to`. Direct messages, file sends, and per-subscriber topic delivery are all checked server-side; an unpermitted send is rejected with `ACL_DENIED`. ACLs are admin-managed (`POST/DELETE/GET /acl`) — a node can't grant itself access.

**Every message is persisted.** Messages land in SQLite at acceptance, with sender, recipient/topic, payload, and timestamps. If the recipient is offline the message queues and drains on its next connect. History is queryable via `GET /messages`.

**Delivery TTL and retention are different lifecycles.** A message's `ttl_ms` (default 5 min; `0` = drop if offline, `null` = never expires) governs *deliverability* only: an undelivered message past its TTL is never delivered, but it stays in the store as history ("sent, never delivered"). How long rows live in the store is a separate server policy — `MESH_RETENTION_MS` (unset = **keep forever**), swept against `sent_at`. Delivered history is never erased at TTL. The retention sweep never removes still-deliverable pending mail (an undelivered, unexpired message keeps queuing regardless of age).

---

## 3. Frame protocol reference

The [SDK](#41-with-the-sdk) implements everything in this section. Read it if you're writing a client in another language, or want to understand the wire.

All frames are JSON with a `type` field. The client must send `auth` first (within 5 s) before any other frame is accepted. Default ports: WS `7384`, admin `7385` (the Docker image uses `7432`/`7433` — see [§8](#9-build--run--deploy)).

### Handshake

`→ auth` (client sends first)
```json
{ "type": "auth", "agent_id": "alice", "token": "<raw bearer token>" }
```
`← auth_ok` (on success)
```json
{ "type": "auth_ok", "agent_id": "alice", "queued": 3, "queued_files": 0 }
```
`queued` / `queued_files` are how many pending messages/files are about to be drained to you. On failure you get an `error` frame (`AUTH_FAILED` / `AUTH_REQUIRED` / `AUTH_TIMEOUT`) and the socket closes.

### Sending

`→ send` — direct message to one agent
```json
{ "type": "send", "msg_id": "m-1", "to": "bob", "payload": "hello",
  "content_type": "text/plain", "ttl_ms": 300000 }
```
`→ publish` — broadcast to a topic's subscribers
```json
{ "type": "publish", "msg_id": "m-2", "topic": "alerts", "payload": "disk full" }
```
`→ subscribe` / `→ unsubscribe` — manage your topic subscriptions (exact-topic; no wildcards)
```json
{ "type": "subscribe", "topic": "alerts" }
{ "type": "unsubscribe", "topic": "alerts" }
```
`content_type` (default `text/plain`) and `ttl_ms` (default `300000`; `0` = drop if recipient offline; payload max 1 MB) are optional on `send`/`publish`. Each gets a server `ack` referencing your `msg_id` (or the topic):
```json
{ "type": "ack", "ref": "m-1", "ok": true }
```
…or an `error` (see [error codes](#errors)).

### Receiving

`← deliver` — a message addressed to you (or a topic you're subscribed to)
```json
{ "type": "deliver", "msg_id": "m-1", "kind": "direct",
  "from": "alice", "to": "bob", "topic": null, "correlation_id": null,
  "payload": "hello", "content_type": "text/plain", "sent_at": 1718900000000 }
```
`kind` is one of `direct | topic | reminder`. For topic deliveries, `to` is `null` and `topic` is set. (Files arrive as their own `file_deliver` frame — see [Files](#files).)

> `correlation_id` is a **vestigial field: always `null`**. It survives only so existing deliver-frame parsers keep working; nothing sets it. Do not build on it — see [Correlated request/reply](#correlated-requestreply-application-level).

`→ ack` — optionally acknowledge that you *processed* a delivered message:
```json
{ "type": "ack", "msg_id": "m-1" }
```
Two distinct uses of `ack`: the server→client ack (has `ref`) confirms your *send* was accepted; the client→server ack (has `msg_id`) marks a *delivered* message as processed (sets `acked_at` in the store).

### Correlated request/reply (application-level)

**The bus has no native request/response primitive.** There is no `request` or `response` frame type, no `kind: "request"` delivery, and no server-side correlation or timeout. Sending `{"type":"request"}` gets you `{ "type": "error", "code": "NOT_IMPLEMENTED", "message": "frame type not implemented" }`.

This is deliberate (bus-purity): correlation is **application state**, so it rides in your payload over ordinary `send` frames. The pattern:

1. The caller mints its own token and puts it **in the payload**, then `send`s as normal.
2. The responder echoes that token back in **its** reply payload — a plain `send` to the caller.
3. The caller keys pending work by its own token and applies its own timeout.

```json
→ { "type": "send", "msg_id": "m-1", "to": "bob",
    "payload": "{\"reply_to\":\"c-abc\",\"q\":\"ping?\"}", "content_type": "application/json" }
← { "type": "deliver", "kind": "direct", "from": "bob",
    "payload": "{\"reply_to\":\"c-abc\",\"a\":\"pong\"}" }
```

The bus stays a dumb pipe; the caller owns the timeout it actually wants. The **webhook gateway** runs exactly this pattern in production (it correlates with its own `X-Conversation`/`X-Request` payload triple), and it is the reference implementation to copy.

### Files

`→ file_send` — base64-encoded file to one agent
```json
{ "type": "file_send", "msg_id": "f-1", "to": "bob", "filename": "report.pdf",
  "content_type": "application/pdf", "data": "<base64>", "caption": "Q3", "ttl_ms": 300000,
  "group_id": "batch-9" }
```
Optional `group_id` tags a multi-file send so the recipient can reassemble the batch (pure passthrough — the bus stores and echoes it, no assembly). The `ack` for a `file_send` carries the stored `file_id` so the sender learns it. `← file_deliver` — the recipient is notified with a fetch URL, not the bytes
```json
{ "type": "file_deliver", "file_id": "<uuid>", "from": "alice", "to": "bob",
  "filename": "report.pdf", "content_type": "application/pdf", "size_bytes": 12345,
  "sent_at": 1718900000000, "fetch_url": "/files/<uuid>", "caption": "Q3",
  "reply_to_msg_id": null, "group_id": "batch-9" }
```
The recipient downloads the bytes via `GET /files/<file_id>`. Max size is `MESH_MAX_FILE_BYTES` (default 10 MB).

### Presence, reminders, keepalive
- `→ ping` `{ "type": "ping", "ts": ... }` → `← pong` `{ "type": "pong", "ts": ..., "server_ts": ... }`. Use as a heartbeat.
- `← agent_status` — arrives when an ACL-related peer goes online/offline: `{ "type": "agent_status", "agent_id": "bob", "online": true, "last_seen": ..., "last_alive": ... }`.
- `→ list_presence` `{ "type": "list_presence", "msg_id": "p-1" }` → `← presence_list` `{ "type": "presence_list", "ref": "p-1", "agents": [{ "id": "bob", "online": true, "last_seen": ..., "last_alive": ... }] }` (ACL-filtered to you + your peers).

  **`last_seen` vs `last_alive`:** `last_seen` advances on TRAFFIC (the node sent or received something); `last_alive` advances when the node answers the keepalive `ping`. So an idle-but-healthy node advances `last_alive` only, and a node whose channel has died advances neither — which is what makes the two distinguishable from outside. `last_alive` is `null` for a node that has never pinged. Use `ping` as a heartbeat (every ~25 s) and treat a stale `last_alive` as a dead channel.
- `→ remind` — schedule a reminder the bus delivers back to you:
  ```json
  { "type": "remind", "msg_id": "rm-1", "text": "stand-up", "when": "0 9 * * 1",
    "recurring": true, "tz": "Australia/Adelaide" }
  ```
  `when` is a duration (`"90s"`, `"2h"`), an ISO datetime, or a cron expression (with `recurring: true`). `tz` is an optional IANA timezone (DST-aware; defaults to UTC). The reminder fires as a normal `deliver` frame (`from: "mesh"`) at the due time and survives restarts and redeploys (it lives in the server DB). Ack: `{ "type": "ack", "ref": "rm-1", "ok": true, "reminder_id": "...", "due_at": ... }`. Also `→ list_reminders` → `← reminders_list`, and `→ cancel_reminder` `{ "type": "cancel_reminder", "id": "..." }`.

### Correlation rule
This is about **client-frame → server-reply** correlation, not message request/reply. If a frame you send carries a `msg_id`, the matching server reply echoes it back as `ref` (acks, `reminders_list`, `presence_list`, and errors all do this). Key every outstanding frame by its `msg_id` and resolve it when a frame with that `ref` arrives — one correlation path for everything.

### Errors
`{ "type": "error", "ref": "<msg_id>", "code": "<CODE>", "message": "..." }`. Codes: `ACL_DENIED`, `AGENT_NOT_FOUND`, `TOPIC_NOT_FOUND`, `MESSAGE_TOO_LARGE`, `PAYLOAD_TOO_LARGE`, `INVALID_REQUEST`, `NOT_IMPLEMENTED` (unknown frame type), `INVALID_CRON`, `INVALID_TZ`, `INVALID_WHEN`, `REMINDER_NOT_FOUND`, plus file codes (`FILE_TOO_LARGE`, `INVALID_BASE64`, `CAPTION_TOO_LARGE`). Handshake failures (`AUTH_FAILED` / `AUTH_REQUIRED` / `AUTH_TIMEOUT`) are covered in [Handshake](#handshake).

---

## 4. Writing a client

### 4.1 With the SDK

`@claude-mesh/client` is the recommended path for JavaScript/TypeScript (Node or Bun). It implements the whole protocol — auth, the deliver loop, ack correlation, reconnect-with-backoff — so you only write your logic. It's also the single shared implementation: its wire types are the same ones the server uses, so the protocol can't drift.

```bash
bun add github:ASolidBPlus/claude-mesh        # pin for reproducibility: …claude-mesh#<commit-or-tag>
```

```ts
import { MeshClient, type Inbound } from '@claude-mesh/client';

const client = new MeshClient({            // omit any field to read it from env:
  serverUrl:  'ws://localhost:7384',       //   MESH_SERVER_URL
  agentId:    'alice',                     //   MESH_AGENT_ID
  agentToken: process.env.ALICE_TOKEN,     //   MESH_AGENT_TOKEN  (raw token; the SDK never hashes)
});

client.on('connect', () => {});            // reconnect — backoff + re-auth + re-subscribe — is automatic
client.onMessage(async (m) => {
  const reply = await decide(m);                                  // ← your logic
  if (reply != null) await client.send(m.from, reply);            // correlate in the payload if you need it
});

await client.connect();
await client.subscribe('alerts');
await client.publish('alerts', 'disk full');
await client.remind({ text: 'stand-up', when: '0 9 * * 1', recurring: true, tz: 'Australia/Adelaide' });
client.close();
```

Every method returns a `Promise` that resolves when the server acks, and rejects with the server's error `code` (e.g. `ACL_DENIED`). There is **no** `client.request()` — see [Correlated request/reply](#correlated-requestreply-application-level).

| Method | Signature | Notes |
|---|---|---|
| constructor | `new MeshClient(config?)` | `{ serverUrl?, agentId?, agentToken?, httpUrl? }`; any omitted field falls back to `MESH_SERVER_URL` / `MESH_AGENT_ID` / `MESH_AGENT_TOKEN` / `MESH_HTTP_URL`. `httpUrl` is the admin HTTP base for `fetchFile` (usually a different port than the WS `serverUrl` — set it) |
| `connect` | `(): Promise<void>` | opens the socket + authenticates; resolves on `auth_ok` |
| `onMessage` | `(h: (m: Inbound) => void): void` | fires for every inbound delivery (direct/topic/file/reminder) |
| `on` | `(event, h): void` | `event` ∈ `'connect' \| 'disconnect' \| 'error' \| 'presence'`. The `'presence'` handler gets a `PresenceEntry` `{ id, online, lastSeen }` on each ACL-related peer's status change |
| `send` | `(to, text, opts?): Promise<void>` | `opts`: `{ ttlMs?, contentType? }`. `ttlMs` is the delivery TTL (`0` = drop if recipient offline; omit for the 5-min default); `contentType` sets the payload MIME (default `text/plain`) |
| `publish` | `(topic, text, opts?): Promise<void>` | broadcast to a topic's subscribers. `opts`: `{ contentType?, ttlMs? }` |
| `sendFile` | `(to, opts): Promise<{ fileId }>` | `opts`: `{ data: Uint8Array\|ArrayBuffer, filename, contentType?, caption?, ttlMs?, replyToMsgId?, groupId? }`. Base64-encodes the bytes into a `file_send`; resolves with the stored `fileId` (`null` if dropped). `groupId` tags a multi-file send. The recipient gets an `Inbound{ kind:'file' }` with the metadata + `fetchUrl` + `groupId` (bytes via `fetchFile`) |
| `fetchFile` | `(fileId): Promise<Uint8Array>` | downloads the bytes over HTTP with the agent token (node-scoped: only the file's sender/recipient succeeds — a non-party / unknown id rejects with an `HTTP_404` error). Needs `httpUrl`; no WS connection required |
| `subscribe` / `unsubscribe` | `(topic): Promise<void>` | exact-topic; no wildcards |
| `remind` | `(opts): Promise<{ reminderId, dueAt }>` | `opts`: `{ text, when, recurring?, tz? }`. `when` is a duration (`"90s"`), an ISO datetime, or a cron expression (with `recurring: true`); `tz` is an IANA zone (default UTC). Fires back as an `Inbound{ kind: 'reminder' }`; survives restarts |
| `listReminders` | `(): Promise<Reminder[]>` | your pending reminders |
| `cancelReminder` | `(id): Promise<void>` | cancel one by id |
| `listPresence` | `(): Promise<PresenceEntry[]>` | roster of self + peers you share a **direct** ACL edge with (either direction), from the registry — each `{ id, online, lastSeen }`. A peer appears (as `online:false`) before it ever connects; peers reachable only via a shared topic/group are **not** included (derive those from `GET /acl` + your own group model). For live updates, listen for the `'presence'` event |
| `close` | `(): void` | graceful shutdown; stops reconnecting |

**`Inbound`** — the normalized (camelCase) form of a delivery:
```ts
{ msgId, kind, from, to?, topic?, text?, payload?, sentAt,
  fileId?, filename?, contentType?, fetchUrl?, size?, caption?, replyToMsgId?, groupId? }
// kind: 'direct' | 'topic' | 'file' | 'reminder'
```
`text` equals `payload` for text messages. For `kind: 'file'`, `payload` is `null` and the file fields are set: `fileId`, `filename`, `contentType`, `size` (bytes), `caption`, `replyToMsgId`, and `fetchUrl` (the relative `/files/:id` path to download the bytes).

Worth knowing: reconnect is automatic (exponential backoff, re-auth, re-subscribe). Sending while disconnected rejects — the SDK does not queue outbound messages locally. File bytes download from `GET /files/:id` (node-scoped — the file's recipient/sender, or admin); the SDK surfaces file metadata on inbound. Full surface and limits: [`client/README.md`](client/README.md).

### 4.2 From scratch (any language)

<details>
<summary>The whole loop by hand — for non-JS clients, or to see what the SDK does for you.</summary>

The pattern is **connect → auth → receive `deliver` → reply**, identical in any language with a WebSocket library. In JS with the `ws` package:

```js
import { WebSocket } from 'ws';

const ws = new WebSocket(process.env.MESH_SERVER_URL ?? 'ws://localhost:7384');
const pending = new Map();                            // msg_id -> resolve, for server acks/errors
const id = () => crypto.randomUUID();

ws.on('open', () => ws.send(JSON.stringify(
  { type: 'auth', agent_id: process.env.MESH_AGENT_ID, token: process.env.MESH_AGENT_TOKEN })));

ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  switch (f.type) {
    case 'auth_ok': console.log(`authed; ${f.queued} queued`); break;
    case 'deliver': handle(f); break;
    case 'ack':
    case 'error':   if (f.ref && pending.has(f.ref)) { pending.get(f.ref)(f); pending.delete(f.ref); }
                    break;
  }
});

function handle(f) {
  const reply = decide(f);                            // ← your logic (LLM, script, human, service)
  if (reply != null)
    ws.send(JSON.stringify({ type: 'send', msg_id: id(), to: f.from, payload: reply }));
}

// send and await the SERVER ACK (not a peer's reply — the bus has no native
// request/response; correlate peer replies in your own payload, see §3)
function sendAcked(to, payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const msg_id = id();
    pending.set(msg_id, resolve);                      // ack/error are keyed by msg_id
    ws.send(JSON.stringify({ type: 'send', msg_id, to, payload }));
    setTimeout(() => pending.delete(msg_id) && reject(new Error('timeout')), timeoutMs);
  });
}

setInterval(() => ws.readyState === ws.OPEN &&
  ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })), 25000);   // keepalive
```

`decide(frame)` is the one seam that's yours — return an LLM's text, a scripted reply, an operator's input, or a service result. Nothing about the bus is AI-specific. To act on a topic instead of a direct message, branch on `frame.kind === 'topic'`. A production client should also reconnect-with-backoff and re-subscribe its topics on reconnect — which is exactly what the SDK handles for you.

</details>

A node needs an `id` + token (`POST /agents`) and at least one ACL entry (`POST /acl`) permitting the traffic it sends — see the [Quickstart](#quickstart).

---

## 5. Federation (cross-mesh peering)

Two organisations can run separate meshes and let named agents talk across the
boundary. Each mesh stays independent: peerings are **directional**, remote
agents are addressed **`alias:agent`**, traffic is **one hop** and **direct
messages only**, and an ordinary ACL grant is still required on both sides — a
peering by itself grants nothing between agents.

**Operators: see [`docs/FEDERATION.md`](docs/FEDERATION.md)** — the setup calls
with example bodies and responses, what each failure looks like, what you can
see while it runs, how to tear a peering down, and what is deliberately not
supported. You do not need to read the design document to run a peering.

`DESIGN_FEDERATION_V2.md` is the design and the reasoning behind it.

---

## 6. Observers and the tap

The tap is the bus's live observability output: a real-time copy of every message flowing through the bus, delivered to authorized observer nodes.

- **Admin-only grant — this is the entire privacy boundary.** An admin grants observer status via `POST /observers { "agent_id": "watcher" }`. A node that hasn't been granted will *never* receive a tap frame, even for traffic it's party to, and there's no way to self-grant over WS or MCP.
- **It bypasses ACL, on purpose.** An observer sees traffic between agents it has no ACL relationship with — that's the point. Guard the grant accordingly.
- **It does NOT cross a border by default (F3).** "Observers see everything" is a *category*, and its scope is settled by what the mesh happens to contain — federation widened it without anyone editing the grant. So cross-border traffic is a **second, explicit grant**: `POST /observers { "agent_id": "watcher", "cross_border": true }`. Without it an observer sees local traffic only and never sees a frame whose sender or recipient is a remote (`alias:agent`) id. The field must be a real `true`; `"true"`, `1` and `"yes"` are rejected, because a scope that widens on a typo is the failure the flag exists to prevent. Existing grants — including every grant made before federation shipped — are local-only, and are **not** grandfathered into the wider scope.
- Granting/revoking takes effect live on a connected socket; a granted observer just connects and receives the tap (no subscribe step).
- Live and fire-and-forget — not queued or persisted. An offline observer misses frames and reads `GET /messages` for history. A slow observer whose send buffer backs up past 8 MB has tap frames dropped, so a consumer can never stall the bus.
- Traffic via the WS protocol and via the MCP interface (§6) is tapped identically.

`← tap` frame:
```json
{ "type": "tap", "msg_id": "m-1", "kind": "direct", "from": "alice", "to": "bob",
  "topic": null, "correlation_id": null, "sent_at": 1718900000000, "size": 5, "payload": "hello" }
```
`kind` ∈ `direct | topic | file`. For topic, `to` is `null` and `topic` is set. For `kind: "file"`, `payload` is `null` and the frame carries `file_id` / `filename` / `content_type` (fetch bytes via `GET /files/<id>` if needed — the tap never inlines them). `correlation_id` is vestigial and always `null`.

Typical consumers: a live comms-map, an audit log, a scoring engine, a moderation view — all outside the bus, reading the tap.

---

## 7. HTTP admin API

A second HTTP listener (admin port, default `7385`) handles administration. Every endpoint except `/metrics` requires `Authorization: Bearer <MESH_ADMIN_TOKEN>` — with two exceptions: `GET /messages` and `GET /files/:id` also accept an **agent's own bearer token**, node-scoped (see below). `/metrics` is intentionally unauthenticated — keep the admin port on an internal network and don't expose it publicly.

**Auth precedence:** on the node-scoped routes (`GET /messages`, `GET /files/:id`) the `Authorization` bearer is matched against the admin token **first** (timing-safe); if it isn't the admin token it is looked up as an agent token. So the admin token always grants full access; every other route stays admin-only.

**Agents**
- `POST /agents` `{ id, hostname, namespace? }` → `201` agent + `token` (raw, shown once). `namespace` is an optional string (identity label; null if omitted).
- `GET /agents[?online=true]` → list. `GET /agents/:id` → one. `DELETE /agents/:id` → `{ ok: true }`. Agent objects include parsed `metadata` (object) and `namespace` (string or null).
- `PATCH /agents/:id` `{ metadata?, namespace? }` → updated agent. **Partial update**: only the keys you send change; an omitted key is left untouched. `metadata` is **replace** (not merge — do read-modify-write) and must be a JSON object ≤ 4096 bytes serialized (oversized/non-object → `400`, never truncated). `namespace` is a string (set) or `null` (clear). The bus attaches no semantics to either — `namespace` is an inert identity label (no routing/ACL/enforcement).

**ACL**
- `POST /acl` `{ from_agent, to_agent, granted_by? }` → `201`. `DELETE /acl` `{ from_agent, to_agent }`.
- `GET /acl?agent=<id>` → `{ inbound: [...], outbound: [...] }` (rows carry `from_agent`, `to_agent`, `granted_by`, `granted_at`).
- **Provenance filter (`granted_by`).** Add `granted_by=<exact>` or `granted_by_prefix=<prefix>` (prefix uses SQL `LIKE`, with `%`/`_`/`\` in the value matched literally). With `agent=` it narrows that agent's inbound/outbound. **Without `agent=`** it's a global query → `{ matches: [...] }` — every ACL edge stamped by that writer / writer-namespace across the table (the reconciler path: "list every edge I granted under `mesh-chat:group:*`"). At least one of `agent` / `granted_by` / `granted_by_prefix` is required (else `400`); `granted_by` + `granted_by_prefix` together is `400`. The bus stores `granted_by` as opaque provenance — no namespace enforcement.

**Observers**
- `POST /observers` `{ agent_id, granted_by?, cross_border? }` → `201` (live-activates a connected socket). `cross_border` must be a boolean; it defaults to `false` and a re-grant **overwrites** it, so the same door narrows a scope as well as widens it.
- `DELETE /observers/:id` → `{ ok: true }`. `GET /observers` → list.

**Topics**
- `POST /topics` `{ name, created_by, description?, metadata? }` → `201`. `GET /topics` → list. (Publishing auto-creates a topic; this is only for pre-registering one.)

**Messages (history)**
- `GET /messages?agent=<id>&topic=<name>&since=<unix_ms>&limit=<n>&before=<cursor>` → array, newest first (all params optional; `limit` default 100, max 1000).
- **Backward pagination:** ordering is `sent_at DESC, id DESC`. To load older messages, pass `before=<sent_at>:<id>` built from the **oldest row of the previous page** (`` `${last.sent_at}:${last.id}` ``); the response is the bare array, so the cursor is derived client-side (no wrapper). Rows strictly older than the cursor are returned, stable across rows sharing a `sent_at`. `since` + `before` together bound a window. A malformed cursor is `400`.
- **Admin token:** unconstrained read; `agent` filters to any node's traffic.
- **Agent token:** node-scoped — results are constrained to messages that node is a party to (`from_agent = self OR to_agent = self`), which covers its direct, topic (per-subscriber copies), and file traffic. `topic`/`since`/`limit` apply within that scope. Passing `agent=<self>` (or omitting it) is fine; passing `agent=<another node>` is `403 {error:"forbidden: cannot query another agent"}`. An unknown/absent token is `401`.

**Files**
- `POST /files` (multipart: `file`, `from_agent`, `to_agent`, `caption?`, `reply_to_msg_id?`, `ttl_ms?`) → `201` file record.
- `GET /files/:id` → the file bytes (`Content-Disposition: attachment`). **Node-scoped:** an agent token may fetch a file only if it is the file's `to_agent` or `from_agent`; admin fetches any. Unauthorized and not-found both return **404** (no existence oracle — an agent can't probe file ids across nodes).

**Reminders**
- `POST /reminders` `{ agent_id, payload, (one of) schedule|due_at|duration, tz? }` → `201`.
- `GET /reminders[?agent_id=<id>]` → pending reminders (one agent, or fleet-wide if omitted).
- `PATCH /reminders/:id` `{ payload?, schedule?|due_at?|duration?, tz? }` → recomputes `due_at` when timing/tz change.
- `DELETE /reminders/:id` → `{ ok: true }`.

**Metrics**
- `GET /metrics` → Prometheus exposition (`text/plain; version=0.0.4`). No auth.

### MCP interface (alternative ingress)
The server also exposes its operations as MCP tools over stdio — for an orchestrator or tool host that drives the bus directly rather than over WS: `mesh_send`, `mesh_broadcast`, `mesh_subscribe`, `mesh_unsubscribe`, `mesh_discover`, `mesh_status`, `mesh_acl_allow`, `mesh_acl_deny`. Sending tools take an `as_agent` parameter (the acting agent, for ACL + tracing). This traffic flows through the same router — ACL-checked, persisted, and tapped exactly like WS traffic.

---

## 8. Observability

### `/metrics` (Prometheus)
Operational aggregates only — no per-conversation/analytic series (those are a consumer's job).
- **Counters:** `mesh_messages_total{kind,status}`, `mesh_messages_sent_total{from_agent}`, `mesh_messages_received_total{to_agent}`, `mesh_acl_denied_total{from_agent}`, `mesh_errors_total{error_code}`, `mesh_bytes_total{direction}`, `mesh_files_total`, `mesh_reminders_fired_total`.
- **Gauges:** `mesh_agents_online`, `mesh_agent_up{agent}`, `mesh_topics`, `mesh_subscriptions`, `mesh_pending_messages`, `mesh_reminders_pending`.
- **Histograms:** `mesh_message_payload_bytes`.

Counters are in-memory and reset on restart — graph them with `rate()`/`increase()`, never raw deltas.

`mesh_messages_total{status="expired"}` counts messages that crossed their delivery TTL while still **undelivered** (their deliverability died) — not messages deleted from the store, which no longer happens at TTL. It's incremented once per message as it expires, windowed over each cleanup tick; because the counter is in-memory, expiries that cross the TTL boundary while the server is down are not counted (consistent with `rate()`/`increase()` graphing).

### The tap
The live message stream — see [§5](#6-observers-and-the-tap). `/metrics` answers *how much / how healthy*, the tap answers *what's flowing now*, the message store answers *what happened*.

### Durable scheduling (reminders / cron)
Server-side scheduling that outlives your node: one-shot (`duration`/`due_at`) or recurring (`cron`), with DST-aware per-reminder timezones, surviving restarts and redeploys. Use it for heartbeats, periodic jobs, or deferred follow-ups without keeping an in-process timer alive.

---

## 9. Build / run / deploy

**Stack:** [Bun](https://bun.sh) runtime, `bun:sqlite` (no external DB), `ws` for WebSocket. No analytics dependencies — true to the pure-bus rule.

**Run locally:**
```bash
cd server && bun install
MESH_ADMIN_TOKEN=dev-secret bun server.ts      # WS :7384, admin :7385
```
`MESH_ADMIN_TOKEN` is the only required variable (the process exits without it). **Test:** `cd server && bun test`.

**Configuration (env):**

| Variable | Default | Purpose |
|---|---|---|
| `MESH_ADMIN_TOKEN` | *(required)* | Bearer token for the admin HTTP API |
| `MESH_DB_PATH` | `/data/mesh.db` | SQLite file |
| `MESH_WS_PORT` | `7384` | Agent WebSocket port |
| `MESH_ADMIN_PORT` | `7385` | Admin HTTP port (also serves `/metrics`) |
| `MESH_FILES_DIR` | `/data/files` | On-disk file storage |
| `MESH_MAX_FILE_BYTES` | `10485760` | Max file size (10 MB) |
| `MESH_CLEANUP_INTERVAL_MS` | `60000` | Cleanup tick interval (expiry accounting, retention sweep, file/reminder cleanup) |
| `MESH_REMINDER_INTERVAL_MS` | `10000` | Reminder scheduler tick |
| `MESH_PRESENCE_DEBOUNCE_MS` | `12000` | Suppress presence flap on reconnect within this window (`0` = immediate) |
| `MESH_MCP_MODE` | `0` | `1` = run as an MCP stdio server (stdin EOF shuts the server down). Default `0` runs as a standalone daemon that survives stdin being closed (e.g. `docker run -d`). |
| `MESH_METRICS_IDENTITY_LABELS` | *(unset = off)* | `1` emits the **identity-bearing** metric labels: agent ids (`mesh_agent_up{agent}`, `mesh_messages_sent_total{from_agent}`, `mesh_messages_received_total{to_agent}`, `mesh_acl_denied_total{from_agent}`) and peer aliases (`mesh_peer_up{alias}`, `mesh_peer_relays_total{alias,…}`). Off by default because `/metrics` is **unauthenticated**: those labels enumerate the agent roster that `list_presence` ACL-filters, and the federation topology that peer aliases name. A label is the same information as an API response with no auth in front of it. Turning it on **is the operator's acceptance** that the admin port is genuinely internal-only. Default emits aggregates (`mesh_agent_up_count{state}`, `mesh_peer_up_count{state}`, and unlabelled totals) which stay alertable without naming anyone. `mesh_errors_total{error_code}` carries no identity and is unaffected. |
| `MESH_RETENTION_MS` | *(unset = forever)* | Retention window: rows older than this (by `sent_at`) are swept from the store. Unset keeps history forever. Still-deliverable pending mail is never swept. Positive integer ms; no upper bound. |

**Docker:**
```bash
docker build -t claude-mesh .
docker run -e MESH_ADMIN_TOKEN=... -p 7432:7432 -p 7433:7433 -v mesh-data:/data claude-mesh
```
The image (`oven/bun:1-alpine`, entrypoint `bun server.ts`) sets `MESH_WS_PORT=7432` and exposes `7432`/`7433`; set `MESH_ADMIN_PORT=7433` so the admin listener matches the exposed port. Mount a volume at `/data` to persist the SQLite DB and files.

**Deploy model:** a single container with its SQLite DB on a mounted volume. A deploy is *pull latest → rebuild image → restart* (some deployments instead git-pull the source and run `bun server.ts` directly — either works; the point is the volume outlives the restart). Restarting flaps WS connections briefly, so clients should reconnect-with-backoff; the DB carries registry, ACL, history, and reminders across the restart.

**Deploy contract** (the rules the deploy model implies — see #71, companion to #23):

- **Restart = deploy.** A deployment that git-pulls the source runs `main` as of its last container start, and *any* merge to `main` goes live on the next restart — planned or not, host reboots included. Treat `main` as production.
- **The boot wrapper must fail-soft to the last-good checkout.** If the fetch fails (GitHub, DNS, or token outage) but a valid checkout exists, log loudly and boot the HEAD you already have; crash-loop only when there is no checkout at all. A fail-hard wrapper (`set -e` around the fetch) turns a transient blip at host reboot — exactly when every client is reconnecting — into a mesh-wide crash-loop.
- **Fetch credentials must track the repo's home.** If this repo moves orgs, the token baked into the wrapper moves with it, or the next restart crash-loops.
- **Schema changes must be safe to run unattended, because a restart is a deploy.** Boot-time migrations run with no operator watching (host reboots included), so each one must be idempotent and must leave a crash mid-way in a state the next boot repairs. The F0 `acl` rebuild (#97) is the reference shape: the `PRAGMA foreign_keys=OFF` is set outside any transaction (it is a no-op inside one), the DDL and the index replay run inside one explicit transaction, and the FK-probe makes a second run a no-op. A process death after `DROP TABLE acl` rolls back and the next boot retries — tested by injecting a crash at that point. The two properties are not independent: the probe is keyed on evidence a crash can destroy, which is why atomicity is not a separate nicety — without it the idempotency check itself is what turns a half-done migration into a clean boot (measured on the pre-fix code: crash after `DROP`, next boot recreates `acl` empty, the probe sees no foreign keys and returns, every grant gone, boot reported clean). A migration that cannot state both properties, and why its probe survives its own crash, does not merge.

The wrapper itself lives in the operator's deployment config, not in this repo: the image entrypoint is a plain `bun server.ts`.

---

## Quick map of the code

The repo is a small monorepo: `server/` is the bus, `client/` is the SDK, and the root `package.json` publishes the SDK as `@claude-mesh/client`.

| File | Responsibility |
|---|---|
| `server/server.ts` | Entry point, config, wiring |
| `server/ws-server.ts` | WebSocket listener, auth, frame dispatch, presence |
| `server/router.ts` | Message routing (direct/topic/file), delivery |
| `server/db.ts` | SQLite schema + all data access |
| `server/http-admin.ts` | Admin HTTP API + `/metrics` route |
| `server/mcp-server.ts` | MCP tool interface (alternative ingress) |
| `server/auth.ts` | Token generation / hashing / timing-safe validation |
| `server/tap.ts` | Event-tap fan-out to observers |
| `server/metrics.ts` | Prometheus metric registry + exposition |
| `server/reminder-scheduler.ts` | Durable reminder scheduling |
| `server/cleanup.ts` | TTL expiry sweeps |
| `client/src/protocol.ts` | **Shared** wire-frame types — the single protocol definition, imported by both the client and `server/router.ts` |
| `client/src/client.ts` | `MeshClient` — the [SDK](#41-with-the-sdk) |

One rule when you extend this: the bus moves messages and emits raw observability — everything analytic is a consumer.
