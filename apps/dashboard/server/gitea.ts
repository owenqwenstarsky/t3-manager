/**
 * Gitea CLI (`gt`) setup pushed into every environment: the Gitea servers set
 * in the dashboard, logged in for the dev user.
 *
 * gt has no system-wide config: logins live in ~/.config/gitea-cli. So the
 * dashboard writes the server list to /etc and a script that asks gt itself
 * to log in to each one (see envs.syncGitea and the image's entrypoint). gt
 * writes its own files, logins added by hand with `gt auth login` are kept,
 * and every sync checks each token against its server.
 *
 * Files written into each container:
 *   /etc/t3m-gitea/servers   url<TAB>token<TAB>default|-, root:dev 0640
 *   /etc/t3m-gitea/sync      the login script, run as dev
 * In dev's home, the script keeps ~/.config/gitea-cli/.t3m-managed: the URLs
 * it logged in to, so servers removed from the dashboard are logged out.
 */
import { DEV_GID, validateGitToken } from "./git.js";

export interface GiteaServer {
  /** Instance URL as gt keys it: http(s)://host[:port][/base-path], no trailing slash. */
  url: string;
  token: string;
  /** gt's default_host: the instance used when no --host or repository picks one. */
  isDefault?: boolean;
  updatedAt: number;
}

export const GITEA_DIR = "/etc/t3m-gitea";
export const GITEA_SERVERS_FILE = `${GITEA_DIR}/servers`;
export const GITEA_SYNC_FILE = `${GITEA_DIR}/sync`;

/**
 * Normalizes what someone types as a server address to the instance URL gt
 * uses as its key (same rules as gt's NormalizeHost). A bare host gets https.
 */
export function normalizeGiteaUrl(input: string): { url: string } | { error: string } {
  let s = input.trim();
  if (!s) return { error: "Enter the server's address, like https://gitea.example.com" };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^https?:\/\//i.test(s)) {
    return { error: "gt talks to Gitea over HTTP(S). Enter the address you open in a browser, like https://gitea.example.com" };
  }
  if (/^[^/\s]+@[^/\s]+:/.test(s)) return { error: "Enter the server's web address, like https://gitea.example.com, not an SSH remote" };
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { error: "That address isn't a valid URL" };
  }
  if (u.username || u.password) return { error: "Leave the username out of the address; the token is enough" };
  if (u.search || u.hash || s.endsWith("?") || s.endsWith("#")) return { error: "Leave the ?query and #fragment out of the address" };
  if (!u.hostname) return { error: "That address has no server name" };
  const segments: string[] = [];
  for (const seg of u.pathname.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === ".." || !/^[A-Za-z0-9._~-]+$/.test(seg)) return { error: "The address's path can only use letters, digits and . _ ~ -" };
    segments.push(seg);
  }
  // Paths a person may paste from the browser are not part of the instance URL.
  const path = segments.length ? `/${segments.join("/")}` : "";
  // URL already lowercases the host and drops the default port for the scheme.
  return { url: `${u.protocol}//${u.host}${path}` };
}

export const validateGiteaToken = validateGitToken;

export function renderGiteaServers(servers: GiteaServer[]): string {
  return servers
    .slice()
    .sort((a, b) => a.url.localeCompare(b.url))
    .map((s) => `${s.url}\t${s.token}\t${s.isDefault ? "default" : "-"}\n`)
    .join("");
}

/**
 * Runs as dev (also at every container start, from the image's entrypoint).
 * Prints one line per event, never a token:
 *   ok URL | fail URL detail | removed URL | warn detail | skip detail
 * A failed login keeps whatever login gt already had for that server.
 */
