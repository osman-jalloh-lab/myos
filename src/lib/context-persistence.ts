import { prisma } from "@/lib/db";

export type ActiveIntentCategory =
  | "active_travel_search"
  | "active_job_search"
  | "active_build_project"
  | "active_email_follow_up"
  | "active_research_task"
  | "user_preferences"
  | "connected_tools"
  | "failed_tools"
  | "pending_approvals";

export interface TravelSearchContext {
  origin?: string;
  destination?: string;
  dateRange?: string;
  rawRequest: string;
}

export interface BuildProjectContext {
  projectName?: string;
  rawRequest: string;
}

export interface RememberedEntities {
  travelSearch?: TravelSearchContext;
  buildProject?: BuildProjectContext;
  jobSearch?: { rawRequest: string };
  emailFollowUp?: { rawRequest: string };
  researchTask?: { rawRequest: string };
  preferences?: string[];
}

export interface ToolHealthEntry {
  tool: string;
  status: "available" | "unavailable" | "unknown";
  reason: string | null;
  lastChecked: string;
}

export interface ToolFailureEntry {
  tool: string;
  reason: string;
  timestamp: string;
}

export interface SessionContextState {
  activeIntent: ActiveIntentCategory | null;
  rememberedEntities: RememberedEntities;
  toolHealth: ToolHealthEntry[];
  recentFailures: ToolFailureEntry[];
}

export interface ContextResolution {
  resolvedText: string;
  reason: string | null;
  activeIntent: ActiveIntentCategory | null;
}

