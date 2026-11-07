import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BarChart3,
  Boxes,
  ExternalLink,
  FileText,
  Laptop,
  LogIn,
  MoreHorizontal,
  Play,
  Plus,
  QrCode,
  RotateCw,
  Smartphone,
  Square,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { EnvPhase, EnvSummary, PairLink, PairedSession } from "../../../server/shared/types";
import {
  Button,
  CopyButton,
  EmptyState,
  Field,
  Menu,
  Modal,
  Notice,
  Select,
  Spinner,
  StatusBadge,
  inputClass,
  type Tone,
} from "../components/ui";
import { api } from "../lib/api";
import { ago, num, usd } from "../lib/format";

const PHASE: Record<EnvPhase, { tone: Tone; label: string }> = {
  creating: { tone: "info", label: "Creating" },
  starting: { tone: "info", label: "Starting" },
  joining: { tone: "info", label: "Joining tailnet" },
  "needs-login": { tone: "warning", label: "Needs tailnet login" },
  "serve-failed": { tone: "serious", label: "HTTPS not available" },
  ready: { tone: "good", label: "Ready" },
  stopped: { tone: "neutral", label: "Stopped" },
  error: { tone: "critical", label: "Problem" },
};

interface SystemStatus {
  docker: boolean;
  proxy: boolean;
  proxyConfigured: boolean;
  image: { name: string; built: boolean };
  tsAuthKeySet: boolean;
}

interface WindowRow {
  value: string;
  label: string;
  windows: Record<string, { total: number; requests: number }>;
}

