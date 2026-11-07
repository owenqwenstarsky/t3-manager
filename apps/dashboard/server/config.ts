import path from "node:path";

function env(name: string, fallback = ""): string {
  const v = process.env[name];
  return v === undefined || v.trim() === "" ? fallback : v.trim();
}

export const config = {
  port: Number(env("PORT", "8080")),
  host: env("HOST", "0.0.0.0"),
  dataDir: path.resolve(env("DATA_DIR", "./data")),
  webDir: path.resolve(env("WEB_DIR", path.join(import.meta.dirname, "..", "web"))),
  adminPassword: env("ADMIN_PASSWORD"),
  dockerSocket: env("DOCKER_SOCKET", "/var/run/docker.sock"),
  /** Docker network shared by the proxy and every environment. */
  dockerNetwork: env("DOCKER_NETWORK", "t3-net"),
  /** URL the dashboard uses to reach the proxy. */
  proxyUrl: env("PROXY_URL", "http://proxy:8317"),
  /** URL environments use to reach the proxy (same network by default). */
  proxyUrlForEnvs: env("PROXY_URL_FOR_ENVS", env("PROXY_URL", "http://proxy:8317")),
  proxyManagementKey: env("PROXY_MANAGEMENT_PASSWORD"),
  defaultImage: env("T3_IMAGE", "t3-env:latest"),
  seedTsAuthKey: env("TS_AUTHKEY"),
  hostnamePrefix: env("ENV_HOSTNAME_PREFIX", "t3-"),
};

export type Config = typeof config;
