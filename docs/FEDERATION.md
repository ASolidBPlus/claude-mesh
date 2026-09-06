# Federation — operator guide

> **Describes `main` as of `62e30ec`.** Every behavioural claim below cites the
> file and the function or route it was read from — deliberately not a line
> number, which drifts on every merge (see the PR for the measurement).
> Everything here describes behaviour that is on `main` today; there are no
> pending-feature caveats left in this guide.
>
> You do not need to read `DESIGN_FEDERATION_V2.md` to use this guide. That
> document explains *why*; this one explains *what to type*.

---

## 1. The model, in five lines

1. **Each organisation runs its own mesh.** There is no shared cluster and no
   central registry — two meshes that have never heard of each other are the
   normal case.
2. **Peerings are directional.** "A may send to B" is one peering. Two-way
   traffic is two peerings, configured independently on each side.
3. **Remote agents are addressed `alias:agent`** — the alias is the name *your*
   mesh gave the peer, so the same remote mesh may be `partner` to you and
   `us` to them (`server/router.ts` `routeDirect`).
4. **One hop.** A peer may not relay on behalf of a third mesh; a `from` or `to`
   containing `:` is refused (`server/router.ts` `routeRelay`).
5. **Direct messages only, and both sides must still approve the pair.** A
   peering does not grant agent-to-agent access: the ordinary ACL grant is
   required as well, on the receiving side (`server/router.ts` `routeDirect`).

---

## 2. Setting up a peering

Two meshes, **Receiver** (accepts inbound) and **Sender** (sends outbound). All
calls are to the admin port with `Authorization: Bearer $ADMIN_TOKEN`.

### Step 1 — Receiver mints a peer key

The receiver decides what the peering is allowed to do. Nothing about the sender
is trusted here; the key is the whole grant.

```bash
curl -X POST "$RECEIVER/peer-keys" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"alias":"partner","kinds":["direct"],"rate_per_min":600,"note":"partner org"}'
```

```json
{
  "id": "3f0c…", "alias": "partner", "kinds": ["direct"],
  "rate_per_min": 600, "expires_at": null, "note": "partner org",
  "key": "•••• shown once ••••"
}
```

**`key` is shown exactly once and is never stored in the clear or returned by
any read API** (`server/http-admin.ts` `handlePeerKeyPost`). If you lose it, revoke the
key and mint another.

| field | default | notes |
|---|---|---|
| `alias` | *required* | `^[a-z0-9][a-z0-9-]{0,62}$`; `mesh` is reserved, and an alias colliding with a local agent id is a `409` (`server/http-admin.ts` `handlePeerKeyPost`, `:495`) |
| `kinds` | `["direct"]` | only `direct` crosses a border today |
| `rate_per_min` | `600` | positive integer (`server/http-admin.ts` `handlePeerKeyPost`) |
| `expires_at` | `null` | ms timestamp; gates **registration only**, not an already-established peering |
| `rotates` | `null` | the key id this one replaces. **Absent means rebind**, and a rebind drops the alias's existing inbound ACL edges (`server/http-admin.ts` `handlePeerKeyPost`) |

Only **one live key per alias** exists at a time — minting a second is a `409`,
so revoking one cannot leave a door open you believed you had closed
(`server/http-admin.ts` `handlePeerKeyPost`).

### Step 2 — Sender registers with the key

The receiver sends the key to the sender's operator out of band. The sender's
mesh then registers **against the receiver's admin port**:

```bash
curl -X POST "$RECEIVER/peers/register" \
  -H 'Content-Type: application/json' \
  -d '{"key":"•••• the minted key ••••","assigned_alias":"us","protocol":1}'
```

```json
{ "alias": "partner", "token": "•••• shown once ••••",
  "kinds": ["direct"], "rate_per_min": 600, "protocol": 1 }
```

This route takes **no admin token** — the key *is* the credential
(`server/http-admin.ts` `handlePeerRegister`). The returned `token` is the sender's
long-lived credential for the border socket, and is likewise shown once.

