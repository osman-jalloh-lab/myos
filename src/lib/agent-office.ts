import type { CoreAgentKey } from "@/lib/agent-roster";

export type AgentOfficeIdentity = {
  id: CoreAgentKey;
  name: string;
  role: string;
  department: string;
  purpose: string;
  accent: string;
  image: string | null;
  safetyLabel: string;
  readOnly: boolean;
};

const PORTRAIT_AGENTS = new Set<CoreAgentKey>([
  "hermes", "argus", "iris", "kairos", "prometheus", "mnemosyne", "themis", "athena", "plutus",
]);

export const AGENT_OFFICE_IDENTITIES: Record<CoreAgentKey, AgentOfficeIdentity> = {
  hermes: { id: "hermes", name: "Hermes", role: "Executive orchestrator", department: "Command", purpose: "Coordinates work, delegates to specialists, and keeps policy and approvals authoritative.", accent: "#C7A55B", image: "/agents/hermes.jpg", safetyLabel: "Policy-governed orchestration", readOnly: false },
  argus: { id: "argus", name: "Argus", role: "Signals and risk specialist", department: "Intelligence", purpose: "Surfaces fresh signals, attention items, monitoring results, and risk.", accent: "#FBBF24", image: "/agents/argus.jpg", safetyLabel: "Read and investigate", readOnly: true },
  iris: { id: "iris", name: "Iris", role: "Communication specialist", department: "Communications", purpose: "Reviews communication, prepares drafts, and tracks follow-up without silently sending.", accent: "#60A5FA", image: "/agents/iris.jpg", safetyLabel: "Sending requires approval", readOnly: false },
  kairos: { id: "kairos", name: "Kairos", role: "Planning and time specialist", department: "Time Operations", purpose: "Organizes deadlines, schedule context, focus time, and planning decisions.", accent: "#38BDF8", image: "/agents/kairos.jpg", safetyLabel: "Calendar writes require approval", readOnly: false },
  prometheus: { id: "prometheus", name: "Prometheus", role: "Builder and coding agent", department: "Engineering", purpose: "Turns approved project intent into isolated builds, tests, QA evidence, and previews.", accent: "#F97316", image: "/agents/prometheus.jpg", safetyLabel: "Docker-isolated project execution", readOnly: false },
  mnemosyne: { id: "mnemosyne", name: "Mnemosyne", role: "Memory and context keeper", department: "Knowledge", purpose: "Retrieves approved facts, project context, decisions, and recent memory use.", accent: "#2DD4BF", image: "/agents/mnemosyne.jpg", safetyLabel: "Approved and inferred memory separated", readOnly: true },
  themis: { id: "themis", name: "Themis", role: "Workplace knowledge specialist", department: "Compliance", purpose: "Explains workplace and I-9 knowledge with evidence, uncertainty, and human-review boundaries.", accent: "#FB7185", image: "/agents/themis.jpg", safetyLabel: "Human review for consequential guidance", readOnly: true },
  athena: { id: "athena", name: "Athena", role: "Career strategy specialist", department: "Career Strategy", purpose: "Supports job research, resume work, interview preparation, and career planning.", accent: "#E879F9", image: "/agents/athena.jpg", safetyLabel: "External submissions require approval", readOnly: false },
  plutus: { id: "plutus", name: "Plutus", role: "Financial insight specialist", department: "Finance", purpose: "Provides read-only analysis of available financial context without moving money.", accent: "#34D399", image: "/agents/plutus.jpg", safetyLabel: "Read-only · transactions disabled", readOnly: true },
  sophos: { id: "sophos", name: "Sophos", role: "Skills and capability scout", department: "Capability", purpose: "Reviews available skills and identifies bounded capability improvements.", accent: "#7DD3FC", image: null, safetyLabel: "Installation remains approval-gated", readOnly: true },
  tyche: { id: "tyche", name: "Tyche", role: "Opportunity specialist", department: "Opportunity", purpose: "Evaluates income opportunities and helps prioritize credible next steps.", accent: "#A3E635", image: null, safetyLabel: "Analysis only unless approved", readOnly: true },
  mercury: { id: "mercury", name: "Mercury", role: "Travel and external-tools specialist", department: "External Operations", purpose: "Compares public travel, weather, mapping, and price information without booking.", accent: "#F59E0B", image: null, safetyLabel: "No autonomous booking", readOnly: true },
};

export function agentOfficeIdentity(id: CoreAgentKey): AgentOfficeIdentity {
  const identity = AGENT_OFFICE_IDENTITIES[id];
  return { ...identity, image: PORTRAIT_AGENTS.has(id) ? identity.image : null };
}

export function agentTextMatches(agent: CoreAgentKey, ...values: Array<string | null | undefined>): boolean {
  const haystack = values.filter(Boolean).join(" ");
  const aliases: Record<CoreAgentKey, RegExp> = {
    hermes: /hermes|orchestrat|delegat/i,
    prometheus: /prometheus|builder|codex|engineering|local_worker/i,
    argus: /argus|signal|risk|brief|monitor/i,
    iris: /iris|email|gmail|message|communication/i,
    kairos: /kairos|calendar|schedule|deadline|time/i,
    mnemosyne: /mnemosyne|mnemo|memory|context|fact/i,
    themis: /themis|i-?9|workplace|compliance|policy/i,
    athena: /athena|career|resume|job|interview/i,
    plutus: /plutus|finance|budget|debt|cash flow/i,
    sophos: /sophos|skill|capability|scout/i,
    tyche: /tyche|income|opportunit|gig/i,
    mercury: /mercury|travel|flight|weather|map/i,
  };
  return aliases[agent].test(haystack);
}
