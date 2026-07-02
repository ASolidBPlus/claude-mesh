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

```jsonc
// consumer package.json — branch form (use while iterating on client-sdk)
"dependencies": {
  "@claude-mesh/client": "github:ASolidBPlus/claude-mesh#client-sdk"
}
```

After merge to `main`, pin to an immutable commit SHA (or a tag):

```jsonc
"dependencies": {
  "@claude-mesh/client": "github:ASolidBPlus/claude-mesh#<commit-sha>"
}
```

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
});

// Handle inbound messages (direct, topic, request, file).
client.onMessage((m: Inbound) => {
  console.log(`[${m.kind}] from ${m.from}:`, m.text);
  // Answer a request:
  if (m.kind === 'request' && m.correlationId) {
    client.send(m.from, 'pong', { kind: 'response', correlationId: m.correlationId });
  }
});

client.on('connect', () => console.log('mesh connected'));
client.on('disconnect', () => console.log('mesh disconnected (auto-reconnecting)'));
client.on('error', (err) => console.error('mesh error', err));

await client.connect();              // resolves on first successful auth

await client.send('other-agent', 'hello');          // resolves on server ack
await client.subscribe('announcements');
await client.publish('announcements', 'hi all');

const reply = await client.request('other-agent', 'are you there?');
console.log('got reply:', reply.text);

client.close();                      // stops reconnect, rejects pending work
```

Config resolution is `constructor value ?? env var`
(`MESH_SERVER_URL` / `MESH_AGENT_ID` / `MESH_AGENT_TOKEN`). If any is still
undefined at `connect()` time, `connect()` rejects with a clear error.

## API surface

| Method | Returns | Notes |
|--------|---------|-------|
| `connect()` | `Promise<void>` | resolves on first `auth_ok`; auto-reconnects with backoff afterward |
| `onMessage(fn)` | `void` | fires for every inbound `deliver`/`file_deliver` (not for `response`s answering a pending `request()`) |
| `on(event, fn)` | `void` | `'connect' \| 'disconnect' \| 'error' \| 'presence'`. `'presence'` fires with a `PresenceEntry` `{ id, online, lastSeen }` on each ACL-related peer's status change |
| `send(to, text, opts?)` | `Promise<void>` | resolves on the server ack; `opts.kind:'response'` requires `opts.correlationId`; `opts.ttlMs` sets the delivery TTL (`0` = drop if recipient offline, omit for the 5-min default) |
| `publish(topic, text)` | `Promise<void>` | resolves on ack |
| `subscribe(topic)` / `unsubscribe(topic)` | `Promise<void>` | resolve on ack; subscriptions are replayed on every reconnect |
| `request(to, text, opts?)` | `Promise<Inbound>` | resolves with the `response`; rejects on timeout or server error (e.g. `ACL_DENIED`) |
| `listPresence()` | `Promise<PresenceEntry[]>` | roster of self + peers you share a **direct** ACL edge with (either direction), from the registry — each `{ id, online, lastSeen }`. Includes registered peers that have never connected (`online:false`); does **not** include peers reachable only via a shared topic/group (derive those from `GET /acl` + your group model) |
| `close()` | `void` | stops reconnect, rejects pending acks/requests |

Errors raised from server rejections carry a `.code` (e.g. `err.code === 'ACL_DENIED'`).

## Limits / out of scope

- **Request timeout** defaults to **30 000 ms**. LLM-backed responders can take longer —
  pass a larger `timeoutMs`: `client.request(to, text, { timeoutMs: 120_000 })`.
- **No file-send method** and **no `fetchFile`** in this version. `onMessage` surfaces
  inbound files as `Inbound{ kind: 'file', fileId, filename, contentType }` (with
  `text`/`payload` null), but downloading the file content and sending files are out of
  scope for now.
- Sending while disconnected rejects with `Error('not connected')` — the SDK does not
  queue outbound messages locally.
