import { describe, expect, it } from "vitest";
import { packFiles, parseToolchains, readTarEntry } from "../server/docker.js";

const sample = {
  built: "2026-11-07T19:00:00Z",
  toolchains: "full",
  languages: [
    { name: "Node.js", tools: "npm, pnpm", default: "24.22.2", versions: ["24.22.2", "26.13.0", "22.23.4"] },
    { name: "Rust", tools: "cargo", default: "stable 1.99.1", versions: ["stable 1.99.1", "nightly 1.101.0-nightly"] },
  ],
};

describe("readTarEntry", () => {
  it("finds a file by name in an archive like docker's getArchive returns", async () => {
    const tar = await packFiles([
      { name: "other.txt", content: "nope", mode: 0o644 },
      { name: "toolchains.json", content: JSON.stringify(sample), mode: 0o644 },
    ]);
    expect(JSON.parse((await readTarEntry(tar, "toolchains.json"))!)).toEqual(sample);
  });

  it("matches a nested path and skips directories", async () => {
    const tar = await packFiles([
      { name: "usr/local/share/t3m/", dir: true },
      { name: "usr/local/share/t3m/toolchains.json", content: "{}", mode: 0o644 },
    ]);
    expect(await readTarEntry(tar, "toolchains.json")).toBe("{}");
  });

  it("returns null when the file isn't there", async () => {
    const tar = await packFiles([{ name: "a.txt", content: "a" }]);
    expect(await readTarEntry(tar, "toolchains.json")).toBeNull();
  });
});

describe("parseToolchains", () => {
  it("parses the file the image writes", () => {
    expect(parseToolchains(JSON.stringify(sample))).toEqual(sample);
  });

  it("returns null for missing or broken files", () => {
    expect(parseToolchains(null)).toBeNull();
    expect(parseToolchains("not json")).toBeNull();
    expect(parseToolchains(JSON.stringify({ built: "x" }))).toBeNull();
  });

  it("drops malformed languages and fills in a missing default", () => {
    const t = parseToolchains(JSON.stringify({ built: "x", toolchains: "minimal", languages: [{ name: "Go", versions: ["1.27.3"] }, { versions: [] }, null] }));
    expect(t?.languages).toEqual([{ name: "Go", tools: "", default: "1.27.3", versions: ["1.27.3"] }]);
  });
});
