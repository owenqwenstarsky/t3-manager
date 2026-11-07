import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { cancelSignIn, signInStatus, startSignIn, submitCallback } from "./accounts.js";
import { checkPassword, clearSession, isAuthenticated, issueSession, requireAuth } from "./auth.js";
import { config } from "./config.js";
import { docker, imageExists } from "./docker.js";
import { envs, HttpError } from "./envs.js";
import { normalizeGitHost, validateGitToken, validateGitUsername } from "./git.js";
import { DEFAULT_PRICING } from "./pricing.js";
import { proxy, ProxyError } from "./proxy.js";
import { settings } from "./settings.js";
import { DIMS, events, summary, timeseries, windows, type UsageQuery } from "./usage.js";
import type { GitSyncResult, UsageDim } from "./shared/types.js";

const app = new Hono();

app.onError((err, c) => {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES") {
    if (String((err as Error).message).includes(".sock")) {
      return c.json({ error: `Docker is not reachable at ${config.dockerSocket} (${code})` }, 503);
    }
  }
  const status = err instanceof HttpError || err instanceof ProxyError ? err.status : 500;
  if (status >= 500) console.error(err);
  return c.json({ error: err.message }, status as 400);
});

async function body<T>(c: Context, schema: z.ZodType<T>): Promise<T> {
  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    // empty body
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => i.message).join("; "));
  return parsed.data;
}

// --- session ---------------------------------------------------------------
app.get("/api/session", (c) => c.json({ authenticated: isAuthenticated(c), authRequired: config.adminPassword !== "" }));
app.post("/api/login", async (c) => {
  const { password } = await body(c, z.object({ password: z.string() }));
  if (!checkPassword(password)) {
    await new Promise((r) => setTimeout(r, 600));
    return c.json({ error: "Wrong password" }, 401);
  }
  issueSession(c);
  return c.json({ ok: true });
});
app.post("/api/logout", (c) => {
  clearSession(c);
  return c.json({ ok: true });
});

const api = new Hono();
api.use("*", requireAuth);

// --- system ----------------------------------------------------------------
api.get("/status", async (c) => {
  const [dockerOk, proxyHealth, image] = await Promise.all([
    docker.ping().then(() => true).catch(() => false),
    proxy.health().catch(() => ({ ok: false })),
    imageExists(settings.raw.image).catch(() => false),
  ]);
  return c.json({
    docker: dockerOk,
    proxy: proxyHealth.ok,
    proxyConfigured: config.proxyManagementKey !== "",
    image: { name: settings.raw.image, built: image },
    tsAuthKeySet: settings.raw.tsAuthKey !== "",
  });
});

// --- environments ----------------------------------------------------------
api.get("/envs", async (c) => c.json(await envs.list()));
api.post("/envs", async (c) => {
  const input = await body(
    c,
    z.object({ name: z.string(), owner: z.string().max(80).optional(), tsAuthKey: z.string().optional() }),
  );
  return c.json(await envs.create(input), 201);
});
api.get("/envs/:name", async (c) => c.json(await envs.get(c.req.param("name"))));
api.post("/envs/:name/:action{start|stop|restart}", async (c) => {
  await envs.action(c.req.param("name"), c.req.param("action") as "start" | "stop" | "restart");
  return c.json({ ok: true });
});
api.delete("/envs/:name", async (c) => {
  await envs.remove(c.req.param("name"), c.req.query("purge") === "1");
  return c.json({ ok: true });
});
api.get("/envs/:name/logs", async (c) => {
  const tail = Math.min(Number(c.req.query("tail") ?? 300) || 300, 5000);
  return c.text(await envs.logs(c.req.param("name"), tail));
});
api.post("/envs/:name/pair", async (c) => {
  const opts = await body(c, z.object({ label: z.string().max(60).optional(), ttl: z.string().optional() }));
  return c.json(await envs.pair(c.req.param("name"), opts));
});
api.get("/envs/:name/sessions", async (c) => c.json(await envs.sessions(c.req.param("name"))));
api.delete("/envs/:name/sessions/:id", async (c) => {
  await envs.revokeSession(c.req.param("name"), c.req.param("id"));
  return c.json({ ok: true });
});

