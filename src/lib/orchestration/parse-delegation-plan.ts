import type { DelegationPlanV1 } from "./types";

export type PlanParseResult = { ok: true; value: DelegationPlanV1 } | { ok: false; error: string };
const forbidden = /__proto__|constructor|prototype/;
export function parseDelegationPlan(output: string, maxBytes: number): PlanParseResult {
  if (!output.trim()) return { ok: false, error: "empty_output" };
  if (Buffer.byteLength(output) > maxBytes) return { ok: false, error: "output_too_large" };
  if (forbidden.test(output)) return { ok: false, error: "unsafe_key" };
  const fenced = [...output.matchAll(/```json\s*([\s\S]*?)```/gi)];
  if (fenced.length > 1) return { ok: false, error: "multiple_objects" };
  let candidate = fenced.length === 1 ? fenced[0][1].trim() : output.trim();
  if (fenced.length === 0 && !candidate.startsWith("{")) {
    const first = candidate.indexOf("{"); const last = candidate.lastIndexOf("}");
    if (first < 0 || last <= first || /}\s*[^\s].*{/s.test(candidate.slice(first, last + 1))) return { ok: false, error: "multiple_objects" };
    candidate = candidate.slice(first, last + 1);
  }
  let value: unknown; try { value = JSON.parse(candidate); } catch { return { ok: false, error: "malformed_output" }; }
  if (!value || Array.isArray(value) || typeof value !== "object") return { ok: false, error: "schema_rejected" };
  const plan = value as DelegationPlanV1;
  if (JSON.stringify(value).length > maxBytes || JSON.stringify(value).split("{").length > 20) return { ok: false, error: "schema_rejected" };
  if (plan.version !== "1" || !["answer", "ask", "delegate", "approval_required", "blocked"].includes(plan.disposition) || !Array.isArray(plan.steps) || !Array.isArray(plan.skillIds) || !Array.isArray(plan.reviewerExecutors) || !Array.isArray(plan.finalValidation) || typeof plan.summary !== "string" || typeof plan.primaryExecutor !== "string" || typeof plan.userFacingStatus !== "string") return { ok: false, error: "schema_rejected" };
  const ids = new Set<string>();
  for (const step of plan.steps) { if (!step || typeof step !== "object" || typeof step.id !== "string" || !step.id || ids.has(step.id) || typeof step.executor !== "string" || typeof step.purpose !== "string" || typeof step.capability !== "string" || !Array.isArray(step.requiredContext) || typeof step.expectedOutput !== "string" || typeof step.requiresApproval !== "boolean") return { ok: false, error: "schema_rejected" }; ids.add(step.id); }
  return { ok: true, value: plan };
}
