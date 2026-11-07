import Docker from "dockerode";
import { PassThrough } from "node:stream";
import tar from "tar-stream";
import { config } from "./config.js";

export const docker = new Docker({ socketPath: config.dockerSocket });

export const LABEL = "t3m.env";
export const LABEL_NAME = "t3m.name";
export const LABEL_OWNER = "t3m.owner";

export const containerName = (env: string) => `t3-env-${env}`;
export const homeVolume = (env: string) => `t3env-${env}-home`;
export const tsVolume = (env: string) => `t3env-${env}-ts`;

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs a command in a container and collects its output. */
export async function exec(
  containerId: string,
  cmd: string[],
  opts: { user?: string; env?: string[]; timeoutMs?: number } = {},
): Promise<ExecResult> {
  const container = docker.getContainer(containerId);
  const ex = await container.exec({
    Cmd: cmd,
    AttachStdout: true,
    AttachStderr: true,
    User: opts.user,
    Env: opts.env,
  });
  const stream = await ex.start({ hijack: true, stdin: false });
  const out = new PassThrough();
  const err = new PassThrough();
  const chunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  out.on("data", (c: Buffer) => chunks.push(c));
  err.on("data", (c: Buffer) => errChunks.push(c));
  docker.modem.demuxStream(stream, out, err);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stream.destroy();
      reject(new Error(`Command timed out: ${cmd.join(" ")}`));
    }, opts.timeoutMs ?? 30_000);
    stream.on("end", () => {
      clearTimeout(timer);
      resolve();
    });
    stream.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
  const info = await ex.inspect();
  return {
    exitCode: info.ExitCode ?? -1,
    stdout: Buffer.concat(chunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
  };
}

/** Writes files into a container (works before it starts). */
export async function putFiles(
  containerId: string,
  dir: string,
  files: { name: string; content: string; mode?: number }[],
): Promise<void> {
  const pack = tar.pack();
  for (const f of files) pack.entry({ name: f.name, mode: f.mode ?? 0o600, uid: 0, gid: 0 }, f.content);
  pack.finalize();
  const chunks: Buffer[] = [];
  for await (const c of pack) chunks.push(c as Buffer);
  await docker.getContainer(containerId).putArchive(Buffer.concat(chunks), { path: dir });
}

/** Last lines of container logs as text. */
export async function logs(containerId: string, tail = 300): Promise<string> {
  const buf = (await docker.getContainer(containerId).logs({
    stdout: true,
    stderr: true,
    tail,
    timestamps: true,
    follow: false,
  })) as unknown as Buffer;
  return demuxBuffer(buf);
}

/** Decodes Docker's multiplexed log framing (8-byte headers) from a buffer. */
export function demuxBuffer(buf: Buffer): string {
  let out = "";
  let i = 0;
  while (i + 8 <= buf.length) {
    const type = buf[i];
    const size = buf.readUInt32BE(i + 4);
    if (type > 2 || i + 8 + size > buf.length) {
      return out + buf.subarray(i).toString("utf8"); // not multiplexed (TTY)
    }
    out += buf.subarray(i + 8, i + 8 + size).toString("utf8");
    i += 8 + size;
  }
  return out;
}

export async function ensureNetwork(name: string): Promise<void> {
  const nets = await docker.listNetworks({ filters: { name: [name] } });
  if (!nets.some((n) => n.Name === name)) {
    await docker.createNetwork({ Name: name, Driver: "bridge", Labels: { "t3m.network": "1" } });
  }
}

export async function imageExists(image: string): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function listEnvContainers() {
  return docker.listContainers({ all: true, filters: { label: [`${LABEL}=1`] } });
}

export async function findEnvContainer(name: string) {
  const list = await docker.listContainers({
    all: true,
    filters: { label: [`${LABEL}=1`, `${LABEL_NAME}=${name}`] },
  });
  return list[0];
}

export async function createEnvContainer(input: {
  name: string;
  image: string;
  hostname: string;
  owner?: string;
  env: Record<string, string>;
}) {
  for (const vol of [homeVolume(input.name), tsVolume(input.name)]) {
    await docker.createVolume({ Name: vol, Labels: { [LABEL]: "1", [LABEL_NAME]: input.name } });
  }
  await ensureNetwork(config.dockerNetwork);
  return docker.createContainer({
    name: containerName(input.name),
    Image: input.image,
    Hostname: input.hostname,
    Env: Object.entries(input.env).map(([k, v]) => `${k}=${v}`),
    Labels: {
      [LABEL]: "1",
      [LABEL_NAME]: input.name,
      ...(input.owner ? { [LABEL_OWNER]: input.owner } : {}),
    },
    HostConfig: {
      RestartPolicy: { Name: "unless-stopped" },
      NetworkMode: config.dockerNetwork,
      Binds: [`${homeVolume(input.name)}:/home/dev`, `${tsVolume(input.name)}:/var/lib/tailscale`],
      Init: false,
    },
  });
}

export async function removeEnvContainer(name: string, purgeVolumes: boolean): Promise<void> {
  const found = await findEnvContainer(name);
  if (found) {
    const c = docker.getContainer(found.Id);
    if (found.State === "running") await c.stop({ t: 10 }).catch(() => undefined);
    await c.remove({ force: true });
  }
  if (purgeVolumes) {
    for (const vol of [homeVolume(name), tsVolume(name)]) {
      await docker.getVolume(vol).remove().catch(() => undefined);
    }
  }
}
