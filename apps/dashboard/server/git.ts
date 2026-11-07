/**
 * Git setup pushed into every environment: HTTPS credentials (one per server)
 * and the commit author, so commits can be traced back to the environment.
 *
 * Files written into each container (see envs.syncGit):
 *   /etc/gitconfig                      system git config: author + credential helper
 *   /etc/t3m-git/credential-helper      read-only helper, answers `get` for known hosts over HTTPS
 *   /etc/t3m-git/credentials            host<TAB>username<TAB>token, root:dev 0640
 */

export interface GitCredential {
  host: string;
  /** Empty means the default for the host (see defaultGitUsername). */
  username?: string;
  token: string;
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
export function normalizeGitHost(input: string): { host: string } | { error: string } {
  let s = input.trim();
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
  // git sends the host without a port for the default HTTPS port.
  return { host: port === 443 ? m[1]! : s };
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
    .map((c) => `${c.host}\t${c.username || defaultGitUsername(c.host)}\t${c.token}\n`)
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
 * username/password back. Only `get` is answered and only over HTTPS, so a token
 * never goes to a plain-HTTP remote; `store`/`erase` are ignored so a failed push
 * can't remove the managed credential.
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
[ "$protocol" = https ] || exit 0
[ -r ${GIT_CREDENTIALS_FILE} ] || exit 0
host=$(printf '%s' "$host" | tr '[:upper:]' '[:lower:]')
tab=$(printf '\\t')
while IFS="$tab" read -r h u p; do
  if [ "$h" = "$host" ]; then
    printf 'username=%s\\npassword=%s\\n' "$u" "$p"
    exit 0
  fi
done < ${GIT_CREDENTIALS_FILE}
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
