import type { AccountLimits, LimitWindow } from "./types.js";

export type LimitTone = "good" | "warning" | "critical" | "neutral";

export interface LimitView {
  id: string;
  label: string;
  /** Percent of the window still available, 0-100. */
  remaining: number;
  used: number;
  /** The reset time has passed since the snapshot, so the window is fresh again. */
  hasReset: boolean;
  resetsAt?: number;
  resetsIn?: string;
  tone: LimitTone;
}

/** "45m", "2h 14m", "3d 4h". */
export function formatResetsIn(ms: number): string {
  const totalMin = Math.max(1, Math.ceil(ms / 60_000));
  if (totalMin < 60) return `${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

export function limitTone(remaining: number): LimitTone {
  if (remaining <= 5) return "critical";
  if (remaining <= 20) return "warning";
  return "good";
}

export function viewWindow(w: LimitWindow, now = Date.now()): LimitView {
  const resetsAt = w.resets_at ? Date.parse(w.resets_at) : undefined;
  const hasReset = resetsAt !== undefined && !Number.isNaN(resetsAt) && resetsAt <= now;
  const used = hasReset ? 0 : Math.min(100, Math.max(0, w.used_percent));
  const remaining = Math.round((100 - used) * 10) / 10;
  return {
    id: w.id,
    label: w.label,
    remaining,
    used,
    hasReset,
    resetsAt: resetsAt !== undefined && !Number.isNaN(resetsAt) ? resetsAt : undefined,
    resetsIn: resetsAt !== undefined && !hasReset ? formatResetsIn(resetsAt - now) : undefined,
    tone: limitTone(remaining),
  };
}

/** The 5-hour and weekly windows lead; any other window follows. */
export function splitWindows(l: AccountLimits | undefined, now = Date.now()): { main: LimitView[]; other: LimitView[] } {
  const views = (l?.windows ?? []).map((w) => viewWindow(w, now));
  const main = ["5h", "7d"].flatMap((id) => views.filter((v) => v.id === id));
  const other = views.filter((v) => v.id !== "5h" && v.id !== "7d");
  // A provider with unusual window lengths still gets two headline meters.
  while (main.length < 2 && other.length) main.push(other.shift()!);
  return { main, other };
}
