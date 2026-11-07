import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  GITEA_SERVERS_FILE,
  GITEA_SYNC_SCRIPT,
  giteaTarFiles,
  normalizeGiteaUrl,
  parseGiteaSync,
  renderGiteaServers,
  type GiteaServer,
} from "../server/gitea.js";

describe("normalizeGiteaUrl", () => {
  it.each([
    ["gitea.example.com", "https://gitea.example.com"],
    ["  https://Gitea.Example.com/ ", "https://gitea.example.com"],
    ["https://gitea.example.com:443", "https://gitea.example.com"],
    ["http://10.0.0.5:3000", "http://10.0.0.5:3000"],
    ["http://10.0.0.5:80/", "http://10.0.0.5"],
    ["https://example.com/gitea/", "https://example.com/gitea"],
    ["https://example.com//gitea/./x", "https://example.com/gitea/x"],
    ["HTTPS://gitea.com", "https://gitea.com"],
    ["https://gitea.com/a/../b", "https://gitea.com/b"],
  ])("%s -> %s", (input, url) => {
    expect(normalizeGiteaUrl(input)).toEqual({ url });
  });
  it.each(["", "ssh://git@gitea.com/x.git", "git@gitea.com:owner/repo.git", "https://bob@gitea.com", "https://gitea.com/?x=1", "https://gitea.com/a%2fb"])(
    "rejects %j",
    (input) => {
      expect(normalizeGiteaUrl(input)).toHaveProperty("error");
    },
  );
});

describe("renderGiteaServers", () => {
  it("sorts by URL and marks the default", () => {
    expect(
      renderGiteaServers([
        { url: "https://z.example.com", token: "t2", updatedAt: 0 },
        { url: "http://10.0.0.5:3000", token: "t1", isDefault: true, updatedAt: 0 },
      ]),
    ).toBe("http://10.0.0.5:3000\tt1\tdefault\nhttps://z.example.com\tt2\t-\n");
  });
  it("keeps the token file private to root and dev", () => {
    const f = giteaTarFiles({ giteaServers: [] }).find((x) => x.name === "etc/t3m-gitea/servers")!;
    expect(f.mode).toBe(0o640);
    expect(f.gid).toBe(1000);
  });
});

describe("parseGiteaSync", () => {
  it("reads results and masks tokens", () => {
    const out = parseGiteaSync(
      ["ok https://a.example.com", "fail http://10.0.0.5:3000 401 for token sekrit", "removed https://old.example.com", "warn no default", "junk"].join("\n"),
      ["sekrit"],
    );
    expect(out.checks).toEqual([
      { url: "https://a.example.com", ok: true },
      { url: "http://10.0.0.5:3000", ok: false, detail: "401 for token …" },
    ]);
    expect(out.warnings).toEqual(["no default"]);
    expect(out.skipped).toBeUndefined();
    expect(parseGiteaSync("skip gt isn't installed").skipped).toBe("gt isn't installed");
  });
});

describe("sync script with a fake gt", () => {
  // A stand-in gt that records each call and keeps "logins" in a file, so the
  // script's merging can be checked without a Gitea server.
  const dir = mkdtempSync(path.join(tmpdir(), "t3m-gitea-"));
  const bin = path.join(dir, "bin");
  const home = path.join(dir, "home");
  const serversFile = path.join(dir, "servers");
  const script = path.join(dir, "sync");
  const log = path.join(dir, "calls.log");
  mkdirSync(bin);
  mkdirSync(home);
  writeFileSync(
    path.join(bin, "gt"),
    `#!/bin/sh
logins="$HOME/logins"
host=; prev=
for a in "$@"; do [ "$prev" = --host ] && host=$a; prev=$a; done
case "$1 $2" in
  "auth login")
    token=$(cat)
    echo "login $host $token" >> "${log}"
    case "$token" in bad*) echo "HTTP 401: invalid token" >&2; exit 4 ;; esac
    grep -vxF "$host" "$logins" 2>/dev/null > "$logins.new"; echo "$host" >> "$logins.new"; mv "$logins.new" "$logins" ;;
  "auth logout")
    echo "logout $host" >> "${log}"
    grep -vxF "$host" "$logins" > "$logins.new"; mv "$logins.new" "$logins" ;;
  "config set")
    echo "default $4" >> "${log}" ;;
esac
`,
    { mode: 0o755 },
  );
  writeFileSync(script, GITEA_SYNC_SCRIPT.replaceAll(GITEA_SERVERS_FILE, serversFile), { mode: 0o755 });
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: "" };
  const run = (servers: GiteaServer[]) => {
    writeFileSync(serversFile, renderGiteaServers(servers));
    writeFileSync(log, "");
    const out = execFileSync("sh", [script], { env, encoding: "utf8" });
    return { out, calls: readFileSync(log, "utf8").trim().split("\n").filter(Boolean), logins: readFileSync(path.join(home, "logins"), "utf8").trim().split("\n") };
  };

  it("logs in to every server, reports failures and sets the default, without printing tokens", () => {
    const r = run([
      { url: "https://a.example.com", token: "tokA", updatedAt: 0 },
      { url: "http://10.0.0.5:3000", token: "badTok", isDefault: true, updatedAt: 0 },
    ]);
    expect(r.calls).toEqual(["login http://10.0.0.5:3000 badTok", "login https://a.example.com tokA", "default http://10.0.0.5:3000"]);
    expect(r.out).not.toContain("tokA");
    expect(parseGiteaSync(r.out).checks).toEqual([
      { url: "http://10.0.0.5:3000", ok: false, detail: "HTTP 401: invalid token" },
      { url: "https://a.example.com", ok: true },
    ]);
    expect(readFileSync(path.join(home, ".config/gitea-cli/.t3m-managed"), "utf8")).toBe("http://10.0.0.5:3000\nhttps://a.example.com\n");
  });

  it("logs out of removed servers and keeps logins added by hand", () => {
    // Someone ran `gt auth login` for their own server.
    writeFileSync(path.join(home, "logins"), `${readFileSync(path.join(home, "logins"), "utf8")}https://mine.example.com\n`);
    const r = run([{ url: "https://b.example.com", token: "tokB", updatedAt: 0 }]);
    expect(r.calls).toEqual(["login https://b.example.com tokB", "logout http://10.0.0.5:3000", "logout https://a.example.com"]);
    expect(r.out).toContain("removed https://a.example.com");
    expect(r.logins.sort()).toEqual(["https://b.example.com", "https://mine.example.com"]);
  });

  it("does nothing and says why when gt isn't installed", () => {
    const out = execFileSync("sh", [script], { env: { ...env, PATH: "/usr/bin:/bin" }, encoding: "utf8" });
    expect(parseGiteaSync(out).skipped).toContain("gt isn't installed");
  });
});