> **Every failure of this step returns the same `403 {"error":"registration
> refused"}`** — bad key, revoked key, expired key, unknown alias, malformed
> JSON, all of it (`server/http-admin.ts` `refusePeerRegistration`). This is deliberate (C9):
> a caller who is not yet trusted must not be able to tell *which* thing was
> wrong, because the differences are exactly what an attacker would enumerate.
> **The real reason is in the receiver's log**, as `evt:"peer.register_refused"`
> with a `reason` field. **Please do not file bugs about the uninformative
> 403** — read the receiver's log instead.

### Step 3 — Sender configures the outbound link

```bash
curl -X POST "$SENDER/outbound-peers" \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"alias":"partner","url":"wss://partner.example/ws",
       "token":"•••• from step 2 ••••","assigned_alias":"us",
       "kinds":["direct"],"rate_per_min":600}'
```

```json
{ "alias": "partner", "url": "wss://partner.example/ws",
  "assigned_alias": "us", "kinds": ["direct"], "rate_per_min": 600,
  "enabled": true, "created_at": 1788000000000, "last_alive": null }
```

**The response never contains `token`, and neither does `GET /outbound-peers`**
(`server/http-admin.ts` `publicOutboundFields`) — it is a live credential, and returning it
would put it in every operator's shell history.

### Step 4 — Reverse the whole thing for two-way traffic

Peerings are directional. For B→A as well, run steps 1–3 again with the roles
swapped: **A** mints a key, **B** registers, **B** configures the outbound link.
The two directions are independent — revoking one does not touch the other.

---

## 3. Sending across a border

An agent sends to a remote id exactly as it would to a local one — the only
difference is the `alias:` prefix:

```json
{ "type": "send", "msg_id": "…", "to": "partner:their-agent", "payload": "hello" }
```

**The sender's own mesh must have an ACL grant for the remote id**, granted like
any other:

```bash
curl -X POST "$SENDER/acl" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"from_agent":"our-agent","to_agent":"partner:their-agent"}'
```

and the **receiving** mesh needs the mirror-image grant for the inbound
direction (`inbound-alias:their-agent` → `local-agent`).

### What a refusal looks like

| code | meaning |
|---|---|
| `AGENT_NOT_FOUND` | **the catch-all.** No such peering, no ACL grant, unknown remote agent, or a second `:` in the address — all one code, so a sender cannot map the far mesh (`server/router.ts` `routeDirect`) |
| `KIND_NOT_ALLOWED` | the message kind is not in *your own* outbound `kinds`. A deliberate exception: it reveals only the sender's own configuration and crosses no border (`server/router.ts` `routeDirect`) |
| `DUPLICATE_MSG_ID` | this `msg_id` is already stored (`server/router.ts` `routeDirect`) |
| `RELAY_REFUSED` | seen by the *peer*, not by your agents: the far side refused a relayed frame and says nothing about why (`server/router.ts` `routeRelay`) |
| `RATE_LIMITED` | the peering's `rate_per_min` bucket is empty — distinct from `RELAY_REFUSED` on purpose, because a sender that must back off needs to know (`server/router.ts` `routeRelay`) |

If `AGENT_NOT_FOUND` surprises you, check in this order: the peering exists and
is enabled; the ACL grant exists on **both** meshes; the remote id has exactly
one `:`.

**`ttl_ms: 0` keeps its local meaning across a border** — deliver live or drop,
never queue. For a remote id, "online" means the peering socket is connected
(`server/router.ts` `routeDirect`).

---

## 4. What an admin can see

### Read APIs

| call | shows |
|---|---|
| `GET /peers` | inbound peerings that have registered, **never their `token_hash`** — alias, the key that minted them, kinds, rate, `last_seen`, `disabled` (`server/http-admin.ts` `handlePeerGet`) |
| `GET /peer-keys` | minted keys, **never the secrets** (`server/http-admin.ts` `handlePeerKeyGet`) |
| `GET /outbound-peers` | configured outbound links, **never the tokens** |
| `GET /agents` | the local roster, including four liveness readings — see below |

