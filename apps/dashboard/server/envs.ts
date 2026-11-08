import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { config } from "./config.js";
import {
  LABEL_NAME,
  LABEL_OWNER,
  createEnvContainer,
  docker,
  exec,
  containerName,
  findEnvContainer,
  imageExists,
  imageId,
  listEnvContainers,
  logs,
  putFiles,
  removeEnvContainer,
} from "./docker.js";
import {
  buildPairLinks,
  derivePhase,
  newProxyKey,
  parsePairingOutput,
  parseTailscaleStatus,
  sortEnvs,
  validateEnvName,
  type TailscaleInfo,
} from "./logic.js";
import {
  GIT_CHECK_SCRIPT,
  GIT_FIX_PERMISSIONS,
  gitAuthorFor,
  gitCheckInput,
  gitTarFiles,
  parseGitCheck,
  type GitVars,
} from "./git.js";
import { AGENT_APPLY_SCRIPT, agentTarFiles } from "./agents.js";
import { GITEA_FIX_PERMISSIONS, GITEA_SYNC_FILE, giteaTarFiles, parseGiteaSync, type GiteaSyncOutput } from "./gitea.js";
import { proxy } from "./proxy.js";
import { settings } from "./settings.js";
import type { AgentSyncResult, EnvSummary, GiteaSyncResult, GitSyncResult, PairLink, PairedSession } from "./shared/types.js";

/**
 * Writes the managed git files into a container (running or stopped). The
 * token file is readable by root and the dev group only.
 */
async function writeGitFiles(containerId: string, vars: GitVars): Promise<void> {
  await putFiles(containerId, "/", gitTarFiles(settings.raw, vars));
}

/**
 * In a running container: fixes ownership by name, then asks git (as dev,
 * prompts disabled, like a clone) for every server's credential.
 */
async function checkGit(containerId: string): Promise<{ host: string; protocol: string; ok: boolean; detail?: string }[]> {
  const fix = await exec(containerId, ["sh", "-c", GIT_FIX_PERMISSIONS], { user: "root", timeoutMs: 15_000 });
  if (fix.exitCode !== 0) throw new Error(`could not set permissions: ${(fix.stderr || fix.stdout).trim().slice(0, 300)}`);
  const creds = settings.raw.gitCredentials;
  if (!creds.length) return [];
  const res = await exec(containerId, ["sh", "-c", GIT_CHECK_SCRIPT], {
    user: "dev",
    env: ["HOME=/home/dev", `T3M_CHECKS=${gitCheckInput(creds)}`],
    timeoutMs: 20_000,
  });
  const checks = parseGitCheck(res.stdout);
  // A server missing from the output means the script itself broke.
  for (const c of creds) {
    if (!checks.some((k) => k.host === c.host)) {
      checks.push({ host: c.host, protocol: c.allowHttp ? "http" : "https", ok: false, detail: (res.stderr || res.stdout).trim().slice(0, 300) || "no result" });
    }
  }
  return checks;
}

/** Writes the global agent instructions file into a container (running or stopped). */
async function writeAgentFiles(containerId: string): Promise<void> {
  await putFiles(containerId, "/", agentTarFiles(settings.raw.agentInstructions));
}

/** Writes the Gitea CLI server list and login script into a container (running or stopped). */
async function writeGiteaFiles(containerId: string): Promise<void> {
  await putFiles(containerId, "/", giteaTarFiles(settings.raw));
}

/**
 * In a running container: fixes ownership by name, then has gt (as dev) log
 * in to every server and log out of the ones that were removed.
 */
async function loginGitea(containerId: string): Promise<GiteaSyncOutput> {
  const fix = await exec(containerId, ["sh", "-c", GITEA_FIX_PERMISSIONS], { user: "root", timeoutMs: 15_000 });
  if (fix.exitCode !== 0) throw new Error(`could not set permissions: ${(fix.stderr || fix.stdout).trim().slice(0, 300)}`);
  const servers = settings.raw.giteaServers;
  const res = await exec(containerId, ["sh", GITEA_SYNC_FILE], {
    user: "dev",
    env: ["HOME=/home/dev"],
    timeoutMs: 30_000 + servers.length * 20_000,
  });
  const out = parseGiteaSync(res.stdout, servers.map((s) => s.token));
  if (!out.skipped) {
    // A server missing from the output means the script itself broke.
    for (const s of servers) {
      if (!out.checks.some((k) => k.url === s.url)) {
        out.checks.push({ url: s.url, ok: false, detail: (res.stderr || res.stdout).trim().slice(0, 300) || "no result" });
      }
    }
  }
  return out;
}

