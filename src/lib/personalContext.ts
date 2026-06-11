import { existsSync, readFileSync, appendFileSync } from "fs";
import { join } from "path";

const CONTEXT_DIR = join(process.cwd(), "hermes-context");

function readIfExists(relativePath: string): string {
  const fullPath = join(CONTEXT_DIR, relativePath);
  if (!existsSync(fullPath)) return "";
  try {
    return readFileSync(fullPath, "utf-8").trim();
  } catch {
    return "";
  }
}

/**
 * Returns a single string containing all personal context files.
 * Returns empty string if the hermes-context/ folder is absent (safe in test/CI).
 */
export function getPersonalContext(): string {
  if (!existsSync(CONTEXT_DIR)) return "";

  const sections = [
    { label: "WHO IS OSMAN (aios-intake)", content: readIfExists("aios-intake.md") },
    { label: "CURRENT PRIORITIES", content: readIfExists("context/priorities.md") },
    { label: "KEY CONNECTIONS", content: readIfExists("connections.md") },
    { label: "WEEKLY OPERATING FRAMEWORK", content: readIfExists("3ms-framework.md") },
  ];

  return sections
    .filter((s) => s.content)
    .map((s) => `--- ${s.label} ---\n${s.content}`)
    .join("\n\n");
}

/**
 * Appends a dated entry to hermes-context/decisions/log.md.
 * Call this from an agent after a significant decision is confirmed.
 * No-ops silently if the file path is not writable.
 */
export function appendDecision(entry: string): void {
  const logPath = join(CONTEXT_DIR, "decisions", "log.md");
  if (!existsSync(logPath)) return;
  const line = `\n- [${new Date().toISOString().slice(0, 10)}] ${entry}`;
  try {
    appendFileSync(logPath, line, "utf-8");
  } catch {
    // non-fatal — decision logging should never crash an agent
  }
}
