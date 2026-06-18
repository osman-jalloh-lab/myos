// E2B code execution — gives Prometheus a real cloud sandbox.
// Requires E2B_API_KEY in env (e2b.dev — 100 hours/month free).

import { Sandbox } from "@e2b/code-interpreter";

export interface CodeResult {
  output: string;
  error?: string;
}

const TIMEOUT_MS = 30_000;

export async function runCode(
  code: string,
  language: "python" | "javascript" | "bash" = "python"
): Promise<CodeResult> {
  if (!process.env.E2B_API_KEY) {
    return { output: "", error: "E2B_API_KEY is not set — add it to Vercel env vars." };
  }

  const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY, timeoutMs: TIMEOUT_MS });

  try {
    const execution = await sandbox.runCode(code, { language, timeoutMs: TIMEOUT_MS });

    const stdout = execution.logs.stdout.join("\n").trim();
    const stderr = execution.logs.stderr.join("\n").trim();
    const resultText = execution.results
      .map((r) => (r as { text?: string }).text ?? "")
      .filter(Boolean)
      .join("\n")
      .trim();

    const output = [stdout, resultText].filter(Boolean).join("\n").trim() || "(no output)";
    const error = execution.error
      ? `${execution.error.name}: ${execution.error.value}`
      : stderr || undefined;

    return { output, error };
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

export async function runBashFile(
  filename: string,
  content: string
): Promise<CodeResult & { filename: string }> {
  if (!process.env.E2B_API_KEY) {
    return { filename, output: "", error: "E2B_API_KEY is not set — add it to Vercel env vars." };
  }

  const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY, timeoutMs: TIMEOUT_MS });

  try {
    const path = `/home/user/${filename}`;
    await sandbox.files.write(path, content);
    const proc = await sandbox.commands.run(`bash ${path}`, { timeoutMs: TIMEOUT_MS });

    return {
      filename,
      output: proc.stdout.trim() || "(no output)",
      error: proc.stderr.trim() || proc.error || undefined,
    };
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

export function e2bConnected(): boolean {
  return !!process.env.E2B_API_KEY;
}
