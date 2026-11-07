// Pure helpers with no I/O, covered by unit tests.
import type { EnvPhase, EnvSummary } from "./shared/types.js";

export const ENV_NAME_RE = /^[a-z][a-z0-9-]{0,30}[a-z0-9]$|^[a-z]$/;

export function validateEnvName(name: string): string | null {
  if (!ENV_NAME_RE.test(name)) {
    return "Use 1-32 lowercase letters, digits or dashes, starting with a letter and not ending with a dash.";
  }
  return null;
}

export interface TailscaleInfo {
  backendState: string;
  authUrl?: string;
  dnsName?: string;
  ips: string[];
  online?: boolean;
}

/** Parses `tailscale status --json`. */
export function parseTailscaleStatus(raw: string): TailscaleInfo {
  const data = JSON.parse(raw) as {
    BackendState?: string;
    AuthURL?: string;
    Self?: { DNSName?: string; TailscaleIPs?: string[]; Online?: boolean };
    TailscaleIPs?: string[];
  };
  const dns = data.Self?.DNSName?.replace(/\.$/, "") || undefined;
  return {
    backendState: data.BackendState ?? "Unknown",
    authUrl: data.AuthURL || undefined,
    dnsName: dns,
    ips: data.Self?.TailscaleIPs ?? data.TailscaleIPs ?? [],
    online: data.Self?.Online,
  };
}

export interface PhaseInput {
  dockerState: string; // created | running | exited | paused | restarting | dead
  health?: string; // starting | healthy | unhealthy
  tailscale?: TailscaleInfo | null;
  serveFailed?: boolean;
}

/** Derives a single user-facing phase from Docker, health and Tailscale state. */
export function derivePhase(input: PhaseInput): { phase: EnvPhase; detail?: string } {
  const { dockerState, health, tailscale } = input;
  if (dockerState === "created") return { phase: "creating" };
  if (dockerState === "exited" || dockerState === "dead") return { phase: "stopped" };
  if (dockerState === "paused") return { phase: "stopped", detail: "Paused" };
  if (dockerState === "restarting") return { phase: "error", detail: "Container keeps restarting; check the logs." };
  if (dockerState !== "running") return { phase: "error", detail: `Docker state: ${dockerState}` };
  if (!tailscale) return { phase: "starting", detail: "Starting Tailscale" };
  if (tailscale.backendState === "NeedsLogin") {
    return tailscale.authUrl
      ? { phase: "needs-login", detail: "Open the login link to add this environment to your tailnet." }
      : { phase: "joining", detail: "Waiting for a Tailscale login link" };
  }
  if (tailscale.backendState === "NeedsMachineAuth") {
    return { phase: "needs-login", detail: "Approve this machine in the Tailscale admin console." };
  }
  if (tailscale.backendState !== "Running") return { phase: "joining", detail: `Tailscale: ${tailscale.backendState}` };
  if (input.serveFailed) {
    return { phase: "serve-failed", detail: "Tailscale Serve failed. Enable HTTPS certificates for your tailnet (admin console → DNS)." };
  }
  if (health === "unhealthy") return { phase: "error", detail: "T3 Code is not answering; check the logs." };
  if (health === "starting" || health === undefined) return { phase: "starting", detail: "Starting T3 Code" };
  return { phase: "ready" };
}

export const DEFAULT_HOSTED_APP_URL = "https://app.t3.codes";

/** Builds the links a client can use to pair, mirroring T3 Code's own formats. */
export function buildPairLinks(baseUrl: string, token: string, label?: string) {
  const pair = new URL("/pair", baseUrl);
  pair.hash = new URLSearchParams([["token", token]]).toString();
  const hosted = new URL("/pair", DEFAULT_HOSTED_APP_URL);
  hosted.searchParams.set("host", new URL(baseUrl).origin);
  if (label?.trim()) hosted.searchParams.set("label", label.trim());
  hosted.hash = new URLSearchParams([["token", token]]).toString();
  const appLink = `t3code://pair?${new URLSearchParams([["pairingUrl", pair.toString()]])}`;
  return { pairUrl: pair.toString(), hostedUrl: hosted.toString(), appLink };
}

/** Parses the JSON printed by `t3 auth pairing create --json`, tolerating log noise. */
export function parsePairingOutput(stdout: string): { credential: string; expiresAt: string; id?: string } {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("T3 did not return a pairing token");
  const data = JSON.parse(stdout.slice(start, end + 1)) as { credential?: string; expiresAt?: string; id?: string };
  if (!data.credential) throw new Error("T3 did not return a pairing token");
  return { credential: data.credential, expiresAt: data.expiresAt ?? "", id: data.id };
}

export type PastedCallback =
  | { kind: "redirect"; redirectUrl: string; state?: string; code?: string }
  | { kind: "code"; code: string; state?: string }
  | { kind: "invalid"; reason: string };

/**
 * Accepts whatever the user copied after signing in: the full redirect URL from
 * the address bar, a "code#state" string (Anthropic's copy-code page), or a bare
 * code. Rejects text whose state does not match the pending login.
 */
export function parsePastedCallback(input: string, expectedState?: string): PastedCallback {
  const text = input.trim().replace(/^["'<]+|[>"']+$/g, "");
  if (!text) return { kind: "invalid", reason: "Paste the address from your browser after signing in." };

  if (/^https?:\/\//i.test(text) || text.startsWith("localhost") || text.startsWith("127.0.0.1")) {
    let url: URL;
    try {
      url = new URL(/^https?:\/\//i.test(text) ? text : `http://${text}`);
    } catch {
      return { kind: "invalid", reason: "That doesn't look like a complete address." };
    }
    const params = new URLSearchParams(url.search);
    for (const [k, v] of new URLSearchParams(url.hash.replace(/^#/, ""))) if (!params.has(k)) params.set(k, v);
    const error = params.get("error");
    if (error) return { kind: "invalid", reason: params.get("error_description") ?? `Sign-in failed: ${error}` };
    const code = params.get("code") ?? undefined;
    const state = params.get("state") ?? undefined;
    if (!code) return { kind: "invalid", reason: "The address has no sign-in code. Copy it after the sign-in finishes." };
    if (expectedState && state && state !== expectedState) {
      return { kind: "invalid", reason: "That address belongs to a different sign-in attempt. Start again." };
    }
    url.search = params.toString();
    url.hash = "";
    return { kind: "redirect", redirectUrl: url.toString(), state, code };
  }

  if (/\s/.test(text)) return { kind: "invalid", reason: "Paste only the address or code, without spaces." };
  const hash = text.indexOf("#");
  if (hash > 0) {
    const code = text.slice(0, hash);
    const state = text.slice(hash + 1);
    if (expectedState && state && state !== expectedState) {
      return { kind: "invalid", reason: "That code belongs to a different sign-in attempt. Start again." };
    }
    return { kind: "code", code, state: state || expectedState };
  }
  if (text.length < 8) return { kind: "invalid", reason: "That code looks too short." };
  return { kind: "code", code: text, state: expectedState };
}

/** Sorts environments: problems first, then by name. */
export function sortEnvs(list: EnvSummary[]): EnvSummary[] {
  const rank: Record<EnvPhase, number> = {
    error: 0,
    "serve-failed": 1,
    "needs-login": 2,
    joining: 3,
    starting: 4,
    creating: 5,
    ready: 6,
    stopped: 7,
  };
  return [...list].sort((a, b) => rank[a.phase] - rank[b.phase] || a.name.localeCompare(b.name));
}

/** Random client key for the proxy, prefixed for easy recognition. */
export function newProxyKey(envName: string, random: string): string {
  return `t3m-${envName}-${random}`;
}
