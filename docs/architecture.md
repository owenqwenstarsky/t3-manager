# Architecture

## Why these pieces

**One container per environment.** Each person gets an isolated home
directory, a tailnet identity and a T3 Code server. T3's own auth (pairing
tokens, revocable sessions) controls who can use it. The dashboard drives T3
through its CLI, inside the container with `docker exec`:

| Action | Command |
| --- | --- |
| Pair link | `t3 auth pairing create --base-url https://<node> --json` |
| List devices | `t3 auth session list --json` |
| Revoke a device | `t3 auth session revoke` |

**Tailscale in userspace mode.** It needs no TUN device and no
capabilities, which avoids most Docker-in-LXC problems. Inbound traffic to the
node (including Tailscale Serve) works. Outbound traffic from an environment to
other tailnet hosts does not go through the tailnet; containers reach the
internet through normal Docker networking.

**Tailscale Serve for HTTPS.** T3's hosted web app (app.t3.codes) only
connects to HTTPS backends, and the mobile app expects HTTPS too. Serve gives each
node a certificate for `<node>.<tailnet>.ts.net` and proxies to T3 on loopback,
so T3 never listens on a network interface.

**One shared model proxy.** CLIProxyAPI turns subscription OAuth accounts into
Anthropic- and OpenAI-compatible endpoints and spreads load across accounts.
T3 Code treats a non-Anthropic `ANTHROPIC_BASE_URL` as an authenticated custom
endpoint, and a Codex `model_provider` with `requires_openai_auth = false` as
ready. So environments need no per-user login.

## Data flow for one request

1. The agent (Claude Code or Codex) in `t3-env-alice` calls
   `http://proxy:8317/v1/messages` or `http://proxy:8317/v1/responses` with
   alice's key.
2. The proxy authenticates the key, picks an account (round-robin or
   fill-first) and forwards the request upstream.
3. Upstream's usage hook emits a record. `t3ext` normalizes the tokens and
   queues the event, and a writer commits batches to `usage.db` (raw event plus
   hourly rollups per dimension combination).
4. The dashboard asks `t3ext` for time series grouped by `[dimension, model]`,
   prices each model's tokens and collapses to the requested grouping.

## Usage store (`services/proxy/t3ext`)

- **Raw events.** Key: big-endian timestamp + request id. Default retention is
  45 days. Used for minute-level charts, the request log, CSV export, live view
  and unusual filter combinations.
- **Hourly rollups.** One row per hour × dimension combination × values:
  - totals
  - key, account, model and provider
  - key×model, account×model, account×key and model×provider

  Each row holds additive counters and a 12-bucket latency histogram for
  p50/p95. Default retention is 800 days.
- **Exact window edges.** A query uses rollups for whole hours and raw events
  for the partial hours at either end, so totals stay exact at any window
  boundary.
- **Token normalization.** Input is *uncached* input. Output includes reasoning.
  Cache read and cache write are separate. This holds for every provider and
  makes cost a simple dot product with the price table.

## Proxy fork policy

`services/proxy` is a squashed `git subtree` of upstream. Changes are new
files plus one line in `cmd/server/main.go`, so `git subtree pull` stays
clean. See `services/proxy/T3_PATCHES.md`.
