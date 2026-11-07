import { Pricer, addMetrics, emptyMetrics } from "./pricing.js";
import { proxy } from "./proxy.js";
import { settings } from "./settings.js";
import type {
  BreakdownRow,
  CostedMetrics,
  Metrics,
  UsageDim,
  UsageSeries,
  UsageSummary,
  UsageTimeseries,
} from "./shared/types.js";

export const DIMS: UsageDim[] = ["key", "account", "model", "provider"];

interface RawSeries {
  group: Record<string, string>;
  labels?: Record<string, string>;
  total: Metrics;
  points: (Metrics & { t: number })[];
}
interface RawTimeseries {
  from: number;
  to: number;
  step: string;
  step_ms: number;
  data_from?: number;
  series: RawSeries[];
}

export interface UsageQuery {
  from?: string;
  to?: string;
  step?: string;
  tz?: string;
  group?: UsageDim | "none";
  limit?: number;
  filters: Partial<Record<UsageDim, string>>;
}

/** Labels for raw dimension values: environment names for keys, emails for accounts. */
export async function labeller(): Promise<(dim: string, value: string, hint?: string) => string> {
  const [accounts, keys] = await Promise.all([proxy.accounts().catch(() => []), proxy.keyLabels().catch(() => [])]);
  const acct = new Map(accounts.map((a) => [a.id, a.email || a.label || a.name]));
  const keyMap = new Map(keys.map((k) => [k.key, k.label]));
  return (dim, value, hint) => {
    if (value === "other") return "Other";
    if (value === "unknown") return dim === "key" ? "No key" : "Unknown";
    if (dim === "key") return hint || keyMap.get(value) || `key ${value.slice(0, 6)}…`;
    if (dim === "account") return acct.get(value) || value.replace(/^.*:/, "").slice(0, 24);
    return value;
  };
}

function rawQuery(q: UsageQuery, group: string[], extra: Record<string, string> = {}) {
  return {
    from: q.from,
    to: q.to,
    step: q.step,
    tz: q.tz,
    group: group.join(","),
    limit: "1000",
    ...q.filters,
    ...extra,
  };
}

function protoGroup(group: UsageDim | "none"): string[] {
  return group === "none" || group === "model" ? ["model"] : [group, "model"];
}

interface Acc {
  value: string;
  hint?: string;
  total: CostedMetrics;
  points: CostedMetrics[];
}

export async function timeseries(q: UsageQuery): Promise<UsageTimeseries> {
  const group = q.group ?? "none";
  const limit = Math.max(1, Math.min(q.limit ?? 8, 25));
  const pricer = new Pricer(settings.raw.pricing);
  const [raw, label] = await Promise.all([
    proxy.usage<RawTimeseries>("timeseries", rawQuery(q, protoGroup(group))),
    labeller(),
  ]);
  const times = raw.series[0]?.points.map((p) => p.t) ?? [];
  const accs = new Map<string, Acc>();
  const unpriced = new Set<string>();
  const total = emptyMetrics();

  for (const s of raw.series) {
    const model = s.group.model ?? "unknown";
    const value = group === "none" ? "all" : group === "model" ? model : (s.group[group] ?? "unknown");
    let acc = accs.get(value);
    if (!acc) {
      acc = { value, hint: s.labels?.key, total: emptyMetrics(), points: times.map(() => emptyMetrics()) };
      accs.set(value, acc);
    }
    const seriesCost = pricer.cost(model, s.total);
    if (seriesCost === null && s.total.total > 0) unpriced.add(model);
    addMetrics(acc.total, s.total, seriesCost);
    addMetrics(total, s.total, seriesCost);
    s.points.forEach((p, i) => {
      if (p.requests > 0 && acc.points[i]) addMetrics(acc.points[i], p, pricer.cost(model, p));
    });
  }

  const rank = (a: Acc) => [a.total.cost ?? 0, a.total.total] as const;
  let list = [...accs.values()].sort((a, b) => {
    const [ca, ta] = rank(a);
    const [cb, tb] = rank(b);
    return cb - ca || tb - ta;
  });
  if (list.length > limit) {
    const other: Acc = { value: "other", total: emptyMetrics(), points: times.map(() => emptyMetrics()) };
    for (const a of list.slice(limit - 1)) {
      mergeCosted(other.total, a.total);
      a.points.forEach((p, i) => mergeCosted(other.points[i], p));
    }
    list = [...list.slice(0, limit - 1), other];
  }

  const series: UsageSeries[] = list.map((a) => ({
    id: a.value,
    value: a.value,
    label: group === "none" ? "All usage" : label(group, a.value, a.hint),
    total: a.total,
    points: a.points.map((p, i) => ({ ...p, t: times[i] })),
  }));

  return {
    from: raw.from,
    to: raw.to,
    step: raw.step,
    stepMs: raw.step_ms,
    group,
    total,
    series,
    unpricedModels: [...unpriced].sort(),
    dataFrom: raw.data_from,
  };
}