**The roster's four liveness readings answer different questions**, and the
difference matters when you are deciding whether an agent is stuck:
`online` = has a socket · `last_seen` = last acted · `last_alive` = the
transport answered the keepalive · `last_responded` = the agent's LOOP emitted
something only the loop can emit.

**`last_alive` does not mean the agent is working.** The keepalive is answered
by the mesh plugin, a separate process, which keeps ponging while the agent's
loop is stuck. `last_responded` is the reading for that question, and it is
`null` until the emitter ships (spawner#346) — a null there means "unknown",
not "stuck".

### Metrics

`/metrics` is Prometheus text on the admin port.

- **`mesh_peer_up`** — emitted as `0` or `1` for **every configured peer**,
  inbound and outbound — the source is supplied at boot (`server/server.ts` `main`)
  into the metrics seam (`server/metrics.ts` `setPeerUpSource`). That is what
  makes `mesh_peer_up == 0` a usable alert: a peering that is down looks
  different from one that was never configured. **This is the series to alert
  on.**
- **`mesh_peer_relays_total{direction,outcome}`** — relayed messages;
  `outcome` is one of `delivered`, `refused`, `rate_limited`, `duplicate`,
  `transient`.
- **`mesh_admin_auth_total{outcome}`** — admin authentications on this port,
  `success` and `failure` (`server/metrics.ts` `incAdminAuth`). **It counts
  uses, not users**: the admin token is shared, so a rising `success` says the
  credential was used, never by whom. No identity or source-address label —
  this document is unauthenticated, and an address is an identity for that
  purpose. The addresses are in the `admin.auth` log events instead.
- **Aggregates** (`mesh_agents_online`, `mesh_agent_up_count{state}`,
  `mesh_peer_up_count{state}`) carry no identities and stay alertable.

#### The admin audit log

Every admin authentication writes one structured event, **success and failure**
(`server/http-admin.ts` `recordAdminAuth`), and every mutation that succeeded
writes an `admin.mutation` event naming the route and the object in its path.

| field | read it as |
|---|---|
| `outcome`, `reason` | `reason` is `absent` or `invalid` and appears **only here** — the 401 body is identical for both, so a caller cannot use the difference (C9) |
| `remote` | the socket's peer address. Unforgeable by the caller, but it is the **proxy's** address whenever one is in front |
| `xff_untrusted` | `x-forwarded-for` verbatim. **A request header — anyone may send one saying anything.** Named so it has to be argued for rather than believed |

**What this does not do: attribute.** While the admin token is shared between
holders, an address narrows *which host*, never *which person*. This lands
alongside retiring the shared token, not instead of it.

#### `MESH_METRICS_IDENTITY_LABELS`

**Unset (the default), no metric label names a party** — no agent id, no peer
alias. Setting it to `1` turns on every party-naming label at once
(`server/metrics.ts` `identityLabelsEnabled`).

It defaults off because **`/metrics` is unauthenticated**. `mesh_agent_up{agent}`
would hand any reader the complete registered agent roster — including agents
that have never connected — which is exactly the roster the ACL filter withholds
elsewhere. A label is an API response with no auth in front of it. **Turning the
flag on is your acceptance that the admin port is genuinely internal-only.**

### Observers and the tap

An observer receives a live copy of bus traffic. It is an admin-only grant, and
it deliberately bypasses ACL — guard it accordingly.

#### The `cross_border` scope

"Observers see everything" is a *category*, and federation widened it without
anyone editing a grant. Cross-border traffic is therefore a **second, explicit
grant**, defaulting to `0` (`server/db.ts` `listCrossBorderObservers`):

```bash
curl -X POST "$MESH/observers" -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"agent_id":"watcher","cross_border":true}'
```

- Without it, an observer sees local traffic only and never a frame whose
  sender or recipient is a remote id (`server/tap.ts` `emitTap`).
- `cross_border` must be a real `true`; `"true"`, `1` and `"yes"` are rejected
  with `400` (`server/http-admin.ts` `handleObserverPost`) — a scope that
  widened on a typo is the failure it exists to prevent.
- **Existing grants, including every grant made before federation shipped, are
  local-only.** They are not grandfathered into the wider scope.
- A re-grant *overwrites*, so the same call narrows a scope as well as widening
  it.

### `MESH_ADMIN_BIND` — where the admin port listens

**Default is every interface, unchanged.** This is a knob and a disclosure, not
a restriction: inside a container the spawner stack reaches both ports over the
Docker network, so a loopback default would make the mesh unreachable.

- `MESH_ADMIN_BIND=127.0.0.1` binds the admin listener to loopback only.
- `MESH_WS_BIND` does the same for the agent/peer port. They are separate
  variables because the ports have **different audiences**: the WS port must be
  reachable by every agent and peering; the admin port need only be reachable
  by operators and the spawner stack.

**At boot the server logs where it bound and that `/metrics` is unauthenticated
on it** (`evt: "admin.listening"`), including when you have set nothing — in
which case it says so in as many words. That line is the point of the feature:
it turns *"the admin port is internal-only"* from an assumption nobody can check
into a statement your deployment either satisfies or does not, visible at boot.

### Break-glass: attributing a flood

> **This section is the single home for the break-glass procedure and for which
> counter attributes which class.** The README's env-table row and counters line
> point here rather than restating it. They restated it once, the two copies
> drifted, and the copy an operator reads mid-incident was the stale one — so if
> you change what the flag attributes, change it here and nowhere else.

**The problem this solves, and its exact scope.** With
`MESH_METRICS_IDENTITY_LABELS` unset — the default, and the right default —
`mesh_acl_denied_total` collapses to an aggregate: the rate stays visible and
the *who* goes dark. That is the attribution incident response needs, **for the
class this counter covers, which is direct sends only.** For topic fan-out the
*who* is not recorded at all, so there is nothing for the flag to reveal — see
the table in step 2.

**The procedure. It is a deploy action, not a code change:**

1. Set `MESH_METRICS_IDENTITY_LABELS=1` on the bus and restart it.
2. Scrape `/metrics` and read the identity-labelled series. **Which classes
   this actually attributes:**

   | class | attributed by the flag? |
   |---|---|
   | **Direct** sends refused by ACL | **Yes** — `mesh_acl_denied_total{from_agent}` names the sources |
   | **Topic fan-out** filtered by ACL | **No.** `mesh_topic_fanout_total` has no party dimension at all, by construction — not hidden behind the flag, absent |

   The fan-out class has no party dimension because topic names and subscriber
   lists are agent-chosen, so any label carrying one would put an agent-chosen
   string into unauthenticated `/metrics`. **The flag cannot reveal what is
   not recorded**, and turning it on for a fan-out flood costs two restarts and
   a roster-exposure window and returns nothing.

   This matters because the flood that produced this procedure — the
   `sys.presence.turn` fan-out — was exactly the class the flag does not
   attribute. For that class the only route is the source-socket bucketing
   described below, which is **not built**.
3. **Unset it and restart again.** Do not leave it on: while set, `/metrics`
   hands the complete registered agent roster to any reader of an
   unauthenticated endpoint.

Treat the window as a deliberate, time-boxed exposure with a named end. If you
find yourself leaving it on "for now", the honest alternative is to restrict the
admin port with `MESH_ADMIN_BIND` and accept the exposure permanently — that is
at least a decision someone made.

**An attribution path that needs no flag** — and for topic fan-out it is the
ONLY one, not a nice-to-have: bucket refusals by *source socket*, since each
plugin host holds one distinguishable connection
to the bus. That is not built; it is recorded here so the break-glass procedure
is understood as the current answer rather than the intended one.

---

## 5. Tearing down

### Revoke a key (receiver side)

**First, see who actually holds a registration** — `GET /peers` lists them by
alias with the `minted_by_key` you are about to revoke, so the revocation acts
on a peering you have seen rather than one you remember:

```bash
curl "$RECEIVER/peers" -H "Authorization: Bearer $ADMIN_TOKEN"
```

*(Docs correction, #153: §4 listed this route from the first version of this
guide and it 404'd until now. It was the only row in that table with no
`file.ts` + symbol citation beside it.)*

```bash
curl -X DELETE "$RECEIVER/peer-keys/$KEY_ID" -H "Authorization: Bearer $ADMIN_TOKEN"
```

→ `{"revoked": true, "id": "…"}`. **The peer's live socket is closed
immediately**, not at the next sweep (`server/http-admin.ts` `handlePeerKeyDelete`).
A `404 {"error":"no such live peer key"}` means it was already revoked.

#### What this costs the SENDER, which is more than it looks

A revocation on your side is a **fatal `AUTH_FAILED`** on theirs, and their mesh
does not merely stop: `endOutboundPeering` runs there
(`server/db.ts` `endOutboundPeering`) and

1. **disables their outbound peering row**,
2. **expires their queued messages for your alias** — not delivered, not left
   pending, and
3. **deletes their outbound ACL edges** to your agents.

So recovery on the sender's side is **`PATCH {enabled:true}` *plus* re-granting
every ACL edge** — and **the queue is not recoverable at all.** An operator who
expects re-enabling to restore the link finds traffic still refused with
`AGENT_NOT_FOUND`, because the edges are gone.

**If you only need the link to stop, do not revoke — disable it.** See
[Disable without deleting](#disable-without-deleting), which keeps both the
edges and the queue.

### Delete an outbound peering (sender side)

```bash
curl -X DELETE "$SENDER/outbound-peers/partner" -H "Authorization: Bearer $ADMIN_TOKEN"
```

→ `{"deleted": true, "alias": "partner", "expired_rows": 3, "removed_edges": 2}`

**What happens to queued messages: they are expired, not delivered and not left
pending.** `endOutboundPeering` stamps still-deliverable rows for that alias as
expired in the same transaction that removes the peering (`server/db.ts` `endOutboundPeering`). `expired_rows` is how many were affected and
`removed_edges` how many ACL edges went with it. **This is not reversible by
re-creating the peering** — recreate it and senders must send again, and the
ACL edges must be re-granted. If you only need the link to stop, use
[Disable without deleting](#disable-without-deleting) instead.

### Disable without deleting

`PATCH /outbound-peers/:alias` with `{"enabled": false}` stops the link while
keeping its configuration — **and, unlike a delete or a revocation, it keeps the
queued messages and the ACL edges.** This is the reversible option: `{"enabled":
true}` restores the link with nothing else to redo.

**While disabled, NEW sends to that alias are refused with `AGENT_NOT_FOUND`**
(a paused peering makes the remote id unknown to local senders); only
already-queued messages wait, and re-enabling drains them. So pausing is not
buffering — expect senders to see refusals for the duration. Prefer it for maintenance,
incidents, and anything you intend to undo.

---

## 6. Not supported, by design

| not supported | why |
|---|---|
| **Multi-hop / transitive federation** | Your admin's decision covers *this* peer, not that peer's peers. A relayed `from`/`to` containing `:` is refused (`server/router.ts` `routeRelay`) |
| **Topics across a border** | Federated pub/sub raises ownership and fan-out questions that are not answered; topics stay local |
| **Files across a border** | Direct messages only for v1 |
| **Presence across a border** | You cannot see whether a remote agent is online — only whether the *peering* is connected |
| **Reminders across a border** | Local scheduling only |
| **Time-boxed peerings** | `expires_at` on a key gates **registration only**. Once a peer has registered, key expiry does not end the peering — revoke it explicitly. Whether peerings should be time-boundable is an open product question |

---

## Cross-references

- `DESIGN_FEDERATION_V2.md` — the design, the constraints, and the reasoning.
- `README.md` — the bus itself: agents, ACL, topics, files, the tap.
