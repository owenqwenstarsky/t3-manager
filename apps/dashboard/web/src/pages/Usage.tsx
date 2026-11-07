import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Activity, CalendarRange, Download, Filter, RefreshCw, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { BreakdownRow, CostedMetrics, UsageDim, UsageSummary, UsageTimeseries } from "../../../server/shared/types";
import {
  Delta,
  LatencyChart,
  Legend,
  ShareBar,
  Sparkline,
  StackedTimeChart,
  StatTile,
  TokenMixChart,
  fmtMetric,
  latencyLegend,
  metricLabel,
  metricValue,
  seriesColor,
  tokenMixLegend,
  type Metric,
} from "../components/charts";
import { Button, Card, Notice, Segmented, Select, Spinner, cx, inputClass } from "../components/ui";
import { api, qs } from "../lib/api";
import { dateTime, ms, num, pct, usd } from "../lib/format";

const RANGES = [
  { value: "1h", label: "1H", ms: 3_600_000 },
  { value: "6h", label: "6H", ms: 6 * 3_600_000 },
  { value: "24h", label: "24H", ms: 86_400_000 },
  { value: "7d", label: "7D", ms: 7 * 86_400_000 },
  { value: "30d", label: "30D", ms: 30 * 86_400_000 },
  { value: "90d", label: "90D", ms: 90 * 86_400_000 },
  { value: "1y", label: "1Y", ms: 365 * 86_400_000 },
  { value: "custom", label: "Custom", ms: 0 },
] as const;
type RangeKey = (typeof RANGES)[number]["value"];

const STEPS = [
  { value: "auto", label: "Auto interval", ms: 0 },
  { value: "minute", label: "Per minute", ms: 60_000 },
  { value: "5m", label: "Per 5 minutes", ms: 300_000 },
  { value: "15m", label: "Per 15 minutes", ms: 900_000 },
  { value: "hour", label: "Hourly", ms: 3_600_000 },
  { value: "6h", label: "Every 6 hours", ms: 21_600_000 },
  { value: "day", label: "Daily", ms: 86_400_000 },
  { value: "week", label: "Weekly", ms: 604_800_000 },
];

export const DIM_LABEL: Record<UsageDim, string> = {
  key: "Environment",
  account: "Account",
  model: "Model",
  provider: "Provider",
};
const DIM_PLURAL: Record<UsageDim, string> = { key: "Environments", account: "Accounts", model: "Models", provider: "Providers" };

