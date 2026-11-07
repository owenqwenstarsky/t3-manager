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
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Account, OAuthStart, OAuthStatus } from "../../../server/shared/types";
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

function accountState(a: Account): { tone: Tone; label: string } {
  if (a.disabled) return { tone: "neutral", label: "Disabled" };
  if (a.requiresSignIn) return { tone: "critical", label: "Sign in again" };
  if (a.quotaBlocked) return { tone: "warning", label: "Usage limit reached" };
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
        <div className="flex items-center gap-2">
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
                  const st = accountState(a);
                  const w = byAccount.get(a.id);
                  return (
                    <div key={a.id} className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4">
                      <div className="min-w-56 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium truncate">{a.email || a.label || a.name}</span>
                          <StatusBadge tone={st.tone} label={st.label} />
                        </div>
                        <div className="text-xs text-ink-3 mt-1 truncate">
                          {[a.accountType, a.lastRefresh && `refreshed ${ago(a.lastRefresh)}`, a.nextRetryAfter && `retry ${ago(a.nextRetryAfter)}`]
                            .filter(Boolean)
                            .join(" · ")}
                        </div>
                        {a.statusMessage && st.tone !== "good" && <div className="text-xs text-ink-2 mt-1">{a.statusMessage}</div>}
                      </div>
                      <div className="grid grid-cols-3 gap-4 text-right">
                        {(["5h", "24h", "7d"] as const).map((k) => (
                          <div key={k}>
                            <div className="text-[11px] text-ink-3">{k}</div>
                            <div className="text-sm font-semibold tabular">{num(w?.[k]?.total ?? 0)}</div>
                          </div>
                        ))}
                      </div>
                      <div className="w-28" title="Requests over the recent window">
                        <Sparkline values={a.recent.map((r) => r.success + r.failed)} height={28} />
                      </div>
                      <div className="text-xs text-ink-3 tabular w-28">
                        {num(a.success)} ok · <span className={a.failed ? "text-critical-ink" : ""}>{num(a.failed)} failed</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <Toggle checked={!a.disabled} onChange={() => toggle.mutate(a)} label="Enabled" />
                        <Menu
                          trigger={<Button size="sm" variant="ghost" aria-label="Account actions" icon={<MoreHorizontal className="size-4" />} />}
                          items={[
                            { label: "Send a test request", icon: <FlaskConical className="size-4" />, onClick: () => verify.mutate(a) },
                            { label: "Refresh sign-in", icon: <RefreshCw className="size-4" />, onClick: () => refresh.mutate(a) },
                            { label: "Remove…", icon: <Trash2 className="size-4" />, onClick: () => setRemoving(a), danger: true },
                          ]}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        );
      })}

      <p className="text-xs text-ink-3">Token counts are what each account served through the proxy. Providers' own limits are not visible here.</p>

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
