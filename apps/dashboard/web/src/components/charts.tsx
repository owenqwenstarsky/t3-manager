import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from "recharts";
import type { CostedMetrics, UsagePoint, UsageSeries } from "../../../server/shared/types";
import { delta, ms, num, pct, timeLabel, usd } from "../lib/format";
import { cx } from "./ui";

// ---------------------------------------------------------------------------
// Colors: categorical slots in fixed order; a value keeps its slot for the
// session, so filters never repaint surviving series. "Other" is gray.
const SLOTS = 8;
const registry = new Map<string, Map<string, number>>();
export function seriesColor(scope: string, value: string): string {
  if (value === "other") return "var(--s-other)";
  let m = registry.get(scope);
  if (!m) registry.set(scope, (m = new Map()));
  if (!m.has(value)) m.set(value, m.size % SLOTS);
  return `var(--s${m.get(value)! + 1})`;
}

export type Metric = "cost" | "tokens" | "requests";
export const metricLabel: Record<Metric, string> = { cost: "Estimated cost", tokens: "Tokens", requests: "Requests" };
export function metricValue(m: CostedMetrics, metric: Metric): number {
  if (metric === "cost") return m.cost ?? 0;
  if (metric === "tokens") return m.total;
  return m.requests;
}
export function fmtMetric(v: number, metric: Metric): string {
  return metric === "cost" ? usd(v) : num(v);
}

// ---------------------------------------------------------------------------
export function Delta({ cur, prev, upIsGood, label = "vs previous period" }: { cur: number; prev: number; upIsGood?: boolean; label?: string }) {
  const d = delta(cur, prev);
  if (d === null) return <span className="text-xs text-ink-3">{label ? "new this period" : "new"}</span>;
  const flat = Math.abs(d) < 0.005;
  const good = flat || upIsGood === undefined ? null : d > 0 === upIsGood;
  const Icon = flat ? Minus : d > 0 ? ArrowUpRight : ArrowDownRight;
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <span
        className={cx("inline-flex items-center gap-0.5 font-medium tabular", good === null ? "text-ink-2" : good ? "text-good-ink" : "text-critical-ink")}
      >
        <Icon className="size-3.5" />
        {flat ? "0%" : d >= 10 ? `${Math.round(d + 1)}×` : `${d > 0 ? "+" : ""}${(d * 100).toFixed(Math.abs(d) < 0.1 ? 1 : 0)}%`}
      </span>
      <span className="text-ink-3">{label}</span>
    </span>
  );
}

