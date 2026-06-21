# claude-mesh

A lightweight **message bus** for autonomous nodes. Nodes connect over a WebSocket, authenticate, and exchange messages — direct, pub/sub topics, and request/response — with server-enforced access control, durable history, scheduled reminders, and live observability.

This document is for **developers building on claude-mesh** — whether your node is an AI agent, a scripted bot, a backend service, or a human-driven UI. It explains the model, the wire protocol, and how to write your first client.

---

## 1. What it is (read this first)

claude-mesh is a **pure bus**. It does exactly two things:

1. **Moves messages** between nodes (direct, topic broadcast, request/response, files), with ACL enforcement and durable persistence.
2. **Exposes raw observability** — a Prometheus `/metrics` endpoint and a live **event tap** of all traffic.

**That's the whole bus.** It deliberately owns **no analytics and no views.**

> **The pure-bus principle:** the bus moves messages and emits *raw* observability outputs. **All analytics, dashboards, graphs, scoring, and views are CONSUMERS that live *outside* the bus** — they read from the two raw outputs (`/metrics`, the tap) and the message store. They are never built into the core.

Why this matters when you extend it: it is tempting to add, say, a "who-talks-to-whom" graph metric or a per-conversation rollup *inside* the server. **Don't.** That kind of derived view belongs in a consumer that reads the tap or queries `GET /messages`. Keeping derived state out of the bus is what keeps the bus small, fast, and correct. If you find yourself adding a metric or table that answers an *analytic* question ("who", "how related", "what's the trend"), it belongs in a consumer, not here.

The three raw surfaces a consumer builds on:
- **`GET /metrics`** — aggregate operational counters/gauges/histograms (Prometheus).
- **The event tap** — a live, ACL-gated copy of *every* message, for authorized observers.
- **The message store** — every message persisted in SQLite, queryable via `GET /messages` (this is your *history*; the tap is *live*).

---

## 2. Core concepts

### Nodes are just WebSocket clients — and brain-agnostic
A "node" (the code calls it an *agent*) is **any** process that opens a WebSocket to the bus and authenticates. The bus does not know or care what's behind it:

- an **AI agent** (an LLM driving replies via some SDK),
- a **scripted bot** / NPC,
- a **human** behind a web UI,
- a **backend service**.

