import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { DEFAULT_PRICING } from "./pricing.js";
import type { PriceRule, Settings } from "./shared/types.js";

export interface EnvRecord {
  /** Raw proxy client key for this environment (needed to revoke it later). */
  proxyKey?: string;
  owner?: string;
  createdAt: number;
}

interface StoredSettings {
  tsAuthKey: string;
  hostnamePrefix: string;
  image: string;
  pricing: PriceRule[];
  sessionSecret: string;
  envs: Record<string, EnvRecord>;
}

const file = () => path.join(config.dataDir, "settings.json");

function load(): StoredSettings {
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  let stored: Partial<StoredSettings> = {};
  try {
    stored = JSON.parse(readFileSync(file(), "utf8")) as Partial<StoredSettings>;
  } catch {
    // first start
  }
  return {
    tsAuthKey: stored.tsAuthKey ?? config.seedTsAuthKey,
    hostnamePrefix: stored.hostnamePrefix ?? config.hostnamePrefix,
    image: stored.image ?? config.defaultImage,
    pricing: stored.pricing ?? DEFAULT_PRICING,
    sessionSecret: stored.sessionSecret ?? randomBytes(32).toString("hex"),
    envs: stored.envs ?? {},
  };
}

let current = load();
save();

function save(): void {
  const tmp = `${file()}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2), { mode: 0o600 });
  renameSync(tmp, file());
}

export const settings = {
  get raw(): Readonly<StoredSettings> {
    return current;
  },
  update(patch: Partial<Omit<StoredSettings, "envs" | "sessionSecret">>): void {
    current = { ...current, ...patch };
    save();
  },
  env(name: string): EnvRecord | undefined {
    return current.envs[name];
  },
  setEnv(name: string, rec: EnvRecord): void {
    current = { ...current, envs: { ...current.envs, [name]: rec } };
    save();
  },
  deleteEnv(name: string): void {
    const envs = { ...current.envs };
    delete envs[name];
    current = { ...current, envs };
    save();
  },
  public(): Settings {
    const key = current.tsAuthKey;
    return {
      tsAuthKeySet: key !== "",
      tsAuthKeyHint: key ? `${key.slice(0, 14)}…${key.slice(-4)}` : undefined,
      hostnamePrefix: current.hostnamePrefix,
      image: current.image,
      pricing: current.pricing,
      proxyUrl: config.proxyUrl,
      authRequired: config.adminPassword !== "",
    };
  },
};
