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
  /** Commit author git uses in this environment, e.g. "alice (T3) <alice@t3.invalid>". */
  gitAuthor?: string;
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
  /** The container runs an older build than the current environment image. */
  imageOutdated: boolean;
}

/** What an environment image contains (written at build time to /usr/local/share/t3m/toolchains.json). */
export interface ImageToolchains {
  built: string;
  toolchains: string;
  languages: { name: string; tools: string; default: string; versions: string[] }[];
  /** Tools that failed to install when the image was built. */
  missing: string[];
}

export interface ImageInfo {
  name: string;
  /** Not built yet. */
  missing?: boolean;
  id?: string;
  created?: string;
  /** Null for images built before toolchains were listed. */
  toolchains?: ImageToolchains | null;
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
  /** Configured git servers. Tokens and usernames are never sent to the browser. */
  gitCredentials: { host: string; customUsername: boolean; allowHttp: boolean; updatedAt: number }[];
  gitAuthor: { enabled: boolean; name: string; email: string };
  /** Gitea servers gt (the Gitea CLI) is logged in to. Tokens are never sent to the browser. */
  giteaServers: { url: string; isDefault: boolean; updatedAt: number }[];
  /** Markdown added to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md in every environment. */
  agentInstructions: string;
}

/** Result of pushing the global agent instructions into environment containers. */
export interface AgentSyncResult {
  /** Containers the instructions file was written to. */
  synced: number;
  /** Running environments whose CLAUDE.md and AGENTS.md were rewritten. */
  applied: string[];
  /** Stopped environments: they pick the instructions up on their next start. */
  unchecked: string[];
  /** Running on an image too old to apply them: rebuild the image and update the environment. */
  outdated: string[];
  failed: { env: string; error: string }[];
  /** Docker itself was unreachable. */
  error?: string;
}

/** Result of pushing git settings into environment containers. */
export interface GitSyncResult {
  synced: number;
  failed: { env: string; error: string }[];
  /** Per running environment and server: did git (as dev, prompts off) get a token? */
  checks: { env: string; host: string; protocol: string; ok: boolean; detail?: string }[];
  /** Stopped environments: files written, but git couldn't be checked. */
  unchecked: string[];
  /** Docker itself was unreachable. */
  error?: string;
}

/** Result of pushing the Gitea CLI servers into environment containers. */
export interface GiteaSyncResult {
  synced: number;
  failed: { env: string; error: string }[];
  /** Per running environment and server: did `gt auth login` (as dev) succeed? */
  checks: { env: string; url: string; ok: boolean; detail?: string }[];
  /** Running environments where gt did nothing, and why (e.g. gt isn't installed on an old image). */
  skipped: { env: string; reason: string }[];
  /** Messages that don't stop gt from working, such as the default server not being set. */
  warnings: { env: string; message: string }[];
  /** Stopped environments: files written; gt logs in when they next start. */
  unchecked: string[];
  /** Docker itself was unreachable. */
  error?: string;
}
