import crypto from "node:crypto";
import { getRegisteredSkillsReadOnly, type SkillRegistryEntry } from "@/lib/skills/registry";
import { inferAgent, MIN_CONFIDENCE, scoreRegisteredSkill } from "@/lib/skills/scoring";
import { getExecutor } from "./executors";
import { classifyTask } from "./classify-task";
import { toOrchestrationSkill } from "./skill-selection";
import { validateDelegationPlan } from "./validate-plan";
import type { DataClass, DelegationPlanV1, ExecutorId, OrchestrationEnvelopeV1 } from "./types";

export type PlanningRequest = { message: string; conversationId?: string | null; preferredExecutor?: ExecutorId | null; candidateSkillIds?: string[]; dataClass?: Exclude<DataClass, "SECRET">; idempotencyKey?: string };
export type PlanPreviewResponse = { accepted: boolean; envelope: Pick<OrchestrationEnvelopeV1, "source" | "taskClass" | "dataClass" | "requestedOutcome">; plan: DelegationPlanV1 | null; matchedSkills: Array<{ id: string; name: string; reason: string }>; policy: { valid: boolean; reasons: string[]; warnings: string[] }; executionStatus: "not_started" };
const MAX_MESSAGE = 8_000;

function previewSkills(message: string, skills: SkillRegistryEntry[], requested: string[] | undefined) {
  const warnings: string[] = []; const byId = new Map(skills.map((skill) => [skill.id, skill]));
  const requestedEntries = (requested ?? []).flatMap((id) => { const skill = byId.get(id); if (!skill) { warnings.push(`Unknown skill omitted: ${id}.`); return []; } return [skill]; });
  const matches = skills.filter((skill) => skill.enabled && skill.validationStatus !== "invalid").map((skill) => ({ skill, score: scoreRegisteredSkill(skill, message, inferAgent(message)) })).filter(({ score }) => score.score >= MIN_CONFIDENCE).sort((a, b) => b.score.score - a.score.score).slice(0, 3);
  const selected = [...new Map([...requestedEntries, ...matches.map((match) => match.skill)].map((skill) => [skill.id, skill])).values()];
  return { selected, matched: selected.map((skill) => ({ id: skill.id, name: skill.name, reason: matches.find((match) => match.skill.id === skill.id)?.score.reason ?? "Requested by the user." })), warnings };
}

export async function createPlanPreview(userId: string, request: PlanningRequest): Promise<PlanPreviewResponse> {
  const message = request.message?.trim();
  const base: PlanPreviewResponse["envelope"] = { source: "myos_chat", taskClass: "answer", dataClass: request.dataClass ?? "PERSONAL", requestedOutcome: "" };
  if (!message) return { accepted: false, envelope: base, plan: null, matchedSkills: [], policy: { valid: false, reasons: ["message is required"], warnings: [] }, executionStatus: "not_started" };
  if (message.length > MAX_MESSAGE) return { accepted: false, envelope: base, plan: null, matchedSkills: [], policy: { valid: false, reasons: [`message exceeds ${MAX_MESSAGE} characters`], warnings: [] }, executionStatus: "not_started" };
  const classification = classifyTask(message); const warnings: string[] = [];
  let primary = classification.primaryExecutor;
  if (request.preferredExecutor) { const preferred = getExecutor(request.preferredExecutor); if (!preferred) warnings.push(`Unknown preferred executor: ${request.preferredExecutor}.`); else if (!preferred.enabled || !preferred.supportedTaskClasses.includes(classification.taskClass) || !preferred.supportedDataClasses.includes(request.dataClass ?? "PERSONAL")) warnings.push(`Preferred executor is not permitted: ${request.preferredExecutor}.`); else primary = request.preferredExecutor; }
  const executor = getExecutor(primary); if (!executor?.enabled) warnings.push(`Default executor is unavailable: ${primary}.`);
  const skills = await getRegisteredSkillsReadOnly(userId); const selection = previewSkills(message, skills, request.candidateSkillIds); warnings.push(...selection.warnings);
  const envelope: OrchestrationEnvelopeV1 = { version: "1", idempotencyKey: request.idempotencyKey?.trim() || crypto.createHash("sha256").update(`${userId}:${request.conversationId ?? ""}:${message}`).digest("hex"), source: "myos_chat", userId, conversationId: request.conversationId ?? null, originalMessage: message, requestedOutcome: classification.requestedOutcome, taskClass: classification.taskClass, dataClass: request.dataClass ?? "PERSONAL", contextRequest: { query: message.slice(0, 500), allowedSources: ["task_history"], maximumItems: 5 }, candidateSkillIds: selection.selected.map((skill) => skill.id), preferredExecutor: request.preferredExecutor ?? null, approvalPolicy: { requiredBeforeExecution: classification.requiresApproval, allowedOperations: classification.requiresApproval ? ["future_approval_required"] : ["read"] }, limits: { maxDelegationDepth: 1, maxSteps: 1, timeoutMs: executor?.defaultTimeoutMs ?? 30_000, maxEstimatedCostUsd: null } };
  const plan: DelegationPlanV1 = { version: "1", disposition: classification.requiresApproval ? "approval_required" : "answer", summary: classification.requestedOutcome, skillIds: selection.selected.map((skill) => skill.id), primaryExecutor: primary, reviewerExecutors: classification.reviewers.filter((id) => getExecutor(id)?.enabled), steps: [{ id: "propose", executor: primary, purpose: "Produce a read-only delegation plan preview.", capability: executor?.capabilities[0] ?? "planning", requiredContext: ["task_history"], expectedOutput: "A proposed plan only.", requiresApproval: classification.requiresApproval }], finalValidation: classification.requiresFinalValidation ? ["Future implementation must run repository validation before completion."] : [], userFacingStatus: "Preview only. No execution, approval, tool, or provider call has started." };
  const policy = validateDelegationPlan(envelope, plan, { skills: selection.selected.map(toOrchestrationSkill) });
  if (warnings.some((warning) => warning.startsWith("Unknown preferred executor"))) policy.reasons.push({ code: "unknown_preferred_executor", message: "Requested executor is unknown." });
  return { accepted: policy.ok, envelope: { source: envelope.source, taskClass: envelope.taskClass, dataClass: envelope.dataClass, requestedOutcome: envelope.requestedOutcome }, plan: policy.ok ? plan : null, matchedSkills: selection.matched, policy: { valid: policy.ok, reasons: policy.reasons.map((reason) => reason.code), warnings }, executionStatus: "not_started" };
}
