// Argus — sentinel & brief
// Owns ONLY these tools (this is what enforces no-overlap): "synthesize","risk-flag","anomaly-watch","morning-brief"
// CAN: read others output, greet, flag risks/suspicious mail
// CANNOT: hold any action tool; pure read-only
// TODO: implement per docs/HERMES_OS_MASTER_SPEC.md section 3. Do not add tools from other agents.
export const argus = {
  name: "Argus",
  domain: "sentinel & brief",
  tools: ["synthesize","risk-flag","anomaly-watch","morning-brief"] as const,
};