// --- accounts (model proxy) ------------------------------------------------
api.get("/accounts", async (c) => c.json(await proxy.accounts()));
api.get("/accounts/limits", async (c) => c.json(await proxy.limits({ id: c.req.query("id") || undefined })));
api.post("/accounts/limits/refresh", async (c) => {
  const { id } = await body(c, z.object({ id: z.string().optional() }));
  return c.json(await proxy.limits({ refresh: true, id }));
});
api.post("/accounts/:name/disabled", async (c) => {
  const { disabled } = await body(c, z.object({ disabled: z.boolean() }));
  await proxy.setAccountDisabled(c.req.param("name"), disabled);
  return c.json({ ok: true });
});
api.post("/accounts/:name/refresh", async (c) => {
  await proxy.refreshAccount(c.req.param("name"));
  return c.json({ ok: true });
});
api.post("/accounts/:name/verify", async (c) => c.json((await proxy.verifyAccount(c.req.param("name"))) ?? {}));
api.delete("/accounts/:name", async (c) => {
  await proxy.deleteAccount(c.req.param("name"));
  return c.json({ ok: true });
});
api.post("/accounts/cooldowns/reset", async (c) => {
  await proxy.resetCooldowns();
  return c.json({ ok: true });
});
api.get("/routing", async (c) => c.json(await proxy.routing()));
api.put("/routing", async (c) => {
  const { strategy } = await body(c, z.object({ strategy: z.enum(["round-robin", "fill-first", "weighted-round-robin"]) }));
  await proxy.setRoutingStrategy(strategy);
  return c.json({ ok: true });
});
api.post("/signin", async (c) => {
  const { provider, mode } = await body(
    c,
    z.object({ provider: z.enum(["claude", "codex"]), mode: z.enum(["redirect", "device"]).optional() }),
  );
  return c.json(await startSignIn(provider, mode));
});
api.get("/signin/:mode{redirect|device}/:state", async (c) =>
  c.json(await signInStatus(c.req.param("mode") as "redirect" | "device", c.req.param("state"))),
);
api.post("/signin/redirect/:state/callback", async (c) => {
  const { pasted } = await body(c, z.object({ pasted: z.string().max(8000) }));
  await submitCallback(c.req.param("state"), pasted);
  return c.json({ ok: true });
});
api.delete("/signin/:mode{redirect|device}/:state", async (c) => {
  await cancelSignIn(c.req.param("mode") as "redirect" | "device", c.req.param("state"));
  return c.json({ ok: true });
});

// --- usage -----------------------------------------------------------------
function usageQuery(c: Context): UsageQuery {
  const q = c.req.query();
  const filters: UsageQuery["filters"] = {};
  for (const d of DIMS) if (q[d]) filters[d] = q[d];
  const group = q.group as UsageDim | "none" | undefined;
  if (group && group !== "none" && !DIMS.includes(group)) throw new HttpError(400, "Unknown group");
  return { from: q.from, to: q.to, step: q.step || undefined, tz: q.tz, group, limit: Number(q.limit) || undefined, filters };
}
api.get("/usage/summary", async (c) => c.json(await summary(usageQuery(c))));
api.get("/usage/timeseries", async (c) => c.json(await timeseries(usageQuery(c))));
api.get("/usage/windows", async (c) => {
  const dim = (c.req.query("dim") ?? "account") as UsageDim;
  if (!DIMS.includes(dim)) throw new HttpError(400, "Unknown dimension");
  return c.json(await windows(dim));
});
api.get("/usage/events", async (c) => c.json(await events(c.req.query())));
api.get("/usage/live", async (c) => c.json(await proxy.usage("live", {})));
api.get("/usage/export.csv", async (c) => {
  const res = await proxy.usageCsv(c.req.query());
  return new Response(res.body, {
    status: res.status,
    headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="t3-usage.csv"' },
  });
});

