import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, KeyRound, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { defaultGitUsername, fillTemplate, normalizeGitHost } from "../../../server/git";
import type { EnvSummary, GitSyncResult, PriceRule, Settings } from "../../../server/shared/types";
import { Button, Card, Field, Modal, Notice, SectionTitle, Spinner, Toggle, inputClass, cx } from "../components/ui";
import { api } from "../lib/api";
import { ago } from "../lib/format";

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
      <GitCard s={s} />
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

/** Shows where a git change was applied and whether git in each environment gets its tokens. */
function SyncNotice({ sync }: { sync: GitSyncResult }) {
  if (sync.error) return <Notice tone="warning">{sync.error}</Notice>;
  const bad = sync.checks.filter((c) => !c.ok);
  const okEnvs = new Set(sync.checks.filter((c) => c.ok).map((c) => c.env));
  for (const c of bad) okEnvs.delete(c.env);
  const hosts = [...new Set(sync.checks.map((c) => c.host))];
  return (
    <div className="space-y-2">
      {sync.failed.length > 0 && (
        <Notice tone="warning" title={`${sync.failed.length} environment${sync.failed.length === 1 ? "" : "s"} weren't updated`}>
          <ul className="mt-1 space-y-0.5 text-xs">
            {sync.failed.map((f) => (
              <li key={f.env}>
                <span className="font-medium">{f.env}</span>: {f.error}
              </li>
            ))}
          </ul>
        </Notice>
      )}
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
