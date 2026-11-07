import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ClipboardPaste,
  ExternalLink,
  FlaskConical,
  KeyRound,
  MoreHorizontal,
  Plus,
  RefreshCw,
  TimerReset,
  Gauge,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { splitWindows, type LimitView } from "../../../server/shared/limits";
import type { Account, AccountLimits, LimitsResponse, OAuthStart, OAuthStatus } from "../../../server/shared/types";
import { Sparkline } from "../components/charts";
import {
  Button,
  CopyButton,
  EmptyState,
  Menu,
  Modal,
  Notice,
  Select,
  Spinner,
  StatusBadge,
  Toggle,
  cx,
  inputClass,
  type Tone,
} from "../components/ui";
import { api } from "../lib/api";
import { ago, num } from "../lib/format";

type Provider = "claude" | "codex";
const PROVIDERS: { id: Provider; name: string; blurb: string; match: (p: string) => boolean }[] = [
  { id: "claude", name: "Claude", blurb: "Claude Pro / Max subscriptions, used by Claude Code", match: (p) => p === "claude" || p === "anthropic" },
  { id: "codex", name: "ChatGPT", blurb: "ChatGPT Plus / Pro / Team subscriptions, used by Codex", match: (p) => p === "codex" || p.startsWith("codex") },
];

function accountState(a: Account, l?: AccountLimits): { tone: Tone; label: string } {
  if (a.disabled) return { tone: "neutral", label: "Disabled" };
  if (a.requiresSignIn) return { tone: "critical", label: "Sign in again" };
  if (a.quotaBlocked || l?.limit_reached) return { tone: "warning", label: "Usage limit reached" };
  if (a.unavailable) return { tone: "serious", label: "Cooling down" };
  if (a.status === "error") return { tone: "critical", label: "Error" };
  return { tone: "good", label: "Active" };
}

interface WindowRow {
  value: string;
  windows: Record<string, { total: number; requests: number }>;
}

