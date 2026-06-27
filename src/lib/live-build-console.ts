export type BuildStepStatus = "pending" | "running" | "complete" | "failed" | "skipped";

export type BuildTimelineStep = {
  key: string;
  label: string;
  status: BuildStepStatus;
  timestamp: string | null;
};

export type LiveBuildLog = {
  timestamp: string | null;
  source: string;
  message: string;
  technical: boolean;
  status: "info" | "success" | "warning" | "error";
};

export type LiveBuildConsoleData = {
  active: boolean;
  project: null | {
    id: string;
    name: string;
    appType: string;
    folderPath: string | null;
    executor: string;
    status: string;
    statusMeaning: string;
    startedAt: string | null;
    updatedAt: string;
    elapsedMs: number;
    stuck: boolean;
    minutesSinceUpdate: number;
  };
  timeline: BuildTimelineStep[];
  logs: LiveBuildLog[];
  files: string[];
  preview: null | { url: string; status: string; manualCommand: string | null };
  worker: { status: "online" | "offline" | "stale"; lastHeartbeat: string | null };
};

export function redactBuildText(value: string): string {
  return value
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/[A-Za-z]:\\Users\\[^\\\s"']+/gi, (match) => process.env.VERCEL ? match.replace(/^[A-Za-z]:\\Users\\[^\\]+/i, "%USERPROFILE%") : match)
    .slice(0, 4000);
}

export function inferAppType(text: string): string {
  const value = text.toLowerCase();
  if (/\bwatch|watches|timepiece|horology\b/.test(value)) return /marketplace|store|shop|ecommerce/.test(value) ? "watch marketplace" : "watch website";
  if (/job tracker|application tracker/.test(value)) return "job tracker app";
  if (/restaurant/.test(value)) return "restaurant website";
  if (/portfolio/.test(value)) return "portfolio website";
  if (/apartment|rental|property/.test(value)) return "apartment finder app";
  if (/productivity/.test(value)) return "personal productivity website";
  if (/marketplace|store|shop|ecommerce/.test(value)) return "ecommerce website";
  if (/dashboard/.test(value)) return "dashboard app";
  if (/landing page/.test(value)) return "landing page";
  return /\bapp\b/.test(value) ? "web app" : "website";
}

export function buildStatusMeaning(status: string, executor: string, logText: string, hasPreview: boolean): string {
  const text = `${status} ${logText}`.toLowerCase();
  if (/failed|error/.test(text)) return "Build failed, needs attention";
  if (hasPreview) return "Preview is ready";
  if (/browser qa|browser_qa/.test(text)) return "Running browser QA";
  if (/building|npm run build/.test(text)) return "Running build check";
  if (executor === "hermes_agent" && /executing|launched|running/.test(text)) return "Hermes Agent is editing files";
  if (/executing|worker claimed|claimed by/.test(text)) return "Worker is building locally";
  if (/waiting|clarif/.test(text)) return "Waiting for your answers";
  return "Planning your app";
}

export function parseTimestampedLog(line: string): { timestamp: string | null; message: string } {
  const match = line.trim().match(/^(\d{4}-\d{2}-\d{2}T[^\s]+)\s+(.+)$/);
  return { timestamp: match?.[1] ?? null, message: redactBuildText(match?.[2] ?? line.trim()) };
}

export function extractBuildFiles(text: string): string[] {
  const found = new Set<string>();
  const pathPattern = /(?:^|[\s,`"'])(package(?:-lock)?\.json|src\/[A-Za-z0-9_./-]+|components\/[A-Za-z0-9_./-]+)/gim;
  for (const match of text.matchAll(pathPattern)) {
    const file = match[1].replace(/[.,;)]+$/, "");
    if (!/\.env|node_modules|\.next/i.test(file)) found.add(file);
  }
  return [...found].slice(0, 80);
}
