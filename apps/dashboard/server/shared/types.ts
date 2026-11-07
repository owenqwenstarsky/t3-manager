// Types shared by the dashboard server and web UI.

export type EnvPhase =
  | "creating"
  | "starting"
  | "needs-login"
  | "joining"
  | "serve-failed"
  | "ready"
  | "stopped"
  | "error";

export interface EnvSummary {
  name: string;
  containerId: string;
  phase: EnvPhase;
  phaseDetail?: string;
  dockerState: string;
  health?: string;
  createdAt: number;
  owner?: string;
  hostname: string;
  tailnet?: {
    backendState: string;
    dnsName?: string;
    url?: string;
    authUrl?: string;
    ips: string[];
    online?: boolean;
  };
  proxyKeyFingerprint?: string;
  agentsConfigured: boolean;
  image: string;
}

export interface PairLink {
  pairUrl: string;
  hostedUrl: string;
  appLink: string;
  token: string;
  expiresAt: string;
  qrSvg: string;
}

export interface PairedSession {
  sessionId: string;
  method?: string;
  subject?: string;
  client?: unknown;
  connected?: boolean;
  issuedAt?: string;
  expiresAt?: string;
  lastConnectedAt?: string | null;
}

export interface PriceRule {
  /** Model id glob, e.g. "claude-opus-5-5*". First match wins. */
  match: string;
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  note?: string;
}

export interface Metrics {
  requests: number;
  failures: number;
  error_rate: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_creation: number;
  total: number;
  cache_hit_rate: number;
  streams: number;
  avg_latency_ms: number;
  p50_latency_ms: number;
  p95_latency_ms: number;
  max_latency_ms: number;
  avg_ttft_ms: number;
}

export interface CostedMetrics extends Metrics {
  /** Estimated USD at API list prices; null when no token in the bucket is priced. */
  cost: number | null;
  /** Tokens that matched no price rule. */
  unpriced_tokens: number;
}

export type UsageDim = "key" | "account" | "model" | "provider";

export interface UsagePoint extends CostedMetrics {
  t: number;
}

export interface UsageSeries {
  id: string;
  value: string;
  label: string;
  total: CostedMetrics;
  points: UsagePoint[];
}

export interface UsageTimeseries {
  from: number;
  to: number;
  step: string;
  stepMs: number;
  group: UsageDim | "none";
  total: CostedMetrics;
  series: UsageSeries[];
  unpricedModels: string[];
  dataFrom?: number;
}

export interface BreakdownRow {
  value: string;
  label: string;
  share: number;
  current: CostedMetrics;
  previous: CostedMetrics;
}

export interface UsageSummary {
  from: number;
  to: number;
  total: CostedMetrics;
  previous: CostedMetrics;
  breakdown: Record<UsageDim, BreakdownRow[]>;
  unpricedModels: string[];
}

export interface Account {
  id: string;
  name: string;
  provider: string;
  label?: string;
  email?: string;
  status: string;
  statusMessage?: string;
  disabled: boolean;
  unavailable: boolean;
  requiresSignIn: boolean;
  quotaBlocked: boolean;
  nextRetryAfter?: string;
  lastRefresh?: string;
  accessTokenExpiresAt?: string;
  accountType?: string;
  success: number;
  failed: number;
  recent: { time: string; success: number; failed: number }[];
}

export interface LimitWindow {
  id: string;
  label: string;
  used_percent: number;
  resets_at?: string;
  window_seconds?: number;
}

/** Subscription limits for one account, from GET /t3/v1/limits. */
export interface AccountLimits {
  auth_id: string;
  auth_index?: string;
  provider: string;
  plan?: string;
  /** live: provider usage endpoint (cached 5 min); headers: last proxied response; none: nothing yet. */
  source: "live" | "headers" | "none";
  observed_at?: string;
  fetched_at?: string;
  limit_reached: boolean;
  windows: LimitWindow[];
  extra_usage?: { enabled: boolean; used_percent?: number; used_credits?: number; monthly_limit?: number };
  credits?: { has_credits: boolean; unlimited: boolean; balance?: string };
  error?: string;
}

export interface LimitsResponse {
  accounts: AccountLimits[];
  ttl_seconds: number;
}

export interface OAuthStart {
  provider: "claude" | "codex";
  mode: "redirect" | "device";
  url: string;
  state: string;
  userCode?: string;
  expiresAt?: string;
}

export interface OAuthStatus {
  status: "wait" | "ok" | "error" | "cancelled";
  error?: string;
  email?: string;
}

export interface Settings {
  tsAuthKeySet: boolean;
  tsAuthKeyHint?: string;
  hostnamePrefix: string;
  image: string;
  pricing: PriceRule[];
  proxyUrl: string;
  authRequired: boolean;
}
