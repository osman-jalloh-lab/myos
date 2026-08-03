import type { RegisteredSkill } from "@/lib/skills/registry";
import type { OrchestrationSkill } from "./types";
export function toOrchestrationSkill(skill: RegisteredSkill): OrchestrationSkill { return { id: skill.id, enabled: skill.enabled, source: skill.source === "built_in" || skill.source === "installed" ? "hermes_os" : skill.source, safetyClass: skill.safetyClass, requiredCapabilities: skill.requiredCapabilities, allowedTools: skill.executionTool ? [skill.executionTool] : [] }; }