export function EnvironmentsPage({ onOpenUsage }: { onOpenUsage: (env: string) => void }) {
  const qc = useQueryClient();
  const envs = useQuery({ queryKey: ["envs"], queryFn: () => api<EnvSummary[]>("/envs"), refetchInterval: 3000 });
  const status = useQuery({ queryKey: ["status"], queryFn: () => api<SystemStatus>("/status"), refetchInterval: 15_000 });
  const usage = useQuery({
    queryKey: ["windows", "key"],
    queryFn: () => api<{ rows: WindowRow[] }>("/usage/windows?dim=key"),
    refetchInterval: 30_000,
    enabled: !!status.data?.proxy,
  });
  const usageByEnv = useMemo(() => new Map((usage.data?.rows ?? []).map((r) => [r.label, r.windows])), [usage.data]);

  const [creating, setCreating] = useState(false);
  const [pairing, setPairing] = useState<EnvSummary | null>(null);
  const [devices, setDevices] = useState<EnvSummary | null>(null);
  const [logsFor, setLogsFor] = useState<EnvSummary | null>(null);
  const [deleting, setDeleting] = useState<EnvSummary | null>(null);

  const action = useMutation({
    mutationFn: ({ name, act }: { name: string; act: "start" | "stop" | "restart" }) => api(`/envs/${name}/${act}`, { method: "POST" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["envs"] }),
  });

  const list = envs.data ?? [];
  const st = status.data;
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Environments</h1>
          <p className="text-sm text-ink-3 mt-0.5">
            Each environment is a T3 Code server in its own container, on your tailnet, using the shared model proxy.
          </p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)} disabled={st ? !st.docker : false}>
          New environment
        </Button>
      </div>

      {st && !st.docker && <Notice tone="critical" title="Docker is not reachable">The dashboard needs /var/run/docker.sock mounted.</Notice>}
      {st && st.docker && !st.image.built && (
        <Notice tone="warning" title={`Image ${st.image.name} is not built`}>
          Run <code className="font-mono text-xs">docker compose build</code> on the host to build it.
        </Notice>
      )}
      {st && !st.tsAuthKeySet && (
        <Notice tone="info" title="No Tailscale auth key saved">
          New environments will each show a login link to join your tailnet. Save a reusable auth key in Settings to skip that step.
        </Notice>
      )}
      {st && st.proxyConfigured && !st.proxy && <Notice tone="critical" title="The model proxy is not answering">Claude Code and Codex in your environments can't reach their models.</Notice>}

      {envs.isLoading ? (
        <div className="py-16 grid place-items-center"><Spinner /></div>
      ) : envs.error && st?.docker !== false ? (
        <Notice tone="critical" title="Could not list environments">{(envs.error as Error).message}</Notice>
      ) : envs.error ? null : list.length === 0 ? (
        <EmptyState
          icon={<Boxes className="size-6" />}
          title="No environments yet"
          action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>Create the first one</Button>}
        >
          Name it after the person who will use it. It joins your tailnet, and you hand them a pairing link or QR code.
        </EmptyState>
      ) : (
        <div className="grid md:grid-cols-2 2xl:grid-cols-3 gap-4">
          {list.map((env) => (
            <EnvCard
              key={env.name}
              env={env}
              usage={usageByEnv.get(env.name)}
              busy={action.isPending && action.variables?.name === env.name}
              onPair={() => setPairing(env)}
              onDevices={() => setDevices(env)}
              onLogs={() => setLogsFor(env)}
              onUsage={() => onOpenUsage(env.name)}
              onAction={(act) => action.mutate({ name: env.name, act })}
              onDelete={() => setDeleting(env)}
            />
          ))}
        </div>
      )}

      <CreateModal open={creating} onClose={() => setCreating(false)} status={st} />
      {pairing && <PairModal env={pairing} onClose={() => setPairing(null)} />}
      {devices && <DevicesModal env={devices} onClose={() => setDevices(null)} />}
      {logsFor && <LogsModal env={logsFor} onClose={() => setLogsFor(null)} />}
      {deleting && <DeleteModal env={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

function EnvCard({
  env,
  usage,
  busy,
  onPair,
  onDevices,
  onLogs,
  onUsage,
  onAction,
  onDelete,
}: {
  env: EnvSummary;
  usage?: Record<string, { total: number; requests: number }>;
  busy: boolean;
  onPair: () => void;
  onDevices: () => void;
  onLogs: () => void;
  onUsage: () => void;
  onAction: (a: "start" | "stop" | "restart") => void;
  onDelete: () => void;
}) {
  const phase = PHASE[env.phase];
  const running = env.dockerState === "running";
  return (
    <div className="card p-4 flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold truncate">{env.name}</h3>
            <StatusBadge tone={phase.tone} label={phase.label} />
          </div>
          <div className="text-xs text-ink-3 mt-1 truncate">
            {env.owner ? `${env.owner} · ` : ""}created {ago(env.createdAt)}
          </div>
          {env.gitAuthor && (
            <div className="text-xs text-ink-3 mt-0.5 truncate" title={`git commits in this environment are authored as ${env.gitAuthor}`}>
              commits as <span className="font-mono text-[11px] text-ink-2">{env.gitAuthor}</span>
            </div>
          )}
        </div>
        <Menu
          trigger={<Button size="sm" variant="ghost" aria-label="More actions" icon={<MoreHorizontal className="size-4" />} />}
          items={[
            { label: "Paired devices", icon: <Smartphone className="size-4" />, onClick: onDevices },
            { label: "Usage", icon: <BarChart3 className="size-4" />, onClick: onUsage },
            { label: "Logs", icon: <FileText className="size-4" />, onClick: onLogs },
            running
              ? { label: "Restart", icon: <RotateCw className="size-4" />, onClick: () => onAction("restart") }
              : { label: "Start", icon: <Play className="size-4" />, onClick: () => onAction("start") },
            running ? { label: "Stop", icon: <Square className="size-4" />, onClick: () => onAction("stop") } : null,
            { label: "Delete…", icon: <Trash2 className="size-4" />, onClick: onDelete, danger: true },
          ]}
        />
      </div>

      <div className="rounded-lg bg-surface-2 px-3 py-2 text-[13px] min-h-[52px]">
        {env.tailnet?.url ? (
          <a href={env.tailnet.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs text-ink hover:underline break-all">
            {env.tailnet.url.replace(/^https:\/\//, "").replace(/\/$/, "")}
            <ExternalLink className="size-3 shrink-0" />
          </a>
        ) : (
          <span className="text-ink-3 font-mono text-xs">{env.hostname}</span>
        )}
        {env.phaseDetail && <div className="text-xs text-ink-3 mt-1">{env.phaseDetail}</div>}
      </div>

      <div className="grid grid-cols-3 gap-2 text-center">
        {[
          ["5h", "Last 5h"],
          ["24h", "Last 24h"],
          ["7d", "Last 7d"],
        ].map(([k, label]) => (
          <div key={k} className="rounded-lg border border-line py-1.5">
            <div className="text-[11px] text-ink-3">{label}</div>
            <div className="text-sm font-semibold tabular">{num(usage?.[k]?.total ?? 0)}</div>
          </div>
        ))}
      </div>
      <div className="text-[11px] text-ink-3 -mt-1.5">tokens through the model proxy{!env.agentsConfigured && " · agents not connected to the proxy"}</div>

      <div className="flex gap-2 mt-auto">
        {env.phase === "needs-login" && env.tailnet?.authUrl ? (
          <Button variant="primary" className="flex-1" icon={<LogIn className="size-4" />} onClick={() => window.open(env.tailnet!.authUrl, "_blank")}>
            Log in to Tailscale
          </Button>
        ) : (
          <Button variant="primary" className="flex-1" icon={<QrCode className="size-4" />} disabled={env.phase !== "ready"} onClick={onPair}>
            Get pair link
          </Button>
        )}
        {!running && (
          <Button icon={<Play className="size-4" />} loading={busy} onClick={() => onAction("start")}>
            Start
          </Button>
        )}
      </div>
    </div>
  );
}

function CreateModal({ open, onClose, status }: { open: boolean; onClose: () => void; status?: SystemStatus }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [owner, setOwner] = useState("");
  const [authKey, setAuthKey] = useState("");
  const [advanced, setAdvanced] = useState(false);
  const create = useMutation({
    mutationFn: () => api<EnvSummary>("/envs", { body: { name, owner: owner || undefined, tsAuthKey: authKey || undefined } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["envs"] });
      setName("");
      setOwner("");
      setAuthKey("");
      onClose();
    },
  });
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New environment"
      subtitle="Starts a T3 Code server with Claude Code and Codex, connected to your tailnet and the model proxy."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!slug} onClick={() => create.mutate()}>
            Create environment
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (slug) create.mutate();
        }}
      >
        <Field label="Name" hint={slug ? <>Tailnet address: <span className="font-mono">t3-{slug}.your-tailnet.ts.net</span></> : "Lowercase letters, digits and dashes."}>
          <input autoFocus className={inputClass} value={name} onChange={(e) => setName(e.target.value)} placeholder="alice" maxLength={32} />
        </Field>
        <Field label="Who is it for?" hint="Optional, shown on the card.">
          <input className={inputClass} value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Alice Example" />
        </Field>
        {!status?.tsAuthKeySet && (
          <Notice tone="info">No Tailscale auth key is saved, so the card will show a login link once the container starts.</Notice>
        )}
        <button type="button" className="text-[13px] text-ink-3 hover:text-ink" onClick={() => setAdvanced((a) => !a)}>
          {advanced ? "Hide" : "Show"} advanced options
        </button>
        {advanced && (
          <Field label="Tailscale auth key for this environment" hint="Overrides the saved key for this one environment.">
            <input className={inputClass} type="password" value={authKey} onChange={(e) => setAuthKey(e.target.value)} placeholder="tskey-auth-…" />
          </Field>
        )}
        {create.error && <Notice tone="critical">{(create.error as Error).message}</Notice>}
      </form>
    </Modal>
  );
}