/** Merges two costed buckets (used for the "Other" series). */
function mergeCosted(acc: CostedMetrics, m: CostedMetrics): void {
  const unpriced = acc.unpriced_tokens + m.unpriced_tokens;
  addMetrics(acc, m, m.cost);
  acc.unpriced_tokens = unpriced;
}

async function totalsBy(
  q: UsageQuery,
  dim: UsageDim,
  from: string,
  to: string,
  pricer: Pricer,
  unpriced: Set<string>,
): Promise<{ rows: Map<string, { hint?: string; m: CostedMetrics }>; total: CostedMetrics }> {
  const raw = await proxy.usage<RawTimeseries>("timeseries", rawQuery({ ...q, from, to, step: undefined }, protoGroup(dim)));
  const rows = new Map<string, { hint?: string; m: CostedMetrics }>();
  const total = emptyMetrics();
  for (const s of raw.series) {
    const model = s.group.model ?? "unknown";
    const value = dim === "model" ? model : (s.group[dim] ?? "unknown");
    const cost = pricer.cost(model, s.total);
    if (cost === null && s.total.total > 0) unpriced.add(model);
    const row = rows.get(value) ?? { hint: s.labels?.key, m: emptyMetrics() };
    addMetrics(row.m, s.total, cost);
    rows.set(value, row);
    addMetrics(total, s.total, cost);
  }
  return { rows, total };
}

export async function summary(q: UsageQuery): Promise<UsageSummary> {
  const now = Date.now();
  const to = Number(q.to) || now;
  const from = Number(q.from) || to - 24 * 3600_000;
  const prevFrom = from - (to - from);
  const pricer = new Pricer(settings.raw.pricing);
  const unpriced = new Set<string>();
  const label = await labeller();

  const results = await Promise.all(
    DIMS.flatMap((dim) => [
      totalsBy(q, dim, String(from), String(to), pricer, unpriced),
      totalsBy(q, dim, String(prevFrom), String(from), pricer, new Set()),
    ]),
  );

  const breakdown = {} as Record<UsageDim, BreakdownRow[]>;
  let total = emptyMetrics();
  let previous = emptyMetrics();
  DIMS.forEach((dim, i) => {
    const cur = results[i * 2];
    const prev = results[i * 2 + 1];
    if (dim === "model") {
      total = cur.total;
      previous = prev.total;
    }
    const grand = cur.total.total || 1;
    breakdown[dim] = [...cur.rows.entries()]
      .map(([value, { hint, m }]) => ({
        value,
        label: label(dim, value, hint),
        share: m.total / grand,
        current: m,
        previous: prev.rows.get(value)?.m ?? emptyMetrics(),
      }))
      .sort((a, b) => (b.current.cost ?? 0) - (a.current.cost ?? 0) || b.current.total - a.current.total);
  });

  return { from, to, total, previous, breakdown, unpricedModels: [...unpriced].sort() };
}

interface RawEvent {
  ts: number;
  id: string;
  key?: string;
  key_label?: string;
  provider?: string;
  auth_id?: string;
  model?: string;
  stream?: boolean;
  input: number;
  output: number;
  reasoning?: number;
  cache_read?: number;
  cache_creation?: number;
  total: number;
  latency_ms: number;
  ttft_ms?: number;
  failed?: boolean;
  status?: number;
  fail_code?: string;
}

export async function events(query: Record<string, string | undefined>) {
  const pricer = new Pricer(settings.raw.pricing);
  const [data, label] = await Promise.all([proxy.usage<{ events: RawEvent[] }>("events", query), labeller()]);
  return {
    events: data.events.map((e) => ({
      ...e,
      key_label: label("key", e.key || "unknown", e.key_label),
      account_label: label("account", e.auth_id || "unknown"),
      cost: pricer.cost(e.model ?? "", {
        input: e.input,
        output: e.output,
        cache_read: e.cache_read ?? 0,
        cache_creation: e.cache_creation ?? 0,
      }),
    })),
  };
}

export async function windows(dim: UsageDim) {
  const [data, label] = await Promise.all([
    proxy.usage<{ windows: string[]; values: Record<string, Record<string, Metrics>>; labels?: Record<string, string> }>(
      "windows",
      { dim },
    ),
    labeller(),
  ]);
  return {
    windows: data.windows,
    rows: Object.entries(data.values)
      .map(([value, w]) => ({ value, label: label(dim, value, data.labels?.[value]), windows: w }))
      .sort((a, b) => (b.windows["24h"]?.total ?? 0) - (a.windows["24h"]?.total ?? 0)),
  };
}
