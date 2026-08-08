import { getExecutor, EXECUTOR_REGISTRY, type ExecutorDefinition } from "./executors";
import { validateContextRequest } from "./context-request";
import type { DelegationPlanV1, OrchestrationEnvelopeV1, OrchestrationSkill, PolicyReason, PolicyResult } from "./types";

export type ValidationOptions = { executors?: Record<string, ExecutorDefinition>; skills?: OrchestrationSkill[] };
const MAX_TIMEOUT_MS = 30 * 60_000;
export function validateOrchestrationEnvelope(value: unknown): PolicyResult {
  const reasons: PolicyReason[] = []; const e = value as Partial<OrchestrationEnvelopeV1> | null;
  if (!e || typeof e !== "object") return { ok: false, reasons: [{ code: "invalid_envelope", message: "Envelope must be an object." }] };
  if (e.version !== "1") reasons.push({ code: "unsupported_version", message: "Only orchestration envelope version 1 is supported.", path: "version" });
  if (!e.idempotencyKey?.trim()) reasons.push({ code: "idempotency_key_required", message: "idempotencyKey is required.", path: "idempotencyKey" });
  if (!e.source || !["telegram_text", "telegram_voice", "myos_chat", "automation"].includes(e.source)) reasons.push({ code: "invalid_source", message: "source is invalid.", path: "source" });
  if (!e.dataClass || !["PUBLIC", "PERSONAL", "PRIVATE", "SECRET"].includes(e.dataClass)) reasons.push({ code: "invalid_data_class", message: "dataClass is invalid.", path: "dataClass" });
  if (!e.userId?.trim() || !e.originalMessage?.trim() || !e.requestedOutcome?.trim()) reasons.push({ code: "required_field_missing", message: "userId, originalMessage, and requestedOutcome are required." });
  if (!e.limits || !Number.isInteger(e.limits.timeoutMs) || e.limits.timeoutMs < 1 || e.limits.timeoutMs > MAX_TIMEOUT_MS) reasons.push({ code: "invalid_timeout", message: "timeoutMs must be bounded and positive.", path: "limits.timeoutMs" });
  return { ok: !reasons.length, reasons };
}

