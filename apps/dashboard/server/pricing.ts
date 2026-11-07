import type { CostedMetrics, Metrics, PriceRule } from "./shared/types.js";

/**
 * Default price table (USD per million tokens) at Anthropic API list prices,
 * cached 2026-10-06. Cache read/write follow the published per-model rates or
 * the standard 0.1x / 1.25x of input. Subscription accounts are not billed per
 * token: these numbers estimate API-equivalent value. Everything is editable in
 * Settings. OpenAI/Codex models ship unpriced so no number is invented.
 */
export const DEFAULT_PRICING: PriceRule[] = [
  { match: "claude-fable-5-1*", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { match: "claude-mythos-5-1*", input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  { match: "claude-fable-5*", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: "claude-mythos*", input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  { match: "claude-opus-5-5*", input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  { match: "claude-opus-5*", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: "claude-opus-4-1*", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: "claude-opus-4-2025*", input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  { match: "claude-opus-4*", input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  { match: "claude-sonnet-5*", input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  { match: "claude-sonnet-4*", input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  { match: "claude-haiku-5*", input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  { match: "claude-haiku-4*", input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
];

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .trim()
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

export class Pricer {
  private readonly rules: { rule: PriceRule; re: RegExp }[];
  private readonly cache = new Map<string, PriceRule | null>();

  constructor(rules: PriceRule[]) {
    this.rules = rules.filter((r) => r.match.trim() !== "").map((rule) => ({ rule, re: globToRegExp(rule.match) }));
  }

  /** Finds the price rule for a model; "provider/model" prefixes are ignored. */
  ruleFor(model: string): PriceRule | null {
    const key = model.toLowerCase();
    if (this.cache.has(key)) return this.cache.get(key)!;
    const bare = key.includes("/") ? key.slice(key.lastIndexOf("/") + 1) : key;
    const hit = this.rules.find(({ re }) => re.test(key) || re.test(bare))?.rule ?? null;
    this.cache.set(key, hit);
    return hit;
  }

  /** Cost of a metrics bucket for one model, or null if the model is unpriced. */
  cost(model: string, m: Pick<Metrics, "input" | "output" | "cache_read" | "cache_creation">): number | null {
    const r = this.ruleFor(model);
    if (!r) return null;
    return (m.input * r.input + m.output * r.output + m.cache_read * r.cacheRead + m.cache_creation * r.cacheWrite) / 1e6;
  }
}

export function emptyMetrics(): CostedMetrics {
  return {
    requests: 0,
    failures: 0,
    error_rate: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cache_read: 0,
    cache_creation: 0,
    total: 0,
    cache_hit_rate: 0,
    streams: 0,
    avg_latency_ms: 0,
    p50_latency_ms: 0,
    p95_latency_ms: 0,
    max_latency_ms: 0,
    avg_ttft_ms: 0,
    cost: null,
    unpriced_tokens: 0,
  };
}

/** Adds metrics with cost into an accumulator. Latency fields are request-weighted. */
export function addMetrics(acc: CostedMetrics, m: Metrics, cost: number | null): void {
  const prevReq = acc.requests;
  const req = prevReq + m.requests;
  const weighted = (a: number, b: number) => (req > 0 ? Math.round((a * prevReq + b * m.requests) / req) : 0);
  acc.avg_latency_ms = weighted(acc.avg_latency_ms, m.avg_latency_ms);
  acc.avg_ttft_ms = weighted(acc.avg_ttft_ms, m.avg_ttft_ms);
  // Percentiles cannot be merged exactly; the request-weighted mean is a fair estimate.
  acc.p50_latency_ms = weighted(acc.p50_latency_ms, m.p50_latency_ms);
  acc.p95_latency_ms = Math.max(acc.p95_latency_ms, m.p95_latency_ms);
  acc.max_latency_ms = Math.max(acc.max_latency_ms, m.max_latency_ms);
  acc.requests = req;
  acc.failures += m.failures;
  acc.input += m.input;
  acc.output += m.output;
  acc.reasoning += m.reasoning;
  acc.cache_read += m.cache_read;
  acc.cache_creation += m.cache_creation;
  acc.total += m.total;
  acc.streams += m.streams;
  acc.error_rate = acc.requests > 0 ? acc.failures / acc.requests : 0;
  const denom = acc.input + acc.cache_read;
  acc.cache_hit_rate = denom > 0 ? acc.cache_read / denom : 0;
  if (cost === null) {
    acc.unpriced_tokens += m.total;
  } else {
    acc.cost = (acc.cost ?? 0) + cost;
  }
}

/** Metrics plus cost for a single-model bucket. */
export function withCost(m: Metrics, pricer: Pricer, model: string): CostedMetrics {
  const acc = emptyMetrics();
  addMetrics(acc, m, pricer.cost(model, m));
  // Keep the exact single-bucket percentiles.
  acc.p50_latency_ms = m.p50_latency_ms;
  acc.p95_latency_ms = m.p95_latency_ms;
  return acc;
}
