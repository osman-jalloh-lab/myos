import type { LiveBuildLog } from "@/lib/live-build-console";

export type ExecutionConsoleTab = "console" | "changes" | "commands" | "tests" | "files" | "trace";

export function executionEngineLabel(executor: string, logs: LiveBuildLog[]): string {
  if (/local[_ -]?worker/i.test(executor)) return "Local worker";
  const text = `${executor} ${logs.map((item) => `${item.source} ${item.message}`).join(" ")}`;
  if (/codex/i.test(text)) return "Codex CLI";
  if (/claude|anthropic/i.test(text)) return "Claude";
  if (/openai/i.test(text)) return "OpenAI";
  if (/deepseek/i.test(text)) return "DeepSeek";
  if (/hermes agent/i.test(text)) return "Hermes Agent";
  if (/local worker|local builder/i.test(text)) return "Local worker";
  return executor || "Not recorded";
}

export function commandLogs(logs: LiveBuildLog[]): LiveBuildLog[] {
  return logs.filter((item) => /npm|npx|pnpm|yarn|command|shell|package manager/i.test(item.source)
    || /(^|\s)(npm|npx|pnpm|yarn)\s|command(?: ran|:)|install(?:ing|ed)? dependencies|run build/i.test(item.message));
}

export function testLogs(logs: LiveBuildLog[]): LiveBuildLog[] {
  return logs.filter((item) => /test|vitest|jest|playwright|browser qa|lint|typecheck|typescript|build (?:pass|fail|complete)/i.test(`${item.source} ${item.message}`));
}
