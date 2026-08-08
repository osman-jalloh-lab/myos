import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildPolicyAwareDelegationPlan,
  type PolicyAwareDelegationRequest,
} from "@/lib/orchestration/policy-aware-delegation";
import type { OrchestrationEnvelopeV1, OrchestrationSkill } from "@/lib/orchestration/types";
import { validateDelegationPlan, validateOrchestrationEnvelope } from "@/lib/orchestration/policy";
import { clearToolRegistryForTests, getToolRegistration, registerTool, type RegisteredTool } from "@/lib/hermes-execution/tool-registry";

function envelope(overrides: Partial<OrchestrationEnvelopeV1> = {}): OrchestrationEnvelopeV1 {
  return {
    version: "1",
    idempotencyKey: "delegation-request-1",
    source: "myos_chat",
    userId: "user-1",
    conversationId: null,
    originalMessage: "Summarize the approved material",
    requestedOutcome: "A concise summary",
    taskClass: "answer",
    dataClass: "PUBLIC",
    contextRequest: { query: "approved material", allowedSources: ["task_history"], maximumItems: 5 },
    candidateSkillIds: [],
    preferredExecutor: null,
    approvalPolicy: { requiredBeforeExecution: false, allowedOperations: ["read"] },
    limits: {
      maxDelegationDepth: 2,
      maxSteps: 4,
      timeoutMs: 30_000,
      maxEstimatedCostUsd: 0.10,
      maxInputTokens: 4_000,
      maxOutputTokens: 1_000,
    },
    ...overrides,
  };
}

function simpleRequest(): PolicyAwareDelegationRequest {
  return {
    envelope: envelope(),
    tasks: [{
      id: "summarize",
      description: "Summarize the approved material.",
      dependencies: [],
      requiredCapabilities: ["summarization"],
      requiredSkillIds: [],
      requiredToolIds: [],
      requiredToolsets: [],
      dataClass: "PUBLIC",
      executorRequirement: {
        role: "general_reasoning",
        capabilities: ["summarization"],
        environment: "server",
        allowExternalModels: true,
      },
      budget: {
        timeoutMs: 30_000,
        maxInputTokens: 2_000,
        maxOutputTokens: 500,
        maxEstimatedCostUsd: 0.05,
      },
      requiresApproval: false,
      expectedOutput: "A concise summary.",
    }],
    skills: [],
    tools: [],
    availableModelProviders: ["openai"],
  };
}


function registeredTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    toolId: "tool.read",
    registrationMode: "policy-gated",
    metadata: {
      source: "hermes-derived",
      toolsets: ["documents"],
      risk: "write",
      availability: "available",
      permissions: ["authenticated", "authorized", "approval"],
      requiresApproval: true,
      timeoutMs: 5_000,
      maxResultBytes: 64_000,
      executionEnvironment: "server",
      description: "Read an approved document.",
      capabilityTags: ["document_read"],
    },
    ...overrides,
  };
}

const enabledSkill: OrchestrationSkill = {
  id: "summarize-skill",
  enabled: true,
  source: "hermes_os",
  safetyClass: "read_only",
  requiredCapabilities: ["planning"],
  allowedTools: ["tool.read"],
};

