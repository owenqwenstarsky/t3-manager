/**
 * Git setup pushed into every environment: HTTPS credentials (one per server)
 * and the commit author, so commits can be traced back to the environment.
 *
 * Files written into each container (see envs.syncGit):
 *   /etc/gitconfig                      system git config: author + credential helper
 *   /etc/t3m-git/credential-helper      read-only helper, answers `get` for known hosts
 *   /etc/t3m-git/credentials            host<TAB>username<TAB>token<TAB>https|any, root:dev 0640
 */

export interface GitCredential {
  host: string;
  /** Empty means the default for the host (see defaultGitUsername). */
  username?: string;
  token: string;
  /** Also send the token to http:// remotes on this server (unencrypted). */
  allowHttp?: boolean;
  updatedAt: number;
}

export interface GitAuthorSettings {
  enabled: boolean;
  /** Templates; {env}, {owner} and {hostname} are replaced. */
  name: string;
  email: string;
}

export const DEFAULT_GIT_AUTHOR: GitAuthorSettings = {
  enabled: true,
  name: "{env} (T3)",
  email: "{env}@t3.invalid",
};

export const GIT_DIR = "/etc/t3m-git";
export const GIT_CREDENTIALS_FILE = `${GIT_DIR}/credentials`;
export const GIT_HELPER_FILE = `${GIT_DIR}/credential-helper`;

/**
 * Normalizes what someone types as a server address to `host[:port]`,
 * lowercase. Accepts bare hosts and http(s) URLs (path and user are dropped).
 * Returns an error message for anything else.
 */