/**
 * Runs `fn` for every environment container. Errors are collected per
 * environment instead of stopping the others.
 */
async function forEachEnvContainer(
  fn: (c: Awaited<ReturnType<typeof listEnvContainers>>[number], env: string, inspect: Awaited<ReturnType<ReturnType<typeof docker.getContainer>["inspect"]>>) => Promise<void>,
): Promise<{ env: string; error: string }[]> {
  const failed: { env: string; error: string }[] = [];
  const list = await listEnvContainers();
  await Promise.all(
    list.map(async (c) => {
      const env = c.Labels[LABEL_NAME] ?? c.Names[0]?.replace(/^\//, "") ?? c.Id;
      try {
        await fn(c, env, await docker.getContainer(c.Id).inspect());
      } catch (e) {
        failed.push({ env, error: (e as Error).message });
      }
    }),
  );
  return failed.sort((a, b) => a.env.localeCompare(b.env));
}

const TS = ["tailscale", "--socket=/var/run/tailscale/tailscaled.sock"];
const T3_ENV = ["T3CODE_HOME=/home/dev/.t3", "HOME=/home/dev"];

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

interface TsProbe {
  at: number;
  info: TailscaleInfo | null;
  serveConfigured: boolean;
}
const tsCache = new Map<string, TsProbe>();

/** Reads Tailscale and Serve state inside a running container (cached briefly). */
async function probeTailscale(containerId: string, fresh = false): Promise<TsProbe> {
  const cached = tsCache.get(containerId);
  if (!fresh && cached && Date.now() - cached.at < 4000) return cached;
  let probe: TsProbe = { at: Date.now(), info: null, serveConfigured: false };
  try {
    const status = await exec(containerId, [...TS, "status", "--json"], { timeoutMs: 8000 });
    if (status.stdout.trim().startsWith("{")) {
      const info = parseTailscaleStatus(status.stdout);
      let serveConfigured = false;
      if (info.backendState === "Running") {
        const serve = await exec(containerId, [...TS, "serve", "status", "--json"], { timeoutMs: 8000 });
        serveConfigured = /"(TCP|Web)"/.test(serve.stdout);
      }
      probe = { at: Date.now(), info, serveConfigured };
    }
  } catch {
    // tailscaled not up yet
  }
  tsCache.set(containerId, probe);
  return probe;
}

async function summarize(c: Awaited<ReturnType<typeof listEnvContainers>>[number], currentImageId?: string): Promise<EnvSummary> {
  const name = c.Labels[LABEL_NAME] ?? c.Names[0]?.replace(/^\//, "") ?? c.Id;
  const inspect = await docker.getContainer(c.Id).inspect();
  const health = inspect.State.Health?.Status;
  const startedAt = Date.parse(inspect.State.StartedAt);
  let ts: TsProbe | null = null;
  if (c.State === "running") ts = await probeTailscale(c.Id);
  // Serve is applied a few seconds after login; only call it failed after a grace period.
  const serveFailed =
    !!ts?.info && ts.info.backendState === "Running" && !ts.serveConfigured && Date.now() - startedAt > 90_000;
  const { phase, detail } = derivePhase({ dockerState: c.State, health, tailscale: ts?.info, serveFailed });
  const record = settings.env(name);
  const dns = ts?.info?.dnsName;
  const author = gitAuthorFor(settings.raw.gitAuthor, {
    env: name,
    owner: c.Labels[LABEL_OWNER] || record?.owner,
    hostname: inspect.Config.Hostname,
  });
  return {
    name,
    containerId: c.Id,
    gitAuthor: author ? `${author.name} <${author.email}>` : undefined,
    phase,
    phaseDetail: detail,
    dockerState: c.State,
    health,
    createdAt: c.Created * 1000,
    owner: c.Labels[LABEL_OWNER] || record?.owner,
    hostname: inspect.Config.Hostname,
    tailnet: ts?.info
      ? {
          backendState: ts.info.backendState,
          dnsName: dns,
          url: dns && ts.serveConfigured ? `https://${dns}/` : undefined,
          authUrl: ts.info.authUrl,
          ips: ts.info.ips,
          online: ts.info.online,
        }
      : undefined,
    agentsConfigured: !!record?.proxyKey,
    image: c.Image,
    imageOutdated: !!currentImageId && inspect.Image !== currentImageId,
  };
}

/** Creates an environment container, writes its secrets and git setup, and starts it. */
async function startEnvContainer(input: {
  name: string;
  image: string;
  hostname: string;
  owner?: string;
  proxyKey?: string;
  tsAuthKey?: string;
  start?: boolean;
}) {
  const container = await createEnvContainer({
    name: input.name,
    image: input.image,
    hostname: input.hostname,
    owner: input.owner,
    env: {
      TS_HOSTNAME: input.hostname,
      ...(input.proxyKey ? { PROXY_URL: config.proxyUrlForEnvs } : {}),
    },
  });
  const files = [];
  if (input.tsAuthKey) files.push({ name: "ts_authkey", content: input.tsAuthKey });
  if (input.proxyKey) files.push({ name: "proxy_key", content: input.proxyKey });
  if (files.length) await putFiles(container.id, "/etc/t3m", files);
  await writeGitFiles(container.id, { env: input.name, owner: input.owner, hostname: input.hostname });
  // gt logs in at start (see the image's entrypoint).
  await writeGiteaFiles(container.id);
  await writeAgentFiles(container.id);
  if (input.start !== false) await container.start();
  return container;
}

export const envs = {
  async list(): Promise<EnvSummary[]> {
    const [containers, current] = await Promise.all([listEnvContainers(), imageId(settings.raw.image)]);
    const out = await Promise.all(containers.map((c) => summarize(c, current).catch(() => null)));
    return sortEnvs(out.filter((e): e is EnvSummary => e !== null));
  },

  async get(name: string): Promise<EnvSummary> {
    const c = await findEnvContainer(name);
    if (!c) throw new HttpError(404, `No environment named ${name}`);
    return summarize(c, await imageId(settings.raw.image));
  },

  async create(input: { name: string; owner?: string; tsAuthKey?: string; image?: string }): Promise<EnvSummary> {
    const name = input.name.trim().toLowerCase();
    const invalid = validateEnvName(name);
    if (invalid) throw new HttpError(400, invalid);
    if (await findEnvContainer(name)) throw new HttpError(409, `An environment named ${name} already exists`);
    const image = input.image?.trim() || settings.raw.image;
    if (!(await imageExists(image))) {
      throw new HttpError(400, `Image ${image} is not built. Run "docker compose build" on the host first.`);
    }
    const tsAuthKey = input.tsAuthKey?.trim() || settings.raw.tsAuthKey;
    const hostname = `${settings.raw.hostnamePrefix}${name}`;

    // A dedicated proxy key per environment, so usage is attributed to it.
    let proxyKey: string | undefined;
    if (config.proxyManagementKey) {
      proxyKey = newProxyKey(name, randomBytes(18).toString("base64url"));
      await proxy.addKey(proxyKey, name);
    }

    try {
      await startEnvContainer({ name, image, hostname, owner: input.owner?.trim() || undefined, proxyKey, tsAuthKey });
      settings.setEnv(name, { proxyKey, owner: input.owner?.trim() || undefined, createdAt: Date.now() });
    } catch (e) {
      if (proxyKey) await proxy.removeKey(proxyKey).catch(() => undefined);
      await removeEnvContainer(name, false).catch(() => undefined);
      throw e;
    }
    return this.get(name);
  },

  /**
   * Moves an environment onto the current image: a new container with the
   * same name, volumes, keys and git setup. The old one is kept (renamed,
   * stopped) until the new one has started, and put back if anything fails.
   */
  async update(name: string): Promise<EnvSummary> {
    const c = await findEnvContainer(name);
    if (!c) throw new HttpError(404, `No environment named ${name}`);
    const image = settings.raw.image;
    if (!(await imageExists(image))) throw new HttpError(400, `Image ${image} is not built. Run "docker compose build" on the host first.`);
    const old = docker.getContainer(c.Id);
    const inspect = await old.inspect();
    const wasRunning = inspect.State.Running;
    const record = settings.env(name);
    const backup = `${containerName(name)}-previous`;
    await docker.getContainer(backup).remove({ force: true }).catch(() => undefined);
    if (wasRunning) await old.stop({ t: 15 });
    await old.rename({ name: backup });
    tsCache.delete(c.Id);
    try {
      const fresh = await startEnvContainer({
        name,
        image,
        hostname: inspect.Config.Hostname,
        owner: c.Labels[LABEL_OWNER] || record?.owner,
        proxyKey: record?.proxyKey,
        // Only used if the node isn't logged in yet; its tailnet state is in the kept volume.
        tsAuthKey: settings.raw.tsAuthKey || undefined,
        start: wasRunning,
      });
      await old.remove({ force: true }).catch(() => undefined);
      return summarize((await listEnvContainers()).find((x) => x.Id === fresh.id)!, await imageId(image));
    } catch (e) {
      await docker.getContainer(containerName(name)).remove({ force: true }).catch(() => undefined);
      await old.rename({ name: containerName(name) }).catch(() => undefined);
      if (wasRunning) await old.start().catch(() => undefined);
      throw new HttpError(500, `Could not update ${name}, so it was left on its old image: ${(e as Error).message}`);
    }
  },

  /** Pushes the current git credentials and author into every environment. */
  async syncGit(): Promise<GitSyncResult> {
    const result: GitSyncResult = { synced: 0, failed: [], checks: [], unchecked: [] };
    result.failed = await forEachEnvContainer(async (c, env, inspect) => {
      await writeGitFiles(c.Id, {
        env,
        owner: c.Labels[LABEL_OWNER] || settings.env(env)?.owner,
        hostname: inspect.Config.Hostname,
      });
      result.synced++;
      if (inspect.State.Running) {
        for (const check of await checkGit(c.Id)) result.checks.push({ env, ...check });
      } else {
        result.unchecked.push(env);
      }
    });
    result.checks.sort((a, b) => a.env.localeCompare(b.env) || a.host.localeCompare(b.host));
    result.unchecked.sort();
    return result;
  },

  /**
   * Pushes the Gitea CLI servers into every environment and, in running ones,
   * has gt log in to them. Stopped ones log in when they next start.
   */
  async syncGitea(): Promise<GiteaSyncResult> {
    const result: GiteaSyncResult = { synced: 0, failed: [], checks: [], skipped: [], warnings: [], unchecked: [] };
    result.failed = await forEachEnvContainer(async (c, env, inspect) => {
      await writeGiteaFiles(c.Id);
      result.synced++;
      if (!inspect.State.Running) {
        result.unchecked.push(env);
        return;
      }
      const out = await loginGitea(c.Id);
      if (out.skipped) result.skipped.push({ env, reason: out.skipped });
      for (const check of out.checks) result.checks.push({ env, ...check });
      for (const message of out.warnings) result.warnings.push({ env, message });
    });
    result.checks.sort((a, b) => a.env.localeCompare(b.env) || a.url.localeCompare(b.url));
    result.skipped.sort((a, b) => a.env.localeCompare(b.env));
    result.unchecked.sort();
    return result;
  },

  /**
   * Pushes the global agent instructions into every environment, and in running
   * ones rewrites ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md right away.
   */
  async syncAgents(): Promise<AgentSyncResult> {
    const result: AgentSyncResult = { synced: 0, applied: [], unchecked: [], outdated: [], failed: [] };
    result.failed = await forEachEnvContainer(async (c, env, inspect) => {
      await writeAgentFiles(c.Id);
      result.synced++;
      if (!inspect.State.Running) {
        result.unchecked.push(env);
        return;
      }
      const res = await exec(c.Id, ["sh", "-c", AGENT_APPLY_SCRIPT], { user: "dev", env: ["HOME=/home/dev"], timeoutMs: 20_000 });
      if (res.stdout.includes("missing")) result.outdated.push(env);
      else if (res.exitCode === 0 && res.stdout.includes("applied")) result.applied.push(env);
      else throw new Error((res.stderr || res.stdout).trim().slice(0, 300) || `exit code ${res.exitCode}`);
    });
    for (const k of ["applied", "unchecked", "outdated"] as const) result[k].sort();
    return result;
  },

  async action(name: string, action: "start" | "stop" | "restart"): Promise<void> {
    const c = await findEnvContainer(name);
    if (!c) throw new HttpError(404, `No environment named ${name}`);
    const container = docker.getContainer(c.Id);
    tsCache.delete(c.Id);
    if (action === "start") await container.start();
    if (action === "stop") await container.stop({ t: 15 });
    if (action === "restart") await container.restart({ t: 15 });
  },

  async remove(name: string, purge: boolean): Promise<void> {
    const record = settings.env(name);
    await removeEnvContainer(name, purge);
    if (record?.proxyKey) await proxy.removeKey(record.proxyKey).catch(() => undefined);
    settings.deleteEnv(name);
  },

  async logs(name: string, tail: number): Promise<string> {
    const c = await findEnvContainer(name);
    if (!c) throw new HttpError(404, `No environment named ${name}`);
    return logs(c.Id, tail);
  },

  async running(name: string): Promise<{ id: string; dns: string }> {
    const c = await findEnvContainer(name);
    if (!c) throw new HttpError(404, `No environment named ${name}`);
    if (c.State !== "running") throw new HttpError(409, `${name} is not running`);
    const probe = await probeTailscale(c.Id, true);
    if (!probe.info || probe.info.backendState !== "Running" || !probe.info.dnsName) {
      throw new HttpError(409, `${name} has not joined the tailnet yet`);
    }
    if (!probe.serveConfigured) throw new HttpError(409, `${name} is not published over Tailscale HTTPS yet`);
    return { id: c.Id, dns: probe.info.dnsName };
  },

  async pair(name: string, opts: { label?: string; ttl?: string }): Promise<PairLink> {
    const { id, dns } = await this.running(name);
    const baseUrl = `https://${dns}`;
    const label = opts.label?.trim() || "T3 Manager";
    const ttl = /^\d+(m|h|d)$/.test(opts.ttl ?? "") ? opts.ttl! : "15m";
    const res = await exec(
      id,
      ["t3", "auth", "pairing", "create", "--base-url", baseUrl, "--ttl", ttl, "--label", label, "--json"],
      { user: "dev", env: T3_ENV, timeoutMs: 60_000 },
    );
    if (res.exitCode !== 0) throw new HttpError(502, `t3 auth pairing create failed: ${(res.stderr || res.stdout).trim().slice(-400)}`);
    const parsed = parsePairingOutput(res.stdout);
    const links = buildPairLinks(baseUrl, parsed.credential, label);
    const qrSvg = await QRCode.toString(links.pairUrl, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
    return { ...links, token: parsed.credential, expiresAt: parsed.expiresAt, qrSvg };
  },

  async sessions(name: string): Promise<PairedSession[]> {
    const c = await findEnvContainer(name);
    if (!c || c.State !== "running") return [];
    const res = await exec(c.Id, ["t3", "auth", "session", "list", "--json"], { user: "dev", env: T3_ENV, timeoutMs: 30_000 });
    const start = res.stdout.indexOf("[");
    if (res.exitCode !== 0 || start < 0) return [];
    return JSON.parse(res.stdout.slice(start)) as PairedSession[];
  },

  async revokeSession(name: string, sessionId: string): Promise<void> {
    const c = await findEnvContainer(name);
    if (!c || c.State !== "running") throw new HttpError(409, `${name} is not running`);
    if (!/^[\w-]+$/.test(sessionId)) throw new HttpError(400, "Invalid session id");
    const res = await exec(c.Id, ["t3", "auth", "session", "revoke", sessionId], { user: "dev", env: T3_ENV });
    if (res.exitCode !== 0) throw new HttpError(502, (res.stderr || res.stdout).trim().slice(-300));
  },
};