function PairModal({ env, onClose }: { env: EnvSummary; onClose: () => void }) {
  const [label, setLabel] = useState(env.owner ? `${env.owner}'s device` : "");
  const [ttl, setTtl] = useState("15m");
  const pair = useMutation({ mutationFn: () => api<PairLink>(`/envs/${env.name}/pair`, { body: { label: label || undefined, ttl } }) });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    pair.mutate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const link = pair.data;
  const left = link ? Math.max(0, Math.round((Date.parse(link.expiresAt) - now) / 1000)) : 0;
  const expired = link && left === 0;
  return (
    <Modal
      open
      onClose={onClose}
      width="max-w-xl"
      title={`Pair a device with ${env.name}`}
      subtitle="Scan with the T3 Code mobile app, or open the link on the device. Each link works once."
    >
      <div className="grid sm:grid-cols-[220px_1fr] gap-5">
        <div className="rounded-xl border border-line bg-white p-3 aspect-square grid place-items-center">
          {pair.isPending ? (
            <Spinner />
          ) : link && !expired ? (
            <div className="w-full [&_svg]:w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: link.qrSvg }} />
          ) : (
            <span className="text-sm text-ink-3">{expired ? "Expired" : "–"}</span>
          )}
        </div>
        <div className="space-y-3 min-w-0">
          {pair.error && <Notice tone="critical">{(pair.error as Error).message}</Notice>}
          {link && (
            <>
              <div className="text-[13px]">
                {expired ? (
                  <span className="text-critical-ink">This link has expired.</span>
                ) : (
                  <span className="text-ink-2">
                    Expires in <span className="font-medium tabular text-ink">{Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}</span>
                  </span>
                )}
              </div>
              <div className="rounded-lg bg-surface-2 p-2.5 font-mono text-[11px] break-all text-ink-2 select-all">{link.pairUrl}</div>
              <div className="flex flex-wrap gap-2">
                <CopyButton text={link.pairUrl} label="Copy link" />
                <Button size="sm" icon={<ExternalLink className="size-4" />} onClick={() => window.open(link.hostedUrl, "_blank")}>
                  Open in app.t3.codes
                </Button>
                <Button size="sm" icon={<Laptop className="size-4" />} onClick={() => (window.location.href = link.appLink)}>
                  Desktop app
                </Button>
              </div>
              <div className="text-xs text-ink-3">
                Pairing code: <span className="font-mono text-ink-2">{link.token}</span>
              </div>
            </>
          )}
          <div className="border-t border-line pt-3 grid grid-cols-[1fr_auto] gap-2 items-end">
            <Field label="Device label">
              <input className={inputClass} value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Alice's phone" />
            </Field>
            <Select
              label="Link lifetime"
              value={ttl}
              onChange={setTtl}
              options={[
                { value: "5m", label: "5 min" },
                { value: "15m", label: "15 min" },
                { value: "1h", label: "1 hour" },
                { value: "24h", label: "24 hours" },
              ]}
            />
          </div>
          <Button variant="primary" size="sm" loading={pair.isPending} icon={<RotateCw className="size-4" />} onClick={() => pair.mutate()}>
            New link
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function DevicesModal({ env, onClose }: { env: EnvSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["sessions", env.name], queryFn: () => api<PairedSession[]>(`/envs/${env.name}/sessions`) });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/envs/${env.name}/sessions/${id}`, { method: "DELETE" }),
    onSettled: () => qc.invalidateQueries({ queryKey: ["sessions", env.name] }),
  });
  const describe = (s: PairedSession) => {
    const c = s.client as { label?: string; deviceType?: string; os?: string; browser?: string } | undefined;
    return [c?.label, c?.deviceType, c?.os, c?.browser].filter(Boolean).join(" · ") || s.subject || s.method || "Device";
  };
  return (
    <Modal open onClose={onClose} title={`Paired devices · ${env.name}`} subtitle="Revoking a device signs it out of this environment.">
      {sessions.isLoading ? (
        <Spinner />
      ) : !sessions.data?.length ? (
        <p className="text-sm text-ink-3 py-6 text-center">No devices are paired yet.</p>
      ) : (
        <ul className="divide-y divide-line -my-2">
          {sessions.data.map((s) => (
            <li key={s.sessionId} className="flex items-center gap-3 py-2.5">
              <Smartphone className="size-4 text-ink-3" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{describe(s)}</div>
                <div className="text-xs text-ink-3">
                  {s.connected ? "Connected now" : `Last seen ${ago(s.lastConnectedAt ?? s.issuedAt)}`}
                </div>
              </div>
              <Button size="sm" variant="ghost" loading={revoke.isPending && revoke.variables === s.sessionId} onClick={() => revoke.mutate(s.sessionId)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function LogsModal({ env, onClose }: { env: EnvSummary; onClose: () => void }) {
  const logs = useQuery({ queryKey: ["logs", env.name], queryFn: () => api<string>(`/envs/${env.name}/logs?tail=400`), refetchInterval: 3000 });
  return (
    <Modal open onClose={onClose} width="max-w-4xl" title={`Logs · ${env.name}`} subtitle="Container output, refreshed every few seconds.">
      <pre className="h-[60vh] overflow-auto rounded-lg bg-[#111110] text-[#e6e5df] p-3 text-[11.5px] leading-relaxed font-mono whitespace-pre-wrap break-all">
        {logs.data ?? (logs.isLoading ? "Loading…" : "")}
      </pre>
    </Modal>
  );
}

function DeleteModal({ env, onClose }: { env: EnvSummary; onClose: () => void }) {
  const qc = useQueryClient();
  const [purge, setPurge] = useState(false);
  const [confirm, setConfirm] = useState("");
  const del = useMutation({
    mutationFn: () => api(`/envs/${env.name}${purge ? "?purge=1" : ""}`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["envs"] });
      onClose();
    },
  });
  return (
    <Modal
      open
      onClose={onClose}
      title={`Delete ${env.name}?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={del.isPending} disabled={purge && confirm !== env.name} onClick={() => del.mutate()}>
            Delete environment
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm text-ink-2">
        <p>The container stops and its proxy key is revoked. Usage history stays.</p>
        <label className="flex items-start gap-2.5 rounded-lg border border-line p-3 cursor-pointer">
          <input type="checkbox" className="mt-0.5" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          <span>
            <span className="font-medium text-ink">Also delete its files</span>
            <span className="block text-xs text-ink-3 mt-0.5">Removes the home volume (projects, settings, history) and its tailnet identity. Without this, creating an environment with the same name picks them up again.</span>
          </span>
        </label>
        {purge && (
          <Field label={`Type ${env.name} to confirm`}>
            <input className={inputClass} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
        )}
        {del.error && <Notice tone="critical">{(del.error as Error).message}</Notice>}
      </div>
    </Modal>
  );
}

export { usd };