// --- settings --------------------------------------------------------------
api.get("/settings", (c) => c.json({ ...settings.public(), defaultPricing: DEFAULT_PRICING }));
const priceRule = z.object({
  match: z.string().min(1).max(120),
  input: z.number().min(0),
  output: z.number().min(0),
  cacheRead: z.number().min(0),
  cacheWrite: z.number().min(0),
  note: z.string().max(200).optional(),
});
api.put("/settings", async (c) => {
  const patch = await body(
    c,
    z.object({
      tsAuthKey: z.string().optional(),
      hostnamePrefix: z.string().regex(/^[a-z0-9-]{0,20}$/).optional(),
      image: z.string().min(1).max(200).optional(),
      pricing: z.array(priceRule).max(300).optional(),
    }),
  );
  settings.update(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
  return c.json(settings.public());
});

// --- git (credentials + commit author pushed into every environment) --------
async function syncGit(): Promise<GitSyncResult> {
  try {
    return await envs.syncGit();
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    const why = err.code === "ENOENT" || err.code === "ECONNREFUSED" ? "Docker isn't reachable" : err.message;
    return { synced: 0, failed: [], checks: [], unchecked: [], error: `Saved, but environments weren't updated: ${why}. They'll be updated when the dashboard next starts with Docker available.` };
  }
}
const gitReply = async (c: Context) => c.json({ settings: settings.public(), sync: await syncGit() });
function checkOrThrow(err: string | null): void {
  if (err) throw new HttpError(400, err);
}

api.post("/git/credentials", async (c) => {
  const input = await body(
    c,
    z.object({ host: z.string(), token: z.string(), username: z.string().optional(), allowHttp: z.boolean().optional() }),
  );
  const parsed = normalizeGitHost(input.host);
  if ("error" in parsed) throw new HttpError(400, parsed.error);
  const token = input.token.trim();
  const username = input.username?.trim() ?? "";
  checkOrThrow(validateGitToken(token));
  checkOrThrow(validateGitUsername(username));
  if (settings.raw.gitCredentials.some((g) => g.host === parsed.host)) {
    throw new HttpError(409, `${parsed.host} already has a token. Change it instead.`);
  }
  settings.update({
    gitCredentials: [
      ...settings.raw.gitCredentials,
      {
        host: parsed.host,
        token,
        username: username || undefined,
        // An http:// address means the server only speaks plain HTTP.
        allowHttp: input.allowHttp ?? parsed.scheme === "http",
        updatedAt: Date.now(),
      },
    ],
  });
  return gitReply(c);
});
api.put("/git/credentials/:host", async (c) => {
  const host = c.req.param("host").toLowerCase();
  // username: omitted keeps the current one, "" goes back to the default for the host.
  // token: omitted keeps the current one (to change only the username or HTTP setting).
  const input = await body(
    c,
    z.object({ token: z.string().optional(), username: z.string().optional(), allowHttp: z.boolean().optional() }),
  );
  const existing = settings.raw.gitCredentials.find((g) => g.host === host);
  if (!existing) throw new HttpError(404, `No token is set for ${host}`);
  const token = input.token?.trim() || existing.token;
  checkOrThrow(validateGitToken(token));
  const username = input.username === undefined ? existing.username : input.username.trim() || undefined;
  checkOrThrow(validateGitUsername(username ?? ""));
  settings.update({
    gitCredentials: settings.raw.gitCredentials.map((g) =>
      g.host === host ? { host, token, username, allowHttp: input.allowHttp ?? g.allowHttp, updatedAt: Date.now() } : g,
    ),
  });
  return gitReply(c);
});
api.delete("/git/credentials/:host", async (c) => {
  const host = c.req.param("host").toLowerCase();
  if (!settings.raw.gitCredentials.some((g) => g.host === host)) throw new HttpError(404, `No token is set for ${host}`);
  settings.update({ gitCredentials: settings.raw.gitCredentials.filter((g) => g.host !== host) });
  return gitReply(c);
});
const authorTemplate = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), "No line breaks");
api.put("/git/author", async (c) => {
  const input = await body(
    c,
    z.object({ enabled: z.boolean(), name: authorTemplate, email: authorTemplate.refine((v) => !/[<>\s]/.test(v), "No spaces or angle brackets") }),
  );
  settings.update({ gitAuthor: input });
  return gitReply(c);
});
api.post("/git/sync", gitReply);

app.route("/api", api);

// --- web UI ----------------------------------------------------------------
if (existsSync(config.webDir)) {
  const indexHtml = readFileSync(path.join(config.webDir, "index.html"), "utf8");
  app.use("/assets/*", serveStatic({ root: path.relative(process.cwd(), config.webDir) }));
  app.use("/favicon.svg", serveStatic({ root: path.relative(process.cwd(), config.webDir) }));
  app.get("*", (c) => c.html(indexHtml));
}

serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  console.log(`T3 Manager dashboard on http://${info.address}:${info.port}`);
  if (!config.adminPassword) console.warn("ADMIN_PASSWORD is not set: the dashboard is open to anyone who can reach it.");
  if (!config.proxyManagementKey) console.warn("PROXY_MANAGEMENT_PASSWORD is not set: model proxy features are disabled.");
  // Bring every environment's git setup in line with the saved settings.
  envs
    .syncGit()
    .then((r) => {
      if (r.failed.length) console.warn(`git settings not applied to: ${r.failed.map((f) => `${f.env} (${f.error})`).join(", ")}`);
      for (const c of r.checks.filter((k) => !k.ok)) console.warn(`git in ${c.env} gets no token for ${c.protocol}://${c.host}: ${c.detail ?? ""}`);
    })
    .catch(() => undefined);
});