describe("policy-aware delegation planning", () => {
  it("builds one structurally valid task without authorizing execution", () => {
    const result = buildPolicyAwareDelegationPlan(simpleRequest());

    expect(result.validation.reasons).toEqual([]);
    expect(result.accepted).toBe(true);
    expect(result.validation.valid).toBe(true);
    expect(result.executionStatus).toBe("not_started");
    expect(result.plan?.steps.map((step) => step.id)).toEqual(["summarize"]);
    expect(result.plan?.steps[0].executorRequirement?.role).toBe("general_reasoning");
    expect(result.plan?.planning?.executionAuthorized).toBe(false);
    expect(JSON.stringify(result.plan)).not.toMatch(/execute|callback|function/i);
  });

  it("orders multi-task dependencies deterministically", () => {
    const base = simpleRequest();
    const analyze = {
      ...base.tasks[0],
      id: "analyze",
      description: "Analyze the source material.",
      budget: { timeoutMs: 30_000, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0.025 },
    };
    const draft = {
      ...base.tasks[0],
      id: "draft",
      description: "Draft the summary.",
      dependencies: ["analyze"],
      budget: { timeoutMs: 30_000, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0.025 },
    };
    const request = {
      ...base,
      envelope: envelope({ limits: { ...envelope().limits, timeoutMs: 60_000 } }),
    };

    const first = buildPolicyAwareDelegationPlan({ ...request, tasks: [draft, analyze] });
    const second = buildPolicyAwareDelegationPlan({ ...request, tasks: [analyze, draft] });

    expect(first.validation.reasons).toEqual([]);
    expect(first.plan?.planning?.orderedTaskIds).toEqual(["analyze", "draft"]);
    expect(first.plan?.steps.map((step) => step.id)).toEqual(["analyze", "draft"]);
    expect(second.plan?.planning?.orderedTaskIds).toEqual(first.plan?.planning?.orderedTaskIds);
  });


  it("rejects malformed dependency graphs and invalid task IDs", () => {
    const base = simpleRequest();
    const task = base.tasks[0];
    const codes = (request: PolicyAwareDelegationRequest) =>
      buildPolicyAwareDelegationPlan(request).validation.reasons.map((reason) => reason.code);

    expect(codes({ ...base, tasks: [{ ...task, id: "Bad task id" }] })).toContain("invalid_task_id");
    expect(codes({ ...base, tasks: [task, { ...task }] })).toContain("duplicate_task_id");
    expect(codes({ ...base, tasks: [{ ...task, dependencies: [task.id] }] })).toContain("self_dependency");
    expect(codes({ ...base, tasks: [{ ...task, dependencies: ["missing"] }] })).toContain("missing_dependency");
    expect(codes({
      ...base,
      tasks: [
        { ...task, id: "first", dependencies: ["second"] },
        { ...task, id: "second", dependencies: ["first"] },
      ],
    })).toContain("dependency_cycle");
  });


  it("resolves registered skills, tool IDs, and toolsets without granting execution", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["internal_write"] } }),
      skills: [enabledSkill],
      tools: [registeredTool()],
      tasks: [{
        ...base.tasks[0],
        requiredSkillIds: [enabledSkill.id],
        requiredToolIds: ["tool.read"],
        requiredToolsets: ["documents"],
        requiresApproval: true,
      }],
    });

    expect(result.validation.reasons).toEqual([]);
    expect(result.plan?.skillIds).toEqual(["summarize-skill"]);
    expect(result.plan?.steps[0].requiredToolIds).toEqual(["tool.read"]);
    expect(result.plan?.steps[0].requiredToolsets).toEqual(["documents"]);
    expect(result.plan?.planning?.executionAuthorized).toBe(false);
  });

  it("rejects disabled skills and unknown or unavailable tools without substitution", () => {
    const base = simpleRequest();
    const codes = (request: PolicyAwareDelegationRequest) =>
      buildPolicyAwareDelegationPlan(request).validation.reasons.map((reason) => reason.code);
    expect(codes({
      ...base,
      skills: [{ ...enabledSkill, enabled: false }],
      tasks: [{ ...base.tasks[0], requiredSkillIds: [enabledSkill.id] }],
    })).toContain("disabled_skill");
    expect(codes({
      ...base,
      tasks: [{ ...base.tasks[0], requiredToolIds: ["missing.tool"] }],
    })).toContain("unknown_tool");
    expect(codes({
      ...base,
      tools: [registeredTool({ metadata: { ...registeredTool().metadata, availability: "unavailable" } })],
      tasks: [{ ...base.tasks[0], requiredToolIds: ["tool.read"] }],
    })).toContain("tool_unavailable");
  });

  it("keeps policy-gated tools approval-gated", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      tools: [registeredTool()],
      tasks: [{ ...base.tasks[0], requiredToolIds: ["tool.read"] }],
    });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("tool_approval_required");
    expect(result.plan).toBeNull();
  });


  it("flows classification downward and rejects missing, invalid, or downgraded values", () => {
    const base = simpleRequest();
    const codes = (request: PolicyAwareDelegationRequest) =>
      buildPolicyAwareDelegationPlan(request).validation.reasons.map((reason) => reason.code);
    expect(codes({
      ...base,
      envelope: envelope({ dataClass: undefined as never }),
    })).toContain("invalid_data_class");
    expect(codes({
      ...base,
      envelope: envelope({ dataClass: "PERSONAL" }),
      tasks: [{ ...base.tasks[0], dataClass: "PUBLIC" }],
    })).toContain("classification_downgrade");
    const stricter = buildPolicyAwareDelegationPlan({
      ...base,
      tasks: [{ ...base.tasks[0], dataClass: "PERSONAL" }],
    });
    expect(stricter.accepted).toBe(true);
  });

  it("blocks SECRET external and fallback routes", () => {
    const base = simpleRequest();
    for (const provider of ["openai", "groq"] as const) {
      const result = buildPolicyAwareDelegationPlan({
        ...base,
        envelope: envelope({ dataClass: "SECRET" }),
        availableModelProviders: [provider],
        tasks: [{ ...base.tasks[0], dataClass: "SECRET" }],
      });
      expect(result.accepted).toBe(false);
      expect(result.plan).toBeNull();
      expect(result.validation.reasons.map((reason) => reason.code)).toContain("model_requirement_unavailable");
    }
  });

  it("routes executor needs through capabilities and supports local-private requirements", () => {
    const base = simpleRequest();
    const local = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({
        dataClass: "PRIVATE",
        limits: { ...envelope().limits, timeoutMs: 60_000 },
      }),
      availableModelProviders: ["ollama"],
      tasks: [{
        ...base.tasks[0],
        dataClass: "PRIVATE",
        requiredCapabilities: ["local_private_inference"],
        executorRequirement: {
          role: "local_private",
          capabilities: ["local_private_inference"],
          environment: "local-worker",
          allowExternalModels: false,
        },
        budget: { ...base.tasks[0].budget, timeoutMs: 60_000 },
      }],
    });
    expect(local.validation.reasons).toEqual([]);
    expect(local.plan?.steps[0].executorRequirement?.role).toBe("local_private");
    expect(local.plan?.steps[0].executor).toBe("local");

    const unavailableLocal = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ dataClass: "PRIVATE", limits: { ...envelope().limits, timeoutMs: 60_000 } }),
      availableModelProviders: ["openai"],
      tasks: [{
        ...base.tasks[0],
        dataClass: "PRIVATE",
        requiredCapabilities: ["local_private_inference"],
        executorRequirement: { role: "local_private", capabilities: ["local_private_inference"], environment: "local-worker", allowExternalModels: false },
        budget: { ...base.tasks[0].budget, timeoutMs: 60_000 },
      }],
    });
    expect(unavailableLocal.validation.reasons.map((reason) => reason.code)).toContain("model_requirement_unavailable");
  });

  it("keeps reviewers optional and never promotes a reviewer-only route", () => {
    const base = simpleRequest();
    const optional = buildPolicyAwareDelegationPlan({
      ...base,
      availableModelProviders: ["openai"],
      tasks: [{
        ...base.tasks[0],
        reviewerRequirement: { required: false, capabilities: ["challenger_reviewer"], environment: "external-service", allowExternalModels: true },
      }],
    });
    expect(optional.accepted).toBe(true);
    expect(optional.plan?.reviewerExecutors).toEqual([]);

    const reviewerOnly = buildPolicyAwareDelegationPlan({
      ...base,
      availableModelProviders: ["deepseek"],
      tasks: [{
        ...base.tasks[0],
        requiredCapabilities: ["challenger_reviewer"],
        executorRequirement: {
          ...base.tasks[0].executorRequirement,
          capabilities: ["challenger_reviewer"],
        },
      }],
    });
    expect(reviewerOnly.accepted).toBe(false);
    expect(reviewerOnly.plan).toBeNull();
    expect(reviewerOnly.validation.reasons.map((reason) => reason.code)).toContain("model_requirement_unavailable");

    const requiredButUnavailable = buildPolicyAwareDelegationPlan({
      ...base,
      availableModelProviders: ["openai"],
      tasks: [{
        ...base.tasks[0],
        reviewerRequirement: { required: true, capabilities: ["challenger_reviewer"], environment: "external-service", allowExternalModels: true },
      }],
    });
    expect(requiredButUnavailable.validation.reasons.map((reason) => reason.code)).toContain("reviewer_unavailable");
  });


  it("bounds every child budget by the parent request", () => {
    const base = simpleRequest();
    const codes = (budget: typeof base.tasks[number]["budget"]) =>
      buildPolicyAwareDelegationPlan({
        ...base,
        tasks: [{ ...base.tasks[0], budget }],
      }).validation.reasons.map((reason) => reason.code);
    expect(codes({ ...base.tasks[0].budget, timeoutMs: 30_001 })).toContain("child_budget_exceeded");
    expect(codes({ ...base.tasks[0].budget, maxInputTokens: 4_001 })).toContain("child_budget_exceeded");
    expect(codes({ ...base.tasks[0].budget, maxOutputTokens: 1_001 })).toContain("child_budget_exceeded");
    expect(codes({ ...base.tasks[0].budget, maxEstimatedCostUsd: 0.101 })).toContain("child_budget_exceeded");
  });

  it("rejects aggregate budget amplification across decomposition", () => {
    const base = simpleRequest();
    const first = { ...base.tasks[0], id: "first", budget: { ...base.tasks[0].budget, maxInputTokens: 2_500, maxOutputTokens: 600, maxEstimatedCostUsd: 0.06 } };
    const second = { ...base.tasks[0], id: "second", budget: { ...base.tasks[0].budget, maxInputTokens: 2_500, maxOutputTokens: 600, maxEstimatedCostUsd: 0.06 } };
    const result = buildPolicyAwareDelegationPlan({ ...base, tasks: [first, second] });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("aggregate_budget_exceeded");
    expect(result.plan).toBeNull();
  });

  it("enforces model timeout and total context-token limits", () => {
    const base = simpleRequest();
    const timeout = buildPolicyAwareDelegationPlan({
      ...base,
      tasks: [{ ...base.tasks[0], budget: { ...base.tasks[0].budget, timeoutMs: 10_000 } }],
    });
    expect(timeout.validation.reasons.map((reason) => reason.code)).toContain("model_requirement_unavailable");

    const context = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ limits: { ...envelope().limits, maxInputTokens: 120_000, maxOutputTokens: 10_000 } }),
      tasks: [{ ...base.tasks[0], budget: { ...base.tasks[0].budget, maxInputTokens: 120_000, maxOutputTokens: 10_000 } }],
    });
    expect(context.validation.reasons.map((reason) => reason.code)).toContain("model_requirement_unavailable");
  });

  it("enforces configurable task, depth, skill, tool, and toolset bounds", () => {
    const base = simpleRequest();
    const task = base.tasks[0];
    const code = (request: PolicyAwareDelegationRequest) =>
      buildPolicyAwareDelegationPlan(request).validation.reasons.map((reason) => reason.code);
    expect(code({ ...base, bounds: { maxTasks: 1 }, tasks: [task, { ...task, id: "second" }] })).toContain("task_limit_exceeded");
    expect(code({
      ...base,
      bounds: { maxDependencyDepth: 1 },
      envelope: envelope({ limits: { ...envelope().limits, timeoutMs: 60_000 } }),
      tasks: [
        { ...task, id: "first", budget: { ...task.budget, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0.02 } },
        { ...task, id: "second", dependencies: ["first"], budget: { ...task.budget, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0.02 } },
      ],
    })).toContain("dependency_depth_exceeded");
    expect(code({ ...base, bounds: { maxSkillsPerTask: 1 }, tasks: [{ ...task, requiredSkillIds: ["one", "two"] }] })).toContain("skill_limit_exceeded");
    expect(code({ ...base, bounds: { maxToolsPerTask: 1 }, tasks: [{ ...task, requiredToolIds: ["one", "two"] }] })).toContain("tool_limit_exceeded");
    expect(code({ ...base, bounds: { maxToolsetsPerTask: 1 }, tasks: [{ ...task, requiredToolsets: ["one", "two"] }] })).toContain("toolset_limit_exceeded");
  });

  it("fails closed on malformed executor requirements", () => {
    const base = simpleRequest();
    const malformed = buildPolicyAwareDelegationPlan({
      ...base,
      tasks: [{
        ...base.tasks[0],
        executorRequirement: {
          ...base.tasks[0].executorRequirement,
          role: "provider-brand" as never,
          capabilities: [],
        },
      }],
    });
    expect(malformed.validation.reasons.map((reason) => reason.code)).toContain("malformed_executor_requirement");
    expect(malformed.plan).toBeNull();
  });


  it("performs no tool execution, queue writes, model calls, or external side effects", () => {
    clearToolRegistryForTests();
    const execute = vi.fn(async () => ({ shouldNotRun: true }));
    const descriptor = registeredTool();
    registerTool({
      tool: {
        name: descriptor.toolId,
        description: descriptor.metadata.description,
        risk: "internal_write",
        requiresApproval: true,
        execute,
      },
      metadata: descriptor.metadata,
    });
    const registered = getToolRegistration(descriptor.toolId);
    expect(registered).toBeDefined();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network access is forbidden"));
    try {
      const base = simpleRequest();
      const result = buildPolicyAwareDelegationPlan({
        ...base,
        envelope: envelope({ approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["internal_write"] } }),
        tools: [registered as RegisteredTool],
        tasks: [{ ...base.tasks[0], requiredToolIds: [descriptor.toolId], requiresApproval: true }],
      });
      expect(result.accepted).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.plan?.steps[0].budget)).toBe(true);
      expect(result.plan?.planning?.executionAuthorized).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      clearToolRegistryForTests();
    }

    const source = readFileSync(new URL("../orchestration/policy-aware-delegation.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/@\/lib\/(?:db|execution-queue|agents\/dispatcher|hermes-execution\/executor)/);
    expect(source).not.toMatch(/telegram-planner|callModel|executeTool|\bfetch\s*\(/);
  });


  it("prevents classification downgrade across dependency edges", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ limits: { ...envelope().limits, timeoutMs: 90_000 } }),
      availableModelProviders: ["openai", "ollama"],
      tasks: [
        {
          ...base.tasks[0],
          id: "private-source",
          dataClass: "PRIVATE",
          requiredCapabilities: ["local_private_inference"],
          executorRequirement: { role: "local_private", capabilities: ["local_private_inference"], environment: "local-worker", allowExternalModels: false },
          budget: { timeoutMs: 60_000, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0 },
        },
        {
          ...base.tasks[0],
          id: "personal-summary",
          dependencies: ["private-source"],
          dataClass: "PERSONAL",
          budget: { timeoutMs: 30_000, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0.05 },
        },
      ],
    });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("classification_downgrade");
  });

  it("enforces executor and skill tool-policy constraints", () => {
    const base = simpleRequest();
    const wrongEnvironment = buildPolicyAwareDelegationPlan({
      ...base,
      availableModelProviders: ["anthropic"],
      tasks: [{
        ...base.tasks[0],
        requiredCapabilities: ["architecture_review"],
        executorRequirement: { role: "architecture_review", capabilities: ["architecture_review"], environment: "local-worker", allowExternalModels: true },
      }],
    });
    expect(wrongEnvironment.validation.reasons.map((reason) => reason.code)).toContain("executor_requirement_unavailable");

    const deniedTool = registeredTool({ toolId: "tool.denied", metadata: { ...registeredTool().metadata, requiresApproval: false, risk: "read", permissions: ["authenticated", "authorized"] } });
    const skillPolicy = buildPolicyAwareDelegationPlan({
      ...base,
      skills: [enabledSkill],
      tools: [deniedTool],
      tasks: [{ ...base.tasks[0], requiredSkillIds: [enabledSkill.id], requiredToolIds: [deniedTool.toolId] }],
    });
    expect(skillPolicy.validation.reasons.map((reason) => reason.code)).toContain("skill_tool_denied");
  });


  it("scopes skill capability validation to the tasks that require each skill", () => {
    const base = simpleRequest();
    const codingSkill: OrchestrationSkill = {
      id: "coding-skill",
      enabled: true,
      source: "hermes_os",
      safetyClass: "approval_required",
      requiredCapabilities: ["repository_implementation"],
      allowedTools: [],
    };
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({
        taskClass: "plan",
        approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["repository_write"] },
        limits: { ...envelope().limits, timeoutMs: 60_000 },
      }),
      skills: [enabledSkill, codingSkill],
      tasks: [
        {
          ...base.tasks[0],
          id: "design",
          requiredSkillIds: [enabledSkill.id],
          budget: { timeoutMs: 30_000, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0.04 },
        },
        {
          ...base.tasks[0],
          id: "implement",
          dependencies: ["design"],
          requiredCapabilities: ["coding"],
          requiredSkillIds: [codingSkill.id],
          executorRequirement: { role: "coding", capabilities: ["coding"], environment: "local-worker", allowExternalModels: true },
          budget: { timeoutMs: 30_000, maxInputTokens: 1_000, maxOutputTokens: 250, maxEstimatedCostUsd: 0.04 },
          requiresApproval: true,
        },
      ],
    });
    expect(result.validation.reasons).toEqual([]);
    expect(result.plan?.steps.map((step) => step.executor)).toEqual(["hermes", "codex"]);
  });


  it("keeps the legacy envelope validator fail-closed for invalid classification", () => {
    const result = validateOrchestrationEnvelope(envelope({ dataClass: undefined as never }));
    expect(result.reasons.map((reason) => reason.code)).toContain("invalid_data_class");
  });


  it("prevents reviewer provider leakage when external models are disallowed", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ limits: { ...envelope().limits, timeoutMs: 60_000 } }),
      availableModelProviders: ["deepseek", "ollama"],
      tasks: [{
        ...base.tasks[0],
        budget: { ...base.tasks[0].budget, timeoutMs: 60_000 },
        executorRequirement: { ...base.tasks[0].executorRequirement, allowExternalModels: false },
        reviewerRequirement: { required: true, capabilities: ["challenger_reviewer"], environment: "local-worker", allowExternalModels: false },
      }],
    });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("reviewer_unavailable");
  });

  it("enforces allowed operations and rejects duplicate resource catalogs", () => {
    const base = simpleRequest();
    const operationDenied = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["read"] } }),
      tools: [registeredTool({ metadata: { ...registeredTool().metadata, capabilityTags: ["read"] } })],
      tasks: [{ ...base.tasks[0], requiredToolIds: ["tool.read"], requiresApproval: true }],
    });
    expect(operationDenied.validation.reasons.map((reason) => reason.code)).toContain("tool_operation_denied");

    const duplicateSkills = buildPolicyAwareDelegationPlan({
      ...base,
      skills: [enabledSkill, { ...enabledSkill, enabled: false }],
      tasks: [{ ...base.tasks[0], requiredSkillIds: [enabledSkill.id] }],
    });
    expect(duplicateSkills.validation.reasons.map((reason) => reason.code)).toContain("duplicate_skill_registration");

    const duplicateTools = buildPolicyAwareDelegationPlan({
      ...base,
      tools: [registeredTool(), registeredTool()],
    });
    expect(duplicateTools.validation.reasons.map((reason) => reason.code)).toContain("duplicate_tool_registration");
  });


  it("returns structured rejection reasons instead of throwing on malformed runtime input", () => {
    const base = simpleRequest();
    const malformed = {
      ...base,
      tasks: [{ ...base.tasks[0], dependencies: null as never }],
    };
    expect(() => buildPolicyAwareDelegationPlan(malformed)).not.toThrow();
    expect(buildPolicyAwareDelegationPlan(malformed).validation.reasons.map((reason) => reason.code)).toContain("malformed_task");

    const malformedReviewer = {
      ...base,
      tasks: [{
        ...base.tasks[0],
        reviewerRequirement: { required: true, capabilities: null, environment: "external-service", allowExternalModels: true } as never,
      }],
    };
    expect(() => buildPolicyAwareDelegationPlan(malformedReviewer)).not.toThrow();
    expect(buildPolicyAwareDelegationPlan(malformedReviewer).validation.reasons.map((reason) => reason.code)).toContain("malformed_reviewer_requirement");
  });


  it("enforces every required skill tool policy and resolves any environment conservatively", () => {
    const base = simpleRequest();
    const permissive = { ...enabledSkill, allowedTools: ["tool.read"] };
    const restrictive = { ...enabledSkill, id: "restricted", allowedTools: [] };
    const crossSkill = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["internal_write"] } }),
      skills: [permissive, restrictive],
      tools: [registeredTool()],
      tasks: [{ ...base.tasks[0], requiredSkillIds: [permissive.id, restrictive.id], requiredToolIds: ["tool.read"], requiresApproval: true }],
    });
    expect(crossSkill.validation.reasons.map((reason) => reason.code)).toContain("skill_tool_denied");

    const browserTool = registeredTool({
      metadata: { ...registeredTool().metadata, risk: "read", requiresApproval: false, executionEnvironment: "browser", capabilityTags: ["document_read"] },
    });
    const anyEnvironment = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ approvalPolicy: { requiredBeforeExecution: false, allowedOperations: ["read"] } }),
      tools: [browserTool],
      tasks: [{ ...base.tasks[0], requiredToolIds: ["tool.read"], executorRequirement: { ...base.tasks[0].executorRequirement, environment: "any" } }],
    });
    expect(anyEnvironment.validation.reasons.map((reason) => reason.code)).toContain("tool_environment_mismatch");
  });

  it("requires approval for every non-read tool even when registration metadata is weaker", () => {
    const base = simpleRequest();
    const weakWrite = registeredTool({ metadata: { ...registeredTool().metadata, requiresApproval: false } });
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ approvalPolicy: { requiredBeforeExecution: false, allowedOperations: ["internal_write"] } }),
      tools: [weakWrite],
      tasks: [{ ...base.tasks[0], requiredToolIds: ["tool.read"], requiresApproval: false }],
    });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("tool_approval_required");
  });

  it("emits a compatibility validation gate for code and preserves generic required-review metadata", () => {
    const base = simpleRequest();
    const code = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({
        taskClass: "code",
        limits: { ...envelope().limits, timeoutMs: 60_000 },
        approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["repository_write"] },
      }),
      tasks: [{
        ...base.tasks[0],
        requiredCapabilities: ["coding"],
        executorRequirement: { role: "coding", capabilities: ["coding"], environment: "local-worker", allowExternalModels: true },
        reviewerRequirement: { required: true, capabilities: ["challenger_reviewer"], environment: "external-service", allowExternalModels: true },
        requiresApproval: true,
      }],
      availableModelProviders: ["openai", "deepseek"],
    });
    expect(code.validation.reasons).toEqual([]);
    expect(code.accepted).toBe(true);
    expect(code.plan?.finalValidation).toEqual(["hermes"]);
    expect(code.plan?.planning?.requiredReviewerTaskIds).toEqual(["summarize"]);
    expect(code.plan?.reviewerExecutors).toEqual([]);
    expect(code.plan?.planning?.executionAuthorized).toBe(false);
  });


  it("rejects contradictory external executor constraints and honors task-class eligibility", () => {
    const base = simpleRequest();
    const contradictory = buildPolicyAwareDelegationPlan({
      ...base,
      availableModelProviders: ["ollama"],
      tasks: [{
        ...base.tasks[0],
        requiredCapabilities: ["local_private_inference"],
        executorRequirement: { role: "general_reasoning", capabilities: ["local_private_inference"], environment: "external-service", allowExternalModels: false },
        budget: { ...base.tasks[0].budget, timeoutMs: 60_000, maxEstimatedCostUsd: 0 },
      }],
      envelope: envelope({ limits: { ...envelope().limits, timeoutMs: 60_000 } }),
    });
    expect(contradictory.validation.reasons.map((reason) => reason.code)).toContain("contradictory_executor_requirement");

    const write = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ taskClass: "write", approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["write"] } }),
      tasks: [{ ...base.tasks[0], executorRequirement: { ...base.tasks[0].executorRequirement, environment: "external-service" }, requiresApproval: true }],
    });
    expect(write.accepted).toBe(true);
    expect(write.plan?.steps[0].executor).toBe("openai");
  });

  it("rejects malformed nested tool registrations without throwing", () => {
    const base = simpleRequest();
    const malformed = {
      ...base,
      tools: [{ toolId: "broken", registrationMode: "policy-gated", metadata: {} } as never],
      tasks: [{ ...base.tasks[0], requiredToolsets: ["documents"] }],
    };
    expect(() => buildPolicyAwareDelegationPlan(malformed)).not.toThrow();
    expect(buildPolicyAwareDelegationPlan(malformed).validation.reasons.map((reason) => reason.code)).toContain("malformed_tool_registration");
  });

  it("does not satisfy exact server or browser reviewer constraints with external reviewers", () => {
    const base = simpleRequest();
    for (const environment of ["server", "browser"] as const) {
      const result = buildPolicyAwareDelegationPlan({
        ...base,
        availableModelProviders: ["openai", "deepseek"],
        tasks: [{
          ...base.tasks[0],
          reviewerRequirement: { required: true, capabilities: ["challenger_reviewer"], environment, allowExternalModels: true },
        }],
      });
      expect(result.validation.reasons.map((reason) => reason.code)).toContain("reviewer_unavailable");
    }
  });


  it("fully validates nested skill and parent runtime fields without throwing", () => {
    const base = simpleRequest();
    const malformedSkill = { ...base, skills: [{ ...enabledSkill, id: "bad", allowedTools: "not-an-array" as never }] };
    expect(() => buildPolicyAwareDelegationPlan(malformedSkill)).not.toThrow();
    expect(buildPolicyAwareDelegationPlan(malformedSkill).validation.reasons.map((reason) => reason.code)).toContain("malformed_skill_registration");

    const malformedParent = { ...base, envelope: { ...base.envelope, originalMessage: {} as never } };
    expect(() => buildPolicyAwareDelegationPlan(malformedParent)).not.toThrow();
    expect(buildPolicyAwareDelegationPlan(malformedParent).validation.reasons.map((reason) => reason.code)).toContain("malformed_parent_request");
  });

  it("serializes the environment resolved from any tool requirement", () => {
    const base = simpleRequest();
    const tool = registeredTool({ toolId: "read.server", metadata: { ...registeredTool().metadata, risk: "read", requiresApproval: false, permissions: ["authenticated", "authorized"], executionEnvironment: "server", capabilityTags: ["document_read"] } });
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      tools: [tool],
      tasks: [{ ...base.tasks[0], requiredToolIds: [tool.toolId], executorRequirement: { ...base.tasks[0].executorRequirement, environment: "any" } }],
    });
    expect(result.accepted).toBe(true);
    expect(result.plan?.steps[0].executorRequirement?.environment).toBe("server");
  });

  it("reserves aggregate budget for required reviewer work", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      availableModelProviders: ["openai", "deepseek"],
      tasks: [{ ...base.tasks[0], reviewerRequirement: { required: true, capabilities: ["challenger_reviewer"], environment: "external-service", allowExternalModels: true } }],
    });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("aggregate_budget_exceeded");
  });


  it("accepts canonical configuration-required tools as unavailable and rejects forged metadata enums", () => {
    const base = simpleRequest();
    const configured = registeredTool({ metadata: { ...registeredTool().metadata, availability: "configuration-required" } });
    const unavailable = buildPolicyAwareDelegationPlan({ ...base, tools: [configured], tasks: [{ ...base.tasks[0], requiredToolIds: [configured.toolId] }] });
    expect(unavailable.validation.reasons.map((reason) => reason.code)).toContain("tool_unavailable");
    expect(unavailable.validation.reasons.map((reason) => reason.code)).not.toContain("malformed_tool_registration");

    for (const metadata of [
      { ...registeredTool().metadata, source: "forged" as never },
      { ...registeredTool().metadata, permissions: ["root"] as never },
    ]) {
      const malformed = buildPolicyAwareDelegationPlan({ ...base, tools: [registeredTool({ metadata })] });
      expect(malformed.validation.reasons.map((reason) => reason.code)).toContain("malformed_tool_registration");
    }
  });

  it("rejects executor capabilities that are not declared task capabilities", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      tasks: [{ ...base.tasks[0], executorRequirement: { ...base.tasks[0].executorRequirement, capabilities: ["summarization", "vision"] } }],
    });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("malformed_executor_requirement");
  });


  it("propagates parent approval requirements into disposition and steps", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({ ...base, envelope: envelope({ approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["read"] } }) });
    expect(result.accepted).toBe(true);
    expect(result.plan?.disposition).toBe("approval_required");
    expect(result.plan?.steps[0].requiresApproval).toBe(true);
  });

  it("forces local-execution skills onto a local-worker executor", () => {
    const base = simpleRequest();
    const localSkill: OrchestrationSkill = { ...enabledSkill, id: "local-only", safetyClass: "local_execution", requiredCapabilities: [] };
    const external = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["read"] } }),
      skills: [localSkill],
      tasks: [{ ...base.tasks[0], requiredSkillIds: [localSkill.id], requiresApproval: true, requiredCapabilities: ["local_private_inference"], executorRequirement: { ...base.tasks[0].executorRequirement, role: "local_private", capabilities: ["local_private_inference"], environment: "external-service" } }],
    });
    expect(external.validation.reasons.map((reason) => reason.code)).toContain("skill_environment_mismatch");

    const local = buildPolicyAwareDelegationPlan({
      ...base,
      availableModelProviders: ["ollama"],
      envelope: envelope({ approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["read"] }, limits: { ...envelope().limits, timeoutMs: 60_000 } }),
      skills: [localSkill],
      tasks: [{ ...base.tasks[0], requiredSkillIds: [localSkill.id], requiresApproval: true, requiredCapabilities: ["local_private_inference"], executorRequirement: { ...base.tasks[0].executorRequirement, role: "local_private", capabilities: ["local_private_inference"], environment: "any", allowExternalModels: false }, budget: { ...base.tasks[0].budget, timeoutMs: 60_000, maxEstimatedCostUsd: 0 } }],
    });
    expect(local.validation.reasons).toEqual([]);
    expect(local.accepted).toBe(true);
    expect(local.plan?.steps[0].executorRequirement?.environment).toBe("local-worker");
    expect(local.plan?.steps[0].executor).toBe("local");
  });

  it("rejects unknown task and optional-reviewer model capabilities", () => {
    const base = simpleRequest();
    const badTask = buildPolicyAwareDelegationPlan({ ...base, tasks: [{ ...base.tasks[0], requiredCapabilities: ["unknown-capability" as never], executorRequirement: { ...base.tasks[0].executorRequirement, capabilities: ["unknown-capability" as never] } }] });
    expect(badTask.validation.reasons.map((reason) => reason.code)).toContain("invalid_model_capability");

    const badReviewer = buildPolicyAwareDelegationPlan({ ...base, tasks: [{ ...base.tasks[0], reviewerRequirement: { required: false, capabilities: ["unknown-capability" as never], environment: "any", allowExternalModels: true } }] });
    expect(badReviewer.validation.reasons.map((reason) => reason.code)).toContain("malformed_reviewer_requirement");
  });


  it("requires approval and an allowed write operation for coding tasks", () => {
    const base = simpleRequest();
    const unsafe = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: envelope({ taskClass: "code", approvalPolicy: { requiredBeforeExecution: false, allowedOperations: ["read"] } }),
      tasks: [{ ...base.tasks[0], requiredCapabilities: ["coding"], executorRequirement: { ...base.tasks[0].executorRequirement, role: "coding", capabilities: ["coding"], environment: "local-worker" }, requiresApproval: false }],
    });
    const codes = unsafe.validation.reasons.map((reason) => reason.code);
    expect(codes).toContain("operation_not_allowed");
    expect(codes).toContain("parent_approval_required");
    expect(unsafe.accepted).toBe(false);
  });


  it("keeps local-execution skill model routing local", () => {
    const base = simpleRequest();
    const localSkill = { ...enabledSkill, id: "local-only", safetyClass: "local_execution" as const, requiredCapabilities: [], allowedTools: [] };
    const tasks = [{ ...base.tasks[0], requiredSkillIds: [localSkill.id], requiredCapabilities: ["local_private_inference" as const], executorRequirement: { role: "local_private" as const, capabilities: ["local_private_inference" as const], environment: "any" as const, allowExternalModels: true }, requiresApproval: true, budget: { ...base.tasks[0].budget, timeoutMs: 60_000, maxEstimatedCostUsd: 0 } }];
    const approvedEnvelope = { ...base.envelope, approvalPolicy: { ...base.envelope.approvalPolicy, requiredBeforeExecution: true }, limits: { ...base.envelope.limits, timeoutMs: 60_000 } };
    const externalOnly = buildPolicyAwareDelegationPlan({ ...base, envelope: approvedEnvelope, tasks, skills: [localSkill], availableModelProviders: ["openai"] });
    expect(externalOnly.accepted).toBe(false);
    expect(externalOnly.validation.reasons.map((reason) => reason.code)).toContain("model_requirement_unavailable");
    const local = buildPolicyAwareDelegationPlan({ ...base, envelope: approvedEnvelope, tasks, skills: [localSkill], availableModelProviders: ["ollama"] });
    expect(local.validation.reasons).toEqual([]);
    expect(local.accepted).toBe(true);
    expect(local.plan?.steps[0]?.executorRequirement?.allowExternalModels).toBe(false);
  });

  it("accepts legacy envelopes that omit optional token limits", () => {
    const base = simpleRequest();
    const limits = { ...base.envelope.limits };
    delete limits.maxInputTokens;
    delete limits.maxOutputTokens;
    const result = buildPolicyAwareDelegationPlan({ ...base, envelope: { ...base.envelope, limits } });
    expect(result.validation.reasons).toEqual([]);
    expect(result.accepted).toBe(true);
  });

  it("rejects forged skill provenance", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({ ...base, skills: [{ ...enabledSkill, source: "forged" as never }] });
    expect(result.accepted).toBe(false);
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("malformed_skill_registration");
  });


  it("requires parent approval for non-read plans even when every task requests approval", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: { ...base.envelope, taskClass: "write", approvalPolicy: { requiredBeforeExecution: false, allowedOperations: ["repository_write"] } },
      tasks: [{ ...base.tasks[0], requiresApproval: true }],
    });
    expect(result.accepted).toBe(false);
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("parent_approval_required");
  });

  it("accepts a bounded child cost budget under an unbounded parent", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: { ...base.envelope, limits: { ...base.envelope.limits, maxEstimatedCostUsd: null } },
      tasks: [{ ...base.tasks[0], budget: { ...base.tasks[0].budget, maxEstimatedCostUsd: 0.01 } }],
    });
    expect(result.validation.reasons).toEqual([]);
    expect(result.accepted).toBe(true);
  });


  it("requires the exact canonical operation for non-read task classes", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: { ...base.envelope, taskClass: "code", approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["typo"] } },
    });
    expect(result.accepted).toBe(false);
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("operation_not_allowed");
  });

  it("rejects non-numeric parent step limits without throwing", () => {
    const base = simpleRequest();
    expect(() => buildPolicyAwareDelegationPlan({ ...base, envelope: { ...base.envelope, limits: { ...base.envelope.limits, maxSteps: Symbol("bad") as never } } })).not.toThrow();
    const result = buildPolicyAwareDelegationPlan({ ...base, envelope: { ...base.envelope, limits: { ...base.envelope.limits, maxSteps: Symbol("bad") as never } } });
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("malformed_parent_request");
  });

  it("includes required reviewer tokens in derived legacy plan limits", () => {
    const base = simpleRequest();
    const limits = { ...base.envelope.limits, timeoutMs: 60_000 };
    delete limits.maxInputTokens;
    delete limits.maxOutputTokens;
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: { ...base.envelope, limits },
      availableModelProviders: ["openai", "deepseek"],
      tasks: [{ ...base.tasks[0], reviewerRequirement: { required: true, capabilities: ["challenger_reviewer"], environment: "external-service", allowExternalModels: true } }],
    });
    expect(result.validation.reasons).toEqual([]);
    expect(result.plan?.planning?.totalBudget.maxInputTokens).toBe(base.tasks[0].budget.maxInputTokens * 2);
    expect(result.plan?.planning?.totalBudget.maxOutputTokens).toBe(base.tasks[0].budget.maxOutputTokens * 2);
  });

  it("sums aggregate costs deterministically across task permutations", () => {
    const base = simpleRequest();
    const makeTask = (id: string, cost: number) => ({ ...base.tasks[0], id, budget: { ...base.tasks[0].budget, maxEstimatedCostUsd: cost } });
    const envelopeWithCost = { ...base.envelope, limits: { ...base.envelope.limits, maxSteps: 3, maxEstimatedCostUsd: 1e16 } };
    const tasks = [makeTask("large", 1e16), makeTask("small-a", 1), makeTask("small-b", 1)];
    const first = buildPolicyAwareDelegationPlan({ ...base, envelope: envelopeWithCost, tasks });
    const second = buildPolicyAwareDelegationPlan({ ...base, envelope: envelopeWithCost, tasks: [...tasks].reverse() });
    expect(first.accepted).toBe(false);
    expect(second.accepted).toBe(false);
    expect(first.validation.reasons).toEqual(second.validation.reasons);
  });


  it("keeps reviewers inside a local-execution skill boundary", () => {
    const base = simpleRequest();
    const localSkill: OrchestrationSkill = { ...enabledSkill, id: "local-review-boundary", safetyClass: "local_execution", requiredCapabilities: ["local_private_inference"] };
    const envelopeWithApproval = { ...base.envelope, limits: { ...base.envelope.limits, timeoutMs: 60_000 }, approvalPolicy: { requiredBeforeExecution: true, allowedOperations: ["read"] } };
    const localTask = {
      ...base.tasks[0],
      budget: { ...base.tasks[0].budget, timeoutMs: 60_000, maxEstimatedCostUsd: 0 },
      requiredSkillIds: [localSkill.id],
      requiredCapabilities: ["local_private_inference" as const],
      executorRequirement: { role: "local_private" as const, capabilities: ["local_private_inference" as const], environment: "any" as const, allowExternalModels: true },
      reviewerRequirement: { required: true, capabilities: ["summarization" as const], environment: "external-service" as const, allowExternalModels: true },
      requiresApproval: true,
    };
    const rejected = buildPolicyAwareDelegationPlan({ ...base, envelope: envelopeWithApproval, skills: [localSkill], availableModelProviders: ["openai", "ollama"], tasks: [localTask] });
    expect(rejected.accepted).toBe(false);
    expect(rejected.validation.reasons.map((reason) => reason.code)).toContain("contradictory_reviewer_requirement");

    const optional = buildPolicyAwareDelegationPlan({ ...base, envelope: envelopeWithApproval, skills: [localSkill], availableModelProviders: ["ollama"], tasks: [{ ...localTask, reviewerRequirement: { required: false, capabilities: ["summarization" as const], environment: "any" as const, allowExternalModels: true } }] });
    expect(optional.validation.reasons).toEqual([]);
    expect(optional.plan?.steps[0]?.reviewerRequirement?.environment).toBe("local-worker");
    expect(optional.plan?.steps[0]?.reviewerRequirement?.allowExternalModels).toBe(false);
  });


  it("returns a fail-closed result for malformed legacy step skill arrays", () => {
    const base = simpleRequest();
    const built = buildPolicyAwareDelegationPlan(base);
    expect(built.accepted).toBe(true);
    const malformed = { ...built.plan!, steps: [{ ...built.plan!.steps[0], requiredSkillIds: null as never }] };
    expect(() => validateDelegationPlan(base.envelope, malformed, { skills: [...base.skills] })).not.toThrow();
    expect(validateDelegationPlan(base.envelope, malformed, { skills: [...base.skills] }).reasons.map((reason) => reason.code)).toContain("invalid_step_skill_ids");
  });


  it("accepts a capable primary-route provider for required local review", () => {
    const base = simpleRequest();
    const localSkill = { ...enabledSkill, id: "local-review", safetyClass: "local_execution" as const, requiredCapabilities: [] };
    const task = {
      ...base.tasks[0],
      requiredSkillIds: [localSkill.id],
      requiredCapabilities: ["local_private_inference" as const],
      executorRequirement: { role: "local_private" as const, capabilities: ["local_private_inference" as const], environment: "any" as const, allowExternalModels: true },
      reviewerRequirement: { required: true, capabilities: ["summarization" as const], environment: "local-worker" as const, allowExternalModels: false },
      requiresApproval: true,
      budget: { ...base.tasks[0].budget, timeoutMs: 60_000, maxEstimatedCostUsd: 0 },
    };
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      envelope: { ...base.envelope, candidateSkillIds: [localSkill.id], approvalPolicy: { ...base.envelope.approvalPolicy, requiredBeforeExecution: true }, limits: { ...base.envelope.limits, timeoutMs: 120_000 } },
      tasks: [task],
      skills: [localSkill],
      availableModelProviders: ["ollama"],
    });
    expect(result.validation.reasons).toEqual([]);
    expect(result.accepted).toBe(true);
  });

  it("rejects contradictory external reviewer requirements even when review is optional", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan({
      ...base,
      tasks: [{ ...base.tasks[0], reviewerRequirement: { required: false, capabilities: ["summarization"], environment: "external-service", allowExternalModels: false } }],
    });
    expect(result.accepted).toBe(false);
    expect(result.validation.reasons.map((reason) => reason.code)).toContain("contradictory_reviewer_requirement");
  });


  it("rejects non-coercible task budgets before tool-policy comparisons", () => {
    const base = simpleRequest();
    const tool = registeredTool();
    const malformed = {
      ...base,
      tools: [tool],
      tasks: [{ ...base.tasks[0], requiredToolIds: [tool.toolId], budget: { ...base.tasks[0].budget, timeoutMs: Symbol("timeout") as never } }],
    };
    expect(() => buildPolicyAwareDelegationPlan(malformed)).not.toThrow();
    expect(buildPolicyAwareDelegationPlan(malformed).validation.reasons.map((reason) => reason.code)).toContain("invalid_task_budget");
  });


  it("rejects step skills omitted from the plan-level policy set", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan(base);
    expect(result.accepted).toBe(true);
    const plan = result.plan as NonNullable<typeof result.plan>;
    const malformed = { ...plan, skillIds: [], steps: [{ ...plan.steps[0], requiredSkillIds: [enabledSkill.id] }] };
    const validation = validateDelegationPlan(base.envelope, malformed, { skills: [...base.skills] });
    expect(validation.reasons.map((reason) => reason.code)).toContain("undeclared_step_skill");
  });


  it("rejects plan skills omitted from every step-level policy set", () => {
    const base = simpleRequest();
    const result = buildPolicyAwareDelegationPlan(base);
    expect(result.accepted).toBe(true);
    const plan = result.plan as NonNullable<typeof result.plan>;
    const malformed = { ...plan, skillIds: [enabledSkill.id], steps: plan.steps.map((step) => ({ ...step, requiredSkillIds: [] })) };
    const validation = validateDelegationPlan(base.envelope, malformed, { skills: [...base.skills] });
    expect(validation.reasons.map((reason) => reason.code)).toContain("unused_plan_skill");
  });

});
