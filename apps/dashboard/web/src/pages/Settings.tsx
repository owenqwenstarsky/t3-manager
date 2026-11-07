import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { PriceRule, Settings } from "../../../server/shared/types";
import { Button, Card, Field, Notice, SectionTitle, Spinner, inputClass, cx } from "../components/ui";
import { api } from "../lib/api";

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
