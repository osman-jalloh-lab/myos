import type { SkillResolution } from "@/lib/skills/routing";
import type { ExecutionPlan, ExecutionRisk } from "./types";

function riskForSkill(risk: SkillResolution["primarySkill"] extends infer T
  ? T extends { executionRisk: infer R } ? R : never
  : never): ExecutionRisk {
  if (risk === "internal_write" || risk === "external_write" || risk === "read") return risk;
  return "read";
}

export function skillResolutionToExecutionPlan(resolution: SkillResolution, message: string): ExecutionPlan | null {
  const primary = resolution.primarySkill;
  if (!resolution.matched || !primary?.executionTool) return null;
  const risk = riskForSkill(primary.executionRisk);
  return {
    intent: `skill:${primary.id}`,
    confidence: Math.max(0.6, primary.confidence / 100),
    steps: [{
      id: "step_1",
      tool: primary.executionTool,
      input: {
        message,
        skillId: primary.id,
        skillName: primary.name,
        matchedSignals: primary.matchedSignals,
      },
      risk,
      requiresApproval: primary.executionRequiresApproval || risk === "external_write" || primary.safetyClass === "approval_required",
    }],
    reasoningSummary: `Executable skill ${primary.id} routed to ${primary.executionTool}.`,
  };
}