All four are identical to the bus: connect, auth, receive `deliver` frames, send `send`/`publish`/`request`/`response` frames. The "brain" is entirely your concern and plugs in at one point (where you decide how to reply). See [§4](#4-how-to-write-a-client).

### Auth — hashed bearer tokens
Each node has an `id` and a secret **bearer token**. The server stores only the **SHA-256 hash** of the token; the raw token is shown **once**, at registration time (`POST /agents`), and never again. Token comparison is **timing-safe**. A node authenticates by sending its `id` + raw token as the first WS frame.

### ACL — who may talk to whom
Message delivery is gated by an **access-control list**, managed by an admin. An ACL entry `from → to` permits `from` to send to `to`. Direct messages, requests, and responses are all ACL-checked server-side; a send to an agent you're not permitted to reach is rejected with `ACL_DENIED`. ACLs are administered out-of-band via the HTTP admin API (`POST/DELETE/GET /acl`) — nodes cannot grant themselves access.

### The message store — durable history
**Every** message is persisted in SQLite (the `messages` table) at acceptance time, with `from`, `to`/`topic`, `kind`, `payload`, `sent_at`, and delivery/ack timestamps. If a recipient is offline, the message waits in the queue and is **drained on its next connect**. History is queryable by an admin via `GET /messages` (filter by agent, topic, time). Messages may carry a TTL (default 5 min) after which they expire; a `null` TTL persists indefinitely.

---

## 3. Frame protocol reference

All WS frames are JSON objects with a `type` field. After the connection opens you **must** send an `auth` frame first (within 5 seconds) before any other frame is accepted.

Ports (code defaults): **WS `7384`**, admin HTTP `7385`. (The provided Docker image sets `MESH_WS_PORT=7432`; set `MESH_ADMIN_PORT=7433` to match its exposed admin port — see [§8](#8-build--run--deploy).)

### Handshake

**→ auth** (client sends first)
```json
{ "type": "auth", "agent_id": "alice", "token": "<raw bearer token>" }
```
**← auth_ok** (on success)
```json
{ "type": "auth_ok", "agent_id": "alice", "queued": 3, "queued_files": 0 }
```
`queued` / `queued_files` tell you how many pending messages/files are about to be drained to you. On failure you get an `error` frame (`AUTH_FAILED` / `AUTH_REQUIRED` / `AUTH_TIMEOUT`) and the socket closes.

### Sending

**→ send** — direct message to one agent
```json
{ "type": "send", "msg_id": "m-1", "to": "bob", "payload": "hello",
  "content_type": "text/plain", "ttl_ms": 300000 }
```
**→ publish** — broadcast to a topic's subscribers
```json
{ "type": "publish", "msg_id": "m-2", "topic": "alerts", "payload": "disk full" }
```
**→ subscribe / unsubscribe** — manage your topic subscriptions
```json
{ "type": "subscribe", "topic": "alerts" }
{ "type": "unsubscribe", "topic": "alerts" }
```
`content_type` (default `text/plain`) and `ttl_ms` (default `300000`; `0` = drop if recipient offline; payload max **1 MB**) are optional on `send`/`publish`.

Each of the above gets a server **ack** referencing your `msg_id` (or the topic):
```json
{ "type": "ack", "ref": "m-1", "ok": true }
```
…or an `error` (see [error codes](#errors)).

### Receiving

**← deliver** — a message addressed to you (or a topic you're subscribed to)
```json
{ "type": "deliver", "msg_id": "m-1", "kind": "direct",
  "from": "alice", "to": "bob", "topic": null, "correlation_id": null,
  "payload": "hello", "content_type": "text/plain", "sent_at": 1718900000000 }
```
`kind` is one of `direct | topic | request | response`. For topic deliveries, `to` is `null` and `topic` is set.

**→ ack** — (optional) acknowledge that you *processed* a delivered message
```json
{ "type": "ack", "msg_id": "m-1" }
```
> Note the two distinct uses of `ack`: the **server→client** ack (has `ref`) confirms your *send* was accepted; the **client→server** ack (has `msg_id`) marks a *delivered* message as processed (sets `acked_at` in the store).

### Request / response (correlated)

**→ request** — like `send`, but you expect a reply, tagged with a `correlation_id`
```json
{ "type": "request", "msg_id": "r-1", "to": "bob", "payload": "ping?",
  "correlation_id": "c-abc", "ttl_ms": 30000 }
```
The recipient receives a `deliver` with `kind: "request"` and the `correlation_id`. Only that recipient may answer:

**→ response** — the recipient replies, echoing the `correlation_id`
```json
{ "type": "response", "msg_id": "r-1b", "correlation_id": "c-abc", "payload": "pong" }
```
The original requester then receives a `deliver` with `kind: "response"` and the matching `correlation_id`. If no response arrives within `ttl_ms` (default 30 s, max 5 min), the requester gets:
```json
{ "type": "error", "ref": "c-abc", "code": "REQUEST_TIMEOUT", "message": "..." }
```

### Files

**→ file_send** — base64-encoded file to one agent
```json
{ "type": "file_send", "msg_id": "f-1", "to": "bob", "filename": "report.pdf",
  "content_type": "application/pdf", "data": "<base64>", "caption": "Q3", "ttl_ms": 300000 }
```
**← file_deliver** — the recipient is notified with a fetch URL (not the bytes)
```json
{ "type": "file_deliver", "file_id": "<uuid>", "from": "alice", "to": "bob",
  "filename": "report.pdf", "content_type": "application/pdf", "size_bytes": 12345,
  "sent_at": 1718900000000, "fetch_url": "/files/<uuid>", "caption": "Q3",
  "reply_to_msg_id": null }
```
The recipient downloads the bytes via `GET /files/<file_id>`. Max size is `MESH_MAX_FILE_BYTES` (default 10 MB).

### Presence, reminders, keepalive
- **→ ping** `{ "type": "ping", "ts": 1718900000000 }` → **← pong** `{ "type": "pong", "ts": ..., "server_ts": ... }`. Use this as a heartbeat.
- **← agent_status** — you receive these when an ACL-related peer goes online/offline: `{ "type": "agent_status", "agent_id": "bob", "online": true, "last_seen": ... }`.
- **→ list_presence** `{ "type": "list_presence", "msg_id": "p-1" }` → **← presence_list** `{ "type": "presence_list", "ref": "p-1", "agents": [{ "id": "bob", "online": true, "last_seen": ... }] }` (ACL-filtered to you + your peers).
- **→ remind** — schedule a reminder the bus will deliver back to you:
  ```json
  { "type": "remind", "msg_id": "rm-1", "text": "stand-up", "when": "0 9 * * 1",
    "recurring": true, "tz": "Australia/Adelaide" }
  ```
  `when` is a **duration** (`"90s"`, `"2h"`), an **ISO datetime**, or a **cron expression** (with `recurring: true`). `tz` is an optional IANA timezone (DST-aware; defaults to UTC). The reminder fires as a normal `deliver` frame (`from: "mesh"`) at the due time — and **survives restarts and your redeploys** because it lives in the server DB. Reply ack: `{ "type": "ack", "ref": "rm-1", "ok": true, "reminder_id": "...", "due_at": 1718900000000 }`. Also: **→ list_reminders** → **← reminders_list**, and **→ cancel_reminder** `{ "type": "cancel_reminder", "id": "..." }`.

### Correlation rule (for typed replies)
If your request frame carries a `msg_id`, the matching server reply echoes it back as `ref` (acks, `reminders_list`, `presence_list`, and errors all do this). Key every outstanding request by its `msg_id` and resolve it when a frame with that `ref` arrives — one clean correlation path for everything.

### Errors
`{ "type": "error", "ref": "<msg_id|correlation_id>", "code": "<CODE>", "message": "..." }`. Common codes: `ACL_DENIED`, `AGENT_NOT_FOUND`, `MESSAGE_TOO_LARGE`, `CORRELATION_NOT_FOUND`, `REQUEST_TIMEOUT`, `INVALID_CRON`, `INVALID_TZ`, `INVALID_WHEN`, `PAYLOAD_TOO_LARGE`, `REMINDER_NOT_FOUND`, plus file codes (`FILE_TOO_LARGE`, `INVALID_BASE64`, `CAPTION_TOO_LARGE`).

---

## 4. How to write a client

A mesh client is a thin WebSocket loop: **connect → auth → receive `deliver` frames → reply**. The "brain" (what you say in reply) is the only part that's yours. Here's a complete, minimal client in JavaScript (works under Node or Bun with the `ws` package; the pattern is identical in any language with a WebSocket library).

```js
import { WebSocket } from 'ws';

const URL   = process.env.MESH_URL   ?? 'ws://localhost:7384';
const ID    = process.env.MESH_ID    ?? 'alice';
const TOKEN = process.env.MESH_TOKEN;            // the raw token from POST /agents

const ws = new WebSocket(URL);
const pending = new Map();                        // msg_id -> resolve(), for request/response

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'auth', agent_id: ID, token: TOKEN }));
});

ws.on('message', (raw) => {
  const f = JSON.parse(raw.toString());
  switch (f.type) {
    case 'auth_ok':
      console.log(`authed as ${f.agent_id}; ${f.queued} message(s) queued`);
      break;

    case 'deliver':
      handleDeliver(f);
      break;

    case 'ack':                                   // a reply we were awaiting?
      if (f.ref && pending.has(f.ref)) { pending.get(f.ref)(f); pending.delete(f.ref); }
      break;

    case 'error':
      if (f.ref && pending.has(f.ref)) { pending.get(f.ref)(f); pending.delete(f.ref); }
      else console.error('mesh error:', f.code, f.message);
      break;

    case 'pong': break;                           // heartbeat reply
    // agent_status / presence_list / reminders_list / file_deliver: handle as needed
  }
});

function handleDeliver(f) {
  // ---- THIS is where your "brain" plugs in ----
  const replyText = decide(f);                    // an LLM call, a script, a UI prompt, ...

  if (f.kind === 'request') {
    // someone is awaiting a correlated answer
    ws.send(JSON.stringify({
      type: 'response', msg_id: id(), correlation_id: f.correlation_id, payload: replyText,
    }));
  } else if (replyText != null) {
    // a normal direct reply back to the sender
    ws.send(JSON.stringify({ type: 'send', msg_id: id(), to: f.from, payload: replyText }));
  }
}

// Send a request and await the correlated response.
function request(to, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const msg_id = id(), correlation_id = id();
    pending.set(msg_id, resolve);                 // ack/error keyed by msg_id
    ws.send(JSON.stringify({ type: 'request', msg_id, to, payload, correlation_id, ttl_ms: timeoutMs }));
    setTimeout(() => { if (pending.delete(msg_id)) reject(new Error('timeout')); }, timeoutMs + 1000);
  });
}

const id = () => crypto.randomUUID();

// Keepalive
setInterval(() => ws.readyState === ws.OPEN && ws.send(JSON.stringify({ type: 'ping', ts: Date.now() })), 25000);
```

### Plugging in a brain (any SDK / any logic)
`decide(frame)` is the single seam. It is deliberately synchronous-looking above; in practice make it async and put whatever you want behind it:

```js
async function decide(frame) {
  // AI persona: call your LLM SDK and return its text
  const reply = await llm.generate({ system: persona, input: frame.payload });
  return reply.text;

  // Scripted bot: return canned/rule-based output
  // Human UI: surface frame.payload in the UI and return the operator's typed reply
  // Service: parse frame.payload as a command and return a structured result
}
```
Nothing about the bus is AI-specific. The same client shell drives an LLM-backed persona, a deterministic script, or a human — you only swap what `decide` does. To act on a topic instead of a direct message, branch on `frame.kind === 'topic'`.

### Getting credentials
A node needs an `id` + token (created by an admin via `POST /agents`, see [§6](#6-http-admin-api)) and at least one ACL entry permitting the traffic it intends to send. In development you'll typically: register two agents, grant ACL both ways, then run two clients.

---

## 5. Observers and the tap

The **tap** is the bus's live observability output: a real-time copy of **every** message flowing through the bus, delivered to **authorized observer nodes**.

- **Becoming an observer is admin-only.** An admin grants it via `POST /observers { "agent_id": "watcher" }`. **This grant is the entire privacy boundary** — a node that has not been explicitly granted observer status will **never** receive a tap frame, even for traffic it is party to. There is no way for a node to grant itself observer status over the WS or MCP interface.
- **Auto-enrolment.** Once granted, an observer simply connects and authenticates like any node; it receives the tap automatically (no subscribe step). Granting/revoking takes effect **live** on a connected socket.
- **It bypasses ACL — on purpose.** An observer sees traffic between agents it has no ACL relationship with. That's the point: observers are privileged auditors. Guard the grant accordingly.
- **Live only, fire-and-forget.** The tap is not queued or persisted. An offline observer misses frames while disconnected and reads the **message store** (`GET /messages`) for history. A slow observer whose send buffer backs up past 8 MB has tap frames dropped (the bus is never stalled by a consumer).
- **Both ingress paths.** Traffic that enters via the WS protocol *and* via the server's MCP interface (§6) is tapped identically.

**← tap** frame:
```json
{ "type": "tap", "msg_id": "m-1", "kind": "direct", "from": "alice", "to": "bob",
  "topic": null, "correlation_id": null, "sent_at": 1718900000000,
  "size": 5, "payload": "hello" }
```
For `kind: "file"`, `payload` is `null` and the frame carries `file_id`, `filename`, `content_type` instead (fetch the bytes via `GET /files/<file_id>` if needed — the tap never inlines file bytes). `kind` ∈ `direct | topic | request | response | file`; for topic, `to` is `null` and `topic` is set.

Typical consumers of the tap: a live comms-map / graph, an audit log, a scoring engine, a moderation view. All of these live **outside** the bus and read the tap stream.

---

## 6. HTTP admin API

A second HTTP listener (admin port, default `7385`) exposes administration. **Every endpoint except `/metrics` requires** `Authorization: Bearer <MESH_ADMIN_TOKEN>`. `/metrics` is intentionally unauthenticated (intended for an internal-only network — do not expose it publicly).

**Agents**
- `POST /agents` `{ id, hostname }` → `201` agent + **`token`** (raw, shown once).
- `GET /agents[?online=true]` → list. `GET /agents/:id` → one. `DELETE /agents/:id` → `{ ok: true }`.

**ACL**
- `POST /acl` `{ from_agent, to_agent, granted_by? }` → `201`. `DELETE /acl` `{ from_agent, to_agent }`.
- `GET /acl?agent=<id>` → `{ inbound: [...], outbound: [...] }`.

**Observers**
- `POST /observers` `{ agent_id, granted_by? }` → `201` (live-activates a connected socket).
- `DELETE /observers/:id` → `{ ok: true }`. `GET /observers` → list.

**Topics**
- `POST /topics` `{ name, created_by, description?, metadata? }` → `201`. `GET /topics` → list.

**Messages (history)**
- `GET /messages?agent=<id>&topic=<name>&since=<unix_ms>&limit=<n>` → array, newest first (all params optional; `limit` default 100, max 1000).

**Files**
- `POST /files` (multipart: `file`, `from_agent`, `to_agent`, `caption?`, `reply_to_msg_id?`, `ttl_ms?`) → `201` file record.
- `GET /files/:id` → the file bytes (`Content-Disposition: attachment`).

**Reminders**
- `POST /reminders` `{ agent_id, payload, (one of) schedule|due_at|duration, tz? }` → `201`.
- `GET /reminders[?agent_id=<id>]` → pending reminders (one agent, or fleet-wide if omitted).
- `PATCH /reminders/:id` `{ payload?, schedule?|due_at?|duration?, tz? }` → updated reminder (recomputes `due_at` when timing/tz change).
- `DELETE /reminders/:id` → `{ ok: true }`.

**Metrics**
- `GET /metrics` → Prometheus exposition (`text/plain; version=0.0.4`). **No auth.**

### MCP interface (alternative ingress)
The server also exposes its operations as **MCP tools** over stdio (for an orchestrator or tool host that drives the bus directly rather than over WS): `mesh_send`, `mesh_broadcast`, `mesh_subscribe`, `mesh_unsubscribe`, `mesh_discover`, `mesh_status`, `mesh_acl_allow`, `mesh_acl_deny`, `mesh_request`. Sending tools take an `as_agent` parameter naming the acting agent (used for ACL + tracing). Traffic sent this way flows through the same router — it is ACL-checked, persisted, and **tapped** exactly like WS traffic.

---

## 7. Observability

The bus's two **raw** outputs (everything else is a consumer):

### `/metrics` (Prometheus)
Operational aggregate only — no per-conversation/analytic series.
- **Counters:** `mesh_messages_total{kind,status}`, `mesh_messages_sent_total{from_agent}`, `mesh_messages_received_total{to_agent}`, `mesh_acl_denied_total{from_agent}`, `mesh_errors_total{error_code}`, `mesh_bytes_total{direction}`, `mesh_files_total`, `mesh_reminders_fired_total`.
- **Gauges:** `mesh_agents_online`, `mesh_agent_up{agent}`, `mesh_topics`, `mesh_subscriptions`, `mesh_pending_messages`, `mesh_pending_requests`, `mesh_reminders_pending`.
- **Histograms:** `mesh_request_duration_seconds`, `mesh_message_payload_bytes`.

Counters are in-memory and reset on restart — graph them with `rate()`/`increase()`, never raw deltas.

### The tap
The live message stream — see [§5](#5-observers-and-the-tap). `/metrics` answers *"how much / how healthy"*; the tap answers *"what exactly is flowing right now"*; the message store answers *"what happened"*.

### Durable scheduling (reminders / cron)
The reminder system (§3, §6) is durable, server-side scheduling: one-shot (`duration`/`due_at`) or recurring (`cron`), DST-aware per-reminder timezones, surviving restarts and node redeploys. Use it for heartbeats, periodic jobs, or deferred follow-ups without keeping an in-process timer alive in your node.

---

## 8. Build / run / deploy

**Stack:** [Bun](https://bun.sh) runtime, `bun:sqlite` (no external DB), `ws` for WebSocket. Zero analytics dependencies — true to the pure-bus principle.

**Run locally:**
```bash
cd server
bun install
MESH_ADMIN_TOKEN=dev-secret bun server.ts      # WS :7384, admin :7385
```
`MESH_ADMIN_TOKEN` is the only required variable (the process exits without it).

**Test:**
```bash
cd server && bun test
```

**Configuration (env):**

| Variable | Default | Purpose |
|---|---|---|
| `MESH_ADMIN_TOKEN` | *(required)* | Bearer token for the admin HTTP API |
| `MESH_DB_PATH` | `/data/mesh.db` | SQLite file |
| `MESH_WS_PORT` | `7384` | Agent WebSocket port |
| `MESH_ADMIN_PORT` | `7385` | Admin HTTP port (also serves `/metrics`) |
| `MESH_FILES_DIR` | `/data/files` | On-disk file storage |
| `MESH_MAX_FILE_BYTES` | `10485760` | Max file size (10 MB) |
| `MESH_CLEANUP_INTERVAL_MS` | `60000` | Expiry sweep interval |
| `MESH_REMINDER_INTERVAL_MS` | `10000` | Reminder scheduler tick |
| `MESH_PRESENCE_DEBOUNCE_MS` | `12000` | Suppress presence flap on reconnect within this window (`0` = immediate) |

**Docker:**
```bash
docker build -t claude-mesh .
docker run -e MESH_ADMIN_TOKEN=... -p 7432:7432 -p 7433:7433 -v mesh-data:/data claude-mesh
```
The image (`oven/bun:1-alpine`, entrypoint `bun server.ts`) sets `MESH_WS_PORT=7432` and exposes `7432`/`7433`. Set `MESH_ADMIN_PORT=7433` so the admin listener matches the exposed admin port. Mount a volume at `/data` to persist the SQLite DB and files across restarts.

**Deploy model:** the server is a single container with its SQLite DB on a mounted volume. A deploy is *pull latest → rebuild image (the source is copied in at build time) → restart the container*. (Some deployments instead git-pull the source onto the host and run `bun server.ts` directly, skipping the image rebuild — either model works; the point is the SQLite volume outlives the restart.) Restarting flaps WS connections briefly; clients should reconnect-with-backoff. The DB on the volume carries registry, ACL, message history, and reminders across the restart.

---

## Quick map of the code

| File | Responsibility |
|---|---|
| `server/server.ts` | Entry point, config, wiring |
| `server/ws-server.ts` | WebSocket listener, auth, frame dispatch, presence |
| `server/router.ts` | Message routing (direct/topic/request/response/file), delivery |
| `server/db.ts` | SQLite schema + all data access |
| `server/http-admin.ts` | Admin HTTP API + `/metrics` route |
| `server/mcp-server.ts` | MCP tool interface (alternative ingress) |
| `server/auth.ts` | Token generation / hashing / timing-safe validation |
| `server/tap.ts` | The event-tap fan-out to observers |
| `server/metrics.ts` | Prometheus metric registry + exposition |
| `server/reminder-scheduler.ts` | Durable reminder scheduling |
| `server/cleanup.ts` | TTL expiry sweeps |

Remember the one rule when you extend this: **the bus moves messages and emits raw observability — everything analytic is a consumer.**
