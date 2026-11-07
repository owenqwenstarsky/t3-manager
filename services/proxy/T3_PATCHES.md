# T3 Manager changes to CLIProxyAPI

`services/proxy` is a `git subtree` of
[router-for-me/CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI).
Keep this list current. Everything here is designed to survive
`git subtree pull` with few or no conflicts.

## Changed upstream files

| File | Change |
| --- | --- |
| `cmd/server/main.go` | One line after `serverOptions := []api.ServerOption(nil)`: `serverOptions = append(serverOptions, t3extServerOptions()...)`. |

If an upstream update conflicts here, re-add that line wherever `serverOptions`
is built before the service starts.

## New files (no upstream equivalent)

| Path | Purpose |
| --- | --- |
| `cmd/server/t3ext_hook.go` | Bridges `main` to `t3ext.ServerOptions()`. |
| `sdk/auth/t3_codex_device.go` | Exposes the existing Codex device-code flow in two steps (`RequestCodexDeviceCode`, `CompleteCodexDeviceLogin`) plus `SaveLoginRecord`. It only calls unexported helpers from `codex_device.go`; if upstream renames them, fix the calls here. |
| `t3ext/` | Usage analytics store and the `/t3/v1` API (see below). |
| `t3ext/docker-entrypoint.sh`, `Dockerfile.t3` | Container image used by `deploy/docker-compose.yml`. |

## t3ext

- **Usage capture.** `t3ext` registers a `sdk/cliproxy/usage` plugin in
  `init()`. Each upstream attempt becomes an event with these fields:
  - client key fingerprint (first 16 hex characters of its SHA-256; the key itself is never stored)
  - provider, account (auth id), model
  - tokens: uncached input, output (including reasoning), reasoning, cache read, cache write and total, normalized from upstream's `TokenBreakdown`
  - latency and time to first token
  - status and failure code
- **Storage.** A bbolt database at `$T3EXT_DATA_DIR/usage.db` holds:
  - raw events (default 45 days, `T3EXT_EVENT_RETENTION_DAYS`)
  - hourly rollups for common dimension combinations (default 800 days, `T3EXT_HOURLY_RETENTION_DAYS`), each with a latency histogram for p50/p95
- **Queries** mix rollups for whole hours with raw events for partial hours,
  so totals are exact at any window boundary.
- **API.** All routes require `Authorization: Bearer $MANAGEMENT_PASSWORD`, except `health`.
  - `GET /t3/v1/health`
  - `GET /t3/v1/usage/summary?from&to&<dim>=<value>`: totals, previous-period comparison, and breakdowns by key, account, model and provider
  - `GET /t3/v1/usage/timeseries?from&to&step&tz&group=a,b&<dim>=<value>&limit`: zero-filled series, top-N plus "other"
  - `GET /t3/v1/usage/windows?dim=account|key|model|provider`: rolling 1h, 5h, 24h, 7d and 30d windows
  - `GET /t3/v1/usage/events?before&limit&failed&<dim>=<value>`: request log, newest first
  - `GET /t3/v1/usage/live`: the last 60 minutes per minute
  - `GET /t3/v1/usage/export.csv`
  - `GET|PUT|DELETE /t3/v1/keys/:fingerprint`: labels keys with the T3 environment name. `PUT` accepts `{"api_key": "..."}` to fingerprint server-side.
  - `POST /t3/v1/oauth/codex-device`, `GET|DELETE /t3/v1/oauth/codex-device/:id`: ChatGPT sign-in by device code, no redirect pasting
  - Dimensions are `key`, `account`, `model` and `provider`. Steps are `minute`, `5m`, `15m`, `hour`, `6h`, `day` and `week`. `tz` is in minutes east of UTC and aligns day and week buckets; weeks start on Monday.
- **Off switch.** Set `T3EXT_ENABLED=false` to turn t3ext off entirely.

## Updating from upstream

```bash
git subtree pull --prefix services/proxy https://github.com/router-for-me/CLIProxyAPI.git main --squash
cd services/proxy && go build ./cmd/server && go test ./t3ext/ ./sdk/auth/
```
