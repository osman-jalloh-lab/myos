// Plutus — finance & spend
// Owns ONLY these tools (this is what enforces no-overlap): "finance.read","budget-cap","llm-cost-monitor","debt-tracker"
// CAN: track spend, LLM cost cap, debt progress, warn
// CANNOT: move money or make transactions
// TODO: implement per docs/HERMES_OS_MASTER_SPEC.md section 3. Do not add tools from other agents.
export const plutus = {
  name: "Plutus",
  domain: "finance & spend",
  tools: ["finance.read","budget-cap","llm-cost-monitor","debt-tracker"] as const,
};
