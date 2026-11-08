import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, GitBranch, KeyRound, Package, Plus, RotateCcw, SquareTerminal, Trash2 } from "lucide-react";
import { Suspense, lazy, useEffect, useState } from "react";
import { MAX_AGENT_INSTRUCTIONS } from "../../../server/agents";
import { defaultGitUsername, fillTemplate, normalizeGitHost } from "../../../server/git";
import { normalizeGiteaUrl } from "../../../server/gitea";
import type { AgentSyncResult, EnvSummary, GiteaSyncResult, GitSyncResult, ImageInfo, PriceRule, Settings } from "../../../server/shared/types";
import { Button, Card, Field, Modal, Notice, SectionTitle, Spinner, Toggle, inputClass, cx } from "../components/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";

// CodeMirror is large: load it only when Settings is opened.
const MarkdownEditor = lazy(() => import("../components/MarkdownEditor").then((m) => ({ default: m.MarkdownEditor })));

type SettingsResponse = Settings & { defaultPricing: PriceRule[] };

export function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<SettingsResponse>("/settings") });
  const save = useMutation({
    mutationFn: (patch: Partial<{ tsAuthKey: string; hostnamePrefix: string; image: string; pricing: PriceRule[] }>) =>
      api<Settings>("/settings", { method: "PUT", body: patch }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  if (!q.data) return q.error ? <Notice tone="critical">{(q.error as Error).message}</Notice> : <Spinner />;
  const s = q.data;
  return (
    <div className="space-y-6 max-w-5xl">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Settings</h1>
        <p className="text-sm text-ink-3 mt-0.5">Stored on the host in the dashboard's data volume.</p>
      </div>
      {save.error && <Notice tone="critical">{(save.error as Error).message}</Notice>}
      <TailnetCard s={s} onSave={(p) => save.mutate(p)} saving={save.isPending} />
      <ImageCard image={s.image} />
      <GitCard s={s} />
      <GiteaCard s={s} />
      <AgentInstructionsCard s={s} />
      <PricingCard s={s} onSave={(pricing) => save.mutate({ pricing })} saving={save.isPending} />
    </div>
  );
}

function TailnetCard({ s, onSave, saving }: { s: SettingsResponse; onSave: (p: { tsAuthKey?: string; hostnamePrefix?: string; image?: string }) => void; saving: boolean }) {
  const [key, setKey] = useState("");
  const [prefix, setPrefix] = useState(s.hostnamePrefix);
  const [image, setImage] = useState(s.image);
  return (
    <Card className="p-5">
      <SectionTitle title="Tailnet and environments" subtitle="Used when creating new environments. Existing ones keep their settings." />
      <div className="grid md:grid-cols-2 gap-5">
        <Field
          label="Tailscale auth key"
          hint={
            <>
              {s.tsAuthKeySet ? <>Saved: <span className="font-mono">{s.tsAuthKeyHint}</span>. </> : "Not set: each new environment shows a login link instead. "}
              Use a <b>reusable</b>, <b>pre-approved</b>, <b>tagged</b> key that is not ephemeral (admin console → Settings → Keys).
            </>
          }
        >
          <div className="flex gap-2">
            <input className={inputClass} type="password" placeholder={s.tsAuthKeySet ? "Paste a new key to replace it" : "tskey-auth-…"} value={key} onChange={(e) => setKey(e.target.value)} />
            <Button loading={saving} disabled={!key.trim()} onClick={() => { onSave({ tsAuthKey: key.trim() }); setKey(""); }}>
              Save
            </Button>
            {s.tsAuthKeySet && (
              <Button variant="ghost" onClick={() => onSave({ tsAuthKey: "" })}>
                Clear
              </Button>
            )}
          </div>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Hostname prefix" hint={`New machines are named ${prefix || ""}<name>.`}>
            <input className={inputClass} value={prefix} onChange={(e) => setPrefix(e.target.value.toLowerCase())} />
          </Field>
          <Field label="Environment image">
            <input className={cx(inputClass, "font-mono text-xs")} value={image} onChange={(e) => setImage(e.target.value)} />
          </Field>
          <div className="col-span-2">
            <Button size="sm" loading={saving} disabled={prefix === s.hostnamePrefix && image === s.image} onClick={() => onSave({ hostnamePrefix: prefix, image })}>
              Save environment defaults
            </Button>
          </div>
        </div>
      </div>
    </Card>
  );
}

/** What the environment image contains, read from the image itself. */
function ImageCard({ image }: { image: string }) {
  const q = useQuery({ queryKey: ["image", image], queryFn: () => api<ImageInfo>("/image"), staleTime: 60_000 });
  const info = q.data;
  const tc = info?.toolchains;
  return (
    <Card className="p-5">
      <SectionTitle
        title="Environment tools"
        subtitle={
          <>
            Every environment gets these preinstalled. Other versions install on first use (for example{" "}
            <code className="font-mono text-xs">mise use node@18</code>) and are kept in the environment's home folder. To change the list, edit{" "}
            <code className="font-mono text-xs">images/t3-env/toolchains/</code> and rebuild the image.
          </>
        }
      />
      {q.isLoading ? (
        <Spinner />
      ) : q.error ? (
        <Notice tone="critical">{(q.error as Error).message}</Notice>
      ) : info?.missing ? (
        <Notice tone="warning" title={`Image ${info.name} is not built`}>
          Run <code className="font-mono text-xs">docker compose build</code> on the host to build it.
        </Notice>
      ) : !tc ? (
        <Notice tone="info" title="This image doesn't list its tools">
          It was built before toolchains were added. Rebuild it with <code className="font-mono text-xs">docker compose build t3-env-image</code>, then update
          your environments from the Environments page.
        </Notice>
      ) : (
        <>
          <div className="text-xs text-ink-3 mb-3 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="inline-flex items-center gap-1">
              <Package className="size-3.5" />
              <span className="font-mono">{info.name}</span>
            </span>
            <span>built {ago(Date.parse(tc.built || info.created || ""))}</span>
            {tc.toolchains === "minimal" && <span className="text-ink-2">minimal build: one version per language</span>}
          </div>
          <div className="grid md:grid-cols-2 gap-x-6 gap-y-3">
            {tc.languages.map((l) => (
              <div key={l.name} className="min-w-0">
                <div className="text-sm font-medium">{l.name}</div>
                <div className="flex flex-wrap gap-1 mt-1">
                  {l.versions.map((v) => (
                    <span
                      key={v}
                      className={cx(
                        "rounded-md px-1.5 py-0.5 font-mono text-[11px] border",
                        v === l.default ? "border-accent bg-accent-wash text-ink" : "border-line text-ink-2",
                      )}
                      title={v === l.default ? "Default" : undefined}
                    >
                      {v}
                    </span>
                  ))}
                </div>
                {l.tools && <div className="text-xs text-ink-3 mt-1">{l.tools}</div>}
              </div>
            ))}
          </div>
          {tc.missing.length > 0 && (
            <div className="mt-4">
              <Notice tone="warning" title="Some tools failed to install when this image was built">
                <span className="font-mono text-xs">{tc.missing.join(", ")}</span>. Rebuilding the image usually fixes it, since
                these are often a network or rate-limit hiccup. Until then, each is one <code className="font-mono text-xs">mise use -g …</code>{" "}
                away inside an environment.
              </Notice>
            </div>
          )}
          <p className="text-xs text-ink-3 mt-4">
            Also: git, gh, glab, gt (Gitea CLI), jq, yq, ripgrep, fd, fzf, tmux, protoc, buf, shellcheck, database clients (psql, mariadb, redis-cli,
            mongosh, sqlite3) and headless Chromium. Docker is not available inside environments.
          </p>
        </>
      )}
    </Card>
  );
}

function PricingCard({ s, onSave, saving }: { s: SettingsResponse; onSave: (p: PriceRule[]) => void; saving: boolean }) {
  const [rows, setRows] = useState<PriceRule[]>(s.pricing);
  useEffect(() => setRows(s.pricing), [s.pricing]);
  const dirty = JSON.stringify(rows) !== JSON.stringify(s.pricing);
  const update = (i: number, patch: Partial<PriceRule>) => setRows((r) => r.map((row, j) => (j === i ? { ...row, ...patch } : row)));
  const numInput = (i: number, field: keyof Pick<PriceRule, "input" | "output" | "cacheRead" | "cacheWrite">) => (
    <input
      type="number"
      min={0}
      step="0.01"
      className={cx(inputClass, "h-8 text-right tabular")}
      value={rows[i][field]}
      onChange={(e) => update(i, { [field]: Number(e.target.value) })}
    />
  );
  return (
    <Card className="p-5">
      <SectionTitle
        title="Pricing"
        subtitle="USD per million tokens, used for cost estimates. The first rule whose pattern matches a model wins; * matches anything. Subscription accounts aren't billed per token, so these show API-equivalent value."
        action={
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setRows(s.defaultPricing)}>
              Defaults
            </Button>
            <Button size="sm" variant="primary" loading={saving} disabled={!dirty} onClick={() => onSave(rows.filter((r) => r.match.trim()))}>
              Save pricing
            </Button>
          </div>
        }
      />
      <div className="overflow-x-auto -mx-5">
        <table className="w-full text-[13px]">
          <thead>
            <tr className="text-left text-ink-3 border-b border-line">
              <th className="font-medium py-2 pl-5 pr-2">Model pattern</th>
              <th className="font-medium py-2 px-2 text-right w-28">Input</th>
              <th className="font-medium py-2 px-2 text-right w-28">Output</th>
              <th className="font-medium py-2 px-2 text-right w-28">Cache read</th>
              <th className="font-medium py-2 px-2 text-right w-28">Cache write</th>
              <th className="w-12 pr-5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="py-1.5 pl-5 pr-2">
                  <input className={cx(inputClass, "h-8 font-mono text-xs")} value={r.match} onChange={(e) => update(i, { match: e.target.value })} placeholder="gpt-6*" />
                </td>
                <td className="py-1.5 px-2">{numInput(i, "input")}</td>
                <td className="py-1.5 px-2">{numInput(i, "output")}</td>
                <td className="py-1.5 px-2">{numInput(i, "cacheRead")}</td>
                <td className="py-1.5 px-2">{numInput(i, "cacheWrite")}</td>
                <td className="py-1.5 pr-5 text-right">
                  <Button size="sm" variant="ghost" aria-label="Remove rule" icon={<Trash2 className="size-4" />} onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setRows((r) => [...r, { match: "", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }])}>
          Add rule
        </Button>
        <span className="text-xs text-ink-3">OpenAI / Codex models have no default price. Add a rule (for example <span className="font-mono">gpt-*</span>) to include them in cost estimates.</span>
      </div>
    </Card>
  );
}

