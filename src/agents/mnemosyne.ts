// Mnemosyne — memory
// Owns ONLY these tools (this is what enforces no-overlap): "memory.read","memory-suggest","context-cards","stale-cleanup","onboarding-memory"
// CAN: suggest memory, surface context, retain onboarding
// CANNOT: save/delete memory without approval
// TODO: implement per docs/HERMES_OS_MASTER_SPEC.md section 3. Do not add tools from other agents.
export const mnemosyne = {
  name: "Mnemosyne",
  domain: "memory",
  tools: ["memory.read","memory-suggest","context-cards","stale-cleanup","onboarding-memory"] as const,
};
