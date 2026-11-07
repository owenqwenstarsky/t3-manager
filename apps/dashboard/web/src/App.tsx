import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Boxes, KeyRound, LogOut, Moon, Settings as SettingsIcon, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Card, Field, Notice, cx, inputClass } from "./components/ui";
import { api } from "./lib/api";
import { AccountsPage } from "./pages/Accounts";
import { EnvironmentsPage } from "./pages/Environments";
import { SettingsPage } from "./pages/Settings";
import { UsagePage } from "./pages/Usage";

type Page = "envs" | "accounts" | "usage" | "settings";
const NAV: { id: Page; label: string; icon: ReactNode }[] = [
  { id: "envs", label: "Environments", icon: <Boxes className="size-4" /> },
  { id: "accounts", label: "Accounts", icon: <KeyRound className="size-4" /> },
  { id: "usage", label: "Usage", icon: <BarChart3 className="size-4" /> },
  { id: "settings", label: "Settings", icon: <SettingsIcon className="size-4" /> },
];

function readHash(): Page {
  const h = window.location.hash.replace(/^#\/?/, "").split("?")[0] as Page;
  return NAV.some((n) => n.id === h) ? h : "envs";
}

function useTheme() {
  const [theme, setTheme] = useState<"light" | "dark" | null>(() => {
    try {
      return (localStorage.getItem("t3m-theme") as "light" | "dark" | null) ?? null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (theme) document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
    try {
      if (theme) localStorage.setItem("t3m-theme", theme);
    } catch {
      // storage unavailable
    }
  }, [theme]);
  const isDark = theme ? theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches;
  return { isDark, toggle: () => setTheme(isDark ? "light" : "dark") };
}

export function App() {
  const qc = useQueryClient();
  const session = useQuery({ queryKey: ["session"], queryFn: () => api<{ authenticated: boolean; authRequired: boolean }>("/session") });
  const [page, setPage] = useState<Page>(readHash);
  const [usageEnv, setUsageEnv] = useState<string | undefined>();
  const theme = useTheme();

  useEffect(() => {
    const onHash = () => setPage(readHash());
    const onUnauth = () => qc.invalidateQueries({ queryKey: ["session"] });
    window.addEventListener("hashchange", onHash);
    window.addEventListener("t3m:unauthorized", onUnauth);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("t3m:unauthorized", onUnauth);
    };
  }, [qc]);

  const go = (p: Page) => {
    window.location.hash = `/${p}`;
    setPage(p);
  };

  if (session.isLoading) return null;
  if (!session.data?.authenticated) return <Login onDone={() => qc.invalidateQueries()} />;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
        <div className="mx-auto max-w-[1440px] px-4 sm:px-6 h-14 flex items-center gap-3 sm:gap-6">
          <div className="flex shrink-0 items-center gap-2 font-semibold">
            <img src="/favicon.svg" alt="" className="size-6" />
            <span className="hidden sm:inline">T3 Manager</span>
          </div>
          <nav className="flex min-w-0 gap-1 overflow-x-auto">
            {NAV.map((n) => (
              <button
                key={n.id}
                aria-label={n.label}
                onClick={() => {
                  if (n.id === "usage") setUsageEnv(undefined);
                  go(n.id);
                }}
                className={cx(
                  "inline-flex items-center gap-1.5 rounded-lg px-3 h-8 text-sm font-medium transition whitespace-nowrap",
                  page === n.id ? "bg-surface-2 text-ink" : "text-ink-3 hover:text-ink",
                )}
              >
                {n.icon}
                <span className="hidden sm:inline">{n.label}</span>
              </button>
            ))}
          </nav>
          <div className="flex-1" />
          <Button size="sm" variant="ghost" aria-label="Toggle theme" icon={theme.isDark ? <Sun className="size-4" /> : <Moon className="size-4" />} onClick={theme.toggle} />
          {session.data.authRequired && (
            <Button
              size="sm"
              variant="ghost"
              aria-label="Sign out"
              icon={<LogOut className="size-4" />}
              onClick={async () => {
                await api("/logout", { method: "POST" });
                qc.invalidateQueries();
              }}
            />
          )}
        </div>
      </header>
      <main className="mx-auto max-w-[1440px] px-4 sm:px-6 py-6">
        {page === "envs" && (
          <EnvironmentsPage
            onOpenUsage={(env) => {
              setUsageEnv(env);
              go("usage");
            }}
          />
        )}
        {page === "accounts" && <AccountsPage />}
        {page === "usage" && <UsageWithEnv env={usageEnv} />}
        {page === "settings" && <SettingsPage />}
      </main>
    </div>
  );
}

/** Opens Usage pre-filtered to one environment, resolving its key fingerprint. */
function UsageWithEnv({ env }: { env?: string }) {
  const keys = useQuery({
    queryKey: ["usage-env-key", env],
    enabled: !!env,
    queryFn: () => api<{ rows: { value: string; label: string }[] }>("/usage/windows?dim=key"),
  });
  if (env && keys.isLoading) return null;
  const key = env ? keys.data?.rows.find((r) => r.label === env)?.value : undefined;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Usage</h1>
        <p className="text-sm text-ink-3 mt-0.5">Every request through the model proxy, by environment, account and model.</p>
      </div>
      <UsagePage key={key ?? "all"} initialFilters={key ? { key } : undefined} />
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="min-h-screen grid place-items-center p-4">
      <Card className="w-full max-w-sm p-6">
        <div className="flex items-center gap-2 font-semibold mb-5">
          <img src="/favicon.svg" alt="" className="size-7" />
          <span className="text-lg">T3 Manager</span>
        </div>
        <form
          className="space-y-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await api("/login", { body: { password } });
              onDone();
            } catch (err) {
              setError((err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Field label="Admin password">
            <input autoFocus type="password" className={inputClass} value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          {error && <Notice tone="critical">{error}</Notice>}
          <Button variant="primary" className="w-full" loading={busy} type="submit">
            Sign in
          </Button>
        </form>
      </Card>
    </div>
  );
}
