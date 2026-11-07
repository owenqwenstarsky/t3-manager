# Environment toolchains

Every environment runs the `t3-env` image. The image has the common languages preinstalled, with every supported version of each, plus their package managers and the usual CLIs. Agents and people can build and test most projects without installing anything first. Any other version or tool is one command away.

## What decides what's installed

Everything is data in [`images/t3-env/toolchains/`](../images/t3-env/toolchains):

| File | What it controls |
| --- | --- |
| `versions/<tool>.txt` | Versions of node, python, java, gradle, go and ruby (installed with [mise](https://mise.jdx.dev)). **The first line is the default.** |
| `mise/tools.toml` | Global tools from mise: bun, deno, pnpm, yarn, uv, maven, kotlin, gh, glab, protoc, … Any name from `mise registry` works. |
| `mise/config.toml` | mise settings: which version files are honoured, trust, auto-install. |
| `rust.conf` | rustup toolchains (first is default), components, extra targets. |
| `php.conf` | PHP versions (packages.sury.org; first is `php`) and extensions. |
| `llvm.conf` | Clang/LLVM versions (apt.llvm.org; first is `clang`). |
| `apt-packages.txt` | Debian packages: CLIs, database clients, C/C++ build tools. |
| `cargo-tools.txt`, `go-tools.txt`, `uv-tools.txt` | CLIs built or installed with cargo-binstall, `go install` and `uv tool install`. |

To add a version, add a line, rebuild (`docker compose build t3-env-image` in `deploy/`), then press **Update** on the Environments page. Each language has its own image layer, so changing one list rebuilds only that layer and the ones after it.

`TOOLCHAINS=minimal` (in `.env`, or as a build arg) installs only the first line of every list. It uses the same scripts, so CI builds it to keep the Dockerfile tested. The full image is roughly 10–13 GB.

The build calls GitHub's release API through mise and cargo-binstall. If a build hits GitHub's anonymous rate limit, pass a token as a build secret:

```bash
GITHUB_TOKEN=ghp_... docker build --secret id=github_token,env=GITHUB_TOKEN -t t3-env:latest images/t3-env
```

## Layout inside the image

| Path | What | Owner |
| --- | --- | --- |
| `/usr/local/share/mise/installs` | Preinstalled mise versions (mise's system install dir) | dev |
| `/etc/mise/config.toml`, `/etc/mise/conf.d/` | System defaults (one file per language, written at build time) | root |
| `/opt/rust/rustup`, `/opt/rust/cargo/bin` | rustup toolchains and the cargo/rustc proxies plus prebuilt cargo tools | dev |
| `/opt/t3m/bin` | Go and Python CLIs (`go install`, `uv tool install`) | root |
| `/opt/t3m/node` | The Node that T3, Claude Code and Codex run on (wrappers in `/usr/local/bin`) | root |
| `/opt/ms-playwright` | Chromium for Playwright; `/usr/local/bin/chromium` points at it | dev |
| `/usr/local/share/t3m/TOOLS.md`, `toolchains.json` | What's installed, generated at the end of the build | root |

The preinstalled toolchains belong to `dev`, so `npm i -g`, `gem install`, `pip install` and `rustup component add` work as on a personal machine. Those changes live in the container, so they're lost when the environment is updated to a new image.

Things `dev` installs on demand go in the home volume (`/home/dev`) and survive updates:
- `mise use node@18` → `~/.local/share/mise`
- `cargo install` → `~/.cargo`
- `go install` → `~/go`
- `pip install --user` → `~/.local`

`PATH` puts these first, then the mise shims, rustup and the system.

## How versions are chosen

mise resolves each command through its shims, and that works in non-interactive shells too, which is how agents run commands. For each tool, the first match wins:
1. a repo's `mise.toml` / `.tool-versions`, or the idiomatic files `.nvmrc`, `.node-version`, `.python-version`, `.ruby-version`, `.java-version`, `.go-version`
2. `~/.config/mise/config.toml` (`mise use -g`)
3. the system defaults in `/etc/mise/conf.d/`

A version that isn't installed yet is installed on first use (`not_found_auto_install`). Python has every preinstalled version active, so `python3.11` … `python3.15` exist for tox and nox. Rust follows `rust-toolchain.toml` and `cargo +nightly`. PHP versions are side by side as `php8.3` and so on; `update-alternatives` picks `php`.

Interactive shells also run `mise activate` and `direnv hook`, so `JAVA_HOME`, `GOROOT` and similar follow the repo you `cd` into.

## Agents

At every start, `lib/agent-guidance.sh` copies `TOOLS.md` into a managed block in `~/.claude/CLAUDE.md` and `~/.codex/AGENTS.md`. Content outside the markers is left alone. That way Claude Code and Codex know what's installed, how to switch versions, and that Docker isn't available, instead of trying to install toolchains or start containers.

T3, Claude Code and Codex run on `/opt/t3m/node`, a Node pinned by the `AGENT_NODE` build arg. A repo that wants Node 18 can't break them.

## Updating environments

An environment keeps running the image it was created from. After a rebuild, the dashboard shows **Update available** on each older environment. **Update** then:
1. stops the container and renames it `t3-env-<name>-previous`
2. creates a new one on the current image with the same name, hostname, volumes, proxy key and git setup, and starts it
3. removes the old container

If anything fails, the new container is removed and the old one is renamed back and restarted.

## Not included

There's no Docker daemon or CLI, and containers stay unprivileged. .NET, Elixir/Erlang, Zig, Scala, Haskell, Flutter/Android and cloud CLIs (kubectl, helm, terraform, aws, gcloud, az) aren't preinstalled. Each is `mise use -g <tool>` away, or can be added to `mise/tools.toml` for everyone.

## Testing

`images/t3-env/test/smoke.sh` is baked into the image:

```bash
docker run --rm --user dev --entrypoint /usr/local/lib/t3m/smoke.sh -e SMOKE_NETWORK=1 t3-env:latest
```

It checks the following, and `SMOKE_NETWORK=1` adds on-demand installs:
- that every CLI is present
- that every preinstalled version runs
- that version files switch versions
- that the agents survive a Node switch
- that hello-world builds work in every language
