# @claude-mesh/client

The reusable WebSocket client SDK for the [claude-mesh](https://github.com/ASolidBPlus/claude-mesh)
fabric. Ships the `MeshClient` class plus the shared wire-protocol types, so every
consumer (the Claude Code plugin, the `mesh-agent` runtime, the spawner UI, tests)
talks to the mesh through ONE implementation instead of drifting copies.

The package ships **TypeScript source** (no build step). Both supported consumers run
under Bun, which imports `.ts` directly. Its only runtime dependency is `ws`.

## Install

### Git dependency (works today, no credentials needed)

Bun does not support git-subdirectory deps and the SDK's package manifest lives at the
**repo root**, so depend on the repo directly — it resolves as `@claude-mesh/client`:

Pin to an immutable commit SHA (or a tag) — always, not just in production. A
floating branch ref silently changes the SDK under you between installs:

```jsonc
// consumer package.json
"dependencies": {
  "@claude-mesh/client": "github:ASolidBPlus/claude-mesh#<commit-sha>"
}
```

> **Bumping the pin?** Regenerate your lockfile in the *same* commit — a changed
> git-dep SHA with a stale `bun.lock` fails `bun install --frozen-lockfile` in CI.

Then `bun add github:ASolidBPlus/claude-mesh#<ref>`.

### npm publish (future hand-off — no credentials in this container)

The package is structured so publishing is a one-liner once creds exist:

```sh
cd client && npm publish --access public
```

If a plain-Node consumer without a TS loader ever appears, add a build step
(`tsup src/index.ts --format esm --dts`) and repoint `main`/`types`/`exports` at
`dist/`. For Bun consumers, source-shipping is correct and lean.

## Usage

```ts
import { MeshClient, type Inbound } from '@claude-mesh/client';

const client = new MeshClient({
  serverUrl: 'ws://mesh.host:8787',   // or process.env.MESH_SERVER_URL
  agentId: 'my-agent',                // or process.env.MESH_AGENT_ID
  agentToken: process.env.MESH_AGENT_TOKEN, // raw bearer token
  httpUrl: 'http://mesh.host:8788',   // or MESH_HTTP_URL — admin HTTP base for fetchFile (usually a different port than serverUrl)
});

// Handle inbound messages (direct, topic, file, reminder).
client.onMessage((m: Inbound) => {
  console.log(`[${m.kind}] from ${m.from}:`, m.text);
  // Replying is just another send. If you need to correlate a reply with the
  // call that prompted it, put your own token in the PAYLOAD — the bus has no
  // native request/response. See "Correlated request/reply" below.
  client.send(m.from, 'pong');
});

client.on('connect', () => console.log('mesh connected'));
client.on('disconnect', () => console.log('mesh disconnected (auto-reconnecting)'));
client.on('error', (err) => console.error('mesh error', err));

await client.connect();              // resolves on first successful auth

await client.send('other-agent', 'hello');          // resolves on server ack
await client.subscribe('announcements');
await client.publish('announcements', 'hi all');

// Durable, server-side scheduling — fires back as an Inbound{ kind: 'reminder' }
await client.remind({ text: 'stand-up', when: '0 9 * * 1', recurring: true, tz: 'Australia/Adelaide' });

client.close();                      // stops reconnect, rejects pending work
```

Config resolution is `constructor value ?? env var`
(`MESH_SERVER_URL` / `MESH_AGENT_ID` / `MESH_AGENT_TOKEN`). If any is still
undefined at `connect()` time, `connect()` rejects with a clear error.

## API surface

| Method | Returns | Notes |
|--------|---------|-------|
| `connect()` | `Promise<void>` | resolves on first `auth_ok`; auto-reconnects with backoff afterward |
| `onMessage(fn)` | `void` | fires for every inbound `deliver`/`file_deliver` — `kind` ∈ `'direct' \| 'topic' \| 'file' \| 'reminder'` |
| `on(event, fn)` | `void` | `'connect' \| 'disconnect' \| 'error' \| 'presence'`. `'presence'` fires with a `PresenceEntry` `{ id, online, lastSeen }` on each ACL-related peer's status change |
| `send(to, text, opts?)` | `Promise<void>` | resolves on the server ack; `opts.ttlMs` sets the delivery TTL (`0` = drop if recipient offline, omit for the 5-min default); `opts.contentType` sets the payload MIME (default `text/plain`) |
| `publish(topic, text, opts?)` | `Promise<void>` | resolves on ack. `opts: { contentType?, ttlMs? }` |
| `sendFile(to, opts)` | `Promise<{ fileId }>` | `opts: { data: Uint8Array\|ArrayBuffer, filename, contentType?, caption?, ttlMs?, replyToMsgId?, groupId? }`; base64-encodes bytes into a `file_send`. Resolves with the stored `fileId` (`null` if dropped). `groupId` tags a multi-file send. Recipient gets an `Inbound{ kind:'file', fileId, filename, contentType, size, caption, replyToMsgId, groupId, fetchUrl }` — download bytes with `fetchFile` |
| `fetchFile(fileId)` | `Promise<Uint8Array>` | downloads the bytes over HTTP with the agent token (node-scoped — only the file's sender/recipient; a non-party or unknown id rejects with an `err.code === 'HTTP_404'`). Requires `httpUrl`/`MESH_HTTP_URL`; no WS connection needed |
| `subscribe(topic)` / `unsubscribe(topic)` | `Promise<void>` | resolve on ack; subscriptions are replayed on every reconnect |
| `remind(opts)` | `Promise<{ reminderId, dueAt }>` | `opts: { text, when, recurring?, tz? }`. `when` is a duration (`"90s"`, `"2h"`), an ISO datetime, or a cron expression (with `recurring: true`); `tz` is an IANA zone (DST-aware, default UTC). Fires back as an `Inbound{ kind:'reminder' }` and survives server restarts |
| `listReminders()` | `Promise<Reminder[]>` | your pending reminders |
| `cancelReminder(id)` | `Promise<void>` | cancel one by id |
| `listPresence()` | `Promise<PresenceEntry[]>` | roster of self + peers you share a **direct** ACL edge with (either direction), from the registry — each `{ id, online, lastSeen }`. Includes registered peers that have never connected (`online:false`); does **not** include peers reachable only via a shared topic/group (derive those from `GET /acl` + your group model) |
| `close()` | `void` | stops reconnect, rejects pending acks |

Errors raised from server rejections carry a `.code` (e.g. `err.code === 'ACL_DENIED'`).

## Correlated request/reply

**There is no `client.request()`, and no `response` message kind.** The bus has no
native request/response primitive — it was removed deliberately (bus-purity): the
server does not correlate replies or enforce a reply timeout.

Correlation is **application state**. Put your own token in the payload, have the
responder echo it back in an ordinary `send`, and apply your own timeout:

```ts
const token = crypto.randomUUID();
const pending = new Map<string, (text: string) => void>();

client.onMessage((m) => {
  const msg = JSON.parse(m.text ?? '{}');
  const resolve = pending.get(msg.reply_to);
  if (resolve) { pending.delete(msg.reply_to); resolve(msg.body); }
});

await client.send('other-agent', JSON.stringify({ reply_to: token, body: 'ping?' }),
  { contentType: 'application/json' });
```

The responder replies with `send(caller, JSON.stringify({ reply_to: token, body: 'pong' }))`.
The webhook gateway runs this pattern in production and is the reference to copy.

## Limits / out of scope

- Sending while disconnected rejects with `Error('not connected')` — the SDK does not
  queue outbound messages locally.
- No wildcard topic subscriptions — `subscribe` is exact-topic only.
- `fetchFile` needs `httpUrl` / `MESH_HTTP_URL` (the admin HTTP base, usually a
  different port from the WS `serverUrl`); without it, file downloads reject.
