import type { CouncilProviderResponse } from "@/lib/council-providers";
import type { ProviderFamily } from "@/lib/model-provider-registry";

export type CouncilDomain = "software" | "security" | "communication" | "planning" | "memory" | "general";

export type DynamicCouncilSelection = {
  domain: CouncilDomain;
  specialists: string[];
  providerFamilies: ProviderFamily[];
  reason: string;
};

export type CouncilSynthesis = {
  stage: "awaiting_user_decision";
  positions: Array<{ participant: string; position: string; status: CouncilProviderResponse["status"] }>;
  disagreement: "none" | "minor" | "material";
  confidence: "low" | "medium" | "high";
  risks: string[];
  recommendation: string;
  needsUserDecision: boolean;
};

function includesAny(text: string, terms: string[]): boolean {
  return terms.some((term) => text.includes(term));
}

export function selectDynamicCouncil(objective: string): DynamicCouncilSelection {
  const text = objective.toLowerCase();
  if (includesAny(text, ["security", "auth", "permission", "secret", "risk", "policy", "credential"])) {
    return { domain: "security", specialists: ["Hermes", "Argus", "Prometheus"], providerFamilies: ["anthropic", "deepseek"], reason: "Security and policy consequences require architecture review plus an independent challenge." };
  }
  if (includesAny(text, ["code", "software", "architecture", "builder", "ui", "api", "database", "library", "framework", "my os", "myos"])) {
    return { domain: "software", specialists: ["Hermes", "Prometheus", "Codex"], providerFamilies: ["openai", "anthropic", "deepseek"], reason: "Software work benefits from implementation feasibility, architecture review, and a challenger." };
  }
  if (includesAny(text, ["write", "message", "email", "communication", "tone", "announce"])) {
    return { domain: "communication", specialists: ["Hermes", "Iris"], providerFamilies: ["anthropic"], reason: "Communication work needs one focused language reviewer." };
  }
  if (includesAny(text, ["schedule", "timeline", "deadline", "plan", "priority"])) {
    return { domain: "planning", specialists: ["Hermes", "Kairos"], providerFamilies: ["openai", "deepseek"], reason: "Planning benefits from feasibility review and a lightweight challenge." };
  }
  if (includesAny(text, ["memory", "knowledge", "obsidian", "context", "remember"])) {
    return { domain: "memory", specialists: ["Hermes", "Mnemosyne"], providerFamilies: ["anthropic", "deepseek"], reason: "Knowledge work needs context-boundary review and a challenger." };
  }
  return { domain: "general", specialists: ["Hermes"], providerFamilies: ["openai"], reason: "A single general reviewer is sufficient for this bounded question." };
}

function concise(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 420 ? `${cleaned.slice(0, 417)}…` : cleaned;
}

export function synthesizeCouncil(responses: CouncilProviderResponse[]): CouncilSynthesis {
  const answered = responses.filter((response) => response.status === "answered");
  const positions = responses.map((response) => ({
    participant: response.roleLabel,
    position: response.status === "answered" ? concise(response.text) : response.safeError ?? "Unavailable",
    status: response.status,
  }));
  const dissentSignals = answered.filter((response) => /\b(disagree|alternative|concern|however|instead|risk)\b/i.test(response.text)).length;
  const disagreement = answered.length > 1 && dissentSignals > 1 ? "material" : dissentSignals ? "minor" : "none";
  const confidence = answered.length === 0 ? "low" : answered.length === responses.length ? "high" : "medium";
  const recommendation = answered[0]
    ? concise(answered[0].text.match(/Recommendation:\s*([^\n]+)/i)?.[1] ?? answered[0].text)
    : "No reviewer answered. Keep the request blocked and ask the user how to proceed.";
  return {
    stage: "awaiting_user_decision",
    positions,
    disagreement,
    confidence,
    risks: responses.filter((response) => response.status !== "answered").map((response) => `${response.provider}: ${response.safeError ?? response.status}`),
    recommendation,
    needsUserDecision: disagreement === "material" || confidence === "low",
  };
}

export function formatDynamicCouncil(selection: DynamicCouncilSelection, synthesis: CouncilSynthesis, fullResponses: CouncilProviderResponse[]): string {
  const positions = synthesis.positions.map((item) => `- **${item.participant}:** ${item.position}`).join("\n");
  const risks = synthesis.risks.length ? synthesis.risks.map((risk) => `- ${risk}`).join("\n") : "- No provider availability risk recorded.";
  const full = fullResponses.map((response) => `### ${response.roleLabel}\n${response.status === "answered" ? response.text : response.safeError ?? response.status}`).join("\n\n");
  return [
    `## Council brief\n${selection.reason}`,
    `**Participants:** ${selection.specialists.join(", ")} · ${synthesis.positions.map((item) => item.participant).join(", ")}`,
    `## Positions\n${positions}`,
    `## Disagreement\n${synthesis.disagreement}${synthesis.needsUserDecision ? " — user decision required" : " — Hermes can resolve within the stated plan"}`,
    `## Hermes synthesis\n${synthesis.recommendation}`,
    `**Confidence:** ${synthesis.confidence}`,
    `## Risks\n${risks}`,
    `<details><summary>View full deliberation</summary>\n\n${full}\n\n</details>`,
  ].join("\n\n");
}
