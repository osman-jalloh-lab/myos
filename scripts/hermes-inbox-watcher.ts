import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) return;
  const content = readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function loadEnv(): void {
  const cwd = process.cwd();
  loadEnvFile(path.join(cwd, ".env.local"));
  loadEnvFile(path.join(cwd, ".env"));
}

function normalizeBaseUrl(value: string | undefined): string | null {
  if (!value?.trim()) return null;
  const candidate = /^https?:\/\//i.test(value.trim()) ? value.trim() : `https://${value.trim()}`;
  try {
    const url = new URL(candidate);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : null;
  } catch {
    return null;
  }
}

function getConfig() {
  const baseUrl = normalizeBaseUrl(
    process.env.HERMES_WORKER_API_BASE_URL
      ?? process.env.NEXT_PUBLIC_APP_URL
      ?? process.env.VERCEL_URL
  );
  const secret = process.env.HERMES_INBOX_WATCHER_SECRET?.trim() || process.env.CRON_SECRET?.trim();
  const interval = Number(process.env.HERMES_INBOX_WATCH_INTERVAL_MS ?? DEFAULT_INTERVAL_MS);
  if (!baseUrl) throw new Error("Set HERMES_WORKER_API_BASE_URL (or NEXT_PUBLIC_APP_URL) for the inbox watcher.");
  if (!secret) throw new Error("Set HERMES_INBOX_WATCHER_SECRET or CRON_SECRET for the inbox watcher.");
  if (!Number.isFinite(interval) || interval < 60_000) {
    throw new Error("HERMES_INBOX_WATCH_INTERVAL_MS must be at least 60000.");
  }
  return { baseUrl, secret, interval };
}

async function scan(baseUrl: string, secret: string): Promise<void> {
  const target = new URL("/api/cron/email-watcher?mode=fast", baseUrl).toString();
  const response = await fetch(target, {
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(55_000),
    cache: "no-store",
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Inbox scan failed (${response.status}): ${text.slice(0, 300)}`);

  try {
    const result = JSON.parse(text) as { processed?: string[]; mode?: string };
    const count = result.processed?.length ?? 0;
    console.log(`[inbox-watcher] ${result.mode ?? "fast"} scan complete. ${count} relevant message${count === 1 ? "" : "s"} processed.`);
  } catch {
    console.log("[inbox-watcher] Scan complete.");
  }
}

async function main(): Promise<void> {
  loadEnv();
  const { baseUrl, secret, interval } = getConfig();
  const runOnce = process.env.HERMES_INBOX_WATCHER_ONCE === "1";
  console.log(`[inbox-watcher] Watching ${baseUrl} every ${Math.round(interval / 60_000)} minute(s).`);

  do {
    try {
      await scan(baseUrl, secret);
    } catch (error) {
      console.error(`[inbox-watcher] ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!runOnce) await new Promise((resolve) => setTimeout(resolve, interval));
  } while (!runOnce);
}

main().catch((error) => {
  console.error(`[inbox-watcher] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
