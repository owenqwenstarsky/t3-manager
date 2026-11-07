const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const full = new Intl.NumberFormat();

/** 1,284 under 10k; 12.9K / 4.2M above. */
export function num(n: number | null | undefined): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return Math.abs(n) < 10_000 ? full.format(Math.round(n)) : compact.format(n);
}

export function fullNum(n: number): string {
  return full.format(Math.round(n));
}

export function usd(n: number | null | undefined, opts: { precise?: boolean } = {}): string {
  if (n === null || n === undefined) return "–";
  if (n === 0) return "$0";
  const abs = Math.abs(n);
  if (abs < 0.01 && !opts.precise) return "<$0.01";
  if (abs < 1) return `$${n.toFixed(opts.precise ? 4 : 2)}`;
  if (abs < 10_000) return `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${compact.format(n)}`;
}

export function pct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "–";
  return `${(n * 100).toFixed(digits)}%`;
}

export function ms(n: number | null | undefined): string {
  if (!n) return "–";
  if (n < 1000) return `${Math.round(n)} ms`;
  if (n < 60_000) return `${(n / 1000).toFixed(n < 10_000 ? 2 : 1)} s`;
  return `${(n / 60_000).toFixed(1)} min`;
}

/** Relative change; null when there is no baseline. */
export function delta(cur: number, prev: number): number | null {
  if (!prev) return cur ? null : 0;
  return (cur - prev) / prev;
}

export function ago(ts: number | string | undefined): string {
  if (!ts) return "–";
  const t = typeof ts === "string" ? Date.parse(ts) : ts;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 0) return `in ${dur(-s)}`;
  if (s < 45) return "just now";
  return `${dur(s)} ago`;
}

export function dur(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

export function timeLabel(t: number, stepMs: number, windowMs: number): string {
  const d = new Date(t);
  if (stepMs >= 86_400_000) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  if (windowMs > 36 * 3_600_000) {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric" });
  }
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function dateTime(t: number): string {
  return new Date(t).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