function toLocalInput(t: number): string {
  const d = new Date(t - new Date(t).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

/** Sums all series into one costed point list (for token mix, latency, trends). */
function combine(ts: UsageTimeseries | undefined) {
  if (!ts?.series.length) return [];
  return ts.series[0].points.map((_, i) => {
    const acc = { ...ts.series[0].points[i] };
    let latW = 0, ttftW = 0, p95 = 0, maxL = 0;
    const fields = ["requests", "failures", "input", "output", "reasoning", "cache_read", "cache_creation", "total", "streams", "unpriced_tokens"] as const;
    for (const f of fields) acc[f] = 0;
    acc.cost = null;
    for (const s of ts.series) {
      const p = s.points[i];
      for (const f of fields) acc[f] += p[f];
      if (p.cost !== null) acc.cost = (acc.cost ?? 0) + p.cost;
      latW += p.avg_latency_ms * p.requests;
      ttftW += p.avg_ttft_ms * p.requests;
      p95 = Math.max(p95, p.p95_latency_ms);
      maxL = Math.max(maxL, p.max_latency_ms);
    }
    acc.avg_latency_ms = acc.requests ? latW / acc.requests : 0;
    acc.avg_ttft_ms = acc.requests ? ttftW / acc.requests : 0;
    acc.p95_latency_ms = p95;
    acc.max_latency_ms = maxL;
    return acc;
  });
}

export function UsagePage({ initialFilters }: { initialFilters?: Partial<Record<UsageDim, string>> }) {
  const [range, setRange] = useState<RangeKey>("24h");
  const [custom, setCustom] = useState(() => ({ from: Date.now() - 7 * 86_400_000, to: Date.now() }));
  const [step, setStep] = useState("auto");
  const [group, setGroup] = useState<UsageDim | "none">("key");
  const [metric, setMetric] = useState<Metric>("cost");
  const [filters, setFilters] = useState<Partial<Record<UsageDim, string>>>(initialFilters ?? {});
  const [breakdownDim, setBreakdownDim] = useState<UsageDim>("key");
  const [auto, setAuto] = useState(true);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!auto || range === "custom") return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [auto, range]);

  const window_ = useMemo(() => {
    if (range === "custom") return { from: custom.from, to: custom.to };
    const r = RANGES.find((x) => x.value === range)!;
    const to = Math.ceil(now / 60_000) * 60_000;
    return { from: to - r.ms, to };
  }, [range, custom, now]);
  const windowMs = window_.to - window_.from;
  const tz = -new Date().getTimezoneOffset();

  const stepOptions = STEPS.filter((s) => s.ms === 0 || (windowMs / s.ms <= 2000 && windowMs / s.ms >= 2));
  useEffect(() => {
    if (!stepOptions.some((s) => s.value === step)) setStep("auto");
  }, [windowMs]); // eslint-disable-line react-hooks/exhaustive-deps

  const base = { from: window_.from, to: window_.to, tz, ...filters };
  const summary = useQuery({
    queryKey: ["usage-summary", base],
    queryFn: () => api<UsageSummary>(`/usage/summary${qs(base)}`),
    placeholderData: keepPreviousData,
  });
  const ts = useQuery({
    queryKey: ["usage-ts", base, group, step],
    queryFn: () =>
      api<UsageTimeseries>(`/usage/timeseries${qs({ ...base, group, step: step === "auto" ? undefined : step, limit: 8 })}`),
    placeholderData: keepPreviousData,
  });
  const live = useQuery({
    queryKey: ["usage-live"],
    queryFn: () => api<{ last_minute: CostedMetrics; last_5_minutes: CostedMetrics; points: { t: number; requests: number; total: number }[]; active_keys: number }>("/usage/live"),
    refetchInterval: auto ? 10_000 : false,
  });

  const combined = useMemo(() => combine(ts.data), [ts.data]);
  const s = summary.data;
  const t = s?.total;
  const p = s?.previous;
  const error = summary.error ?? ts.error;
  const loading = summary.isLoading || ts.isLoading;
  const fetching = summary.isFetching || ts.isFetching;
  const activeFilters = Object.entries(filters).filter(([, v]) => v) as [UsageDim, string][];
  const filterLabel = (dim: UsageDim, value: string) => s?.breakdown[dim]?.find((r) => r.value === value)?.label ?? value;

  return (
    <div className="space-y-5">
      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={range} onChange={setRange} options={RANGES.map((r) => ({ value: r.value, label: r.label }))} />
        {range === "custom" && (
          <div className="flex items-center gap-1.5">
            <CalendarRange className="size-4 text-ink-3" />
            <input
              type="datetime-local"
              className={cx(inputClass, "!w-auto h-8 text-[13px]")}
              value={toLocalInput(custom.from)}
              max={toLocalInput(custom.to)}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, from: new Date(e.target.value).getTime() }))}
            />
            <span className="text-ink-3 text-sm">to</span>
            <input
              type="datetime-local"
              className={cx(inputClass, "!w-auto h-8 text-[13px]")}
              value={toLocalInput(custom.to)}
              min={toLocalInput(custom.from)}
              onChange={(e) => e.target.value && setCustom((c) => ({ ...c, to: new Date(e.target.value).getTime() }))}
            />
          </div>
        )}
        <Select label="Interval" value={step} onChange={setStep} options={stepOptions} className="h-8 text-[13px]" />
        <div className="flex-1" />
        <span className="text-xs text-ink-3 hidden md:inline">
          {dateTime(window_.from)} – {dateTime(window_.to)}
        </span>
        <Button size="sm" variant="ghost" icon={<RefreshCw className={cx("size-4", fetching && "animate-spin")} />} onClick={() => setNow(Date.now())}>
          {auto && range !== "custom" ? "Live" : "Refresh"}
        </Button>
        <Button
          size="sm"
          icon={<Download className="size-4" />}
          onClick={() => window.open(`/api/usage/export.csv${qs({ from: window_.from, to: window_.to, ...filters })}`, "_blank")}
        >
          CSV
        </Button>
      </div>

      {activeFilters.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-[13px]">
          <Filter className="size-4 text-ink-3" />
          {activeFilters.map(([dim, value]) => (
            <span key={dim} className="inline-flex items-center gap-1 rounded-full bg-accent-wash px-2.5 py-1 text-ink">
              <span className="text-ink-3">{DIM_LABEL[dim]}:</span> {filterLabel(dim, value)}
              <button aria-label="Remove filter" onClick={() => setFilters((f) => ({ ...f, [dim]: undefined }))} className="ml-0.5 text-ink-3 hover:text-ink">
                <X className="size-3.5" />
              </button>
            </span>
          ))}
          <button onClick={() => setFilters({})} className="text-ink-3 hover:text-ink underline-offset-2 hover:underline">
            Clear all
          </button>
        </div>
      )}

      {error && <Notice tone="critical" title="Usage data unavailable">{(error as Error).message}</Notice>}
      {s && s.unpricedModels.length > 0 && (
        <Notice tone="warning" title="Some models have no price">
          {s.unpricedModels.join(", ")} {s.unpricedModels.length === 1 ? "is" : "are"} excluded from cost estimates
          ({num(t?.unpriced_tokens)} tokens). Add a price in Settings → Pricing.
        </Notice>
      )}

      {/* KPI tiles */}
      <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatTile
          label="Estimated cost"
          hint="API-equivalent value at list prices. Subscription accounts are not billed per token."
          value={t ? usd(t.cost ?? 0) : "–"}
          deltaNode={t && p && <Delta cur={t.cost ?? 0} prev={p.cost ?? 0} upIsGood={false} />}
          trend={combined.map((x) => x.cost ?? 0)}
        />
        <StatTile
          label="Tokens"
          value={t ? num(t.total) : "–"}
          sub={t && `${num(t.input + t.cache_read + t.cache_creation)} in · ${num(t.output)} out`}
          deltaNode={t && p && <Delta cur={t.total} prev={p.total} />}
          trend={combined.map((x) => x.total)}
        />
        <StatTile
          label="Requests"
          value={t ? num(t.requests) : "–"}
          sub={t && t.requests > 0 && `${num(t.total / t.requests)} tokens / request`}
          deltaNode={t && p && <Delta cur={t.requests} prev={p.requests} />}
          trend={combined.map((x) => x.requests)}
        />
        <StatTile
          label="Cache hit rate"
          hint="Cache reads as a share of all input tokens."
          value={t ? pct(t.cache_hit_rate) : "–"}
          deltaNode={t && p && <Delta cur={t.cache_hit_rate} prev={p.cache_hit_rate} upIsGood />}
        />
        <StatTile
          label="Error rate"
          value={t ? pct(t.error_rate) : "–"}
          sub={t && `${num(t.failures)} failed attempts`}
          deltaNode={t && p && <Delta cur={t.error_rate} prev={p.error_rate} upIsGood={false} />}
        />
        <StatTile
          label="p95 latency"
          value={t ? ms(t.p95_latency_ms) : "–"}
          sub={t && t.avg_ttft_ms > 0 && `${ms(t.avg_ttft_ms)} to first token`}
          deltaNode={t && p && p.requests > 0 && <Delta cur={t.p95_latency_ms} prev={p.p95_latency_ms} upIsGood={false} />}
        />
      </div>

      {/* Main chart */}
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <h2 className="text-[15px] font-semibold">
              {metricLabel[metric]} over time{group !== "none" && ` by ${DIM_LABEL[group].toLowerCase()}`}
            </h2>
            <p className="text-[13px] text-ink-3 mt-0.5">
              {t ? fmtMetric(metricValue(t, metric), metric) : "–"} in this period
              {ts.data && ` · ${STEPS.find((x) => x.value === ts.data.step)?.label.toLowerCase() ?? ts.data.step}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              value={metric}
              onChange={setMetric}
              options={[
                { value: "cost", label: "Cost" },
                { value: "tokens", label: "Tokens" },
                { value: "requests", label: "Requests" },
              ]}
            />
            <Select
              label="Group by"
              value={group}
              onChange={setGroup}
              className="h-8 text-[13px]"
              options={[
                { value: "key", label: "By environment" },
                { value: "account", label: "By account" },
                { value: "model", label: "By model" },
                { value: "provider", label: "By provider" },
                { value: "none", label: "No grouping" },
              ]}
            />
          </div>
        </div>
        {loading ? (
          <div className="h-[280px] grid place-items-center"><Spinner /></div>
        ) : ts.data && ts.data.total.requests > 0 ? (
          <>
            <StackedTimeChart series={ts.data.series} metric={metric} stepMs={ts.data.stepMs} windowMs={windowMs} colorScope={ts.data.group} />
            {ts.data.series.length > 1 && (
              <div className="mt-3">
                <Legend
                  items={ts.data.series.map((x) => ({
                    id: x.id,
                    label: x.label,
                    color: seriesColor(ts.data!.group, x.value),
                    value: fmtMetric(metricValue(x.total, metric), metric),
                  }))}
                />
              </div>
            )}
            {ts.data.dataFrom && (
              <p className="mt-3 text-xs text-ink-3">Request-level history starts {dateTime(ts.data.dataFrom)}; pick an hourly or larger interval for older data.</p>
            )}
          </>
        ) : (
          <div className="h-[280px] grid place-items-center text-center">
            <div>
              <Activity className="size-6 mx-auto text-ink-3" />
              <p className="mt-2 text-sm text-ink-2">No model requests in this period</p>
              <p className="text-xs text-ink-3 mt-1">Usage appears here as soon as an environment sends a request through the proxy.</p>
            </div>
          </div>
        )}
      </Card>

      {/* Token mix + latency */}
      {ts.data && ts.data.total.requests > 0 && (
        <div className="grid lg:grid-cols-2 gap-5">
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold">Token mix</h2>
            <p className="text-[13px] text-ink-3 mt-0.5 mb-4">
              {t && `${pct(t.cache_hit_rate)} of input served from cache · ${num(t.reasoning)} reasoning tokens`}
            </p>
            <TokenMixChart points={combined} stepMs={ts.data.stepMs} windowMs={windowMs} />
            <div className="mt-3"><Legend items={tokenMixLegend} /></div>
          </Card>
          <Card className="p-5">
            <h2 className="text-[15px] font-semibold">Latency</h2>
            <p className="text-[13px] text-ink-3 mt-0.5 mb-4">
              {t && `${ms(t.avg_latency_ms)} average · ${ms(t.p95_latency_ms)} p95 · ${ms(t.max_latency_ms)} slowest`}
            </p>
            <LatencyChart points={combined} stepMs={ts.data.stepMs} windowMs={windowMs} />
            <div className="mt-3"><Legend items={latencyLegend} /></div>
          </Card>
        </div>
      )}

      {/* Breakdown table */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h2 className="text-[15px] font-semibold">Breakdown</h2>
            <p className="text-[13px] text-ink-3 mt-0.5">Change is against the previous {RANGES.find((r) => r.value === range)?.label ?? "period"} window. Select a row to filter.</p>
          </div>
          <Segmented
            value={breakdownDim}
            onChange={setBreakdownDim}
            options={(["key", "account", "model", "provider"] as UsageDim[]).map((d) => ({ value: d, label: DIM_PLURAL[d] }))}
          />
        </div>
        <BreakdownTable
          rows={s?.breakdown[breakdownDim] ?? []}
          dim={breakdownDim}
          active={filters[breakdownDim]}
          onSelect={(v) => setFilters((f) => ({ ...f, [breakdownDim]: f[breakdownDim] === v ? undefined : v }))}
        />
      </Card>

      <div className="grid xl:grid-cols-[1fr_320px] gap-5">
        <RecentRequests filters={filters} from={window_.from} />
        <Card className="p-5 self-start">
          <h2 className="text-[15px] font-semibold">Right now</h2>
          <p className="text-[13px] text-ink-3 mt-0.5 mb-4">Last 60 minutes, per minute</p>
          {live.data ? (
            <>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <div className="text-xs text-ink-3">Requests / min</div>
                  <div className="text-xl font-semibold tabular">{num(live.data.last_5_minutes.requests / 5)}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-3">Tokens / min</div>
                  <div className="text-xl font-semibold tabular">{num(live.data.last_5_minutes.total / 5)}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-3">Active environments</div>
                  <div className="text-xl font-semibold tabular">{live.data.active_keys}</div>
                </div>
                <div>
                  <div className="text-xs text-ink-3">Errors (5 min)</div>
                  <div className="text-xl font-semibold tabular">{num(live.data.last_5_minutes.failures)}</div>
                </div>
              </div>
              <Sparkline values={live.data.points.map((x) => x.total)} height={56} />
              <div className="flex justify-between text-[11px] text-ink-3 mt-1">
                <span>60 min ago</span>
                <span>now</span>
              </div>
            </>
          ) : (
            <Spinner />
          )}
        </Card>
      </div>
    </div>
  );
}

function BreakdownTable({ rows, dim, active, onSelect }: { rows: BreakdownRow[]; dim: UsageDim; active?: string; onSelect: (v: string) => void }) {
  if (!rows.length) return <p className="py-8 text-center text-sm text-ink-3">No data for this period.</p>;
  return (
    <div className="overflow-x-auto -mx-5">
      <table className="w-full text-[13px] tabular">
        <thead>
          <tr className="text-left text-ink-3 border-b border-line">
            <th className="font-medium py-2 pl-5 pr-3">{DIM_LABEL[dim]}</th>
            <th className="font-medium py-2 px-3 w-40">Share of tokens</th>
            <th className="font-medium py-2 px-3 text-right">Requests</th>
            <th className="font-medium py-2 px-3 text-right">Input</th>
            <th className="font-medium py-2 px-3 text-right">Cache read</th>
            <th className="font-medium py-2 px-3 text-right">Output</th>
            <th className="font-medium py-2 px-3 text-right">Total tokens</th>
            <th className="font-medium py-2 px-3 text-right">Est. cost</th>
            <th className="font-medium py-2 px-3 text-right">Change</th>
            <th className="font-medium py-2 pl-3 pr-5 text-right">Errors</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const color = seriesColor(dim, r.value);
            return (
              <tr
                key={r.value}
                onClick={() => onSelect(r.value)}
                className={cx("border-b border-line last:border-0 cursor-pointer hover:bg-surface-2", active === r.value && "bg-accent-wash")}
              >
                <td className="py-2.5 pl-5 pr-3">
                  <span className="inline-flex items-center gap-2 min-w-0">
                    <span className="size-2.5 rounded-[3px] shrink-0" style={{ background: color }} />
                    <span className="truncate max-w-64 text-ink font-medium">{r.label}</span>
                  </span>
                </td>
                <td className="py-2.5 px-3">
                  <div className="flex items-center gap-2">
                    <ShareBar share={r.share} color={color} />
                    <span className="text-ink-3 w-10 text-right">{pct(r.share, 0)}</span>
                  </div>
                </td>
                <td className="py-2.5 px-3 text-right">{num(r.current.requests)}</td>
                <td className="py-2.5 px-3 text-right text-ink-2">{num(r.current.input)}</td>
                <td className="py-2.5 px-3 text-right text-ink-2">{num(r.current.cache_read)}</td>
                <td className="py-2.5 px-3 text-right text-ink-2">{num(r.current.output)}</td>
                <td className="py-2.5 px-3 text-right font-medium">{num(r.current.total)}</td>
                <td className="py-2.5 px-3 text-right font-medium">{r.current.cost === null ? <span className="text-ink-3">unpriced</span> : usd(r.current.cost)}</td>
                <td className="py-2.5 px-3 text-right">
                  <Delta cur={r.current.cost ?? r.current.total} prev={r.previous.cost ?? r.previous.total} label="" />
                </td>
                <td className="py-2.5 pl-3 pr-5 text-right">
                  {r.current.failures > 0 ? <span className="text-critical-ink">{num(r.current.failures)}</span> : <span className="text-ink-3">0</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface EventRow {
  ts: number;
  id: string;
  key_label: string;
  account_label: string;
  model?: string;
  provider?: string;
  stream?: boolean;
  input: number;
  output: number;
  cache_read?: number;
  cache_creation?: number;
  total: number;
  latency_ms: number;
  ttft_ms?: number;
  failed?: boolean;
  status?: number;
  cost: number | null;
}

function RecentRequests({ filters, from }: { filters: Partial<Record<UsageDim, string>>; from: number }) {
  const [failedOnly, setFailedOnly] = useState(false);
  const q = useInfiniteQuery({
    queryKey: ["usage-events", filters, failedOnly, from],
    initialPageParam: 0,
    queryFn: ({ pageParam }) =>
      api<{ events: EventRow[] }>(`/usage/events${qs({ ...filters, limit: 25, before: pageParam || undefined, failed: failedOnly ? "1" : undefined, from })}`),
    getNextPageParam: (last) => (last.events.length === 25 ? last.events[last.events.length - 1].ts : undefined),
    refetchInterval: 30_000,
  });
  const rows = q.data?.pages.flatMap((p) => p.events) ?? [];
  return (
    <Card className="p-5 min-w-0">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-[15px] font-semibold">Recent requests</h2>
          <p className="text-[13px] text-ink-3 mt-0.5">Every upstream attempt, newest first</p>
        </div>
        <Segmented
          value={failedOnly ? "failed" : "all"}
          onChange={(v) => setFailedOnly(v === "failed")}
          options={[
            { value: "all", label: "All" },
            { value: "failed", label: "Failed" },
          ]}
        />
      </div>
      {q.isLoading ? (
        <Spinner />
      ) : rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-3">No requests in this period.</p>
      ) : (
        <div className="overflow-x-auto -mx-5">
          <table className="w-full text-[13px] tabular">
            <thead>
              <tr className="text-left text-ink-3 border-b border-line">
                <th className="font-medium py-2 pl-5 pr-3">Time</th>
                <th className="font-medium py-2 px-3">Environment</th>
                <th className="font-medium py-2 px-3">Model</th>
                <th className="font-medium py-2 px-3">Account</th>
                <th className="font-medium py-2 px-3 text-right">In / cache / out</th>
                <th className="font-medium py-2 px-3 text-right">Latency</th>
                <th className="font-medium py-2 px-3 text-right">Cost</th>
                <th className="font-medium py-2 pl-3 pr-5">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id + e.ts} className="border-b border-line last:border-0">
                  <td className="py-2 pl-5 pr-3 text-ink-2 whitespace-nowrap">{dateTime(e.ts)}</td>
                  <td className="py-2 px-3 truncate max-w-40">{e.key_label}</td>
                  <td className="py-2 px-3 font-mono text-xs truncate max-w-48">{e.model ?? "–"}</td>
                  <td className="py-2 px-3 text-ink-2 truncate max-w-48">{e.account_label}</td>
                  <td className="py-2 px-3 text-right text-ink-2 whitespace-nowrap">
                    {num(e.input)} / {num(e.cache_read ?? 0)} / {num(e.output)}
                  </td>
                  <td className="py-2 px-3 text-right whitespace-nowrap">
                    {ms(e.latency_ms)}
                    {e.ttft_ms ? <span className="text-ink-3"> · {ms(e.ttft_ms)}</span> : null}
                  </td>
                  <td className="py-2 px-3 text-right">{e.cost === null ? <span className="text-ink-3">–</span> : usd(e.cost, { precise: e.cost < 0.01 })}</td>
                  <td className="py-2 pl-3 pr-5 whitespace-nowrap">
                    {e.failed ? (
                      <span className="text-critical-ink">Failed{e.status ? ` · ${e.status}` : ""}</span>
                    ) : (
                      <span className="text-ink-3">OK{e.stream ? " · stream" : ""}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && (
        <div className="mt-3 flex justify-center">
          <Button size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>
            Load older requests
          </Button>
        </div>
      )}
    </Card>
  );
}
