import { parsePastedCallback } from "./logic.js";
import { proxy } from "./proxy.js";
import type { OAuthStart, OAuthStatus } from "./shared/types.js";
import { HttpError } from "./envs.js";

/**
 * Starts a sign-in. ChatGPT (Codex) uses a device code by default so nothing
 * has to be pasted back; Claude uses the redirect flow with a smart paste box.
 */
export async function startSignIn(provider: "claude" | "codex", mode?: "redirect" | "device"): Promise<OAuthStart> {
  if (provider === "codex" && mode !== "redirect") {
    const d = await proxy.deviceStart();
    return { provider, mode: "device", url: d.verification_url, state: d.id, userCode: d.user_code, expiresAt: d.expires_at };
  }
  const r = await proxy.oauthStart(provider);
  return { provider, mode: "redirect", url: r.url, state: r.state };
}

export async function signInStatus(mode: "redirect" | "device", state: string): Promise<OAuthStatus> {
  if (mode === "device") {
    const s = await proxy.deviceStatus(state);
    return { status: (s.status as OAuthStatus["status"]) ?? "wait", error: s.error, email: s.email };
  }
  const s = await proxy.oauthStatus(state);
  return { status: s.status === "ok" ? "ok" : s.status === "error" ? "error" : "wait", error: s.error };
}

export async function submitCallback(state: string, pasted: string): Promise<void> {
  // The provider is inferred from the pending state (Claude sessions are
  // registered as "anthropic"), so it is deliberately not sent.
  const parsed = parsePastedCallback(pasted, state);
  if (parsed.kind === "invalid") throw new HttpError(400, parsed.reason);
  if (parsed.kind === "redirect") {
    await proxy.oauthCallback({ state: parsed.state ?? state, redirect_url: parsed.redirectUrl });
  } else {
    await proxy.oauthCallback({ state: parsed.state ?? state, code: parsed.code });
  }
}

export async function cancelSignIn(mode: "redirect" | "device", state: string): Promise<void> {
  if (mode === "device") await proxy.deviceCancel(state);
  else await proxy.oauthCancel(state);
}