export function normalizeGitHost(input: string): { host: string; scheme?: "http" | "https" } | { error: string } {
  let s = input.trim();
  const scheme = /^http:\/\//i.test(s) ? "http" : /^https:\/\//i.test(s) ? "https" : undefined;
  if (!s) return { error: "Enter a server address, like github.com" };
  if (/^(ssh|git):\/\//i.test(s) || /^[^/\s]+@[^/\s]+:/.test(s)) {
    return { error: "Tokens are used over HTTPS. Enter the server's https address, like github.com" };
  }
  if (/^https?:\/\//i.test(s)) {
    try {
      s = new URL(s).host;
    } catch {
      return { error: "That address isn't a valid URL" };
    }
  } else {
    s = s.replace(/[/?#].*$/, "");
    if (s.includes("@")) s = s.slice(s.lastIndexOf("@") + 1);
  }
  s = s.toLowerCase().replace(/\.$/, "");
  const m = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)(?::(\d{1,5}))?$/.exec(s);
  if (!m || s.length > 253) return { error: "That isn't a valid server address" };
  const port = m[2] ? Number(m[2]) : undefined;
  if (port !== undefined && (port < 1 || port > 65535)) return { error: "That port isn't valid" };
  // git sends the host without a port when it is the default for the scheme.
  const defaultPort = scheme === "http" ? 80 : 443;
  return { host: port === defaultPort ? m[1]! : s, ...(scheme ? { scheme } : {}) };
}

/** Username sent with the token when none is set. Hosts that check it get the value they document. */
export function defaultGitUsername(host: string): string {
  const h = host.replace(/:\d+$/, "");
  if (h === "github.com" || h.endsWith(".ghe.com")) return "x-access-token";
  if (h === "bitbucket.org") return "x-token-auth";
  if (h === "gitlab.com" || h.startsWith("gitlab.")) return "oauth2";
  return "git";
}

/** Returns an error message, or null when the token can be stored. */
export function validateGitToken(token: string): string | null {
  if (!token) return "Enter a token";
  if (token.length > 4096) return "That token is too long";
  if (/[\s\u0000-\u001f\u007f]/.test(token)) return "Tokens can't contain spaces or line breaks";
  return null;
}

export function validateGitUsername(username: string): string | null {
  if (username.length > 200) return "That username is too long";
  if (/[\s\u0000-\u001f\u007f]/.test(username)) return "Usernames can't contain spaces or line breaks";
  return null;
}

export function renderGitCredentials(creds: GitCredential[]): string {
  return creds
    .slice()
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((c) => `${c.host}\t${c.username || defaultGitUsername(c.host)}\t${c.token}\t${c.allowHttp ? "any" : "https"}\n`)
    .join("");
}

/** Fills an author template. Control characters are dropped so the value stays on one line. */
export function fillTemplate(template: string, vars: { env: string; owner?: string; hostname: string }): string {
  return template
    .replace(/\{(env|owner|hostname)\}/g, (_, k: "env" | "owner" | "hostname") =>
      k === "owner" ? vars.owner || vars.env : vars[k],
    )
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim();
}

function gitQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function gitAuthorFor(
  author: GitAuthorSettings,
  vars: { env: string; owner?: string; hostname: string },
): { name: string; email: string } | null {
  if (!author.enabled) return null;
  const name = fillTemplate(author.name, vars);
  const email = fillTemplate(author.email, vars).replace(/[<>\s]/g, "");
  if (!name || !email) return null;
  return { name, email };
}

export function renderGitConfig(author: { name: string; email: string } | null): string {
  const lines = [
    "# Managed by T3 Manager (Settings → Git). This file is rewritten on every change.",
    "# Override per repository with `git config user.name ...` if you need to.",
  ];
  if (author) lines.push("[user]", `\tname = ${gitQuote(author.name)}`, `\temail = ${gitQuote(author.email)}`);
  lines.push("[credential]", `\thelper = ${GIT_HELPER_FILE}`);
  return `${lines.join("\n")}\n`;
}

/**
 * git credential helper protocol: git writes key=value lines on stdin and reads
 * username/password back. Only `get` is answered, and only over HTTPS unless the
 * server was saved with plain HTTP allowed; `store`/`erase` are ignored so a
 * failed push can't remove the managed credential.
 */
export const GIT_CREDENTIAL_HELPER = `#!/bin/sh
# Managed by T3 Manager: serves the git tokens set in the dashboard (read-only).
[ "$1" = get ] || exit 0
protocol=
host=
while IFS= read -r line; do
  [ -z "$line" ] && break
  case "$line" in
    protocol=*) protocol=\${line#protocol=} ;;
    host=*) host=\${line#host=} ;;
  esac
done
case "$protocol" in https | http) ;; *) exit 0 ;; esac
# Git shows a helper's stderr, so say why no token was given.
if [ ! -r ${GIT_CREDENTIALS_FILE} ]; then
  echo "t3-manager: git tokens can't be read as $(id -un) (${GIT_CREDENTIALS_FILE}). Open Settings > Git and use Apply and check." >&2
  exit 0
fi
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
tab=$(printf '\\t')
while IFS="$tab" read -r h u p mode; do
  if [ "$h" = "$host" ]; then
    if [ "$protocol" = http ] && [ "$mode" != any ]; then
      echo "t3-manager: the token for $host is only sent over HTTPS. Turn on Allow plain HTTP for it in Settings > Git." >&2
      exit 0
    fi
    printf 'username=%s\\npassword=%s\\n' "$u" "$p"
    exit 0
  fi
done < ${GIT_CREDENTIALS_FILE}
echo "t3-manager: no git token is saved for $host (Settings > Git)." >&2
exit 0
`;

/** gid of the `dev` user in the t3-env image (the base image's `node` user). */
export const DEV_GID = 1000;

export interface GitVars {
  env: string;
  owner?: string;
  hostname: string;
}

/** The managed files for one environment, relative to / for a tar archive. */
export function gitTarFiles(
  s: { gitAuthor: GitAuthorSettings; gitCredentials: GitCredential[] },
  vars: GitVars,
): { name: string; content?: string; mode: number; gid?: number; dir?: boolean }[] {
  const dir = GIT_DIR.replace(/^\//, "");
  return [
    { name: "etc/gitconfig", content: renderGitConfig(gitAuthorFor(s.gitAuthor, vars)), mode: 0o644 },
    { name: `${dir}/`, dir: true, mode: 0o755 },
    { name: `${dir}/credential-helper`, content: GIT_CREDENTIAL_HELPER, mode: 0o755 },
    // The token file: root and the dev group only.
    { name: `${dir}/credentials`, content: renderGitCredentials(s.gitCredentials), mode: 0o640, gid: DEV_GID },
  ];
}

/** Runs as root after the files are copied in: ownership by name, in case the archive's ids didn't stick. */
export const GIT_FIX_PERMISSIONS = `set -e
chown root:dev ${GIT_CREDENTIALS_FILE} 2>/dev/null || chown 0:1000 ${GIT_CREDENTIALS_FILE}
chmod 0640 ${GIT_CREDENTIALS_FILE}
chmod 0755 ${GIT_DIR} ${GIT_HELPER_FILE}
chmod 0644 /etc/gitconfig`;

/**
 * Runs as dev: asks git for each server's credential exactly like a clone with
 * prompts disabled does. $T3M_CHECKS holds "protocol host" lines. Prints one
 * "ok|fail protocol host [detail]" line per server; passwords never leave the
 * container (the password= line is only tested for, never printed).
 */
export const GIT_CHECK_SCRIPT = `printf '%s\\n' "$T3M_CHECKS" | while read -r proto host; do
  [ -n "$host" ] || continue
  out=$(printf 'protocol=%s\\nhost=%s\\n\\n' "$proto" "$host" | GIT_TERMINAL_PROMPT=0 GIT_ASKPASS='' SSH_ASKPASS='' git credential fill 2>&1)
  if printf '%s\\n' "$out" | grep -q '^password=.'; then
    echo "ok $proto $host"
  else
    why=$(printf '%s\\n' "$out" | grep -v '^password=' | tr '\\n' ' ')
    # shellcheck disable=SC2012 # human-readable listing for the report
    files=$(ls -ln /etc/gitconfig ${GIT_DIR}/ 2>&1 | tr '\\n' ' ')
    helper=$(git config --show-origin --get-all credential.helper 2>&1 | tr '\\n' ' ')
    echo "fail $proto $host git said: $why| user: $(id) | helpers: $helper| files: $files"
  fi
done`;

export interface GitCheck {
  host: string;
  protocol: string;
  ok: boolean;
  detail?: string;
}

/** The "protocol host" lines checked for a set of credentials. */
export function gitCheckInput(creds: Pick<GitCredential, "host" | "allowHttp">[]): string {
  return creds.map((c) => `${c.allowHttp ? "http" : "https"} ${c.host}`).join("\n");
}

export function parseGitCheck(stdout: string): GitCheck[] {
  const checks: GitCheck[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(ok|fail) (https?) (\S+)(?: (.*))?$/.exec(line.trim());
    if (!m) continue;
    // Belt and braces: nothing that looks like a password line is ever reported.
    const detail = m[4]?.replace(/password=\S*/g, "password=…").trim().slice(0, 600);
    checks.push({ ok: m[1] === "ok", protocol: m[2]!, host: m[3]!, ...(detail ? { detail } : {}) });
  }
  return checks;
}
