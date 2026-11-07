import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_AGENT_INSTRUCTIONS, agentTarFiles, normalizeInstructions, validateInstructions } from "../server/agents";

const SCRIPT = path.resolve(__dirname, "../../../images/t3-env/lib/agent-guidance.sh");

describe("agent instructions", () => {
  it("normalizes line endings and trailing whitespace", () => {
    expect(normalizeInstructions("# Hi\r\nthere\r\n\n  ")).toBe("# Hi\nthere\n");
    expect(normalizeInstructions("  \n\n")).toBe("");
  });

  it("writes a world-readable file under /etc/t3m-agent", () => {
    const files = agentTarFiles("Be nice.");
    expect(files).toEqual([
      { name: "etc/t3m-agent/", dir: true, mode: 0o755 },
      { name: "etc/t3m-agent/instructions.md", content: "Be nice.\n", mode: 0o644 },
    ]);
  });

  it("limits the size", () => {
    expect(validateInstructions("x".repeat(MAX_AGENT_INSTRUCTIONS))).toBeNull();
    expect(validateInstructions("x".repeat(MAX_AGENT_INSTRUCTIONS + 1))).toMatch(/limited/);
    expect(validateInstructions("a\u0000b")).toMatch(/NUL/);
  });
});

describe("agent-guidance.sh", () => {
  function setup() {
    const dir = mkdtempSync(path.join(tmpdir(), "t3m-guidance-"));
    const home = path.join(dir, "home");
    mkdirSync(path.join(home, ".claude"), { recursive: true });
    const tools = path.join(dir, "TOOLS.md");
    const instr = path.join(dir, "instructions.md");
    const run = () =>
      execFileSync("bash", [SCRIPT], { env: { ...process.env, HOME: home, T3M_TOOLS_FILE: tools, T3M_INSTRUCTIONS_FILE: instr } });
    const claude = () => readFileSync(path.join(home, ".claude/CLAUDE.md"), "utf8");
    const codex = () => readFileSync(path.join(home, ".codex/AGENTS.md"), "utf8");
    return { home, tools, instr, run, claude, codex };
  }

  it("adds the instructions block, keeps user notes, and is idempotent", () => {
    const e = setup();
    writeFileSync(e.tools, "# Tools\n- rg\n");
    writeFileSync(e.instr, "## Rules\nBe nice.");
    writeFileSync(path.join(e.home, ".claude/CLAUDE.md"), "my own note\n");
    e.run();
    const first = e.claude();
    expect(first).toContain("# Tools\n- rg\n<!-- <<< t3-manager tools -->");
    expect(first).toMatch(/t3-manager instructions \(managed[^\n]*\n## Rules\nBe nice\.\n<!-- <<< t3-manager instructions -->/);
    expect(first.trimEnd().endsWith("my own note")).toBe(true);
    expect(e.codex()).toContain("Be nice.");
    e.run();
    expect(e.claude()).toBe(first);
  });

  it("removes the block when the instructions are cleared", () => {
    const e = setup();
    writeFileSync(e.tools, "# Tools\n");
    writeFileSync(e.instr, "Be nice.\n");
    e.run();
    writeFileSync(e.instr, "");
    e.run();
    expect(e.claude()).not.toContain("instructions");
    expect(e.claude()).toContain("# Tools");
  });

  it("works without a tools list", () => {
    const e = setup();
    writeFileSync(e.instr, "Only this.\n");
    e.run();
    expect(e.claude()).not.toContain("t3-manager tools");
    expect(e.claude()).toContain("Only this.");
  });
});
