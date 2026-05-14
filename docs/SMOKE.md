<!-- SPDX-License-Identifier: Apache-2.0 -->

# Smoke Scripts

Loomwiki ships runnable smoke scripts for milestone acceptance. They are not
wired to CI (wrangler dev requires authenticated bindings); run them manually
against a local or staging deployment to capture the operator-facing evidence
required by each milestone.

---

## M2 — chat round trip

**Script:** [`scripts/smoke-m2.ts`](../scripts/smoke-m2.ts)

**Source issue:** [#17](https://github.com/schmug/loomwiki/issues/17)

Captures the two operator-facing M2 verification artifacts from SPEC §9:

1. **Sub-500ms two-client round-trip latency** — opens two WebSocket
   connections to the `ChatRoom` Durable Object (`GET /api/rooms/:rid/ws`),
   sends a sentinel message from client 1, and measures the elapsed time until
   client 2 receives the echo. The hard gate is 500 ms (the SPEC §9 target is
   200 ms on a healthy LAN; 500 ms accommodates slow dev CPUs).

2. **Zero `wrangler tail` events during a 60 s idle window** — after the
   round-trip test both sockets are closed and `wrangler tail --format=json`
   is monitored for 60 seconds. Zero output confirms the Hibernation API
   (`ctx.acceptWebSocket`) is active and the isolate is **not** kept warm
   between messages.

### Prerequisites

```sh
# 1. Create apps/worker/.dev.vars (script will generate a starter if absent):
#    ALLOW_LOCAL_DEV_AUTH=true
#    BYOK_ENCRYPTION_KEY="dev-only-32-byte-key-change-me!!"

# 2. Start the local dev server (port 8788):
pnpm dev

# 3. (Optional) Apply local D1 migrations if this is a fresh checkout:
pnpm migrate:local
```

### Running

```sh
# Default — connects to http://localhost:8788
pnpm smoke:m2

# Custom base URL
pnpm smoke:m2 -- --base-url http://localhost:8788

# Override test identities
SMOKE_EMAIL_1=alice@example.com SMOKE_EMAIL_2=bob@example.com pnpm smoke:m2
```

All flags and environment variables:

| Variable / flag         | Default                        | Purpose                          |
| ----------------------- | ------------------------------ | -------------------------------- |
| `--base-url <url>`      | `http://localhost:8788`        | Worker base URL                  |
| `SMOKE_BASE_URL`        | `http://localhost:8788`        | Alternative to `--base-url`      |
| `SMOKE_EMAIL_1`         | `smoke-client1@local.test`     | Dev email for WS client 1        |
| `SMOKE_EMAIL_2`         | `smoke-client2@local.test`     | Dev email for WS client 2        |
| `SMOKE_ROOM_SLUG`       | `smoke-m2`                     | Room slug (created if absent)    |
| `SMOKE_ROOM_NAME`       | `Smoke M2`                     | Room display name (create only)  |

### Exit codes

| Code | Meaning                                                        |
| ---- | -------------------------------------------------------------- |
| `0`  | All checks passed; prints observed RTT and hibernation result  |
| `1`  | Check failed; reason printed to stderr                         |
| `2`  | Prerequisite missing (e.g. worker unreachable)                 |

### Example output

```
Loomwiki M2 smoke @ http://localhost:8788
  Email 1 : smoke-client1@local.test
  Email 2 : smoke-client2@local.test
  Room    : smoke-m2
  RTT gate: 500ms
  Idle    : 60s

[17:04:01.123] ✓ [   12ms] worker liveness check
[17:04:01.140] ✓ [   18ms] /api/me (client 1)
[17:04:01.145] ✓ [    5ms] /api/me (client 2)
[17:04:01.160] ✓ [   15ms] ensure room "smoke-m2"
[17:04:01.320] ✓ [  160ms] WS round-trip (two clients)
  Round-trip: 48ms (gate: 500ms)
[17:05:01.900] ✓ [ 60580ms] hibernation idle check (60s)
  wrangler tail output lines during idle: 0

Smoke M2 PASSED. Round-trip: 48ms (gate 500ms). Hibernation: zero tail events in 60s idle.
```

### How it works

1. **`.dev.vars` bootstrap** — if `apps/worker/.dev.vars` is absent, the script
   writes a starter file with `ALLOW_LOCAL_DEV_AUTH=true` and warns you to
   restart `wrangler dev`. If the file already exists, it warns and continues
   using it as-is.

2. **Worker liveness** — `GET /api/health`; exits with an actionable message if
   the worker is unreachable.

3. **User + workspace bootstrap** — calls `GET /api/me` for both test emails;
   the auth middleware JIT-provisions both users and the shared workspace.

4. **Room bootstrap** — lists rooms and reuses the smoke room if it already
   exists, or creates it.

5. **Round-trip test** — both WebSocket connections authenticate via the
   `?devEmail=` query parameter (the browser `WebSocket` constructor cannot
   carry custom headers; `ALLOW_LOCAL_DEV_AUTH` + loopback IP gate this).
   A timestamped sentinel string is sent from client 1; client 2 listens for
   any frame containing the sentinel and measures elapsed milliseconds.

6. **Hibernation check** — spawns `wrangler tail --format=json` as a
   subprocess, waits 60 s with all sockets closed, then asserts zero output
   lines. If `wrangler` is not in `PATH` the check is skipped with a warning
   rather than failing the whole run.

---

## M7 — live end-to-end

**Script:** [`scripts/smoke-live.ts`](../scripts/smoke-live.ts)

Walks the full M7 happy path against a deployed worker (bootstrap → seed →
ingest → proposal → merge → wiki page → digest). Requires a Cloudflare Access
service token; see the script header for environment variables.
