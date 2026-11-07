import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GIT_AUTHOR,
  GIT_CREDENTIALS_FILE,
  GIT_CHECK_SCRIPT,
  GIT_CREDENTIAL_HELPER,
  gitCheckInput,
  parseGitCheck,
  GIT_HELPER_FILE,
  defaultGitUsername,
  fillTemplate,
  gitAuthorFor,
  normalizeGitHost,
  renderGitConfig,
  renderGitCredentials,
  validateGitToken,
} from "../server/git.js";

describe("normalizeGitHost", () => {
  it.each([
    ["github.com", "github.com"],
    ["  GitHub.com/ ", "github.com"],
    ["https://github.com/org/repo.git", "github.com"],
    ["https://user@gitlab.example.com:8443/group", "gitlab.example.com:8443"],
    ["https://git.example.com:443/", "git.example.com"],
    ["gitea", "gitea"],
    ["token@git.example.com/x", "git.example.com"],
  ])("%s → %s", (input, host) => {
    expect(normalizeGitHost(input)).toMatchObject({ host });
  });
  it("remembers the scheme and drops its default port", () => {
    expect(normalizeGitHost("http://10.77.0.11:3000/owner/bloxblast.git")).toEqual({ host: "10.77.0.11:3000", scheme: "http" });
    expect(normalizeGitHost("http://git.lan:80/x")).toEqual({ host: "git.lan", scheme: "http" });
    expect(normalizeGitHost("https://git.lan:443/x")).toEqual({ host: "git.lan", scheme: "https" });
    expect(normalizeGitHost("git.lan:3000")).toEqual({ host: "git.lan:3000" });
  });
  it.each(["", "git@github.com:org/repo.git", "ssh://git@github.com/x", "exa mple.com", "-bad.com", "host:99999"])(
    "rejects %j",
    (input) => {
      expect(normalizeGitHost(input)).toHaveProperty("error");
    },
  );
});

describe("git credentials", () => {
  it("picks the username each host documents", () => {
    expect(defaultGitUsername("github.com")).toBe("x-access-token");
    expect(defaultGitUsername("gitlab.com")).toBe("oauth2");
    expect(defaultGitUsername("gitlab.example.com:8443")).toBe("oauth2");
    expect(defaultGitUsername("bitbucket.org")).toBe("x-token-auth");
    expect(defaultGitUsername("git.example.com")).toBe("git");
  });
  it("validates tokens", () => {
    expect(validateGitToken("ghp_abc")).toBeNull();
    expect(validateGitToken("")).not.toBeNull();
    expect(validateGitToken("a b")).not.toBeNull();
    expect(validateGitToken("a\nb")).not.toBeNull();
  });
  it("renders one sorted line per host", () => {
    expect(
      renderGitCredentials([
        { host: "gitlab.com", token: "glpat-1", updatedAt: 0 },
        { host: "github.com", token: "ghp_2", username: "me", updatedAt: 0 },
      ]),
    ).toBe("github.com\tme\tghp_2\thttps\ngitlab.com\toauth2\tglpat-1\thttps\n");
    expect(renderGitCredentials([{ host: "10.77.0.11:3000", token: "t", allowHttp: true, updatedAt: 0 }])).toBe(
      "10.77.0.11:3000\tgit\tt\tany\n",
    );
  });
});

describe("git author", () => {
  const vars = { env: "alice", owner: "Alice Smith", hostname: "t3-alice" };
  it("fills templates", () => {
    expect(fillTemplate("{owner} via {env} ({hostname})", vars)).toBe("Alice Smith via alice (t3-alice)");
    expect(fillTemplate("{owner}", { env: "bob", hostname: "t3-bob" })).toBe("bob");
    expect(fillTemplate("a\nb", vars)).toBe("ab");
  });
  it("uses the defaults", () => {
    expect(gitAuthorFor(DEFAULT_GIT_AUTHOR, vars)).toEqual({ name: "alice (T3)", email: "alice@t3.invalid" });
    expect(gitAuthorFor({ ...DEFAULT_GIT_AUTHOR, enabled: false }, vars)).toBeNull();
  });
  it("quotes values in gitconfig", () => {
    const cfg = renderGitConfig({ name: 'a "b" \\ c', email: "x@y" });
    expect(cfg).toContain('name = "a \\"b\\" \\\\ c"');
    expect(cfg).toContain(`helper = ${GIT_HELPER_FILE}`);
    expect(renderGitConfig(null)).not.toContain("[user]");
  });
});

