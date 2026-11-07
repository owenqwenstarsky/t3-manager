# T3 Manager

Self-hosted control panel for handing out [T3 Code](https://github.com/pingdotgg/t3code)
environments over Tailscale.

- **Environments.** Each person gets a T3 Code server in its own Docker container.
  It joins your tailnet on its own (`t3-alice.your-tailnet.ts.net`) and is
  published over Tailscale HTTPS. A **Get pair link** button gives you a QR code
  and links for the T3 mobile app, app.t3.codes and the desktop app.
- **One model proxy for everyone.** Claude Code and Codex in every environment
  are preconfigured to use a bundled fork of
  [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI). You add Claude and
  ChatGPT subscription accounts once in the dashboard, and nobody signs in inside
  their environment.
- **Usage analytics.** Every request is recorded with:
  - environment, account and model
  - tokens: input, cache read, cache write, output, reasoning
  - latency and time to first token
  - status

  The dashboard charts this over any time range, with estimated cost,
  breakdowns, comparison with the previous period, a request log and CSV export.

```
Proxmox CT (Docker)
├── dashboard   tailnet node "t3-manager" ─ HTTPS ─ you
│   └─ drives Docker, the proxy's management API, and each environment
├── proxy       internal only (t3-net), pools Claude / ChatGPT accounts, records usage
└── t3-env-<name> × N
    ├─ tailscaled (userspace) → node "t3-<name>", Tailscale Serve :443 → T3 Code
    ├─ t3 serve (user dev, loopback)
    └─ Claude Code + Codex → http://proxy:8317 with a per-environment key
```

## 1. One-time tailnet setup

In the [Tailscale admin console](https://login.tailscale.com/admin):

1. **DNS:** enable **MagicDNS** and **HTTPS Certificates**. T3's hosted app and
   mobile pairing need HTTPS, which Tailscale Serve provides.
2. **Access controls:** add a tag for the machines and let people reach them on
   443. Adapt this to your policy:

   ```jsonc
   "tagOwners": { "tag:t3": ["autogroup:admin"] },
   "grants": [
     { "src": ["autogroup:member"], "dst": ["tag:t3"], "ip": ["tcp:443"] }
   ]
   ```

3. **Keys:** generate an auth key that is **reusable**, **pre-approved** and
   **tagged** `tag:t3`, and **not ephemeral** (an ephemeral node disappears when its
   container stops). New environments then join with no manual step. Without a
   key, each new environment card shows a Tailscale login link instead.

## 2. Host (Proxmox CT)

- Docker inside an LXC container needs **nesting** turned on (and `keyctl=1` for
  an unprivileged CT).
- Nothing Tailscale-specific is needed on the host. Every container runs
  Tailscale in userspace mode, so no `/dev/net/tun` and no `NET_ADMIN`.

## 3. Run it

```bash
git clone https://github.com/owenqwenstarsky/t3-manager.git
```

```bash
cd t3-manager/deploy && cp .env.example .env
```

Edit `.env` and set:

- `ADMIN_PASSWORD`
- `PROXY_MANAGEMENT_PASSWORD` (`openssl rand -hex 32`)
- `TS_AUTHKEY`

Then:

```bash
docker compose up -d --build
```

This builds three images: the proxy, the dashboard, and `t3-env:latest`, which
every environment runs. The `t3-env-image` service only exists to build that
image, so it exits right away.

`t3-env` ships every common toolchain (see [Inside an environment](#inside-an-environment)),
so it is big: about 10–13 GB, and 30–60 minutes for the first build. Docker
stores it once on the host, not once per environment. Set `TOOLCHAINS=minimal`
in `.env` for one version of each language instead. Once the stack is up, the dashboard is at
`https://t3-manager.<your-tailnet>.ts.net` and `http://<host>:8080`.

## 4. Use it

1. **Accounts → Add Claude account / Add ChatGPT account.**
   - ChatGPT uses a device code: open the link, type the code, done.
   - Claude opens its sign-in page. Afterwards, paste the `localhost` address
     your browser lands on into the box. It submits on paste.
2. **Environments → New environment.** Enter a name (and optionally who it's
   for). The card moves through *Starting → Joining tailnet → Ready*.
3. **Get pair link.** The person scans the QR code with the T3 Code app, or opens
   the link. Each link works once and expires (15 minutes by default). Revoke
   devices under **⋯ → Paired devices**.
   Each account shows how much of its **5-hour and weekly limits** is left and
   when each resets (plus Opus/Sonnet or other extra windows where the
   provider reports them). The proxy asks Anthropic/OpenAI at most every 5
   minutes per account and updates the numbers from every request in between.
   **⋯ → Check limits now** forces a fresh check.
4. **Settings → Git** (optional).
   - **Credentials:** add an HTTPS token for each git server (github.com,
     gitlab.com, your own host). There's one token per server. After saving
     you can only replace or remove it, not view it. For a server without
     HTTPS (say a LAN Gitea at `http://10.0.0.5:3000`), enter its `http://`
     address or turn on **Allow plain HTTP**. The token is then sent
     unencrypted to that server only.
   - **Commit author:** set an author template (default `{env} (T3) <{env}@t3.invalid>`)
     so every commit shows which environment made it.
   - **Delivery:** both are pushed into every environment, existing and new,
     as soon as you save.
5. **Usage.** Pick a range (1H … 1Y, or custom), an interval, a grouping
   (environment / account / model / provider) and a metric (cost / tokens /
   requests). Select a breakdown row to filter by it.

Cost is an **estimate at API list prices** (edit them in **Settings →
Pricing**). Subscription accounts aren't billed per token, so read it as
API-equivalent value. OpenAI/Codex models ship without a price, so the dashboard
doesn't invent one; add a rule to include them.

## Operations

| Task | How |
| --- | --- |
| Update everything | `git pull && docker compose up -d --build`, then **Update** on the Environments page to move environments onto the new image (home files, paired devices and the tailnet address stay; if the new image fails to start, the environment is put back on the old one) |
| Give every agent the same instructions | **Settings → Agent instructions**: markdown added to `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md` in every environment (between `t3-manager instructions` markers), applied right away to running ones |
| Change the preinstalled tools | Edit the lists in `images/t3-env/toolchains/` and rebuild. See [`docs/toolchains.md`](docs/toolchains.md) |
| Pin versions | `T3_VERSION`, `CLAUDE_CODE_VERSION`, `CODEX_VERSION` in `.env` |
| Update the proxy from upstream | see [`services/proxy/T3_PATCHES.md`](services/proxy/T3_PATCHES.md) |
| Environment files | Docker volumes `t3env-<name>-home` (`/home/dev`) and `t3env-<name>-ts` (tailnet identity). **Delete → Also delete its files** removes them. |
| Usage retention | `USAGE_EVENT_RETENTION_DAYS` (request log, default 45), `USAGE_HOURLY_RETENTION_DAYS` (charts, default 800) |
| Back up | volumes `t3-manager_proxy-data` (accounts, usage, keys) and `t3-manager_dashboard-data` (settings) |

### Inside an environment

Every environment has these preinstalled. **Settings → Environment tools** lists the exact versions in your image:

| | Preinstalled (default first) | With |
| --- | --- | --- |
| Node.js | 24, 22, 26 | npm, pnpm, yarn 1, bun, deno, tsx, typescript, prettier, eslint |
| Python | 3.14, 3.11, 3.12, 3.13, 3.15 (each also as `python3.X`) | pip, uv, pipx, poetry, pdm, hatch, ruff, black, pre-commit |
| Java (Temurin) | 21, 8, 11, 17, 25 | Maven, Gradle 9 and 8, Kotlin |
| Go | 1.27, 1.26 | gopls, golangci-lint, staticcheck, dlv, air |
| Rust | stable, beta, nightly (wasm and musl targets) | clippy, rustfmt, rust-analyzer, cargo-nextest, cargo-watch, cargo-edit, sccache, wasm-pack, trunk |
| Ruby | 3.4, 3.3, 4.0 | gem, bundler |
| PHP | 8.4, 8.3, 8.5 | composer, common extensions |
| C / C++ | gcc 14, clang 23 and 22 | cmake, ninja, meson, ccache, mold, gdb, lldb, valgrind |

Also git, gh, glab, tea, lazygit, ripgrep, fd, fzf, jq, yq, tmux, protoc, buf,
shellcheck, the psql/mariadb/redis/mongosh/sqlite3 clients and headless
Chromium. There is **no Docker** inside environments.

- Versions follow the repo: `.nvmrc`, `.python-version`, `.ruby-version`,
  `.java-version`, `.tool-versions`, `mise.toml`, `rust-toolchain.toml`.
  `mise use node@22` pins one for a repo.
- Any other version installs on first use, e.g. `mise use node@18`. So do
  other tools, e.g. `mise use -g kubectl`. These installs are kept in the home
  volume, so they survive updates.
- Claude Code and Codex get the same list (in `~/.claude/CLAUDE.md` and
  `~/.codex/AGENTS.md`, between `t3-manager tools` markers), so they use what's
  there instead of installing toolchains. T3, Claude Code and Codex run on
  their own Node, so changing the project's Node version can't break them.
- People work as `dev` and have passwordless `sudo`, for `apt install` and the like.
- Projects go in `/home/dev/workspace` (persistent).
- T3's in-app browser needs `sudo t3 browser setup` once in the T3 terminal.
- Git uses the dashboard's settings through `/etc/gitconfig` (system scope).
  People can still override them in `~/.gitconfig` or per repository. Tokens
  are only given out for the exact server they were saved for, and only over
  HTTPS unless plain HTTP is allowed for that server.
- Claude Code reads `~/.claude/settings.json` and Codex reads `~/.codex/config.toml`.
  The entrypoint rewrites only the proxy keys in those files at each start.

## Security notes

- Each environment has its own proxy key. Deleting the environment revokes it.
  The proxy treats an empty key list as "no auth", so it always keeps a reserved
  key and the dashboard never removes the last one.
- The proxy publishes no ports. Its management API is reachable only on the
  internal `t3-net` network and requires `PROXY_MANAGEMENT_PASSWORD`.
- The dashboard controls Docker through its socket, which amounts to root on the
  host. Keep it behind `ADMIN_PASSWORD` and your tailnet, or set
  `DASHBOARD_BIND=127.0.0.1`.
- Auth keys are handed to containers as files, deleted after joining, and never
  set as environment variables.
- Git tokens are shared by every environment, and anyone with an environment
  can read them (they have `sudo`). Use tokens limited to the repositories and
  permissions people should have.
- Environments share the model accounts. Anyone with an environment can spend
  from them; the Usage page shows who did.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Card says **HTTPS not available** | Enable HTTPS Certificates for the tailnet (step 1), then **Restart** the environment |
| Card says **Needs tailnet login** | Click **Log in to Tailscale**, or save an auth key in Settings for next time |
| Claude Code / Codex say they can't reach the model | **Accounts** needs at least one active account for that provider. Check **Usage → Recent requests → Failed** |
| Clone fails with `could not read Username … terminal prompts disabled` | Look for a `t3-manager:` line just above it in the error. It names the cause: no token saved for that server, token is HTTPS-only (turn on **Allow plain HTTP** for an `http://` server), or the token file isn't readable. **Settings → Git → Apply and check** rewrites the files in every environment and checks, as the `dev` user, that git gets each token. |
| **Image t3-env:latest is not built** | `docker compose up -d --build` in `deploy/` |

## Repository layout

| Path | What |
| --- | --- |
| `apps/dashboard` | Dashboard: Hono + dockerode server, React + Recharts UI |
| `services/proxy` | CLIProxyAPI subtree + `t3ext` (usage analytics, key labels, Codex device login) |
| `images/t3-env` | The per-environment image; `toolchains/` lists what it installs |
| `deploy` | Compose file and `.env.example` |
| `docs/architecture.md` | How the pieces fit and why |

## Development

```bash
pnpm install
```

```bash
pnpm --filter @t3m/dashboard test
```

```bash
cd services/proxy && go test ./t3ext/ && go build ./cmd/server
```

To run the dashboard against a local proxy, set `PROXY_URL=http://127.0.0.1:8317`,
`PROXY_MANAGEMENT_PASSWORD`, `ADMIN_PASSWORD` and `DATA_DIR`, then start
`pnpm --filter @t3m/dashboard dev`. The UI is on :5173 and the API on :8080.
