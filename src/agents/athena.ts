// Athena — career & jobs
// Owns ONLY these tools (this is what enforces no-overlap): "job-search","fit-score","skill-gap","github-scout","resume-tailor","ats-optimize","cover-letter","app-tracker"
// CAN: find/rank roles, tailor resumes (no em dashes, his rules), draft letters
// CANNOT: apply or message recruiters without approval
// TODO: implement per docs/HERMES_OS_MASTER_SPEC.md section 3. Do not add tools from other agents.
export const athena = {
  name: "Athena",
  domain: "career & jobs",
  tools: ["job-search","fit-score","skill-gap","github-scout","resume-tailor","ats-optimize","cover-letter","app-tracker"] as const,
};