const DATE_RANGE_RE =
  /\b((?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:\s*(?:-|–|to)\s*\d{1,2})?(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*(?:-|–|to)\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?)/i;

function cleanEntity(value: string | undefined): string | undefined {
  const cleaned = value
    ?.replace(/\b(round trip|one way|one-way|flight|flights|prices?|fares?|tickets?)\b/gi, "")
    .replace(/[,.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 2 || cleaned.length > 80) return undefined;
  return cleaned.replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractTravelSearch(text: string): TravelSearchContext | null {
  if (!/\b(flights?|fly|airfare|plane ticket|travel)\b/i.test(text)) return null;

  const fromTo = text.match(/\bfrom\s+(.+?)\s+to\s+(.+?)(?:\s+(?:on|for|from)?\s*([A-Za-z]{3,9}\.?\s+\d{1,2}(?:\s*(?:-|–|to)\s*\d{1,2})?(?:,\s*\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?:\s*(?:-|–|to)\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?))?(?:[,.!?]|$)/i);
  const toOnly = !fromTo
    ? text.match(/\b(?:flight|flights|fly)\s+(?:to|into)\s+(.+?)(?:\s+(?:from)\s+(.+?))?(?:[,.!?]|$)/i)
    : null;
  const date = text.match(DATE_RANGE_RE)?.[1]?.replace(/–/g, "-").trim();

  if (fromTo) {
    const origin = cleanEntity(fromTo[1]);
    const destination = cleanEntity(fromTo[2]);
    if (!origin && !destination) return null;
    return { origin, destination, dateRange: fromTo[3]?.replace(/–/g, "-").trim() ?? date, rawRequest: text };
  }

  if (toOnly) {
    const destination = cleanEntity(toOnly[1]);
    const origin = cleanEntity(toOnly[2]);
    return { origin, destination, dateRange: date, rawRequest: text };
  }

  return { dateRange: date, rawRequest: text };
}

function extractBuildProject(text: string): BuildProjectContext | null {
  const direct = text.match(/\b(?:build|create|make|design|develop)\s+(?:a\s+|an\s+|the\s+)?(.{3,80}?)(?:\s+(?:for me|please|with|using|that|and)\b|[.!?]|$)/i);
  if (!direct) return null;
  const projectName = cleanEntity(direct[1]);
  if (!projectName) return null;
  return { projectName, rawRequest: text };
}

export function mergeContextFromMessage(previous: SessionContextState, message: string): SessionContextState {
  const rememberedEntities: RememberedEntities = { ...previous.rememberedEntities };
  let activeIntent = previous.activeIntent;

  const travelSearch = extractTravelSearch(message);
  if (travelSearch) {
    rememberedEntities.travelSearch = {
      ...rememberedEntities.travelSearch,
      ...travelSearch,
      rawRequest: message,
    };
    activeIntent = "active_travel_search";
  }

  const buildProject = extractBuildProject(message);
  if (buildProject) {
    rememberedEntities.buildProject = {
      ...rememberedEntities.buildProject,
      ...buildProject,
      rawRequest: message,
    };
    activeIntent = "active_build_project";
  }

  if (/\b(job search|find jobs|job openings|roles in|applications?)\b/i.test(message)) {
    rememberedEntities.jobSearch = { rawRequest: message };
    activeIntent = "active_job_search";
  }

  if (/\b(email follow.?up|reply to|respond to|recruiter follow.?up)\b/i.test(message)) {
    rememberedEntities.emailFollowUp = { rawRequest: message };
    activeIntent = "active_email_follow_up";
  }

  if (/\b(research|brief|source summary|pdf|youtube|github repo)\b/i.test(message)) {
    rememberedEntities.researchTask = { rawRequest: message };
    activeIntent = "active_research_task";
  }

  return { ...previous, activeIntent, rememberedEntities };
}

export function resolveMessageWithContext(message: string, state: SessionContextState): ContextResolution {
  const trimmed = message.trim();
  const travel = state.rememberedEntities.travelSearch;
  if (
    state.activeIntent === "active_travel_search" &&
    travel &&
    /\b(show me prices|prices|fares|cost|cheapest|options|times|nonstop|airlines?)\b/i.test(trimmed) &&
    !/\bfrom\s+\w+|\bto\s+\w+/i.test(trimmed)
  ) {
    const route = [travel.origin, travel.destination].filter(Boolean).join(" to ");
    const date = travel.dateRange ? ` on ${travel.dateRange}` : "";
    return {
      resolvedText: `Continue active flight search: show flight prices/options for ${route}${date}. User follow-up: ${trimmed}`,
      reason: "Resolved flight follow-up from active travel search context.",
      activeIntent: "active_travel_search",
    };
  }

  const build = state.rememberedEntities.buildProject;
  if (
    state.activeIntent === "active_build_project" &&
    build &&
    /\b(it|this|that|make it|improve|better|polish|upgrade|fix it|keep going)\b/i.test(trimmed) &&
    !/\b(email|calendar|flight|job|research)\b/i.test(trimmed)
  ) {
    return {
      resolvedText: `Continue active build project "${build.projectName ?? "current project"}": ${trimmed}`,
      reason: "Resolved pronoun/reference from active build project context.",
      activeIntent: "active_build_project",
    };
  }

  return { resolvedText: message, reason: null, activeIntent: state.activeIntent };
}

export function parseSessionJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function contextStateFromContextBlock(chatContext: string | undefined): SessionContextState {
  const lines = chatContext?.split("\n") ?? [];
  const activeIntentLine = lines.find((line) => line.startsWith("ACTIVE INTENT:"));
  const entitiesLine = lines.find((line) => line.startsWith("REMEMBERED ENTITIES:"));
  const activeIntentText = activeIntentLine?.replace("ACTIVE INTENT:", "").trim() || null;
  const activeIntent = activeIntentText && activeIntentText !== "none"
    ? activeIntentText as SessionContextState["activeIntent"]
    : null;
  return {
    activeIntent,
    rememberedEntities: parseSessionJson<RememberedEntities>(entitiesLine?.replace("REMEMBERED ENTITIES:", "").trim(), {}),
    toolHealth: parseToolHealthFromContext(lines),
    recentFailures: parseFailuresFromContext(lines),
  };
}

function parseToolHealthFromContext(lines: string[]): ToolHealthEntry[] {
  const entries: ToolHealthEntry[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line === "TOOL HEALTH:") {
      inSection = true;
      continue;
    }
    if (inSection && line.trim() === "") break;
    if (!inSection || !line.startsWith("  - ")) continue;
    const match = line.match(/^\s+-\s+(.+?):\s+(available|unavailable|unknown)(?:\s+\((.+)\))?/i);
    if (match) {
      entries.push({
        tool: match[1],
        status: match[2].toLowerCase() as ToolHealthEntry["status"],
        reason: match[3] ?? null,
        lastChecked: new Date().toISOString(),
      });
    }
  }
  return entries;
}

function parseFailuresFromContext(lines: string[]): ToolFailureEntry[] {
  const entries: ToolFailureEntry[] = [];
  let inSection = false;
  for (const line of lines) {
    if (line === "RECENT TOOL FAILURES:") {
      inSection = true;
      continue;
    }
    if (inSection && line.trim() === "") break;
    if (!inSection || !line.startsWith("  - ")) continue;
    const match = line.match(/^\s+-\s+(.+?):\s+(.+?)(?:\s+\((.+)\))?$/);
    if (match) {
      entries.push({ tool: match[1], reason: match[2], timestamp: match[3] ?? new Date().toISOString() });
    }
  }
  return entries;
}

export function toolHealthFromEnvironment(now = new Date()): ToolHealthEntry[] {
  const checked = now.toISOString();
  const hasAny = (...keys: string[]) => keys.some((key) => Boolean(process.env[key]));
  const hasAll = (...keys: string[]) => keys.every((key) => Boolean(process.env[key]));
  return [
    {
      tool: "Web Search",
      status: hasAny("FIRECRAWL_API_KEY") ? "available" : "unavailable",
      reason: hasAny("FIRECRAWL_API_KEY") ? null : "Missing FIRECRAWL_API_KEY.",
      lastChecked: checked,
    },
    {
      tool: "Google Flights Search",
      status: hasAny("SERPAPI_API_KEY") ? "available" : "unavailable",
      reason: hasAny("SERPAPI_API_KEY") ? null : "Missing SERPAPI_API_KEY.",
      lastChecked: checked,
    },
    {
      tool: "Amadeus Travel Search",
      status: hasAll("AMADEUS_CLIENT_ID", "AMADEUS_CLIENT_SECRET") ? "available" : "unavailable",
      reason: hasAll("AMADEUS_CLIENT_ID", "AMADEUS_CLIENT_SECRET") ? null : "Missing AMADEUS_CLIENT_ID or AMADEUS_CLIENT_SECRET.",
      lastChecked: checked,
    },
    {
      tool: "Fugu Design Critic",
      status: hasAny("SAKANA_API_KEY") ? "available" : "unavailable",
      reason: hasAny("SAKANA_API_KEY") ? null : "Missing SAKANA_API_KEY.",
      lastChecked: checked,
    },
  ];
}

export function redactFailureReason(reason: string): string {
  return reason
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .slice(0, 300);
}

export async function persistToolFailure(userId: string, tool: string, reason: string): Promise<void> {
  const safeReason = redactFailureReason(reason);
  await prisma.memory.create({
    data: {
      userId,
      fact: `Tool unavailable: ${tool} - ${safeReason}`,
      source: `tool-health:${tool.toLowerCase().replace(/\s+/g, "-")}`,
      approvedAt: new Date(),
    },
  });
}

export async function recentToolFailures(userId: string, limit = 8): Promise<ToolFailureEntry[]> {
  const rows = await prisma.memory.findMany({
    where: { userId, source: { startsWith: "tool-health:" } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map((row) => {
    const cleaned = row.fact.replace(/^Tool unavailable:\s*/i, "");
    const [tool, ...rest] = cleaned.split(" - ");
    return {
      tool: tool || row.source?.replace("tool-health:", "") || "Unknown tool",
      reason: rest.join(" - ") || cleaned,
      timestamp: row.createdAt.toISOString(),
    };
  });
}

export function serializeContextState(state: SessionContextState): {
  activeIntent: string | null;
  rememberedEntities: string;
  toolHealth: string;
  recentFailures: string;
} {
  return {
    activeIntent: state.activeIntent,
    rememberedEntities: JSON.stringify(state.rememberedEntities),
    toolHealth: JSON.stringify(state.toolHealth),
    recentFailures: JSON.stringify(state.recentFailures),
  };
}
