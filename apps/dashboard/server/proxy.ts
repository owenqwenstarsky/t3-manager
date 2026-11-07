import { config } from "./config.js";
import type { Account } from "./shared/types.js";

export class ProxyError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, query?: Record<string, string | undefined>): Promise<T> {
  const url = new URL(path, config.proxyUrl);
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== "") url.searchParams.set(k, v);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${config.proxyManagementKey}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new ProxyError(`Model proxy unreachable at ${config.proxyUrl}: ${(e as Error).message}`, 503);
  }
  const text = await res.text();
  let data: unknown = undefined;
  try {
    data = text ? JSON.parse(text) : undefined;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | undefined)?.error ?? `${res.status} ${res.statusText}`;
    throw new ProxyError(msg, res.status);
  }
  return data as T;
}

const M = "/v8/management";

// Key-list edits are read-modify-write; run them one at a time.
let keyLock: Promise<unknown> = Promise.resolve();
function withKeyLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = keyLock.then(fn, fn);
  keyLock = run.catch(() => undefined);
  return run;
}

interface RawCredential {
  id: string;
  name: string;
  provider?: string;
  type?: string;
  label?: string;
  email?: string;
  status?: string;
  status_message?: string;
  disabled?: boolean;
  unavailable?: boolean;
  requires_sign_in?: boolean;
  quota_blocked?: boolean;
  next_retry_after?: string;
  last_refresh?: string;
  access_token_expires_at?: string;
  account_type?: string;
  success?: number;
  failed?: number;
  recent_requests?: { time: string; success: number; failed: number }[];
}

export const proxy = {
  async health(): Promise<{ ok: boolean }> {
    const res = await fetch(new URL("/t3/v1/health", config.proxyUrl), { signal: AbortSignal.timeout(5000) });
    return (await res.json()) as { ok: boolean };
  },

  // --- client keys -------------------------------------------------------------
  async listKeys(): Promise<string[]> {
    const data = await call<string[] | { "api-keys"?: string[] }>("GET", `${M}/config/access/api-keys`);
    return Array.isArray(data) ? data : (data["api-keys"] ?? []);
  },
  async setKeys(keys: string[]): Promise<void> {
    await call("PUT", `${M}/config/access/api-keys`, keys);
  },
  async addKey(key: string, label: string): Promise<string> {
    await withKeyLock(async () => {
      const keys = await this.listKeys();
      if (!keys.includes(key)) await this.setKeys([...keys, key]);
    });
    const saved = await call<{ key: string }>("PUT", "/t3/v1/keys/_", { api_key: key, label, env: label });
    return saved.key;
  },
  /** Removes a key but never the last one: an empty list makes the proxy open. */
  async removeKey(key: string): Promise<void> {
    await withKeyLock(async () => {
      const keys = await this.listKeys();
      const next = keys.filter((k) => k !== key);
      if (next.length === keys.length) return;
      if (next.length === 0) throw new ProxyError("Refusing to remove the proxy's last client key", 409);
      await this.setKeys(next);
    });
  },

  // --- accounts ---------------------------------------------------------------
  async accounts(): Promise<Account[]> {
    const data = await call<{ files?: RawCredential[] }>("GET", `${M}/credentials`);
    return (data.files ?? []).map((f) => ({
      id: f.id,
      name: f.name,
      provider: (f.provider || f.type || "unknown").toLowerCase(),
      label: f.label || undefined,
      email: f.email || undefined,
      status: f.status ?? "unknown",
      statusMessage: f.status_message || undefined,
      disabled: !!f.disabled,
      unavailable: !!f.unavailable,
      requiresSignIn: !!f.requires_sign_in,
      quotaBlocked: !!f.quota_blocked,
      nextRetryAfter: f.next_retry_after || undefined,
      lastRefresh: f.last_refresh || undefined,
      accessTokenExpiresAt: f.access_token_expires_at || undefined,
      accountType: f.account_type || undefined,
      success: f.success ?? 0,
      failed: f.failed ?? 0,
      recent: f.recent_requests ?? [],
    }));
  },
  async setAccountDisabled(name: string, disabled: boolean): Promise<void> {
    await call("PATCH", `${M}/credentials/status`, { name, disabled });
  },
  async deleteAccount(name: string): Promise<void> {
    await call("DELETE", `${M}/credentials`, undefined, { name });
  },
  async refreshAccount(name: string): Promise<void> {
    await call("POST", `${M}/credentials/refresh`, { name });
  },
  async verifyAccount(name: string): Promise<unknown> {
    return call("POST", `${M}/credentials/verify`, { name });
  },
  async resetCooldowns(): Promise<void> {
    await call("POST", `${M}/routing/cooldown/reset`, {});
  },
  async routing(): Promise<{ strategy?: string }> {
    return call<{ strategy?: string }>("GET", `${M}/config/routing`).catch(() => ({}));
  },
  async setRoutingStrategy(strategy: string): Promise<void> {
    await call("PATCH", `${M}/config/routing`, { strategy });
  },

  // --- sign-in ----------------------------------------------------------------
  async oauthStart(provider: string): Promise<{ url: string; state: string }> {
    return call("GET", `${M}/oauth/auth-url`, undefined, { provider });
  },
  async oauthStatus(state: string): Promise<{ status: string; error?: string }> {
    return call("GET", `${M}/oauth/status`, undefined, { state });
  },
  async oauthCallback(body: { provider?: string; state?: string; code?: string; redirect_url?: string }): Promise<unknown> {
    return call("POST", `${M}/oauth/callback`, body);
  },
  async oauthCancel(state: string): Promise<void> {
    await call("DELETE", `${M}/oauth/session`, undefined, { state });
  },
  async deviceStart(): Promise<{ id: string; user_code: string; verification_url: string; expires_at: string }> {
    return call("POST", "/t3/v1/oauth/codex-device", {});
  },
  async deviceStatus(id: string): Promise<{ status: string; error?: string; email?: string }> {
    return call("GET", `/t3/v1/oauth/codex-device/${encodeURIComponent(id)}`);
  },
  async deviceCancel(id: string): Promise<void> {
    await call("DELETE", `/t3/v1/oauth/codex-device/${encodeURIComponent(id)}`);
  },

  // --- usage ------------------------------------------------------------------
  usage<T>(path: string, query: Record<string, string | undefined>): Promise<T> {
    return call<T>("GET", `/t3/v1/usage/${path}`, undefined, query);
  },
  async usageCsv(query: Record<string, string | undefined>): Promise<Response> {
    const url = new URL("/t3/v1/usage/export.csv", config.proxyUrl);
    for (const [k, v] of Object.entries(query)) if (v) url.searchParams.set(k, v);
    return fetch(url, { headers: { Authorization: `Bearer ${config.proxyManagementKey}` } });
  },
  async keyLabels(): Promise<{ key: string; label: string; env?: string }[]> {
    const data = await call<{ keys: { key: string; label: string; env?: string }[] }>("GET", "/t3/v1/keys");
    return data.keys ?? [];
  },
};
