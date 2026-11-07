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

## Subscription limits (`services/proxy/t3ext/limits.go`)

Token counts say what an account *served*. The 5-hour and weekly limits are
the provider's own numbers, so `t3ext` reads them from the provider:

- **Live check.** It calls the same usage endpoint each provider's CLI uses
  (Anthropic `/api/oauth/usage`, ChatGPT `/backend-api/wham/usage`) with the
  account's own token.
- **Caching.** Each account is checked at most every 5 minutes, and requests in
  flight are shared. That keeps the dashboard from creating provider traffic or
  tripping their rate limits.
- **Passive updates.** Every proxied response carries rate-limit headers, which
  upstream already records. When those are newer than the cached check, they
  replace the 5-hour and weekly numbers, so values stay current between checks
  at no cost. If a live check fails, the headers alone are shown, with the
  error.
- **After a reset.** If a window's reset time has passed since the last
  reading, the dashboard shows it as full again.

## Git setup (`apps/dashboard/server/git.ts`)

The dashboard keeps git tokens (one per `host[:port]`) and an author template
in its settings file. The API only ever returns hosts. On every change, on
environment creation and on dashboard start, it writes three files into each
environment container through the Docker archive API. That works whether the
container is running or stopped:

| File | Owner, mode | Purpose |
| --- | --- | --- |
| `/etc/gitconfig` | root, 0644 | System-scope `user.name`/`user.email` from the template, and `credential.helper` |
| `/etc/t3m-git/credential-helper` | root, 0755 | Answers git's `get` with the token for an exact host, over HTTPS (also HTTP when that server allows it). Ignores `store`/`erase`, so a failed push can't delete it |
| `/etc/t3m-git/credentials` | root:dev, 0640 | `host<TAB>username<TAB>token<TAB>https\|any` |

After writing them, the dashboard sets the token file's owner by name
(`root:dev`) inside each running container. It then runs
`git credential fill` as `dev` with prompts disabled, which is what a clone
does, and reports per environment and server whether git got a token (the
token itself never leaves the container). When the helper declines, it says
why on stderr, and git shows that in the clone error.

Using system scope leaves `~/.gitconfig` to the person. The author shows on
each environment card ("commits as …").

## Environment image and toolchains (`images/t3-env`)

The image is `buildpack-deps:trixie` plus every supported version of Node,
Python, Java, Go, Ruby, PHP, Rust and Clang, with their package managers.
Versions are managed by mise (system installs) and rustup. The lists of what
gets installed are plain files in `toolchains/`, so changing them doesn't
touch the Dockerfile. See [toolchains.md](toolchains.md).

The build ends by writing `/usr/local/share/t3m/toolchains.json`. The
dashboard reads it from the image through a created-but-never-started
container and the archive API, caches it per image id, and shows it in
**Settings → Environment tools**. Each environment summary compares the
container's image id with the current image's, which drives **Update
available**. `envs.update` swaps the container and keeps the volumes, and it
rolls back if the new container fails to start.

## Proxy fork policy

`services/proxy` is a squashed `git subtree` of upstream. Changes are new
files plus one line in `cmd/server/main.go`, so `git subtree pull` stays
clean. See `services/proxy/T3_PATCHES.md`.
