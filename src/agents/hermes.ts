// Hermes — orchestration
// Owns ONLY these tools (this is what enforces no-overlap): "model-router","approval-queue","a2a-handoff","decisions-log","skill-registry","skill-match"
// CAN: route tasks, pick model, match skills, gate every write
// CANNOT: read raw data itself; it delegates
// TODO: implement per docs/HERMES_OS_MASTER_SPEC.md section 3. Do not add tools from other agents.
export const hermes = {
  name: "Hermes",
  domain: "orchestration",
  tools: ["model-router","approval-queue","a2a-handoff","decisions-log","skill-registry","skill-match"] as const,
};