export function AccountsPage() {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: () => api<Account[]>("/accounts"), refetchInterval: 10_000 });
  const windows = useQuery({ queryKey: ["windows", "account"], queryFn: () => api<{ rows: WindowRow[] }>("/usage/windows?dim=account"), refetchInterval: 30_000 });
  const routing = useQuery({ queryKey: ["routing"], queryFn: () => api<{ strategy?: string }>("/routing") });
  const byAccount = useMemo(() => new Map((windows.data?.rows ?? []).map((r) => [r.value, r.windows])), [windows.data]);
  // The proxy caches each account's live limits for 5 minutes, so polling here is cheap.
  const limits = useQuery({ queryKey: ["limits"], queryFn: () => api<LimitsResponse>("/accounts/limits"), refetchInterval: 60_000 });
  const limitsById = useMemo(() => new Map((limits.data?.accounts ?? []).map((l) => [l.auth_id, l])), [limits.data]);
  const refreshLimits = useMutation({
    mutationFn: (a: Account) => api<LimitsResponse>("/accounts/limits/refresh", { body: { id: a.id } }),
    onSuccess: (res) => {
      qc.setQueryData<LimitsResponse>(["limits"], (old) => {
        if (!old) return res;
        const next = new Map(old.accounts.map((l) => [l.auth_id, l]));
        for (const l of res.accounts) next.set(l.auth_id, l);
        return { ...old, accounts: [...next.values()] };
      });
    },
  });
  const now = useNow(30_000);
  const [adding, setAdding] = useState<Provider | null>(null);
  const [removing, setRemoving] = useState<Account | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ["accounts"] });
  const toggle = useMutation({ mutationFn: (a: Account) => api(`/accounts/${encodeURIComponent(a.name)}/disabled`, { body: { disabled: !a.disabled } }), onSettled: invalidate });
  const refresh = useMutation({ mutationFn: (a: Account) => api(`/accounts/${encodeURIComponent(a.name)}/refresh`, { method: "POST" }), onSettled: invalidate });
  const verify = useMutation({ mutationFn: (a: Account) => api(`/accounts/${encodeURIComponent(a.name)}/verify`, { method: "POST" }), onSettled: invalidate });
  const resetCooldowns = useMutation({ mutationFn: () => api("/accounts/cooldowns/reset", { method: "POST" }), onSettled: invalidate });
  const setStrategy = useMutation({
    mutationFn: (strategy: string) => api("/routing", { method: "PUT", body: { strategy } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["routing"] }),
  });

  const list = accounts.data ?? [];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Model accounts</h1>
          <p className="text-sm text-ink-3 mt-0.5">
            Subscriptions the proxy pools for every environment. Add an account once; no one signs in inside their environment.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            label="Routing"
            value={routing.data?.strategy || "round-robin"}
            onChange={(v) => setStrategy.mutate(v)}
            className="h-8 text-[13px]"
            options={[
              { value: "round-robin", label: "Spread load (round-robin)" },
              { value: "fill-first", label: "Use one until its limit (fill-first)" },
            ]}
          />
          <Button size="sm" icon={<TimerReset className="size-4" />} loading={resetCooldowns.isPending} onClick={() => resetCooldowns.mutate()}>
            Reset cooldowns
          </Button>
        </div>
      </div>

      {accounts.error && <Notice tone="critical" title="Could not reach the model proxy">{(accounts.error as Error).message}</Notice>}
      {(verify.error || refresh.error) && <Notice tone="critical">{((verify.error || refresh.error) as Error).message}</Notice>}
      {verify.isSuccess && <Notice tone="info" title="Test request sent">The account answered a one-token request.</Notice>}

      {PROVIDERS.map((prov) => {
        const items = list.filter((a) => prov.match(a.provider));
        return (
          <section key={prov.id}>
            <div className="flex items-end justify-between mb-3">
              <div>
                <h2 className="text-[15px] font-semibold">{prov.name}</h2>
                <p className="text-[13px] text-ink-3">{prov.blurb}</p>
              </div>
              <Button size="sm" variant={items.length ? "secondary" : "primary"} icon={<Plus className="size-4" />} onClick={() => setAdding(prov.id)}>
                Add {prov.name} account
              </Button>
            </div>
            {accounts.isLoading ? (
              <Spinner />
            ) : items.length === 0 ? (
              <EmptyState icon={<KeyRound className="size-6" />} title={`No ${prov.name} accounts`}>
                {prov.id === "claude" ? "Claude Code in your environments needs at least one." : "Codex in your environments needs at least one."}
              </EmptyState>
            ) : (
              <div className="card divide-y divide-line">
                {items.map((a) => {
                  const lim = limitsById.get(a.id);
                  const st = accountState(a, lim);
                  const w = byAccount.get(a.id);
                  const { main, other } = splitWindows(lim, now);
                  const refreshing = refreshLimits.isPending && refreshLimits.variables?.id === a.id;
                  return (
                    <div key={a.id} className="p-4 space-y-4">
                      <div className="flex flex-wrap items-start gap-x-5 gap-y-2">
                        <div className="min-w-56 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium truncate">{a.email || a.label || a.name}</span>
                            <StatusBadge tone={st.tone} label={st.label} />
                          </div>
                          <div className="text-xs text-ink-3 mt-1 truncate">
                            {[
                              planName(lim?.plan) ?? a.accountType,
                              a.lastRefresh && `signed in ${ago(a.lastRefresh)}`,
                              a.nextRetryAfter && `retry ${ago(a.nextRetryAfter)}`,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </div>
                          {a.statusMessage && st.tone !== "good" && <div className="text-xs text-ink-2 mt-1">{a.statusMessage}</div>}
                        </div>
                        <div className="flex items-center gap-2">
                          <Toggle checked={!a.disabled} onChange={() => toggle.mutate(a)} label="Enabled" />
                          <Menu
                            trigger={<Button size="sm" variant="ghost" aria-label="Account actions" icon={<MoreHorizontal className="size-4" />} />}
                            items={[
                              { label: "Check limits now", icon: <Gauge className="size-4" />, onClick: () => refreshLimits.mutate(a) },
                              { label: "Send a test request", icon: <FlaskConical className="size-4" />, onClick: () => verify.mutate(a) },
                            { label: "Refresh sign-in", icon: <RefreshCw className="size-4" />, onClick: () => refresh.mutate(a) },
                              { label: "Remove…", icon: <Trash2 className="size-4" />, onClick: () => setRemoving(a), danger: true },
                            ]}
                          />
                        </div>
                      </div>

                      <div className="grid gap-x-6 gap-y-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                        {main.length ? (
                          main.map((v) => <LimitMeter key={v.id} view={v} />)
                        ) : (
                          <div className="md:col-span-2 rounded-lg border border-dashed border-line px-3 py-3 text-[13px] text-ink-3">
                            {limits.isLoading || refreshing ? (
                              <span className="inline-flex items-center gap-2"><Spinner /> Checking limits…</span>
                            ) : (
                              "No limit data yet. It appears after the provider answers a usage check or a request."
                            )}
                          </div>
                        )}
                        {main.length === 1 && <div className="hidden md:block" />}
                        <div className="flex items-end gap-4 md:justify-end">
                          <div className="grid grid-cols-3 gap-3 text-right" title="Tokens this account served through the proxy">
                            {(["5h", "24h", "7d"] as const).map((k) => (
                              <div key={k}>
                                <div className="text-[11px] text-ink-3">{k} tokens</div>
                                <div className="text-sm font-semibold tabular">{num(w?.[k]?.total ?? 0)}</div>
                              </div>
                            ))}
                          </div>
                          <div className="w-20" title={`Requests over the recent window: ${num(a.success)} ok, ${num(a.failed)} failed`}>
                            <Sparkline values={a.recent.map((r) => r.success + r.failed)} height={28} />
                          </div>
                        </div>
                      </div>

                      {(other.length > 0 || lim?.extra_usage?.enabled || lim?.credits?.has_credits) && (
                        <div className="flex flex-wrap gap-2">
                          {other.map((v) => (
                            <span key={v.id} className="inline-flex items-center gap-1.5 rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2">
                              <span className="size-1.5 rounded-full" style={{ background: toneColor(v.tone) }} />
                              {v.label}: <span className="font-medium text-ink tabular">{fmtPct(v.remaining)} left</span>
                              {v.resetsIn && <span className="text-ink-3">· resets in {v.resetsIn}</span>}
                            </span>
                          ))}
                          {lim?.extra_usage?.enabled && (
                            <span className="inline-flex items-center rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2">
                              Extra usage on
                              {lim.extra_usage.used_percent != null && ` · ${fmtPct(lim.extra_usage.used_percent)} of monthly cap used`}
                            </span>
                          )}
                          {lim?.credits?.has_credits && (
                            <span className="inline-flex items-center rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2">
                              Credits: {lim.credits.unlimited ? "unlimited" : (lim.credits.balance ?? "available")}
                            </span>
                          )}
                        </div>
                      )}

                      <LimitSource limits={lim} refreshing={refreshing} onRefresh={() => refreshLimits.mutate(a)} />
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      <p className="text-xs text-ink-3">
        Limits come from each provider's own usage check, made at most every {Math.round((limits.data?.ttl_seconds ?? 300) / 60)} minutes per
        account, and are updated from every request the proxy sends in between. Token counts are what each account served through the proxy.
      </p>

      {adding && <SignInModal provider={adding} onClose={() => setAdding(null)} onDone={invalidate} />}
      {removing && (
        <Modal
          open
          onClose={() => setRemoving(null)}
          title="Remove this account?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
              <RemoveButton account={removing} onDone={() => { setRemoving(null); invalidate(); }} />
            </>
          }
        >
          <p className="text-sm text-ink-2">
            {removing.email || removing.name} stops serving requests and its saved sign-in is deleted. Usage history stays.
          </p>
        </Modal>
      )}
    </div>
  );
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function toneColor(tone: LimitView["tone"]): string {
  if (tone === "critical") return "var(--critical)";
  if (tone === "warning") return "var(--warning)";
  return "var(--accent)";
}

function fmtPct(n: number): string {
  return `${n >= 10 || Number.isInteger(n) ? Math.round(n) : n.toFixed(1)}%`;
}

function planName(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  return `${plan.charAt(0).toUpperCase()}${plan.slice(1)} plan`;
}

/** One rolling window: how much is left and when it resets. */
function LimitMeter({ view }: { view: LimitView }) {
  const color = toneColor(view.tone);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[12px] font-medium text-ink-2">{view.label}</span>
        <span className="text-[11px] text-ink-3 tabular truncate">
          {view.hasReset ? "reset since last check" : view.resetsIn ? `resets in ${view.resetsIn}` : ""}
        </span>
      </div>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <span className="text-xl font-semibold tabular" style={view.tone === "critical" ? { color: "var(--critical-ink)" } : undefined}>
          {fmtPct(view.remaining)}
        </span>
        <span className="text-xs text-ink-3">left</span>
      </div>
      <div
        className="mt-1.5 h-1.5 rounded-full bg-surface-3 overflow-hidden"
        role="meter"
        aria-label={`${view.label} remaining`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={view.remaining}
        title={`${fmtPct(view.used)} used${view.resetsAt ? ` · resets ${new Date(view.resetsAt).toLocaleString()}` : ""}`}
      >
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${view.remaining}%`, background: color }} />
      </div>
    </div>
  );
}

function LimitSource({ limits, refreshing, onRefresh }: { limits?: AccountLimits; refreshing: boolean; onRefresh: () => void }) {
  const when = limits?.observed_at;
  const label =
    !limits || limits.source === "none"
      ? "Not checked yet"
      : limits.source === "live"
        ? `Checked with the provider ${ago(when)}`
        : `From the last proxied request ${ago(when)}`;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-3">
      <span>{label}</span>
      {limits?.error && (
        <span className="text-ink-2" title={limits.error}>
          · Live check failed: {limits.error}
        </span>
      )}
      <button
        className="inline-flex items-center gap-1 hover:text-ink disabled:opacity-50"
        onClick={onRefresh}
        disabled={refreshing}
      >
        <RefreshCw className={cx("size-3", refreshing && "animate-spin")} /> Check now
      </button>
    </div>
  );
}

function RemoveButton({ account, onDone }: { account: Account; onDone: () => void }) {
  const del = useMutation({ mutationFn: () => api(`/accounts/${encodeURIComponent(account.name)}`, { method: "DELETE" }), onSuccess: onDone });
  return (
    <Button variant="danger" loading={del.isPending} onClick={() => del.mutate()}>
      Remove account
    </Button>
  );
}

function SignInModal({ provider, onClose, onDone }: { provider: Provider; onClose: () => void; onDone: () => void }) {
  const [mode, setMode] = useState<"redirect" | "device">(provider === "codex" ? "device" : "redirect");
  const [start, setStart] = useState<OAuthStart | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [status, setStatus] = useState<OAuthStatus>({ status: "wait" });
  const [opened, setOpened] = useState(false);
  const [pasted, setPasted] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const startedRef = useRef<OAuthStart | null>(null);

  // Start (or restart) the sign-in when the mode changes.
  useEffect(() => {
    let cancelled = false;
    setStart(null);
    setStartError(null);
    setStatus({ status: "wait" });
    setOpened(false);
    setPasted("");
    setSubmitted(false);
    api<OAuthStart>("/signin", { body: { provider, mode } })
      .then((s) => {
        if (cancelled) return;
        setStart(s);
        startedRef.current = s;
      })
      .catch((e: Error) => !cancelled && setStartError(e.message));
    return () => {
      cancelled = true;
    };
  }, [provider, mode]);

  // Poll for completion.
  useEffect(() => {
    if (!start || status.status !== "wait") return;
    if (start.mode === "redirect" && !submitted) return;
    const id = window.setInterval(async () => {
      try {
        const s = await api<OAuthStatus>(`/signin/${start.mode}/${start.state}`);
        if (s.status !== "wait") {
          setStatus(s);
          if (s.status === "ok") onDone();
        }
      } catch (e) {
        setStatus({ status: "error", error: (e as Error).message });
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [start, submitted, status.status, onDone]);

  const close = () => {
    const s = startedRef.current;
    if (s && status.status === "wait") api(`/signin/${s.mode}/${s.state}`, { method: "DELETE" }).catch(() => undefined);
    onClose();
  };

  const submit = async (text: string) => {
    if (!start || !text.trim()) return;
    setSubmitting(true);
    setPasteError(null);
    try {
      await api(`/signin/redirect/${start.state}/callback`, { body: { pasted: text } });
      setSubmitted(true);
    } catch (e) {
      setPasteError((e as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  const name = provider === "claude" ? "Claude" : "ChatGPT";
  const done = status.status === "ok";
  return (
    <Modal
      open
      onClose={close}
      title={`Add a ${name} account`}
      subtitle={done ? undefined : "Sign in with the account whose subscription the proxy should use."}
      footer={done ? <Button variant="primary" onClick={onClose}>Done</Button> : <Button variant="ghost" onClick={close}>Cancel</Button>}
    >
      {startError && (
        <Notice
          tone="critical"
          title="Could not start the sign-in"
          action={
            provider === "codex" && mode === "device" ? (
              <Button size="sm" onClick={() => setMode("redirect")}>Use browser redirect</Button>
            ) : undefined
          }
        >
          {startError}
        </Notice>
      )}
      {!start && !startError && <div className="py-10 grid place-items-center"><Spinner /></div>}

      {done && (
        <div className="py-6 text-center">
          <CheckCircle2 className="size-10 mx-auto" style={{ color: "var(--good)" }} />
          <p className="mt-3 font-medium">{status.email ? `${status.email} added` : "Account added"}</p>
          <p className="text-sm text-ink-3 mt-1">Environments can use it right away.</p>
        </div>
      )}
      {status.status === "error" && <Notice tone="critical" title="Sign-in failed">{status.error ?? "Try again."}</Notice>}

      {start && !done && start.mode === "device" && (
        <div className="space-y-4">
          <Step n={1} title="Open the ChatGPT device page">
            <Button variant="primary" size="sm" icon={<ExternalLink className="size-4" />} onClick={() => window.open(start.url, "_blank")}>
              Open {new URL(start.url).host}
            </Button>
          </Step>
          <Step n={2} title="Enter this code and approve">
            <div className="flex items-center gap-3">
              <span className="rounded-lg border border-line bg-surface-2 px-4 py-2 font-mono text-2xl tracking-[0.2em] font-semibold">{start.userCode}</span>
              <CopyButton text={start.userCode ?? ""} />
            </div>
          </Step>
          <div className="flex items-center gap-2 text-sm text-ink-2">
            <Spinner /> Waiting for approval… this window updates on its own.
          </div>
          <button className="text-xs text-ink-3 hover:text-ink" onClick={() => setMode("redirect")}>
            Device sign-in not working? Use a browser redirect instead
          </button>
        </div>
      )}

      {start && !done && start.mode === "redirect" && (
        <div className="space-y-4">
          <Step n={1} title={`Sign in to ${name}`}>
            <Button
              variant={opened ? "secondary" : "primary"}
              size="sm"
              icon={<ExternalLink className="size-4" />}
              onClick={() => {
                window.open(start.url, "_blank");
                setOpened(true);
              }}
            >
              {opened ? "Open sign-in again" : "Open sign-in page"}
            </Button>
          </Step>
          <Step n={2} title="Copy the address you land on">
            <p className="text-[13px] text-ink-2 leading-relaxed">
              After you approve, the browser goes to a <span className="font-mono text-xs">localhost</span> page that
              won't load. That's expected. Copy the whole address from the address bar
              {provider === "claude" && " (or the code shown on the page)"} and paste it below.
            </p>
          </Step>
          <Step n={3} title="Paste it here">
            <div className="relative">
              <ClipboardPaste className="absolute left-3 top-2.5 size-4 text-ink-3" />
              <input
                className={cx(inputClass, "pl-9 font-mono text-xs")}
                placeholder="http://localhost:…/callback?code=…"
                value={pasted}
                disabled={submitting || submitted}
                onChange={(e) => setPasted(e.target.value)}
                onPaste={(e) => {
                  const text = e.clipboardData.getData("text");
                  if (text) {
                    e.preventDefault();
                    setPasted(text);
                    void submit(text);
                  }
                }}
                onKeyDown={(e) => e.key === "Enter" && submit(pasted)}
              />
            </div>
            {pasteError && <p className="text-xs text-critical-ink mt-1.5">{pasteError}</p>}
            {submitting || submitted ? (
              <div className="flex items-center gap-2 text-sm text-ink-2 mt-2">
                <Spinner /> Finishing sign-in…
              </div>
            ) : (
              <Button size="sm" className="mt-2" disabled={!pasted.trim()} onClick={() => submit(pasted)}>
                Continue
              </Button>
            )}
          </Step>
          {provider === "codex" && (
            <button className="text-xs text-ink-3 hover:text-ink" onClick={() => setMode("device")}>
              Use a device code instead
            </button>
          )}
        </div>
      )}
    </Modal>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-accent-wash text-xs font-semibold text-accent">{n}</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium mb-2">{title}</div>
        {children}
      </div>
    </div>
  );
}
