// Iris — email
// Owns ONLY these tools (this is what enforces no-overlap): "gmail.read","classify","triage","draft-reply"
// CAN: read, classify, draft replies across 3 accounts
// CANNOT: send/delete/label; touch calendar or money
// TODO: implement per docs/HERMES_OS_MASTER_SPEC.md section 3. Do not add tools from other agents.
export const iris = {
  name: "Iris",
  domain: "email",
  tools: ["gmail.read","classify","triage","draft-reply"] as const,
};