type GitReply = { settings: Settings; sync: GitSyncResult };

/** Environments a settings change couldn't be written to. */
function FailedEnvsNotice({ failed }: { failed: { env: string; error: string }[] }) {
  if (!failed.length) return null;
  return (
    <Notice tone="warning" title={`${failed.length} environment${failed.length === 1 ? "" : "s"} weren't updated`}>
      <ul className="mt-1 space-y-0.5 text-xs">
        {failed.map((f) => (
          <li key={f.env}>
            <span className="font-medium">{f.env}</span>: {f.error}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/** Shows where a git change was applied and whether git in each environment gets its tokens. */
function SyncNotice({ sync }: { sync: GitSyncResult }) {
  if (sync.error) return <Notice tone="warning">{sync.error}</Notice>;
  const bad = sync.checks.filter((c) => !c.ok);
  const okEnvs = new Set(sync.checks.filter((c) => c.ok).map((c) => c.env));
  for (const c of bad) okEnvs.delete(c.env);
  const hosts = [...new Set(sync.checks.map((c) => c.host))];
  return (
    <div className="space-y-2">
      <FailedEnvsNotice failed={sync.failed} />
      {bad.length > 0 && (
        <Notice tone="critical" title="git couldn't get a token in some environments">
          <ul className="mt-1 space-y-2 text-xs">
            {bad.map((c) => (
              <li key={`${c.env}/${c.host}`}>
                <div>
                  <span className="font-medium">{c.env}</span> → <span className="font-mono">{c.protocol}://{c.host}</span>
                </div>
                {c.detail && <div className="mt-0.5 font-mono text-[11px] text-ink-3 break-all">{c.detail}</div>}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <p className="text-xs text-ink-3">
        Written to {sync.synced} environment{sync.synced === 1 ? "" : "s"}.
        {hosts.length > 0 && okEnvs.size > 0 && (
          <>
            {" "}
            Checked inside {okEnvs.size}: git gets the token for {hosts.join(", ")}.
          </>
        )}
        {sync.unchecked.length > 0 && <> Not checked because they're stopped: {sync.unchecked.join(", ")}.</>}
        {sync.synced === 0 && " New environments get it when they're created."}
      </p>
    </div>
  );
}

function GitCard({ s }: { s: SettingsResponse }) {
  const qc = useQueryClient();
  const [lastSync, setLastSync] = useState<GitSyncResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const done = (r: GitReply) => {
    qc.setQueryData<SettingsResponse>(["settings"], (old) => (old ? { ...old, ...r.settings } : old));
    qc.invalidateQueries({ queryKey: ["envs"] });
    setLastSync(r.sync);
  };
  const remove = useMutation({
    mutationFn: (host: string) => api<GitReply>(`/git/credentials/${encodeURIComponent(host)}`, { method: "DELETE" }),
    onSuccess: (r) => {
      done(r);
      setRemoving(null);
    },
  });
  const sync = useMutation({ mutationFn: () => api<GitReply>("/git/sync", { method: "POST" }), onSuccess: done });

  return (
    <Card className="p-5 space-y-6">
      <SectionTitle
        title="Git"
        subtitle="Pushed into every environment, existing and new: HTTPS tokens for your git servers, and a commit author that names the environment, so every commit can be traced back to where it was made."
        action={
          <Button size="sm" variant="ghost" loading={sync.isPending} onClick={() => sync.mutate()}>
            Apply and check
          </Button>
        }
      />
      {lastSync && <SyncNotice sync={lastSync} />}
      {(remove.error || sync.error) && <Notice tone="critical">{((remove.error || sync.error) as Error).message}</Notice>}

      <div>
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <h3 className="text-sm font-semibold">Credentials</h3>
            <p className="text-xs text-ink-3 mt-0.5">
              One token per server. Tokens can't be viewed again after saving, only replaced. Git sends them only over HTTPS unless you allow plain HTTP for a server.
            </p>
          </div>
          <Button size="sm" variant={s.gitCredentials.length ? "secondary" : "primary"} icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add server
          </Button>
        </div>
        {s.gitCredentials.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-[13px] text-ink-3">
            No git servers yet. Add one so <span className="font-mono text-xs">git clone</span> and <span className="font-mono text-xs">git push</span> work over HTTPS in every environment.
          </div>
        ) : (
          <div className="rounded-lg border border-line divide-y divide-line">
            {s.gitCredentials.map((g) => (
              <div key={g.host} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-2.5">
                <KeyRound className="size-4 text-ink-3 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[13px] truncate">{g.allowHttp ? `http://${g.host}` : g.host}</div>
                  <div className="text-xs text-ink-3">
                    Token set · updated {ago(g.updatedAt)}
                    {g.customUsername && " · custom username"}
                    {g.allowHttp && <span className="text-ink-2"> · plain HTTP allowed (token sent unencrypted)</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button size="sm" onClick={() => setChanging(g.host)}>
                    Change token
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${g.host}`} icon={<Trash2 className="size-4" />} onClick={() => setRemoving(g.host)} />
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-ink-3 mt-2">
          Anyone with an environment can use these tokens, and can read them from inside it. Give each token only the repositories and permissions people should have.
        </p>
      </div>

      <AuthorSection s={s} onDone={done} />

      {adding && <CredentialModal mode="add" existing={s.gitCredentials.map((g) => g.host)} onClose={() => setAdding(false)} onDone={done} />}
      {changing && (
        <CredentialModal
          mode="change"
          host={changing}
          allowHttp={!!s.gitCredentials.find((g) => g.host === changing)?.allowHttp}
          onClose={() => setChanging(null)}
          onDone={done}
        />
      )}
      {removing && (
        <Modal
          open
          onClose={() => setRemoving(null)}
          title={`Remove the token for ${removing}?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
              <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(removing)}>
                Remove token
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">Environments stop using it right away. Revoke it on {removing} too if it shouldn't work anywhere else.</p>
        </Modal>
      )}
    </Card>
  );
}

function CredentialModal(
  props: { onClose: () => void; onDone: (r: GitReply) => void } & (
    | { mode: "add"; existing: string[] }
    | { mode: "change"; host: string; allowHttp: boolean }
  ),
) {
  const [hostInput, setHostInput] = useState("");
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [showUser, setShowUser] = useState(false);
  // null: follow the scheme typed in the address (http:// turns it on).
  const [httpChoice, setHttpChoice] = useState<boolean | null>(props.mode === "change" ? props.allowHttp : null);
  const parsed = props.mode === "add" && hostInput.trim() ? normalizeGitHost(hostInput) : null;
  const allowHttp = httpChoice ?? (!!parsed && "scheme" in parsed && parsed.scheme === "http");
  const httpChanged = props.mode === "change" && allowHttp !== props.allowHttp;
  const host = props.mode === "change" ? props.host : parsed && "host" in parsed ? parsed.host : "";
  const duplicate = props.mode === "add" && !!host && props.existing.includes(host);
  const save = useMutation({
    mutationFn: () =>
      props.mode === "add"
        ? api<GitReply>("/git/credentials", { body: { host: hostInput, token, username: username.trim() || undefined, allowHttp } })
        : api<GitReply>(`/git/credentials/${encodeURIComponent(props.host)}`, {
            method: "PUT",
            body: { token: token.trim() || undefined, allowHttp, ...(showUser ? { username: username.trim() } : {}) },
          }),
    onSuccess: (r) => {
      props.onDone(r);
      props.onClose();
    },
  });
  const canSave =
    (props.mode === "add" ? !!token.trim() : !!token.trim() || httpChanged || showUser) && !!host && !duplicate && !save.isPending;
  return (
    <Modal
      open
      onClose={props.onClose}
      title={props.mode === "add" ? "Add a git server" : `Change the token for ${props.host}`}
      subtitle={props.mode === "add" ? "Every environment can then clone and push over HTTPS without signing in." : "The old token stops being used in every environment right away."}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
            {props.mode === "add" ? "Save" : token.trim() ? "Replace token" : "Save"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        {props.mode === "add" && (
          <Field
            label="Server address"
            hint={
              parsed && "error" in parsed ? (
                <span className="text-critical-ink">{parsed.error}</span>
              ) : duplicate ? (
                <span className="text-critical-ink">{host} already has a token. Change it from the list instead.</span>
              ) : host ? (
                <>Saved as <span className="font-mono">{host}</span>. Applies to every repository on this server.</>
              ) : (
                "For example github.com, gitlab.com or git.example.com:8443. Pasting a repository URL works too."
              )
            }
          >
            <input className={cx(inputClass, "font-mono text-xs")} autoFocus value={hostInput} onChange={(e) => setHostInput(e.target.value)} placeholder="github.com" />
          </Field>
        )}
        <Field
          label={props.mode === "add" ? "Token" : "New token"}
          hint={props.mode === "change" ? "Leave empty to keep the current token." : host ? tokenHint(host) : undefined}
        >
          <input
            className={cx(inputClass, "font-mono text-xs")}
            type="password"
            autoComplete="off"
            autoFocus={props.mode === "change"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the token"
          />
        </Field>
        {showUser ? (
          <Field
            label="Username"
            hint={
              props.mode === "change"
                ? `Leave empty to use the default (${defaultGitUsername(host)}).`
                : `Only needed if your server checks it. Empty uses ${host ? defaultGitUsername(host) : "the default for the server"}.`
            }
          >
            <input className={cx(inputClass, "font-mono text-xs")} value={username} onChange={(e) => setUsername(e.target.value)} placeholder={host ? defaultGitUsername(host) : ""} />
          </Field>
        ) : (
          <button type="button" className="text-xs text-ink-3 hover:text-ink" onClick={() => setShowUser(true)}>
            {props.mode === "change" ? "Change the username too" : "Set a username (only some servers need one)"}
          </button>
        )}
        <div className="rounded-lg border border-line px-3 py-2.5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-medium">Allow plain HTTP</div>
              <div className="text-xs text-ink-3 mt-0.5">For servers without HTTPS, like a LAN Gitea at http://10.0.0.5:3000.</div>
            </div>
            <Toggle checked={allowHttp} onChange={setHttpChoice} label="Allow plain HTTP" />
          </div>
          {allowHttp && (
            <p className="mt-2 text-xs text-ink-2">
              The token is sent unencrypted to <span className="font-mono">http://{host || "…"}</span>. Only use this on a network you trust.
            </p>
          )}
        </div>
        {save.error && <Notice tone="critical">{(save.error as Error).message}</Notice>}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

type GiteaReply = { settings: Settings; sync: GiteaSyncResult };

/** Shows where a Gitea CLI change was applied and whether gt could log in in each environment. */
function GiteaSyncNotice({ sync }: { sync: GiteaSyncResult }) {
  if (sync.error) return <Notice tone="warning">{sync.error}</Notice>;
  const bad = sync.checks.filter((c) => !c.ok);
  const okEnvs = new Set(sync.checks.filter((c) => c.ok).map((c) => c.env));
  for (const c of bad) okEnvs.delete(c.env);
  const urls = [...new Set(sync.checks.map((c) => c.url))];
  return (
    <div className="space-y-2">
      <FailedEnvsNotice failed={sync.failed} />
      {bad.length > 0 && (
        <Notice tone="critical" title="gt couldn't log in in some environments">
          <ul className="mt-1 space-y-2 text-xs">
            {bad.map((c) => (
              <li key={`${c.env}/${c.url}`}>
                <div>
                  <span className="font-medium">{c.env}</span> → <span className="font-mono">{c.url}</span>
                </div>
                {c.detail && <div className="mt-0.5 font-mono text-[11px] text-ink-3 break-all">{c.detail}</div>}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs">Check the token and that the server runs Gitea 28 or newer and can be reached from the environments. Any earlier login for that server is kept.</p>
        </Notice>
      )}
      {sync.skipped.length > 0 && (
        <Notice tone="warning" title="gt wasn't set up in some environments">
          <ul className="mt-1 space-y-0.5 text-xs">
            {sync.skipped.map((k) => (
              <li key={k.env}>
                <span className="font-medium">{k.env}</span>: {k.reason}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {sync.warnings.length > 0 && (
        <Notice tone="warning">
          <ul className="space-y-0.5 text-xs">
            {sync.warnings.map((w, i) => (
              <li key={i}>
                <span className="font-medium">{w.env}</span>: {w.message}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      <p className="text-xs text-ink-3">
        Written to {sync.synced} environment{sync.synced === 1 ? "" : "s"}.
        {urls.length > 0 && okEnvs.size > 0 && (
          <>
            {" "}
            gt is logged in to {urls.join(", ")} in {okEnvs.size}.
          </>
        )}
        {sync.unchecked.length > 0 && <> Stopped, so gt logs in when they next start: {sync.unchecked.join(", ")}.</>}
        {sync.synced === 0 && " New environments get it when they're created."}
      </p>
    </div>
  );
}

function GiteaCard({ s }: { s: SettingsResponse }) {
  const qc = useQueryClient();
  const [lastSync, setLastSync] = useState<GiteaSyncResult | null>(null);
  const [adding, setAdding] = useState(false);
  const [changing, setChanging] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const done = (r: GiteaReply) => {
    qc.setQueryData<SettingsResponse>(["settings"], (old) => (old ? { ...old, ...r.settings } : old));
    setLastSync(r.sync);
  };
  const remove = useMutation({
    mutationFn: (url: string) => api<GiteaReply>(`/gitea/servers?url=${encodeURIComponent(url)}`, { method: "DELETE" }),
    onSuccess: (r) => {
      done(r);
      setRemoving(null);
    },
  });
  const makeDefault = useMutation({
    mutationFn: (url: string) => api<GiteaReply>("/gitea/servers", { method: "PUT", body: { url, isDefault: true } }),
    onSuccess: done,
  });
  const sync = useMutation({ mutationFn: () => api<GiteaReply>("/gitea/sync", { method: "POST" }), onSuccess: done });
  const error = remove.error || makeDefault.error || sync.error;

  return (
    <Card className="p-5 space-y-6">
      <SectionTitle
        title="Gitea CLI"
        subtitle={
          <>
            Logs <span className="font-mono">gt</span>, Gitea's official CLI, in to these servers in every environment, existing and new. Needs Gitea 28 or newer. Logins
            people add themselves with <span className="font-mono">gt auth login</span> are kept.
          </>
        }
        action={
          <Button size="sm" variant="ghost" loading={sync.isPending} onClick={() => sync.mutate()}>
            Apply and check
          </Button>
        }
      />
      {lastSync && <GiteaSyncNotice sync={lastSync} />}
      {error && <Notice tone="critical">{(error as Error).message}</Notice>}

      <div>
        <div className="flex items-end justify-between gap-3 mb-2">
          <div>
            <h3 className="text-sm font-semibold">Servers</h3>
            <p className="text-xs text-ink-3 mt-0.5">
              One token per server. Tokens can't be viewed again after saving, only replaced. The default server is used when no <span className="font-mono">--host</span> or repository picks one.
            </p>
          </div>
          <Button size="sm" variant={s.giteaServers.length ? "secondary" : "primary"} icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
            Add server
          </Button>
        </div>
        {s.giteaServers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-[13px] text-ink-3">
            No Gitea servers yet. Add one so <span className="font-mono text-xs">gt pr list</span>, <span className="font-mono text-xs">gt issue create</span> and the rest work in every environment.
          </div>
        ) : (
          <div className="rounded-lg border border-line divide-y divide-line">
            {s.giteaServers.map((g) => (
              <div key={g.url} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3.5 py-2.5">
                <SquareTerminal className="size-4 text-ink-3 shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="font-mono text-[13px] truncate">
                    {g.url}
                    {g.isDefault && <span className="ml-2 rounded bg-surface-2 px-1.5 py-0.5 font-sans text-[11px] text-ink-2">Default</span>}
                  </div>
                  <div className="text-xs text-ink-3">
                    Token set · updated {ago(g.updatedAt)}
                    {g.url.startsWith("http://") && <span className="text-ink-2"> · plain HTTP (token sent unencrypted)</span>}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  {!g.isDefault && (
                    <Button size="sm" variant="ghost" loading={makeDefault.isPending && makeDefault.variables === g.url} onClick={() => makeDefault.mutate(g.url)}>
                      Make default
                    </Button>
                  )}
                  <Button size="sm" onClick={() => setChanging(g.url)}>
                    Change token
                  </Button>
                  <Button size="sm" variant="ghost" aria-label={`Remove ${g.url}`} icon={<Trash2 className="size-4" />} onClick={() => setRemoving(g.url)} />
                </div>
              </div>
            ))}
          </div>
        )}
        <p className="text-xs text-ink-3 mt-2">
          Anyone with an environment can use these tokens, and can read them from inside it. Give each token only the scopes people should have.
        </p>
      </div>

      {adding && <GiteaServerModal mode="add" existing={s.giteaServers.map((g) => g.url)} first={s.giteaServers.length === 0} onClose={() => setAdding(false)} onDone={done} />}
      {changing && <GiteaServerModal mode="change" url={changing} onClose={() => setChanging(null)} onDone={done} />}
      {removing && (
        <Modal
          open
          onClose={() => setRemoving(null)}
          title={`Remove ${removing}?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRemoving(null)}>Cancel</Button>
              <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate(removing)}>
                Remove server
              </Button>
            </>
          }
        >
          <p className="text-sm text-ink-2">
            gt logs out of it in every running environment right away, and in stopped ones when they next start. Revoke the token on the server too if it shouldn't work anywhere else.
          </p>
        </Modal>
      )}
    </Card>
  );
}

function GiteaServerModal(
  props: { onClose: () => void; onDone: (r: GiteaReply) => void } & ({ mode: "add"; existing: string[]; first: boolean } | { mode: "change"; url: string }),
) {
  const [urlInput, setUrlInput] = useState("");
  const [token, setToken] = useState("");
  const [isDefault, setIsDefault] = useState(props.mode === "add" && props.first);
  const parsed = props.mode === "add" && urlInput.trim() ? normalizeGiteaUrl(urlInput) : null;
  const url = props.mode === "change" ? props.url : parsed && "url" in parsed ? parsed.url : "";
  const duplicate = props.mode === "add" && !!url && props.existing.includes(url);
  const save = useMutation({
    mutationFn: () =>
      props.mode === "add"
        ? api<GiteaReply>("/gitea/servers", { body: { url: urlInput, token, isDefault } })
        : api<GiteaReply>("/gitea/servers", { method: "PUT", body: { url: props.url, token } }),
    onSuccess: (r) => {
      props.onDone(r);
      props.onClose();
    },
  });
  const canSave = !!token.trim() && !!url && !duplicate && !save.isPending;
  return (
    <Modal
      open
      onClose={props.onClose}
      title={props.mode === "add" ? "Add a Gitea server" : `Change the token for ${props.url}`}
      subtitle={props.mode === "add" ? "gt is then logged in to it in every environment." : "gt logs in again with the new token in every environment."}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canSave} loading={save.isPending} onClick={() => save.mutate()}>
            {props.mode === "add" ? "Save" : "Replace token"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSave) save.mutate();
        }}
      >
        {props.mode === "add" && (
          <Field
            label="Server address"
            hint={
              parsed && "error" in parsed ? (
                <span className="text-critical-ink">{parsed.error}</span>
              ) : duplicate ? (
                <span className="text-critical-ink">{url} is already set up. Change its token from the list instead.</span>
              ) : url ? (
                <>
                  Saved as <span className="font-mono">{url}</span>.
                  {url.startsWith("http://") && " Plain HTTP: the token is sent unencrypted, so only use this on a network you trust."}
                </>
              ) : (
                "The address you open in a browser, like https://gitea.example.com, or http://10.0.0.5:3000 for a LAN server without HTTPS."
              )
            }
          >
            <input className={cx(inputClass, "font-mono text-xs")} autoFocus value={urlInput} onChange={(e) => setUrlInput(e.target.value)} placeholder="https://gitea.example.com" />
          </Field>
        )}
        <Field
          label={props.mode === "add" ? "Token" : "New token"}
          hint={
            <>
              An access token from <span className="font-mono">{url || "your server"}/user/settings/applications</span>, with at least read access to user, plus the repository, issue and other
              scopes people need.
            </>
          }
        >
          <input
            className={cx(inputClass, "font-mono text-xs")}
            type="password"
            autoComplete="off"
            autoFocus={props.mode === "change"}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="Paste the token"
          />
        </Field>
        {props.mode === "add" && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2.5">
            <div>
              <div className="text-[13px] font-medium">Default server</div>
              <div className="text-xs text-ink-3 mt-0.5">Used when no --host or repository picks one.{props.first && " The first server is always the default."}</div>
            </div>
            <Toggle checked={isDefault || props.first} onChange={setIsDefault} label="Default server" />
          </div>
        )}
        {save.error && <Notice tone="critical">{(save.error as Error).message}</Notice>}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

function tokenHint(host: string): string {
  const h = host.replace(/:\d+$/, "");
  if (h === "github.com") return "A fine-grained personal access token with Contents read and write on the repositories people need.";
  if (h === "gitlab.com" || h.startsWith("gitlab.")) return "A personal, project or group access token with read_repository and write_repository.";
  if (h === "bitbucket.org") return "A repository, project or workspace access token.";
  return "A personal access token, or the password for HTTPS access.";
}

function AuthorSection({ s, onDone }: { s: SettingsResponse; onDone: (r: GitReply) => void }) {
  const [enabled, setEnabled] = useState(s.gitAuthor.enabled);
  const [name, setName] = useState(s.gitAuthor.name);
  const [email, setEmail] = useState(s.gitAuthor.email);
  useEffect(() => {
    setEnabled(s.gitAuthor.enabled);
    setName(s.gitAuthor.name);
    setEmail(s.gitAuthor.email);
  }, [s.gitAuthor]);
  const envs = useQuery({ queryKey: ["envs"], queryFn: () => api<EnvSummary[]>("/envs"), retry: false });
  const sample = envs.data?.[0];
  const vars = { env: sample?.name ?? "alice", owner: sample?.owner ?? (sample ? undefined : "Alice Example"), hostname: sample?.hostname ?? `${s.hostnamePrefix}alice` };
  const dirty = enabled !== s.gitAuthor.enabled || name !== s.gitAuthor.name || email !== s.gitAuthor.email;
  const save = useMutation({ mutationFn: () => api<GitReply>("/git/author", { method: "PUT", body: { enabled, name, email } }), onSuccess: onDone });
  const previewName = fillTemplate(name, vars);
  const previewEmail = fillTemplate(email, vars).replace(/[<>\s]/g, "");
  return (
    <div>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h3 className="text-sm font-semibold">Commit author</h3>
          <p className="text-xs text-ink-3 mt-0.5">
            Set as the system-wide git identity in each environment. Placeholders: <span className="font-mono">{"{env}"}</span>,{" "}
            <span className="font-mono">{"{owner}"}</span> (falls back to the environment name), <span className="font-mono">{"{hostname}"}</span>.
          </p>
        </div>
        <Toggle checked={enabled} onChange={setEnabled} label="Set the commit author" />
      </div>
      <div className={cx("grid md:grid-cols-2 gap-4", !enabled && "opacity-50 pointer-events-none")}>
        <Field label="Name">
          <input className={cx(inputClass, "font-mono text-xs")} value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Email" hint="t3.invalid is a reserved domain that never receives mail. Use your own domain if your git server requires a verified email.">
          <input className={cx(inputClass, "font-mono text-xs")} value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
          <GitBranch className="size-3.5 text-ink-3 shrink-0" />
          {enabled ? (
            <span className="truncate">
              In <span className="font-medium">{vars.env}</span>, commits are authored as{" "}
              <span className="font-mono text-ink">
                {previewName || "…"} &lt;{previewEmail || "…"}&gt;
              </span>
            </span>
          ) : (
            <span className="text-ink-3">Off: environments use whatever author people set themselves.</span>
          )}
        </div>
        <Button size="sm" variant="primary" disabled={!dirty || (enabled && (!name.trim() || !email.trim()))} loading={save.isPending} onClick={() => save.mutate()}>
          Save author
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => { setName("{env} (T3)"); setEmail("{env}@t3.invalid"); }}>
            Defaults
          </Button>
        )}
      </div>
      {save.error && <div className="mt-2"><Notice tone="critical">{(save.error as Error).message}</Notice></div>}
    </div>
  );
}

// --- global agent instructions ---------------------------------------------

type AgentReply = { settings: Settings; sync: AgentSyncResult };

const STARTER_INSTRUCTIONS = `# Team guidelines

These apply in every repository on this machine. Each repository's own CLAUDE.md or AGENTS.md comes first when they disagree.

## Working style
- Read the surrounding code before changing it, and follow its conventions.
- Keep changes small and focused on the task. Ask before large refactors.
- Run the project's tests and linters before saying a change is done.

## Git
- Never force-push to \`main\` or shared branches.
- Write commit messages in the imperative mood, with a short summary line.

## Safety
- Never commit secrets, tokens or \`.env\` files.
`;

const plural = (n: number, word: string) => `${n} environment${n === 1 ? "" : "s"}${word}`;

/** Where saved instructions went: rewritten now, on next start, or not at all. */
function AgentSyncNotice({ sync }: { sync: AgentSyncResult }) {
  if (sync.error) return <Notice tone="warning">{sync.error}</Notice>;
  return (
    <div className="space-y-2">
      {sync.failed.length > 0 && (
        <Notice tone="warning" title={`${plural(sync.failed.length, "")} weren't updated`}>
          <ul className="mt-1 space-y-0.5 text-xs">
            {sync.failed.map((f) => (
              <li key={f.env}>
                <span className="font-medium">{f.env}</span>: {f.error}
              </li>
            ))}
          </ul>
        </Notice>
      )}
      {sync.outdated.length > 0 && (
        <Notice tone="warning" title="Some environments run an image that can't apply these yet">
          {sync.outdated.join(", ")}. Rebuild the image with <code className="font-mono text-xs">docker compose build t3-env-image</code>, then update
          these environments from the Environments page.
        </Notice>
      )}
      <p className="text-xs text-ink-3">
        {sync.applied.length > 0 && <>Applied in {sync.applied.join(", ")}: agents use them from their next conversation. </>}
        {sync.unchecked.length > 0 && <>Stopped, so they get them on their next start: {sync.unchecked.join(", ")}. </>}
        {sync.synced === 0 && "No environments yet. New environments get them when they're created."}
      </p>
    </div>
  );
}

function AgentInstructionsCard({ s }: { s: SettingsResponse }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState(s.agentInstructions);
  const [lastSync, setLastSync] = useState<AgentSyncResult | null>(null);
  useEffect(() => setDraft(s.agentInstructions), [s.agentInstructions]);
  const dirty = draft !== s.agentInstructions;
  const tooLong = draft.length > MAX_AGENT_INSTRUCTIONS;

  // Ask before leaving the page with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const done = (r: AgentReply) => {
    qc.setQueryData<SettingsResponse>(["settings"], (old) => (old ? { ...old, ...r.settings } : old));
    setLastSync(r.sync);
  };
  const save = useMutation({
    mutationFn: () => api<AgentReply>("/agents/instructions", { method: "PUT", body: { instructions: draft } }),
    onSuccess: done,
  });
  const sync = useMutation({ mutationFn: () => api<AgentReply>("/agents/sync", { method: "POST" }), onSuccess: done });
  const error = save.error || sync.error;

  return (
    <Card className="p-5">
      <SectionTitle
        title="Agent instructions"
        subtitle={
          <>
            Global instructions for Claude Code and Codex in every environment, existing and new. They're kept in a managed section of{" "}
            <code className="font-mono text-xs">~/.claude/CLAUDE.md</code> and <code className="font-mono text-xs">~/.codex/AGENTS.md</code>. Notes people
            add to those files themselves are kept.
          </>
        }
        action={
          <Button size="sm" variant="ghost" loading={sync.isPending} disabled={dirty} title={dirty ? "Save your changes first" : undefined} onClick={() => sync.mutate()}>
            Apply to environments
          </Button>
        }
      />
      <Suspense
        fallback={
          <div className="grid h-[505px] place-items-center rounded-xl border border-line">
            <Spinner />
          </div>
        }
      >
        <MarkdownEditor
          label="Agent instructions"
          value={draft}
          onChange={setDraft}
          maxLength={MAX_AGENT_INSTRUCTIONS}
          placeholder={"# Guidelines\n\nWrite instructions every agent should follow, in markdown…"}
        />
      </Suspense>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button size="sm" variant="primary" icon={<Bot className="size-4" />} disabled={!dirty || tooLong} loading={save.isPending} onClick={() => save.mutate()}>
          Save instructions
        </Button>
        {dirty && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(s.agentInstructions)}>
            Discard changes
          </Button>
        )}
        {!draft.trim() && (
          <Button size="sm" variant="ghost" onClick={() => setDraft(STARTER_INSTRUCTIONS)}>
            Start from an example
          </Button>
        )}
        <span className="text-xs text-ink-3">
          {dirty
            ? "Unsaved changes."
            : s.agentInstructions.trim()
              ? "Both agents load these into every conversation, so keep them short."
              : "No global instructions yet. Saving an empty text removes the section."}
        </span>
      </div>
      {tooLong && (
        <div className="mt-3">
          <Notice tone="critical">That's over the {MAX_AGENT_INSTRUCTIONS / 1024} KB limit. Shorten it to save.</Notice>
        </div>
      )}
      {error && (
        <div className="mt-3">
          <Notice tone="critical">{(error as Error).message}</Notice>
        </div>
      )}
      {lastSync && (
        <div className="mt-3">
          <AgentSyncNotice sync={lastSync} />
        </div>
      )}
    </Card>
  );
}
