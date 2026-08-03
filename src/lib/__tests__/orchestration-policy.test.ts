import { describe, expect, it } from "vitest";
import { EXECUTOR_REGISTRY } from "@/lib/orchestration/executors";
import { validateDelegationPlan, validateOrchestrationEnvelope } from "@/lib/orchestration/validate-plan";
import { TRACE_EVENTS, type DelegationPlanV1, type OrchestrationEnvelopeV1, type OrchestrationSkill } from "@/lib/orchestration/types";

const skills: OrchestrationSkill[] = [
  { id: "read", enabled: true, source: "hermes_os", safetyClass: "read_only", requiredCapabilities: ["planning"] },
  { id: "disabled", enabled: false, source: "user", safetyClass: "read_only", requiredCapabilities: [] },
  { id: "code", enabled: true, source: "hermes_os", safetyClass: "approval_required", requiredCapabilities: ["repository_implementation"] },
];
const envelope = (overrides: Partial<OrchestrationEnvelopeV1> = {}): OrchestrationEnvelopeV1 => ({ version: "1", idempotencyKey: "request-1", source: "myos_chat", userId: "user-1", conversationId: null, originalMessage: "Summarize my tasks", requestedOutcome: "A concise summary", taskClass: "answer", dataClass: "PUBLIC", contextRequest: { query: "current tasks", allowedSources: ["task_history"], maximumItems: 5 }, candidateSkillIds: ["read"], preferredExecutor: "hermes", approvalPolicy: { requiredBeforeExecution: false, allowedOperations: ["read"] }, limits: { maxDelegationDepth: 2, maxSteps: 3, timeoutMs: 30_000, maxEstimatedCostUsd: null }, ...overrides });
const plan = (overrides: Partial<DelegationPlanV1> = {}): DelegationPlanV1 => ({ version: "1", disposition: "answer", summary: "Read-only summary", skillIds: ["read"], primaryExecutor: "hermes", reviewerExecutors: [], steps: [{ id: "summarize", executor: "hermes", purpose: "Summarize", capability: "planning", requiredContext: ["task_history"], expectedOutput: "summary", requiresApproval: false }], finalValidation: [], userFacingStatus: "planned", ...overrides });
const codes = (result: ReturnType<typeof validateDelegationPlan>) => result.reasons.map((reason) => reason.code);

describe("Hermes head orchestration policy", () => {
  it("accepts valid read-only and approved Codex coding plans", () => {
    expect(validateDelegationPlan(envelope(), plan(), { skills }).ok).toBe(true);
    const coding = envelope({ taskClass: "code", approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["repository_write"] }, candidateSkillIds: ["code"] });
    const codingPlan = plan({ skillIds: ["code"], primaryExecutor: "codex", steps: [{ id: "implement", executor: "codex", purpose: "Implement", capability: "repository_write", requiredContext: [], expectedOutput: "patch", requiresApproval: true }], finalValidation: ["tests pass"] });
    expect(validateDelegationPlan(coding, codingPlan, { skills }).ok).toBe(true);
  });
  it("rejects unknown and disabled executors and skills", () => {
    expect(codes(validateDelegationPlan(envelope(), plan({ primaryExecutor: "unknown" as never }), { skills }))).toContain("unknown_executor");
    const registry = { ...EXECUTOR_REGISTRY, hermes: { ...EXECUTOR_REGISTRY.hermes, enabled: false } };
    expect(codes(validateDelegationPlan(envelope(), plan(), { skills, executors: registry }))).toContain("disabled_executor");
    expect(codes(validateDelegationPlan(envelope(), plan({ skillIds: ["missing"] }), { skills }))).toContain("unknown_skill");
    expect(codes(validateDelegationPlan(envelope(), plan({ skillIds: ["disabled"] }), { skills }))).toContain("disabled_skill");
  });
  it("protects SECRET data and requires approval and a coding executor for writes", () => {
    expect(codes(validateDelegationPlan(envelope({ dataClass: "SECRET" }), plan(), { skills }))).toContain("data_class_denied");
    const write = envelope({ taskClass: "write" });
    const unsafe = plan({ steps: [{ id: "write", executor: "hermes", purpose: "Write", capability: "write", requiredContext: [], expectedOutput: "draft", requiresApproval: false }] });
    expect(codes(validateDelegationPlan(write, unsafe, { skills }))).toContain("write_requires_approval");
    const code = envelope({ taskClass: "code", approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["repository_write"] } });
    const claudeWrite = plan({ primaryExecutor: "claude", steps: [{ id: "write", executor: "claude", purpose: "Write", capability: "repository_write", requiredContext: [], expectedOutput: "patch", requiresApproval: true }], finalValidation: ["review"] });
    expect(codes(validateDelegationPlan(code, claudeWrite, { skills }))).toContain("repository_write_requires_coding_executor");
  });
  it("enforces bounds, context, graph safety, skill capability, and final validation", () => {
    expect(codes(validateDelegationPlan(envelope({ limits: { ...envelope().limits, maxDelegationDepth: 9 } }), plan(), { skills }))).toContain("delegation_depth_exceeded");
    expect(codes(validateDelegationPlan(envelope({ limits: { ...envelope().limits, maxSteps: 1 } }), plan({ steps: [plan().steps[0], { ...plan().steps[0], id: "other" }] }), { skills }))).toContain("step_limit_exceeded");
    const cyclic = plan({ steps: [{ ...plan().steps[0], dependsOn: ["b"] }, { ...plan().steps[0], id: "b", dependsOn: ["summarize"] }] });
    expect(codes(validateDelegationPlan(envelope(), cyclic, { skills }))).toContain("circular_dependencies");
    expect(codes(validateDelegationPlan(envelope({ contextRequest: { query: "", allowedSources: ["vault"], maximumItems: 999 } }), plan(), { skills }))).toEqual(expect.arrayContaining(["context_query_required", "context_unbounded", "context_source_denied", "context_full_store_denied"]));
    expect(codes(validateDelegationPlan(envelope(), plan({ skillIds: ["code"] }), { skills }))).toContain("skill_capability_denied");
    expect(codes(validateDelegationPlan(envelope({ taskClass: "code" }), plan(), { skills }))).toContain("final_validation_required");
  });
  it("keeps DeepSeek optional, rejects mandatory gates, and validates envelope identity", () => {
    expect(validateDelegationPlan(envelope(), plan({ reviewerExecutors: ["deepseek"] }), { skills }).ok).toBe(true);
    expect(codes(validateDelegationPlan(envelope(), plan({ reviewerExecutors: ["deepseek"], userFacingStatus: "review required gate" }), { skills }))).toContain("mandatory_reviewer_gate");
    expect(validateOrchestrationEnvelope(envelope({ idempotencyKey: "" })).reasons.map((r) => r.code)).toContain("idempotency_key_required");
    expect(validateOrchestrationEnvelope(envelope({ source: "bad" as never })).reasons.map((r) => r.code)).toContain("invalid_source");
    expect(validateOrchestrationEnvelope(envelope({ limits: { ...envelope().limits, timeoutMs: 0 } })).ok).toBe(false);
    expect(TRACE_EVENTS.join(" ")).not.toMatch(/fugu|sakana/i);
  });
});
