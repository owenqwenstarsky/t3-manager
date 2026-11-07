import { randomBytes } from "node:crypto";
import QRCode from "qrcode";
import { config } from "./config.js";
import {
  LABEL_NAME,
  LABEL_OWNER,
  createEnvContainer,
  docker,
  exec,
  findEnvContainer,
  imageExists,
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
import { proxy } from "./proxy.js";
import { settings } from "./settings.js";
import type { EnvSummary, PairLink, PairedSession } from "./shared/types.js";

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

async function summarize(c: Awaited<ReturnType<typeof listEnvContainers>>[number]): Promise<EnvSummary> {
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
  return {
    name,
    containerId: c.Id,
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
  };
}

export const envs = {
  async list(): Promise<EnvSummary[]> {
    const containers = await listEnvContainers();
    const out = await Promise.all(containers.map((c) => summarize(c).catch(() => null)));
    return sortEnvs(out.filter((e): e is EnvSummary => e !== null));
  },

  async get(name: string): Promise<EnvSummary> {
    const c = await findEnvContainer(name);
    if (!c) throw new HttpError(404, `No environment named ${name}`);
    return summarize(c);
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
      const container = await createEnvContainer({
        name,
        image,
        hostname,
        owner: input.owner?.trim() || undefined,
        env: {
          TS_HOSTNAME: hostname,
          ...(proxyKey ? { PROXY_URL: config.proxyUrlForEnvs } : {}),
        },
      });
      const files = [];
      if (tsAuthKey) files.push({ name: "ts_authkey", content: tsAuthKey });
      if (proxyKey) files.push({ name: "proxy_key", content: proxyKey });
      if (files.length) await putFiles(container.id, "/etc/t3m", files);
      settings.setEnv(name, { proxyKey, owner: input.owner?.trim() || undefined, createdAt: Date.now() });
      await container.start();
    } catch (e) {
      if (proxyKey) await proxy.removeKey(proxyKey).catch(() => undefined);
      await removeEnvContainer(name, false).catch(() => undefined);
      throw e;
    }
    return this.get(name);
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