export const GITEA_SYNC_SCRIPT = `#!/bin/sh
# Managed by T3 Manager: logs gt (the Gitea CLI) in to the Gitea servers set in
# the dashboard (Settings > Gitea CLI). Logins added with \`gt auth login\` are kept.
servers=${GITEA_SERVERS_FILE}
cfg=\${GITEA_CLI_CONFIG_DIR:-\${XDG_CONFIG_HOME:-$HOME/.config}/gitea-cli}
marker=$cfg/.t3m-managed
if ! command -v gt >/dev/null 2>&1; then
  echo "skip gt isn't installed in this environment. Update it to the current image."
  exit 0
fi
if [ ! -r "$servers" ]; then
  echo "skip $servers can't be read as $(id -un)"
  exit 0
fi
mkdir -p "$cfg" && chmod 700 "$cfg" || exit 1
if command -v flock >/dev/null 2>&1; then
  exec 9>"$cfg/.t3m-lock"
  flock -w 90 9 || { echo "skip another gt sync is still running"; exit 0; }
fi
tab=$(printf '\\t')
default=
while IFS="$tab" read -r url token def; do
  [ -n "$url" ] || continue
  [ "$def" = default ] && default=$url
  if out=$(printf '%s\\n' "$token" | gt auth login --host "$url" --with-token --credential-store file --yes --no-input 2>&1); then
    echo "ok $url"
  else
    echo "fail $url $(printf '%s' "$out" | tr '\\n' ' ' | cut -c1-500)"
  fi
done < "$servers"
# Log out of servers this script logged in to that are no longer in the list.
if [ -r "$marker" ]; then
  while IFS= read -r old; do
    [ -n "$old" ] || continue
    if ! cut -f1 "$servers" | grep -qxF "$old"; then
      gt auth logout --host "$old" --yes --no-input </dev/null >/dev/null 2>&1
      echo "removed $old"
    fi
  done < "$marker"
fi
cut -f1 "$servers" | grep -v '^$' > "$marker.tmp" && mv "$marker.tmp" "$marker"
if [ -n "$default" ]; then
  if ! out=$(gt config set default_host "$default" --no-input </dev/null 2>&1); then
    echo "warn couldn't make $default the default server: $(printf '%s' "$out" | tr '\\n' ' ' | cut -c1-300)"
  fi
fi
exit 0
`;

/** The managed files for one environment, relative to / for a tar archive. */
export function giteaTarFiles(s: { giteaServers: GiteaServer[] }): {
  name: string;
  content?: string;
  mode: number;
  gid?: number;
  dir?: boolean;
}[] {
  const dir = GITEA_DIR.replace(/^\//, "");
  return [
    { name: `${dir}/`, dir: true, mode: 0o755 },
    { name: `${dir}/sync`, content: GITEA_SYNC_SCRIPT, mode: 0o755 },
    // The token file: root and the dev group only.
    { name: `${dir}/servers`, content: renderGiteaServers(s.giteaServers), mode: 0o640, gid: DEV_GID },
  ];
}

/** Runs as root after the files are copied in: ownership by name, in case the archive's ids didn't stick. */
export const GITEA_FIX_PERMISSIONS = `set -e
chown root:dev ${GITEA_SERVERS_FILE} 2>/dev/null || chown 0:1000 ${GITEA_SERVERS_FILE}
chmod 0640 ${GITEA_SERVERS_FILE}
chmod 0755 ${GITEA_DIR} ${GITEA_SYNC_FILE}`;

export interface GiteaCheck {
  url: string;
  ok: boolean;
  detail?: string;
}

export interface GiteaSyncOutput {
  checks: GiteaCheck[];
  /** Why the script did nothing (e.g. gt isn't installed), if it said so. */
  skipped?: string;
  warnings: string[];
}

/** Parses the sync script's output. Any token that shows up in gt's messages is masked. */
export function parseGiteaSync(stdout: string, tokens: string[] = []): GiteaSyncOutput {
  const mask = (s: string) => {
    let out = s;
    for (const t of tokens) if (t) out = out.split(t).join("…");
    return out.trim().slice(0, 600);
  };
  const res: GiteaSyncOutput = { checks: [], warnings: [] };
  for (const raw of stdout.split("\n")) {
    const line = raw.trim();
    let m: RegExpExecArray | null;
    if ((m = /^(ok|fail) (https?:\/\/\S+)(?: (.*))?$/.exec(line))) {
      const detail = m[3] ? mask(m[3]) : "";
      res.checks.push({ ok: m[1] === "ok", url: m[2]!, ...(detail ? { detail } : {}) });
    } else if ((m = /^skip (.*)$/.exec(line))) {
      res.skipped = mask(m[1]!);
    } else if ((m = /^warn (.*)$/.exec(line))) {
      res.warnings.push(mask(m[1]!));
    }
  }
  return res;
}
