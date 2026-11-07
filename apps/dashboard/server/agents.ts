/**
 * Global agent instructions, set in Settings and pushed into every environment.
 *
 * The dashboard writes the text to /etc/t3m-agent/instructions.md (world-readable,
 * so dev can read it; /etc/t3m holds secrets and is root-only). The image's
 * agent-guidance.sh, run as dev on every start and right after a save, copies it
 * into a managed block in ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md. The rest of
 * those files is left to the people using the environment.
 */

export const AGENT_DIR = "/etc/t3m-agent";
export const AGENT_INSTRUCTIONS_FILE = `${AGENT_DIR}/instructions.md`;
export const AGENT_GUIDANCE_SCRIPT = "/usr/local/lib/t3m/agent-guidance.sh";
/** Characters. Both agents load this into every conversation, so keep it modest. */
export const MAX_AGENT_INSTRUCTIONS = 64 * 1024;

/** Line endings to \n, no trailing whitespace at the end, one final newline (empty stays empty). */
export function normalizeInstructions(text: string): string {
  const t = text.replace(/\r\n?/g, "\n").replace(/\s+$/, "");
  return t ? `${t}\n` : "";
}

export function validateInstructions(text: string): string | null {
  if (text.length > MAX_AGENT_INSTRUCTIONS) return `Instructions are limited to ${MAX_AGENT_INSTRUCTIONS / 1024} KB`;
  if (/\u0000/.test(text)) return "Instructions can't contain NUL characters";
  return null;
}

/** The managed file for a tar archive extracted at /. */
export function agentTarFiles(text: string): { name: string; content?: string; mode: number; dir?: boolean }[] {
  const dir = AGENT_DIR.replace(/^\//, "");
  return [
    { name: `${dir}/`, dir: true, mode: 0o755 },
    { name: `${dir}/instructions.md`, content: normalizeInstructions(text), mode: 0o644 },
  ];
}

/**
 * Runs as dev in a running container: rewrites the managed blocks now. Prints
 * "missing" when the image predates agent-guidance.sh's instructions support,
 * so the dashboard can say the image needs a rebuild.
 */
export const AGENT_APPLY_SCRIPT = `if [ -x ${AGENT_GUIDANCE_SCRIPT} ] && grep -q t3m-agent ${AGENT_GUIDANCE_SCRIPT}; then
  ${AGENT_GUIDANCE_SCRIPT} && echo applied
else
  echo missing
fi`;