export function Sparkline({ values, color = "var(--accent)", height = 32 }: { values: number[]; color?: string; height?: number }) {
  const w = 120;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => `${(i / Math.max(values.length - 1, 1)) * w},${height - 2 - (v / max) * (height - 4)}`);
  return (
    <svg viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <polyline points={`0,${height} ${pts.join(" ")} ${w},${height}`} fill={color} opacity={0.1} stroke="none" />
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function StatTile({
  label,
  value,
  sub,
  deltaNode,
  trend,
  hint,
}: {
  label: string;
  value: string;
  sub?: ReactNode;
  deltaNode?: ReactNode;
  trend?: number[];
  hint?: string;
}) {
  return (
    <div className="card p-4 flex flex-col gap-1 min-w-0" title={hint}>
      <div className="text-[13px] text-ink-3">{label}</div>
      <div className="text-2xl font-semibold tracking-tight text-ink truncate">{value}</div>
      <div className="min-h-4">{deltaNode}</div>
      {sub && <div className="text-xs text-ink-3">{sub}</div>}
      {trend && trend.length > 1 && (
        <div className="mt-1">
          <Sparkline values={trend} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
export function Legend({ items }: { items: { id: string; label: string; color: string; value?: string }[] }) {
  return (
    <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[13px]">
      {items.map((i) => (
        <span key={i.id} className="inline-flex items-center gap-1.5 text-ink-2 min-w-0">
          <span className="size-2.5 rounded-[3px] shrink-0" style={{ background: i.color }} />
          <span className="truncate max-w-48">{i.label}</span>
          {i.value && <span className="text-ink-3 tabular">{i.value}</span>}
        </span>
      ))}
    </div>
  );
}

function axisTick(metric: Metric) {
  return (v: number) => (metric === "cost" ? usd(v) : num(v));
}

const axisProps = {
  stroke: "var(--ink-3)",
  tick: { fill: "var(--ink-3)", fontSize: 11 },
  tickLine: false,
  axisLine: { stroke: "var(--line-strong)" },
} as const;

interface Row {
  t: number;
  [series: string]: number;
}

function ChartTooltip({
  active,
  payload,
  label,
  metric,
  stepMs,
  windowMs,
  names,
  colors,
}: TooltipContentProps<number, string> & { metric: Metric; stepMs: number; windowMs: number; names: Map<string, string>; colors: Map<string, string> }) {
  if (!active || !payload?.length) return null;
  const items = payload.filter((p) => typeof p.value === "number").sort((a, b) => Number(b.value) - Number(a.value));
  const total = items.reduce((s, p) => s + Number(p.value), 0);
  return (
    <div className="card px-3 py-2.5 shadow-xl text-[13px] min-w-52">
      <div className="text-ink-3 text-xs mb-1.5">{timeLabel(Number(label), stepMs, windowMs)}</div>
      {items.length > 1 && (
        <div className="flex justify-between gap-6 font-medium text-ink pb-1.5 mb-1.5 border-b border-line">
          <span>Total</span>
          <span className="tabular">{fmtMetric(total, metric)}</span>
        </div>
      )}
      {items.slice(0, 10).map((p) => (
        <div key={String(p.dataKey)} className="flex items-center justify-between gap-6 py-0.5">
          <span className="inline-flex items-center gap-1.5 text-ink-2 min-w-0">
            <span className="size-2.5 rounded-[3px] shrink-0" style={{ background: colors.get(String(p.dataKey)) }} />
            <span className="truncate max-w-40">{names.get(String(p.dataKey))}</span>
          </span>
          <span className="tabular text-ink">{fmtMetric(Number(p.value), metric)}</span>
        </div>
      ))}
    </div>
  );
}

/** Stacked columns over time, one segment per series. */
export function StackedTimeChart({
  series,
  metric,
  stepMs,
  windowMs,
  colorScope,
  height = 280,
}: {
  series: UsageSeries[];
  metric: Metric;
  stepMs: number;
  windowMs: number;
  colorScope: string;
  height?: number;
}) {
  const { rows, names, colors } = useMemo(() => {
    const names = new Map<string, string>();
    const colors = new Map<string, string>();
    const rows: Row[] = (series[0]?.points ?? []).map((p) => ({ t: p.t }));
    series.forEach((s, si) => {
      const key = `s${si}`;
      names.set(key, s.label);
      colors.set(key, seriesColor(colorScope, s.value));
      s.points.forEach((p, i) => {
        if (rows[i]) rows[i][key] = metricValue(p, metric);
      });
    });
    return { rows, names, colors };
  }, [series, metric, colorScope]);

  const keys = [...names.keys()];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis
          dataKey="t"
          {...axisProps}
          tickFormatter={(t: number) => timeLabel(t, stepMs, windowMs)}
          minTickGap={28}
        />
        <YAxis {...axisProps} axisLine={false} width={metric === "cost" ? 64 : 52} tickFormatter={axisTick(metric)} />
        <Tooltip
          cursor={{ fill: "var(--surface-3)", opacity: 0.6 }}
          content={(props) => (
            <ChartTooltip {...(props as TooltipContentProps<number, string>)} metric={metric} stepMs={stepMs} windowMs={windowMs} names={names} colors={colors} />
          )}
        />
        {keys.map((k, i) => (
          <Bar
            key={k}
            dataKey={k}
            stackId="a"
            fill={colors.get(k)}
            stroke="var(--surface)"
            strokeWidth={1}
            maxBarSize={24}
            radius={i === keys.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Token composition: uncached input, cache read, cache write and output per bucket. */
export function TokenMixChart({ points, stepMs, windowMs, height = 220 }: { points: UsagePoint[]; stepMs: number; windowMs: number; height?: number }) {
  const parts = [
    { key: "input", label: "Input (uncached)", color: "var(--s1)" },
    { key: "cache_read", label: "Cache read", color: "var(--s3)" },
    { key: "cache_creation", label: "Cache write", color: "var(--s4)" },
    { key: "output", label: "Output", color: "var(--s2)" },
  ] as const;
  const names = new Map<string, string>(parts.map((p) => [p.key, p.label]));
  const colors = new Map<string, string>(parts.map((p) => [p.key, p.color]));
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barCategoryGap="18%">
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis dataKey="t" {...axisProps} tickFormatter={(t: number) => timeLabel(t, stepMs, windowMs)} minTickGap={28} />
        <YAxis {...axisProps} axisLine={false} width={52} tickFormatter={axisTick("tokens")} />
        <Tooltip
          cursor={{ fill: "var(--surface-3)", opacity: 0.6 }}
          content={(props) => (
            <ChartTooltip {...(props as TooltipContentProps<number, string>)} metric="tokens" stepMs={stepMs} windowMs={windowMs} names={names} colors={colors} />
          )}
        />
        {parts.map((p, i) => (
          <Bar
            key={p.key}
            dataKey={p.key}
            stackId="a"
            fill={p.color}
            stroke="var(--surface)"
            strokeWidth={1}
            maxBarSize={24}
            radius={i === parts.length - 1 ? [4, 4, 0, 0] : 0}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}

export const tokenMixLegend = [
  { id: "input", label: "Input (uncached)", color: "var(--s1)" },
  { id: "cache_read", label: "Cache read", color: "var(--s3)" },
  { id: "cache_creation", label: "Cache write", color: "var(--s4)" },
  { id: "output", label: "Output (incl. reasoning)", color: "var(--s2)" },
];

/** Latency lines (ms) on one axis: average, p95 and time to first token. */
export function LatencyChart({ points, stepMs, windowMs, height = 220 }: { points: UsagePoint[]; stepMs: number; windowMs: number; height?: number }) {
  const data = points.map((p) => ({
    t: p.t,
    avg: p.requests ? p.avg_latency_ms : null,
    p95: p.requests ? p.p95_latency_ms : null,
    ttft: p.requests && p.avg_ttft_ms ? p.avg_ttft_ms : null,
  }));
  const lines = [
    { key: "p95", label: "p95 latency", color: "var(--s2)" },
    { key: "avg", label: "Average latency", color: "var(--s1)" },
    { key: "ttft", label: "Time to first token", color: "var(--s3)" },
  ];
  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid vertical={false} stroke="var(--line)" />
        <XAxis dataKey="t" {...axisProps} tickFormatter={(t: number) => timeLabel(t, stepMs, windowMs)} minTickGap={28} />
        <YAxis {...axisProps} axisLine={false} width={56} tickFormatter={(v: number) => ms(v)} />
        <Tooltip
          cursor={{ stroke: "var(--line-strong)", strokeWidth: 1 }}
          content={({ active, payload, label }) =>
            active && payload?.length ? (
              <div className="card px-3 py-2.5 shadow-xl text-[13px] min-w-48">
                <div className="text-ink-3 text-xs mb-1.5">{timeLabel(Number(label), stepMs, windowMs)}</div>
                {lines.map((l) => {
                  const v = payload.find((p) => p.dataKey === l.key)?.value;
                  return (
                    <div key={l.key} className="flex items-center justify-between gap-6 py-0.5">
                      <span className="inline-flex items-center gap-1.5 text-ink-2">
                        <span className="h-0.5 w-3 rounded" style={{ background: l.color }} />
                        {l.label}
                      </span>
                      <span className="tabular text-ink">{typeof v === "number" ? ms(v) : "–"}</span>
                    </div>
                  );
                })}
              </div>
            ) : null
          }
        />
        {lines.map((l) => (
          <Line
            key={l.key}
            dataKey={l.key}
            stroke={l.color}
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }}
            connectNulls
            isAnimationActive={false}
          />
        ))}
      </LineChart>
    </ResponsiveContainer>
  );
}

export const latencyLegend = [
  { id: "p95", label: "p95 latency", color: "var(--s2)" },
  { id: "avg", label: "Average latency", color: "var(--s1)" },
  { id: "ttft", label: "Time to first token", color: "var(--s3)" },
];

export function ShareBar({ share, color }: { share: number; color: string }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-surface-3 overflow-hidden" aria-hidden>
      <div className="h-full rounded-full" style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%`, background: color }} />
    </div>
  );
}

export { pct };
