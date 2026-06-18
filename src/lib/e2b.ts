// E2B code execution — gives Prometheus a real cloud sandbox.
// Requires E2B_API_KEY in env (e2b.dev — 100 hours/month free).

import { Sandbox } from "@e2b/code-interpreter";

export interface CodeResult {
  output: string;
  error?: string;
  files?: { path: string; content: string }[];
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

// Runs code, captures output, AND reads back any files written to /home/user/output/.
// Prometheus uses this to build full apps — the files can then be pushed to GitHub.
export async function runCodeAndCapture(
  code: string,
  language: "python" | "javascript" | "bash" = "python"
): Promise<CodeResult> {
  if (!process.env.E2B_API_KEY) {
    return { output: "", error: "E2B_API_KEY is not set — add it to Vercel env vars." };
  }

  const sandbox = await Sandbox.create({ apiKey: process.env.E2B_API_KEY, timeoutMs: TIMEOUT_MS });

  try {
    // Ensure output dir exists
    await sandbox.commands.run("mkdir -p /home/user/output", { timeoutMs: 5_000 });

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

    // Read any files written to /home/user/output/
    const files: { path: string; content: string }[] = [];
    try {
      const entries = await sandbox.files.list("/home/user/output");
      for (const entry of entries) {
        if (entry.type === "file") {
          const content = await sandbox.files.read(`/home/user/output/${entry.name}`);
          files.push({ path: entry.name, content });
        }
      }
    } catch {
      // Output dir empty or listing failed — not an error
    }

    return { output, error, files: files.length ? files : undefined };
  } finally {
    await sandbox.kill().catch(() => {});
  }
}

export function e2bConnected(): boolean {
  return !!process.env.E2B_API_KEY;
}
