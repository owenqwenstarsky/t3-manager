import { describe, expect, it } from "vitest";
import {
  buildPairLinks,
  derivePhase,
  parsePairingOutput,
  parsePastedCallback,
  parseTailscaleStatus,
  validateEnvName,
} from "../server/logic.js";
import { DEFAULT_PRICING, Pricer, addMetrics, emptyMetrics } from "../server/pricing.js";

describe("validateEnvName", () => {
  it.each(["alice", "a", "bob-2", "x1"])("accepts %s", (n) => expect(validateEnvName(n)).toBeNull());
  it.each(["", "Alice", "-a", "a-", "1abc", "a_b", "a".repeat(33), "a b"])("rejects %j", (n) =>
    expect(validateEnvName(n)).not.toBeNull(),
  );
});

describe("parseTailscaleStatus", () => {
  it("reads a logged-in node", () => {
    const info = parseTailscaleStatus(
      JSON.stringify({
        BackendState: "Running",
        Self: { DNSName: "t3-alice.tail1234.ts.net.", TailscaleIPs: ["100.64.0.5"], Online: true },
      }),
    );
    expect(info).toEqual({
      backendState: "Running",
      authUrl: undefined,
      dnsName: "t3-alice.tail1234.ts.net",
      ips: ["100.64.0.5"],
      online: true,
    });
  });
  it("reads the login URL", () => {
    const info = parseTailscaleStatus(JSON.stringify({ BackendState: "NeedsLogin", AuthURL: "https://login.tailscale.com/a/x" }));
    expect(info.authUrl).toBe("https://login.tailscale.com/a/x");
  });
});

describe("derivePhase", () => {
  const running = { backendState: "Running", ips: [], dnsName: "x.ts.net" };
  it("maps docker states", () => {
    expect(derivePhase({ dockerState: "exited" }).phase).toBe("stopped");
    expect(derivePhase({ dockerState: "created" }).phase).toBe("creating");
    expect(derivePhase({ dockerState: "restarting" }).phase).toBe("error");
  });
  it("walks the tailnet join", () => {
    expect(derivePhase({ dockerState: "running", tailscale: null }).phase).toBe("starting");
    expect(derivePhase({ dockerState: "running", tailscale: { backendState: "NeedsLogin", ips: [] } }).phase).toBe("joining");
    expect(
      derivePhase({ dockerState: "running", tailscale: { backendState: "NeedsLogin", authUrl: "u", ips: [] } }).phase,
    ).toBe("needs-login");
    expect(derivePhase({ dockerState: "running", tailscale: running, health: "starting" }).phase).toBe("starting");
    expect(derivePhase({ dockerState: "running", tailscale: running, health: "healthy" }).phase).toBe("ready");
    expect(derivePhase({ dockerState: "running", tailscale: running, health: "healthy", serveFailed: true }).phase).toBe(
      "serve-failed",
    );
  });
});

describe("pair links", () => {
  it("matches T3 Code's formats", () => {
    const l = buildPairLinks("https://t3-alice.tail1234.ts.net", "KKT7E49RBUKU", "Alice phone");
    expect(l.pairUrl).toBe("https://t3-alice.tail1234.ts.net/pair#token=KKT7E49RBUKU");
    expect(l.hostedUrl).toBe(
      "https://app.t3.codes/pair?host=https%3A%2F%2Ft3-alice.tail1234.ts.net&label=Alice+phone#token=KKT7E49RBUKU",
    );
    expect(l.appLink).toBe(
      "t3code://pair?pairingUrl=https%3A%2F%2Ft3-alice.tail1234.ts.net%2Fpair%23token%3DKKT7E49RBUKU",
    );
  });
  it("parses CLI output with surrounding noise", () => {
    const out = 'warn: something\n{\n  "id": "1",\n  "credential": "ABC",\n  "expiresAt": "2026-11-07T04:33:49.196Z"\n}\n';
    expect(parsePairingOutput(out)).toEqual({ id: "1", credential: "ABC", expiresAt: "2026-11-07T04:33:49.196Z" });
    expect(() => parsePairingOutput("error")).toThrow();
  });
});

describe("parsePastedCallback", () => {
  it("accepts the full redirect URL", () => {
    const r = parsePastedCallback("http://localhost:54545/callback?code=abc123&state=st1", "st1");
    expect(r).toMatchObject({ kind: "redirect", code: "abc123", state: "st1" });
  });
  it("accepts an address without scheme and quotes", () => {
    const r = parsePastedCallback(' "localhost:1455/auth/callback?code=zz9988&state=s" ', "s");
    expect(r.kind).toBe("redirect");
  });
  it("accepts code#state", () => {
    expect(parsePastedCallback("abcdef123456#st1", "st1")).toEqual({ kind: "code", code: "abcdef123456", state: "st1" });
  });
  it("accepts a bare code", () => {
    expect(parsePastedCallback("abcdef123456", "st1")).toEqual({ kind: "code", code: "abcdef123456", state: "st1" });
  });
  it("rejects mismatched state, errors and junk", () => {
    expect(parsePastedCallback("http://localhost:54545/callback?code=a&state=other", "st1").kind).toBe("invalid");
    expect(parsePastedCallback("http://localhost:54545/callback?error=access_denied", "st1").kind).toBe("invalid");
    expect(parsePastedCallback("abcdef#nope", "st1").kind).toBe("invalid");
    expect(parsePastedCallback("hello world", "st1").kind).toBe("invalid");
    expect(parsePastedCallback("", "st1").kind).toBe("invalid");
  });
});

describe("pricing", () => {
  const pricer = new Pricer(DEFAULT_PRICING);
  it("matches the most specific rule first", () => {
    expect(pricer.ruleFor("claude-opus-5-5")?.input).toBe(4);
    expect(pricer.ruleFor("claude-opus-5")?.input).toBe(5);
    expect(pricer.ruleFor("claude-opus-4-1-20250805")?.input).toBe(15);
    expect(pricer.ruleFor("claude-opus-4-8")?.input).toBe(5);
    expect(pricer.ruleFor("claude-fable-5-1")?.cacheRead).toBe(0.25);
    expect(pricer.ruleFor("anthropic/claude-sonnet-5-5")?.input).toBe(2);
    expect(pricer.ruleFor("gpt-6-astra")).toBeNull();
  });
  it("computes cost from normalized tokens", () => {
    // 1M uncached input + 1M output + 10M cache reads + 0.1M cache writes on Opus 5.5
    const c = pricer.cost("claude-opus-5-5", { input: 1e6, output: 1e6, cache_read: 1e7, cache_creation: 1e5 });
    expect(c).toBeCloseTo(4 + 20 + 2 + 0.5, 6);
  });
  it("tracks unpriced tokens separately and weights latency", () => {
    const acc = emptyMetrics();
    const m = { ...emptyMetrics(), requests: 1, total: 100, input: 100, avg_latency_ms: 1000 };
    addMetrics(acc, m, 0.5);
    addMetrics(acc, { ...m, requests: 3, avg_latency_ms: 2000 }, null);
    expect(acc.cost).toBe(0.5);
    expect(acc.unpriced_tokens).toBe(100);
    expect(acc.requests).toBe(4);
    expect(acc.avg_latency_ms).toBe(1750);
  });
});
