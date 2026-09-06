# DRIVE3 — how to run the F4 drive (P13–P18)

`f2-verify/drive3.ts` drives F4 (topics across peerings, hub-and-spoke) against
a **three-mesh sandbox**. It starts nothing and observes a sandbox, never
production.

## 1. The pinned checkout (already created)

```bash
cd /home/coder/project/claude-mesh
git fetch origin feat/f4-topics-across-peerings
git worktree add /home/coder/project/f2-verify/mesh-f4 f62fca6c713259767a62a6bf536b7586ac45dbba
cd /home/coder/project/f2-verify/mesh-f4/client && bun install --frozen-lockfile
cd /home/coder/project/f2-verify/mesh-f4/server && bun install --frozen-lockfile
```

`f62fca6c…` is PR #172 (`ASolidBPlus/claude-mesh`). **On a later head:** remove
the worktree (`git worktree remove f2-verify/mesh-f4`), re-add at the new SHA
under the same directory name, and nothing in the driver changes. If the
directory name must change, `drive3.ts` names it in exactly two adjacent places
— `const CHECKOUT` and the `import` literal directly below it (lines ~27-29).

## 2. Sandbox services (the orchestrator brings these up)

Four services in **one** sandbox, sharing one network stack so `127.0.0.1`
reaches all of them — the outbound peer URLs are loopback, which is the only
thing `validateOutboundPeerUrl` permits for `ws://`.

Each mesh service: image `oven/bun:1-alpine`, files `[{from:"f2-verify/mesh-f4",
to:"/src"}]`, a writable volume at `/work`, command
`sh -c "cp -r /src /work/<name> && cd /work/<name>/server && bun install && exec bun server.ts"`.

| service | `MESH_WS_PORT` | `MESH_ADMIN_PORT` | `MESH_ADMIN_TOKEN` | `MESH_DB_PATH` | `MESH_FILES_DIR` |
|---|---|---|---|---|---|
| `pod1` | `7432` | `7433` | `verify-admin-pod1` | `/work/pod1.db` | `/work/files-pod1` |
| `orch` | `7442` | `7443` | `verify-admin-orch` | `/work/orch.db` | `/work/files-orch` |
| `pod2` | `7452` | `7453` | `verify-admin-pod2` | `/work/pod2.db` | `/work/files-pod2` |

**`MESH_METRICS_IDENTITY_LABELS` must be UNSET** on all three (the default).
The driver reads the flag-off **aggregate** series
`mesh_peer_relays_total{direction="in",outcome="delivered",kind="topic"}` — that
label order is what `server/metrics.ts` renders — and its first assertion is
that zero identity labels appear in `/metrics`. Setting the flag invalidates
every metric key in the file.

The fourth service is the driver itself (same image, `f2-verify` mounted, a
`bun` command — see §3). Everything is reachable from this container as
`mesh-planner-sandbox:<port>`, so the driver can equally be run from here.

## 3. Running it

```bash
cd /home/coder/project/f2-verify
MESH_SERVER_URL= MESH_AGENT_ID= MESH_AGENT_TOKEN= MESH_HTTP_URL= \
  bun drive3.ts > run-f4-<sha>.jsonl 2> run-f4-<sha>.stderr
echo "exit=$?"
```

**Blanking the four `MESH_*` SDK variables is mandatory** — `MeshClient` falls
back to them, and in this container they name **production** (#100).

Overridable, all with the defaults in the table above:
`MESH_HOST` (default `mesh-planner-sandbox`), `MESH_ADMIN_TOKEN_POD1`,
`MESH_ADMIN_TOKEN_ORCH`, `MESH_ADMIN_TOKEN_POD2`.

**Exit code 0 only if every check passes.** Every step also carries a CONTROL —
the case that must NOT happen — and both readings are recorded.

## 4. Output

One JSON object per line on stdout (the drive2 convention):

- `{"probe":"check", …}` — one per assertion, with `kind` (`assert` |
  `control`), `expected`, `actual`, `pass`.
- `{"probe":"p13_mint" | "p14_registry" | "p15_hub_publish" | …}` — the
  observations each step recorded, whether or not they were asserted on.
- `{"probe":"SUMMARY", "verdict":"PASS"|"FAIL", "steps":[…]}` — last line.
- `{"probe":"FATAL", …}` — a step threw; everything after it was NOT DRIVEN.

Grade it the way `design/F2_DRIVE_PLAN.md` does: a match between prediction and
finding is shape-inherited and proves little; a MISS is the information. The
sandbox-not-production caveat travels next to each number, never in a footer.

## 5. Idempotency, and what the driver mutates

Peer aliases are FIXED (`pod1`, `pod2`, `orch`) because §16 A3's same-alias rule
binds the two tables on one mesh and P14 asserts the literal route
`GET /peers/pod1/subscriptions`. The sandbox DB persists across runs, so the
driver's first step **resets**: it deletes every agent whose id starts with
`f4-` (which purges that agent's subscriptions and ACL rows, and cascades away
any topic it created), deletes the outbound peerings for those three aliases,
and revokes their live peer keys (which deletes that alias's remote
subscriptions). Agent ids are additionally run-suffixed. It is safe to re-run.

Two mutations to know about:

- **P14** pauses and re-enables `pod1 → orch` for a few seconds to drive one
  input through two causes (§16 N). Rows and grants survive a pause.
- **P18b** connects a raw `PeerClient` to `pod2` as the alias `orch`, using the
  credential `orch`'s forwarder holds. That **evicts the forwarder's socket**
  (newer-wins); it reconnects. This is deliberately the LAST step — nothing
  after it depends on `orch → pod2` being continuously up.

## 6. Typecheck (no server needed)

```bash
cd /home/coder/project/f2-verify/mesh-f4/client
bunx tsc --noEmit --target ESNext --module ESNext --moduleResolution bundler \
  --allowImportingTsExtensions --strict --noImplicitAny --strictNullChecks \
  --noUncheckedIndexedAccess --exactOptionalPropertyTypes --noImplicitReturns \
  --noFallthroughCasesInSwitch --noUnusedLocals --noUnusedParameters \
  --skipLibCheck --types bun-types ../../drive3.ts
```

Those are the checkout's own `tsconfig.json` `compilerOptions`, passed on the
command line because the driver lives outside the client's `include` glob;
running from `mesh-f4/client` is what makes `bun-types` and `ws` resolve.
It exits 0 today.