export function validateDelegationPlan(envelope: OrchestrationEnvelopeV1, plan: DelegationPlanV1, options: ValidationOptions = {}): PolicyResult {
  const reasons = validateOrchestrationEnvelope(envelope).reasons; const registry = options.executors ?? EXECUTOR_REGISTRY; const skills = new Map((options.skills ?? []).map((skill) => [skill.id, skill]));
  const allExecutors = [plan.primaryExecutor, ...plan.reviewerExecutors, ...plan.steps.map((step) => step.executor)];
  for (const id of allExecutors) { const executor = getExecutor(id, registry); if (!executor) reasons.push({ code: "unknown_executor", message: `Unknown executor: ${id}.` }); else if (!executor.enabled) reasons.push({ code: "disabled_executor", message: `Executor is disabled: ${id}.` }); }
  if (plan.steps.length > envelope.limits.maxSteps || plan.steps.length > 100) reasons.push({ code: "step_limit_exceeded", message: "Plan exceeds the configured step limit." });
  if (envelope.limits.maxDelegationDepth < 0 || envelope.limits.maxDelegationDepth > 8) reasons.push({ code: "delegation_depth_exceeded", message: "Delegation depth is outside policy bounds." });
  const ids = new Set<string>(); for (const step of plan.steps) { if (!step.id.trim() || ids.has(step.id)) reasons.push({ code: "duplicate_step_id", message: `Step ID must be unique: ${step.id}.` }); ids.add(step.id); }
  const graph = new Map(plan.steps.map((step) => [step.id, step.dependsOn ?? []])); const visiting = new Set<string>(); const visited = new Set<string>(); const visit = (id: string) => { if (visiting.has(id)) { reasons.push({ code: "circular_dependencies", message: "Delegation plan contains a circular dependency." }); return; } if (visited.has(id)) return; visiting.add(id); for (const parent of graph.get(id) ?? []) if (!graph.has(parent)) reasons.push({ code: "unknown_dependency", message: `Unknown dependency: ${parent}.` }); else visit(parent); visiting.delete(id); visited.add(id); }; [...graph.keys()].forEach(visit);
  const referencedStepSkillIds = new Set<string>();
  for (const step of plan.steps) {
    if (step.requiredSkillIds === undefined) {
      for (const skillId of plan.skillIds) referencedStepSkillIds.add(skillId);
      continue;
    }
    if (!Array.isArray(step.requiredSkillIds)
      || step.requiredSkillIds.some((skillId) => typeof skillId !== "string" || !skillId.trim())
      || new Set(step.requiredSkillIds).size !== step.requiredSkillIds.length) {
      reasons.push({ code: "invalid_step_skill_ids", message: "Step requiredSkillIds must be an array of unique non-empty strings.", path: "steps." + step.id + ".requiredSkillIds" });
      continue;
    }
    for (const skillId of step.requiredSkillIds) {
      referencedStepSkillIds.add(skillId);
      if (!plan.skillIds.includes(skillId)) reasons.push({ code: "undeclared_step_skill", message: "Step skill must be declared by the plan: " + skillId + ".", path: "steps." + step.id + ".requiredSkillIds" });
    }
  }
  for (const skillId of plan.skillIds) {
    if (!referencedStepSkillIds.has(skillId)) reasons.push({ code: "unused_plan_skill", message: "Plan skill must apply to at least one step: " + skillId + ".", path: "skillIds" });
    const skill = skills.get(skillId); if (!skill) { reasons.push({ code: "unknown_skill", message: `Unknown skill: ${skillId}.` }); continue; } if (!skill.enabled) reasons.push({ code: "disabled_skill", message: `Skill is disabled: ${skillId}.` }); if (skill.safetyClass !== "read_only" && !envelope.approvalPolicy.requiredBeforeExecution) reasons.push({ code: "skill_approval_required", message: `Skill requires approval: ${skillId}.` }); const applicableSteps = plan.steps.filter((step) => step.requiredSkillIds === undefined || (Array.isArray(step.requiredSkillIds) && step.requiredSkillIds.includes(skillId))); for (const step of applicableSteps) { const executor = getExecutor(step.executor, registry); if (executor && skill.requiredCapabilities.some((capability) => !executor.capabilities.includes(capability) && capability !== step.capability)) reasons.push({ code: "skill_capability_denied", message: `Executor ${step.executor} lacks a capability required by ${skillId}.` }); } }
  for (const step of plan.steps) { const executor = getExecutor(step.executor, registry); if (!executor) continue; if (!executor.supportedTaskClasses.includes(envelope.taskClass)) reasons.push({ code: "unsupported_task_class", message: `${step.executor} does not support ${envelope.taskClass}.` }); if (!executor.supportedDataClasses.includes(envelope.dataClass)) reasons.push({ code: "data_class_denied", message: `${step.executor} cannot receive ${envelope.dataClass} data.` }); const writes = envelope.taskClass === "write" || envelope.taskClass === "operate" || /write|commit|push|delete|modify/i.test(step.capability); if (writes && (!envelope.approvalPolicy.requiredBeforeExecution || !step.requiresApproval)) reasons.push({ code: "write_requires_approval", message: "Write operations require approval." }); if (/repository|git|code_write/i.test(step.capability) && !executor.codingCapability) reasons.push({ code: "repository_write_requires_coding_executor", message: "Repository writes require a coding executor." }); }
  const primary = getExecutor(plan.primaryExecutor, registry); reasons.push(...validateContextRequest(envelope, primary?.supportedDataClasses ?? []));
  if (plan.reviewerExecutors.includes("deepseek") && /required|gate/i.test(plan.userFacingStatus)) reasons.push({ code: "mandatory_reviewer_gate", message: "Reviewers, including DeepSeek, cannot be mandatory gates." });
  if ((envelope.taskClass === "code" || envelope.taskClass === "operate") && !plan.finalValidation.length) reasons.push({ code: "final_validation_required", message: "Code and operation plans require final validation." });
  if (plan.steps.some((step) => step.executor === plan.primaryExecutor && step.dependsOn?.includes(step.id))) reasons.push({ code: "recursive_executor", message: "An executor cannot recursively depend on itself without a boundary." });
  return { ok: !reasons.length, reasons };
}