describe("generated files with real git", () => {
  // Point the generated helper and config at a temp dir, then ask git itself.
  const dir = mkdtempSync(path.join(tmpdir(), "t3m-git-"));
  const credFile = path.join(dir, "credentials");
  const helper = path.join(dir, "credential-helper");
  const sysConfig = path.join(dir, "gitconfig");
  writeFileSync(helper, GIT_CREDENTIAL_HELPER.replaceAll(GIT_CREDENTIALS_FILE, credFile), { mode: 0o755 });
  writeFileSync(
    credFile,
    renderGitCredentials([
      { host: "github.com", token: "ghp_secret", updatedAt: 0 },
      { host: "git.example.com:8443", token: "tok2", username: "deploy", updatedAt: 0 },
      { host: "10.77.0.11:3000", token: "gitea_tok", allowHttp: true, updatedAt: 0 },
    ]),
  );
  writeFileSync(
    sysConfig,
    renderGitConfig(gitAuthorFor(DEFAULT_GIT_AUTHOR, { env: "alice", owner: 'Al "Q"', hostname: "t3-alice" })).replace(
      GIT_HELPER_FILE,
      helper,
    ),
  );
  const env = { ...process.env, GIT_CONFIG_SYSTEM: sysConfig, GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", HOME: dir };
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { env, input, cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
  const fill = (url: string) => {
    try {
      return git(["credential", "fill"], `url=${url}\n\n`);
    } catch (e) {
      return `failed: ${(e as { stderr?: string }).stderr ?? ""}`;
    }
  };

  it("serves the token for a configured host over https", () => {
    const out = fill("https://github.com/org/repo.git");
    expect(out).toContain("username=x-access-token");
    expect(out).toContain("password=ghp_secret");
    expect(fill("https://GIT.example.com:8443/x.git")).toContain("username=deploy\npassword=tok2");
  });
  it("gives nothing for other hosts, other ports or plain http", () => {
    expect(fill("https://gitlab.com/x.git")).not.toContain("password=");
    expect(fill("https://git.example.com/x.git")).not.toContain("password=");
    expect(fill("http://github.com/x.git")).not.toContain("password=");
  });
  it("serves plain HTTP only for servers saved with it allowed", () => {
    expect(fill("http://10.77.0.11:3000/owner/bloxblast.git")).toContain("username=git\npassword=gitea_tok");
    expect(fill("https://10.77.0.11:3000/owner/bloxblast.git")).toContain("password=gitea_tok");
    expect(fill("http://10.77.0.11:3001/x.git")).not.toContain("password=");
  });
  it("explains on stderr why it gave no token", () => {
    expect(fill("http://github.com/x.git")).toContain("only sent over HTTPS. Turn on Allow plain HTTP");
    expect(fill("https://gitlab.com/x.git")).toContain("no git token is saved for gitlab.com");
  });
  it("ignores store and erase", () => {
    git(["credential", "reject"], "protocol=https\nhost=github.com\nusername=x-access-token\npassword=ghp_secret\n\n");
    expect(fill("https://github.com/x.git")).toContain("password=ghp_secret");
  });
  it("checks every server the way a clone does, without printing tokens", () => {
    const checks = gitCheckInput([
      { host: "github.com" },
      { host: "10.77.0.11:3000", allowHttp: true },
      { host: "gitlab.com" },
    ]);
    const out = execFileSync("sh", ["-c", GIT_CHECK_SCRIPT], { env: { ...env, T3M_CHECKS: checks }, cwd: dir, encoding: "utf8" });
    expect(out).not.toContain("ghp_secret");
    expect(out).not.toContain("gitea_tok");
    const parsed = parseGitCheck(out);
    expect(parsed.map((c) => [c.protocol, c.host, c.ok])).toEqual([
      ["https", "github.com", true],
      ["http", "10.77.0.11:3000", true],
      ["https", "gitlab.com", false],
    ]);
    expect(parsed[2]!.detail).toContain("terminal prompts disabled");
    expect(parsed[2]!.detail).toContain("credential-helper");
  });
  it("reports an unreadable token file as a failure", () => {
    const locked = path.join(dir, "locked-helper");
    writeFileSync(locked, GIT_CREDENTIAL_HELPER.replaceAll(GIT_CREDENTIALS_FILE, path.join(dir, "missing")), { mode: 0o755 });
    const lockedConfig = path.join(dir, "locked-gitconfig");
    writeFileSync(lockedConfig, renderGitConfig(null).replace(GIT_HELPER_FILE, locked));
    const out = execFileSync("sh", ["-c", GIT_CHECK_SCRIPT], {
      env: { ...env, GIT_CONFIG_SYSTEM: lockedConfig, T3M_CHECKS: "https github.com" },
      cwd: dir,
      encoding: "utf8",
    });
    expect(parseGitCheck(out)).toMatchObject([{ host: "github.com", ok: false }]);
  });
  it("sets the author", () => {
    expect(git(["config", "user.name"]).trim()).toBe("alice (T3)");
    expect(git(["config", "user.email"]).trim()).toBe("alice@t3.invalid");
  });
});

describe("parseGitCheck", () => {
  it("parses lines and scrubs anything password-like", () => {
    expect(parseGitCheck("ok https github.com\nfail http git.lan:3000 git said: x password=abc |\njunk\n")).toEqual([
      { ok: true, protocol: "https", host: "github.com" },
      { ok: false, protocol: "http", host: "git.lan:3000", detail: "git said: x password=… |" },
    ]);
  });
});

describe("container archive", () => {
  it("writes the files with the right owners and modes", async () => {
    const { packFiles } = await import("../server/docker.js");
    const { gitTarFiles } = await import("../server/git.js");
    const tar = await import("tar-stream");
    const buf = await packFiles(
      gitTarFiles(
        { gitAuthor: DEFAULT_GIT_AUTHOR, gitCredentials: [{ host: "github.com", token: "t", updatedAt: 0 }] },
        { env: "alice", hostname: "t3-alice" },
      ),
    );
    const entries: { name: string; mode?: number; uid?: number; gid?: number; type?: string | null }[] = [];
    const extract = tar.extract();
    await new Promise<void>((resolve, reject) => {
      extract.on("entry", (h, stream, next) => {
        entries.push({ name: h.name, mode: h.mode, uid: h.uid, gid: h.gid, type: h.type });
        stream.on("end", next);
        stream.resume();
      });
      extract.on("finish", resolve);
      extract.on("error", reject);
      extract.end(buf);
    });
    expect(entries).toEqual([
      { name: "etc/gitconfig", mode: 0o644, uid: 0, gid: 0, type: "file" },
      { name: "etc/t3m-git/", mode: 0o755, uid: 0, gid: 0, type: "directory" },
      { name: "etc/t3m-git/credential-helper", mode: 0o755, uid: 0, gid: 0, type: "file" },
      { name: "etc/t3m-git/credentials", mode: 0o640, uid: 0, gid: 1000, type: "file" },
    ]);
  });
});
