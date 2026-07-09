export type CoreAgentKey =
  | "hermes"
  | "iris"
  | "kairos"
  | "argus"
  | "plutus"
  | "athena"
  | "mnemosyne"
  | "sophos"
  | "tyche"
  | "themis"
  | "prometheus"
  | "mercury";

export type CouncilAgentKey =
  | "council_openai"
  | "council_anthropic"
  | "council_ollama";

export type AgentKey = CoreAgentKey | CouncilAgentKey;

export interface RosterAgent {
  id: AgentKey | "mnemo";
  letter: string;
  name: string;
  role: string;
  color: string;
  emptyStateText?: string;
}

export const AGENT_ALIASES: Record<string, AgentKey> = {
  mnemo: "mnemosyne",
};

export const AGENT_COLORS: Record<AgentKey, string> = {
  hermes: "#A78BFA",
  iris: "#60A5FA",
  kairos: "#A78BFA",
  argus: "#FBBF24",
  plutus: "#34D399",
  athena: "#FBBF24",
  mnemosyne: "#2DD4BF",
  sophos: "#7DD3FC",
  tyche: "#A3E635",
  themis: "#FB7185",
  prometheus: "#F97316",
  mercury: "#F59E0B",
  council_openai: "#60A5FA",
  council_anthropic: "#C084FC",
  council_ollama: "#A3E635",
};

export function normalizeAgentKey(agentName: string): AgentKey {
  const key = agentName.trim().toLowerCase();
  return AGENT_ALIASES[key] ?? (key as AgentKey);
}

export const CHAT_ROSTER_AGENTS: RosterAgent[] = [
  {
    id: "hermes",
    letter: "H",
    name: "Hermes",
    role: "orchestrator - ask anything",
    color: AGENT_COLORS.hermes,
    emptyStateText: "Talk to Hermes, the orchestrator. Ask for anything; it routes to the right agent or answers itself.",
  },
  {
    id: "iris",
    letter: "I",
    name: "Iris",
    role: "email & communication",
    color: AGENT_COLORS.iris,
    emptyStateText: "Ask Iris about your inbox: unread counts, what needs a reply, or to draft a response. Drafts only, never sends.",
  },
  {
    id: "kairos",
    letter: "K",
    name: "Kairos",
    role: "calendar & time",
    color: AGENT_COLORS.kairos,
    emptyStateText: "Ask Kairos about your week: what's on the calendar, scheduling conflicts, or where to block focus time.",
  },
  {
    id: "argus",
    letter: "A",
    name: "Argus",
    role: "daily brief & signals",
    color: AGENT_COLORS.argus,
    emptyStateText: "Ask Argus what's worth your attention today: synthesized signals and risk-flagged items across your accounts.",
  },
  {
    id: "plutus",
    letter: "P",
    name: "Plutus",
    role: "finance (read-only)",
    color: AGENT_COLORS.plutus,
    emptyStateText: "Ask Plutus about your money: net position, budget status, or debt tracking. Read-only, never moves money.",
  },
  {
    id: "athena",
    letter: "A",
    name: "Athena",
    role: "jobs & resume",
    color: AGENT_COLORS.athena,
    emptyStateText: "Ask Athena about your job search: pipeline status, fit scores, or what to tighten on your resume.",
  },
  {
    id: "mnemo",
    letter: "M",
    name: "Mnemosyne",
    role: "memory",
    color: AGENT_COLORS.mnemosyne,
    emptyStateText: "Ask Mnemosyne what it remembers: approved facts and context cards relevant to what you're working on.",
  },
  {
    id: "sophos",
    letter: "S",
    name: "Sophos",
    role: "skills & capability scout",
    color: AGENT_COLORS.sophos,
    emptyStateText: "Ask Sophos what's new: recent Anthropic releases or repos worth a look for your stack.",
  },
  {
    id: "tyche",
    letter: "Y",
    name: "Tyche",
    role: "income opportunities",
    color: AGENT_COLORS.tyche,
    emptyStateText: "Ask Tyche about income opportunities: side income leads, gigs, and what's worth your hours right now.",
  },
  {
    id: "themis",
    letter: "T",
    name: "Themis",
    role: "workplace knowledge (I-9)",
    color: AGENT_COLORS.themis,
    emptyStateText: "Ask Themis about work and I-9 questions. Answers are grounded only in your loaded workplace knowledge files.",
  },
  {
    id: "prometheus",
    letter: "P",
    name: "Prometheus",
    role: "idea forge & builder",
    color: AGENT_COLORS.prometheus,
    emptyStateText: "Ask Prometheus to shape an idea, website, or app build into concrete next steps.",
  },
];

export const COUNCIL_REVIEWER_AGENTS: RosterAgent[] = [
  {
    id: "council_openai",
    letter: "O",
    name: "OpenAI",
    role: "Engineering reviewer",
    color: AGENT_COLORS.council_openai,
    emptyStateText: "Visit OpenAI's engineering office for implementation checks, code plans, and repo-level review. This office talks to OpenAI only.",
  },
  {
    id: "council_anthropic",
    letter: "C",
    name: "Claude",
    role: "Architecture reviewer",
    color: AGENT_COLORS.council_anthropic,
    emptyStateText: "Visit Claude's architecture office for system design, tradeoffs, and long-form reasoning. This office talks to Anthropic only.",
  },
  {
    id: "council_ollama",
    letter: "L",
    name: "Ollama",
    role: "Local reviewer",
    color: AGENT_COLORS.council_ollama,
    emptyStateText: "Visit Ollama's local office for private low-cost review on the always-on laptop. This office talks to Ollama only.",
  },
];

export const TASK_ASSIGNABLE_AGENT_KEYS: CoreAgentKey[] = CHAT_ROSTER_AGENTS.map((agent) =>
  normalizeAgentKey(agent.id)
).filter((agent): agent is CoreAgentKey => !agent.startsWith("council_"));

export const COMMAND_AGENT_PREFIXES: CoreAgentKey[] = [
  ...TASK_ASSIGNABLE_AGENT_KEYS.filter((agent) => agent !== "hermes"),
  "mercury",
];

export function isTaskAssignableAgent(agentName: string): boolean {
  const key = normalizeAgentKey(agentName);
  return !key.startsWith("council_") && TASK_ASSIGNABLE_AGENT_KEYS.includes(key as CoreAgentKey);
}

export function chatTargetForAgent(agentName: string): AgentKey | null {
  const key = normalizeAgentKey(agentName);
  return key === "hermes" ? null : key;
}

export function agentColor(agentName: string): string {
  return AGENT_COLORS[normalizeAgentKey(agentName)] ?? "#94A3B8";
}
