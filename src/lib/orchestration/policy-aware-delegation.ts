import { MODEL_PROVIDER_REGISTRY, routeModelCandidates, type ModelCapability } from "@/lib/model-provider-registry";
import type { RegisteredTool } from "@/lib/hermes-execution/tool-registry";
import { EXECUTOR_REGISTRY, type ExecutorDefinition } from "./executors";
import type {
  DataClass,
  DelegationPlanV1,
  ExecutionEnvironmentConstraint,
  ExecutorId,
  ExecutorRequirementV1,
  ExecutorRole,
  OrchestrationEnvelopeV1,
  OrchestrationSkill,
  PolicyReason,
  ReviewerRequirementV1,
  TaskBudgetV1,
} from "./types";
import { validateDelegationPlan } from "./validate-plan";

export type DelegationTaskRequest = {
  id: string;
  description: string;
  dependencies: string[];
  requiredCapabilities: ModelCapability[];
  requiredSkillIds: string[];
  requiredToolIds: string[];
  requiredToolsets: string[];
  dataClass?: DataClass;
  executorRequirement: ExecutorRequirementV1;
  reviewerRequirement?: ReviewerRequirementV1;
  budget: TaskBudgetV1;
  requiresApproval: boolean;
  expectedOutput: string;
};

export type DelegationPlannerBounds = {
  maxTasks: number;
  maxDependencyDepth: number;
  maxSkillsPerTask: number;
  maxToolsPerTask: number;
  maxToolsetsPerTask: number;
};

export type PolicyAwareDelegationRequest = {
  envelope: OrchestrationEnvelopeV1;
  tasks: DelegationTaskRequest[];
  skills: readonly OrchestrationSkill[];
  tools: readonly RegisteredTool[];
  availableModelProviders: readonly string[];
  bounds?: Partial<DelegationPlannerBounds>;
};

export type DelegationValidationResult = Readonly<{
  valid: boolean;
  reasons: readonly PolicyReason[];
}>;

export type PolicyAwareDelegationResult = Readonly<{
  accepted: boolean;
  plan: DelegationPlanV1 | null;
  validation: DelegationValidationResult;
  executionStatus: "not_started";
}>;

const DATA_CLASSES = new Set<DataClass>(["PUBLIC", "PERSONAL", "PRIVATE", "SECRET"]);
const DATA_CLASS_RANK: Record<DataClass, number> = { PUBLIC: 0, PERSONAL: 1, PRIVATE: 2, SECRET: 3 };
const EXECUTOR_ROLES = new Set<ExecutorRole>(["general_reasoning", "architecture_review", "coding", "structured_planning", "local_private"]);
const EXECUTION_ENVIRONMENTS = new Set<ExecutionEnvironmentConstraint>(["any", "server", "local-worker", "browser", "external-service"]);
const KNOWN_MODEL_CAPABILITIES = new Set(MODEL_PROVIDER_REGISTRY.flatMap((provider) => provider.routing.capabilities));
const DEFAULT_BOUNDS: DelegationPlannerBounds = { maxTasks: 16, maxDependencyDepth: 4, maxSkillsPerTask: 8, maxToolsPerTask: 12, maxToolsetsPerTask: 8 };
const ABSOLUTE_BOUNDS: DelegationPlannerBounds = { maxTasks: 64, maxDependencyDepth: 8, maxSkillsPerTask: 16, maxToolsPerTask: 24, maxToolsetsPerTask: 16 };

function isDataClass(value: unknown): value is DataClass {
  return DATA_CLASSES.has(value as DataClass);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function hasValidEnvelopeRuntime(envelope: OrchestrationEnvelopeV1): boolean {
  return Boolean(envelope && typeof envelope === "object"
    && typeof envelope.version === "string" && typeof envelope.idempotencyKey === "string"
    && typeof envelope.source === "string" && typeof envelope.userId === "string"
    && (envelope.conversationId === null || typeof envelope.conversationId === "string")
    && typeof envelope.originalMessage === "string" && typeof envelope.requestedOutcome === "string"
    && envelope.contextRequest && typeof envelope.contextRequest === "object"
    && typeof envelope.contextRequest.query === "string" && isStringArray(envelope.contextRequest.allowedSources)
    && Number.isInteger(envelope.contextRequest.maximumItems) && isStringArray(envelope.candidateSkillIds)
    && (envelope.preferredExecutor === null || typeof envelope.preferredExecutor === "string")
    && envelope.approvalPolicy && typeof envelope.approvalPolicy === "object"
    && typeof envelope.approvalPolicy.requiredBeforeExecution === "boolean" && isStringArray(envelope.approvalPolicy.allowedOperations)
    && envelope.limits && typeof envelope.limits === "object"
    && Number.isInteger(envelope.limits.maxSteps) && Number.isInteger(envelope.limits.maxDelegationDepth)
    && Number.isFinite(envelope.limits.timeoutMs)
    && (envelope.limits.maxInputTokens === undefined || Number.isFinite(envelope.limits.maxInputTokens))
    && (envelope.limits.maxOutputTokens === undefined || Number.isFinite(envelope.limits.maxOutputTokens))
    && (envelope.limits.maxEstimatedCostUsd === null || Number.isFinite(envelope.limits.maxEstimatedCostUsd)));
}

function hasValidSkillRegistration(skill: OrchestrationSkill): boolean {
  return Boolean(skill && typeof skill.id === "string" && skill.id.length && typeof skill.enabled === "boolean"
    && ["hermes_os", "claude_code", "user", "scouted"].includes(skill.source)
    && ["read_only", "approval_required", "local_execution"].includes(skill.safetyClass)
    && isStringArray(skill.requiredCapabilities) && (skill.allowedTools === undefined || isStringArray(skill.allowedTools)));
}

function hasValidToolRegistration(tool: RegisteredTool): boolean {
  const metadata = tool?.metadata;
  return Boolean(tool && typeof tool.toolId === "string" && tool.toolId.length
    && ["policy-gated", "legacy-compatible"].includes(tool.registrationMode)
    && metadata && typeof metadata === "object"
    && ["native", "hermes-derived", "mcp", "local-worker", "builder", "system", "unknown"].includes(metadata.source)
    && isStringArray(metadata.toolsets) && ["read", "write", "privileged", "external-side-effect"].includes(metadata.risk)
    && ["available", "degraded", "configuration-required", "unavailable"].includes(metadata.availability)
    && isStringArray(metadata.permissions)
    && metadata.permissions.every((permission) => ["authenticated", "authorized", "approval", "secret-access", "local-worker", "budget", "audit"].includes(permission))
    && typeof metadata.requiresApproval === "boolean"
    && Number.isInteger(metadata.timeoutMs) && metadata.timeoutMs > 0
    && Number.isInteger(metadata.maxResultBytes) && metadata.maxResultBytes > 0
    && ["server", "local-worker", "browser", "external-service", "unknown"].includes(metadata.executionEnvironment)
    && typeof metadata.description === "string" && isStringArray(metadata.capabilityTags));
}

function hasValidRuntimeShape(request: PolicyAwareDelegationRequest): boolean {
  if (!request || typeof request !== "object" || !Array.isArray(request.tasks) || !Array.isArray(request.skills) || !Array.isArray(request.tools)) return false;
  if (!isStringArray(request.availableModelProviders)) return false;
  return request.tasks.every((task) => task && typeof task === "object"
    && typeof task.id === "string" && typeof task.description === "string" && typeof task.expectedOutput === "string"
    && isStringArray(task.dependencies) && isStringArray(task.requiredCapabilities)
    && isStringArray(task.requiredSkillIds) && isStringArray(task.requiredToolIds) && isStringArray(task.requiredToolsets)
    && task.executorRequirement && typeof task.executorRequirement === "object"
    && task.budget && typeof task.budget === "object" && typeof task.requiresApproval === "boolean"
    && (task.reviewerRequirement === undefined || (task.reviewerRequirement && typeof task.reviewerRequirement === "object")))
    && request.skills.every((skill) => skill && typeof skill.id === "string")
    && request.tools.every((tool) => tool && typeof tool.toolId === "string" && tool.metadata && typeof tool.metadata === "object");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

function executorSupportsRole(executor: ExecutorDefinition, role: ExecutorRole): boolean {
  if (role === "coding") return executor.codingCapability;
  if (role === "architecture_review") return executor.capabilities.includes("architecture");
  if (role === "local_private") return executor.capabilities.includes("private_processing");
  if (role === "structured_planning") return executor.capabilities.includes("planning");
  return executor.capabilities.some((capability) => ["planning", "general_reasoning", "conversation"].includes(capability));
}

function resolveExecutor(
  requirement: ExecutorRequirementV1,
  dataClass: DataClass,
  taskClass: OrchestrationEnvelopeV1["taskClass"],
  registry: Record<string, ExecutorDefinition>,
): ExecutorId | null {
  for (const executor of Object.values(registry).sort((a, b) => a.id.localeCompare(b.id))) {
    const environmentMatches = requirement.environment === "any" || executor.executionEnvironment === requirement.environment;
    const externalAllowed = requirement.allowExternalModels || executor.executionEnvironment !== "external-service";
    if (executor.enabled && externalAllowed && environmentMatches && executor.supportedDataClasses.includes(dataClass)
      && executor.supportedTaskClasses.includes(taskClass) && executorSupportsRole(executor, requirement.role)) {
      return executor.id;
    }
  }
  return null;
}

function boundedPlannerLimits(input: Partial<DelegationPlannerBounds> | undefined, reasons: PolicyReason[]): DelegationPlannerBounds {
  const result = { ...DEFAULT_BOUNDS };
  for (const key of Object.keys(DEFAULT_BOUNDS) as (keyof DelegationPlannerBounds)[]) {
    const value = input?.[key] ?? DEFAULT_BOUNDS[key];
    if (!Number.isInteger(value) || value < 1) {
      reasons.push({ code: "invalid_planner_bounds", message: `${key} must be a positive integer.`, path: `bounds.${key}` });
      continue;
    }
    result[key] = Math.min(value, ABSOLUTE_BOUNDS[key]);
  }
  return result;
}

function validBudgetNumber(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function hasValidTaskBudget(budget: unknown): budget is TaskBudgetV1 {
  if (!budget || typeof budget !== "object") return false;
  const value = budget as Partial<TaskBudgetV1>;
  return Number.isInteger(value.timeoutMs) && (value.timeoutMs ?? 0) > 0
    && Number.isInteger(value.maxInputTokens) && (value.maxInputTokens ?? -1) >= 0
    && Number.isInteger(value.maxOutputTokens) && (value.maxOutputTokens ?? -1) >= 0
    && (value.maxEstimatedCostUsd === null || validBudgetNumber(value.maxEstimatedCostUsd as number));
}

function rejected(reasons: PolicyReason[]): PolicyAwareDelegationResult {
  return deepFreeze({
    accepted: false,
    plan: null,
    validation: { valid: false, reasons },
    executionStatus: "not_started" as const,
  });
}

type OrderedTasks = { ordered: DelegationTaskRequest[]; maxDepth: number };

function orderTasks(tasks: readonly DelegationTaskRequest[], reasons: PolicyReason[]): OrderedTasks | null {
  const byId = new Map<string, DelegationTaskRequest>();
  for (const task of tasks) {
    if (!/^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/.test(task.id) || task.id.length > 64) {
      reasons.push({ code: "invalid_task_id", message: `Invalid task ID: ${task.id}.`, path: `tasks.${task.id}` });
    }
    if (byId.has(task.id)) reasons.push({ code: "duplicate_task_id", message: `Duplicate task ID: ${task.id}.`, path: `tasks.${task.id}` });
    else byId.set(task.id, task);
  }
  if (reasons.length) return null;
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    const dependencies = Array.from(new Set(task.dependencies));
    indegree.set(task.id, dependencies.length);
    for (const dependency of dependencies) {
      if (dependency === task.id) {
        reasons.push({ code: "self_dependency", message: `Task ${task.id} cannot depend on itself.`, path: `tasks.${task.id}.dependencies` });
        continue;
      }
      if (!byId.has(dependency)) {
        reasons.push({ code: "missing_dependency", message: `Task ${task.id} references missing dependency ${dependency}.`, path: `tasks.${task.id}.dependencies` });
        continue;
      }
      const children = dependents.get(dependency) ?? [];
      children.push(task.id);
      dependents.set(dependency, children);
    }
  }
  if (reasons.length) return null;
  const ready = [...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id).sort();
  const ordered: DelegationTaskRequest[] = [];
  const depths = new Map<string, number>();
  while (ready.length) {
    const id = ready.shift() as string;
    const task = byId.get(id) as DelegationTaskRequest;
    const depth = task.dependencies.length ? Math.max(...task.dependencies.map((dependency) => depths.get(dependency) ?? 0)) + 1 : 1;
    depths.set(id, depth);
    ordered.push(task);
    for (const child of (dependents.get(id) ?? []).sort()) {
      const next = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, next);
      if (next === 0) { ready.push(child); ready.sort(); }
    }
  }
  if (ordered.length !== tasks.length) {
    reasons.push({ code: "dependency_cycle", message: "Delegation tasks contain a dependency cycle.", path: "tasks" });
    return null;
  }
  return { ordered, maxDepth: Math.max(0, ...depths.values()) };
}

export function buildPolicyAwareDelegationPlan(request: PolicyAwareDelegationRequest): PolicyAwareDelegationResult {
  const reasons: PolicyReason[] = [];
  if (!hasValidRuntimeShape(request)) return rejected([{ code: "malformed_task", message: "Delegation request contains malformed runtime input.", path: "tasks" }]);
  if (!hasValidEnvelopeRuntime(request.envelope)) {
    return rejected([{ code: "malformed_parent_request", message: "Parent envelope contains malformed runtime input.", path: "envelope" }]);
  }
  if (request.skills.some((skill) => !hasValidSkillRegistration(skill))) {
    return rejected([{ code: "malformed_skill_registration", message: "Skill catalog contains malformed registration metadata.", path: "skills" }]);
  }
  if (request.tools.some((tool) => !hasValidToolRegistration(tool))) {
    return rejected([{ code: "malformed_tool_registration", message: "Tool catalog contains malformed registration metadata.", path: "tools" }]);
  }
  const registry = EXECUTOR_REGISTRY;
  const parent = request.envelope;
  if (!parent || typeof parent !== "object" || !parent.limits || !parent.approvalPolicy
    || typeof parent.approvalPolicy.requiredBeforeExecution !== "boolean" || !Array.isArray(parent.approvalPolicy.allowedOperations)
    || !parent.contextRequest || !Array.isArray(parent.contextRequest.allowedSources)) {
    return rejected([{ code: "malformed_parent_request", message: "Parent orchestration envelope is malformed.", path: "envelope" }]);
  }
  if (!isDataClass(parent.dataClass)) return rejected([{ code: "invalid_data_class", message: "A valid parent data classification is required.", path: "envelope.dataClass" }]);
  const plannedOperation = parent.taskClass === "code" ? "repository_write" : parent.taskClass === "write" ? "write" : parent.taskClass === "operate" ? "operate" : null;
  if (plannedOperation !== null && !parent.approvalPolicy.allowedOperations.includes(plannedOperation)) {
    reasons.push({ code: "operation_not_allowed", message: "Parent policy does not allow the requested task operation.", path: "envelope.approvalPolicy.allowedOperations" });
  }
  const bounds = boundedPlannerLimits(request.bounds, reasons);
  if (!request.tasks.length) reasons.push({ code: "task_count_invalid", message: "At least one task is required." });
  if (request.tasks.length > Math.min(bounds.maxTasks, parent.limits.maxSteps, 100)) reasons.push({ code: "task_limit_exceeded", message: "The plan exceeds its task limit.", path: "tasks" });
  if (!Number.isInteger(parent.limits.maxSteps) || parent.limits.maxSteps < 1 || parent.limits.maxSteps > 100
    || !Number.isInteger(parent.limits.maxDelegationDepth) || parent.limits.maxDelegationDepth < 0 || parent.limits.maxDelegationDepth > ABSOLUTE_BOUNDS.maxDependencyDepth) {
    reasons.push({ code: "invalid_parent_bounds", message: "Parent task and dependency bounds must be conservative integers.", path: "envelope.limits" });
  }
  const parentBudgetValid = Number.isInteger(parent.limits.timeoutMs) && parent.limits.timeoutMs > 0
    && (parent.limits.maxInputTokens === undefined || (Number.isInteger(parent.limits.maxInputTokens) && parent.limits.maxInputTokens >= 0))
    && (parent.limits.maxOutputTokens === undefined || (Number.isInteger(parent.limits.maxOutputTokens) && parent.limits.maxOutputTokens >= 0))
    && (parent.limits.maxEstimatedCostUsd === null || validBudgetNumber(parent.limits.maxEstimatedCostUsd));
  if (!parentBudgetValid) reasons.push({ code: "invalid_parent_budget", message: "Planning requires bounded timeout and token budgets.", path: "envelope.limits" });
  if (plannedOperation !== null && !parent.approvalPolicy.requiredBeforeExecution) {
    reasons.push({ code: "parent_approval_required", message: "Non-read task work requires parent approval before execution.", path: "envelope.approvalPolicy.requiredBeforeExecution" });
  }
  if (reasons.length) return rejected(reasons);
  const orderedTasks = orderTasks(request.tasks, reasons);
  if (!orderedTasks) return rejected(reasons);
  if (new Set(request.skills.map((skill) => skill.id)).size !== request.skills.length) reasons.push({ code: "duplicate_skill_registration", message: "Skill catalog contains duplicate IDs.", path: "skills" });
  if (new Set(request.tools.map((tool) => tool.toolId)).size !== request.tools.length) reasons.push({ code: "duplicate_tool_registration", message: "Tool catalog contains duplicate IDs.", path: "tools" });
  if (orderedTasks.maxDepth > Math.min(bounds.maxDependencyDepth, parent.limits.maxDelegationDepth)) {
    reasons.push({ code: "dependency_depth_exceeded", message: "The plan exceeds its dependency-depth limit.", path: "tasks" });
  }
  const skillCatalog = new Map(request.skills.map((skill) => [skill.id, skill]));
  const toolCatalog = new Map(request.tools.map((tool) => [tool.toolId, tool]));
  const taskCatalog = new Map(orderedTasks.ordered.map((task) => [task.id, task]));
  for (const task of orderedTasks.ordered) {
    if (!hasValidTaskBudget(task.budget)) reasons.push({ code: "invalid_task_budget", message: "Task " + task.id + " has a malformed budget.", path: "tasks." + task.id + ".budget" });
  }
  if (reasons.length) return rejected(reasons);
  const resolved = orderedTasks.ordered.map((task) => {
    const requestedDataClass: unknown = task.dataClass ?? parent.dataClass;
    const dataClass = isDataClass(requestedDataClass) ? requestedDataClass : parent.dataClass;
    if (task.requiredSkillIds.length > bounds.maxSkillsPerTask) reasons.push({ code: "skill_limit_exceeded", message: `Task ${task.id} exceeds its skill limit.`, path: `tasks.${task.id}.requiredSkillIds` });
    if (task.requiredToolIds.length > bounds.maxToolsPerTask) reasons.push({ code: "tool_limit_exceeded", message: `Task ${task.id} exceeds its tool limit.`, path: `tasks.${task.id}.requiredToolIds` });
    if (task.requiredToolsets.length > bounds.maxToolsetsPerTask) reasons.push({ code: "toolset_limit_exceeded", message: `Task ${task.id} exceeds its toolset limit.`, path: `tasks.${task.id}.requiredToolsets` });
    if (task.requiredCapabilities.some((capability) => !KNOWN_MODEL_CAPABILITIES.has(capability))) {
      reasons.push({ code: "invalid_model_capability", message: `Task ${task.id} contains an unknown model capability.`, path: `tasks.${task.id}.requiredCapabilities` });
    }
    const requirement = task.executorRequirement as Partial<ExecutorRequirementV1> | null;
    if (!requirement || !EXECUTOR_ROLES.has(requirement.role as ExecutorRole)
      || !Array.isArray(requirement.capabilities) || !requirement.capabilities.length
      || task.requiredCapabilities.length === 0
      || task.requiredCapabilities.some((capability) => !requirement.capabilities?.includes(capability))
      || requirement.capabilities.some((capability) => !task.requiredCapabilities.includes(capability))
      || requirement.capabilities.some((capability) => !KNOWN_MODEL_CAPABILITIES.has(capability))
      || !EXECUTION_ENVIRONMENTS.has(requirement.environment as ExecutionEnvironmentConstraint)
      || typeof requirement.allowExternalModels !== "boolean") {
      reasons.push({ code: "malformed_executor_requirement", message: `Task ${task.id} has a malformed executor requirement.`, path: `tasks.${task.id}.executorRequirement` });
    }
    if (task.executorRequirement.environment === "external-service" && !task.executorRequirement.allowExternalModels) {
      reasons.push({ code: "contradictory_executor_requirement", message: `Task ${task.id} disallows the external executor environment it requires.`, path: `tasks.${task.id}.executorRequirement` });
    }
    const reviewer = task.reviewerRequirement as Partial<ReviewerRequirementV1> | undefined;
    if (reviewer && (typeof reviewer.required !== "boolean"
      || !Array.isArray(reviewer.capabilities) || !reviewer.capabilities.length
      || reviewer.capabilities.some((capability) => !KNOWN_MODEL_CAPABILITIES.has(capability))
      || !EXECUTION_ENVIRONMENTS.has(reviewer.environment as ExecutionEnvironmentConstraint)
      || typeof reviewer.allowExternalModels !== "boolean")) {
      reasons.push({ code: "malformed_reviewer_requirement", message: `Task ${task.id} has a malformed reviewer requirement.`, path: `tasks.${task.id}.reviewerRequirement` });
    }
    if (reviewer?.environment === "external-service" && reviewer.allowExternalModels === false) {
      reasons.push({ code: "contradictory_reviewer_requirement", message: "Task " + task.id + " disallows the external reviewer environment it requires.", path: "tasks." + task.id + ".reviewerRequirement" });
    }
    const budget = task.budget as Partial<TaskBudgetV1> | null;
    const budgetValid = hasValidTaskBudget(budget);
    if (!budgetValid) reasons.push({ code: "invalid_task_budget", message: `Task ${task.id} has a malformed budget.`, path: `tasks.${task.id}.budget` });
    else {
      const costOverflow = parent.limits.maxEstimatedCostUsd !== null
        && (budget?.maxEstimatedCostUsd === null || (budget?.maxEstimatedCostUsd ?? 0) > parent.limits.maxEstimatedCostUsd);
      if ((budget?.timeoutMs ?? 0) > parent.limits.timeoutMs
        || (parent.limits.maxInputTokens !== undefined && (budget?.maxInputTokens ?? 0) > parent.limits.maxInputTokens)
        || (parent.limits.maxOutputTokens !== undefined && (budget?.maxOutputTokens ?? 0) > parent.limits.maxOutputTokens)
        || costOverflow) {
        reasons.push({ code: "child_budget_exceeded", message: `Task ${task.id} exceeds its parent budget.`, path: `tasks.${task.id}.budget` });
      }
    }
    if (!isDataClass(requestedDataClass)) {
      reasons.push({ code: "invalid_data_class", message: `Task ${task.id} has an invalid data classification.`, path: `tasks.${task.id}.dataClass` });
    } else if (DATA_CLASS_RANK[dataClass] < DATA_CLASS_RANK[parent.dataClass]) {
      reasons.push({ code: "classification_downgrade", message: `Task ${task.id} cannot be less restrictive than its parent.`, path: `tasks.${task.id}.dataClass` });
    } else if (task.dependencies.some((dependency) => {
      const dependencyClass = taskCatalog.get(dependency)?.dataClass ?? parent.dataClass;
      return isDataClass(dependencyClass) && DATA_CLASS_RANK[dataClass] < DATA_CLASS_RANK[dependencyClass];
    })) {
      reasons.push({ code: "classification_downgrade", message: `Task ${task.id} cannot be less restrictive than a dependency.`, path: `tasks.${task.id}.dataClass` });
    }
    for (const skillId of task.requiredSkillIds) {
      const skill = skillCatalog.get(skillId);
      if (!skill) reasons.push({ code: "unknown_skill", message: `Unknown skill: ${skillId}.`, path: `tasks.${task.id}.requiredSkillIds` });
      else if (!skill.enabled) reasons.push({ code: "disabled_skill", message: `Skill is disabled: ${skillId}.`, path: `tasks.${task.id}.requiredSkillIds` });
      else if (skill.safetyClass !== "read_only" && (!task.requiresApproval || !parent.approvalPolicy.requiredBeforeExecution)) {
        reasons.push({ code: "skill_approval_required", message: `Skill requires approval: ${skillId}.`, path: `tasks.${task.id}.requiredSkillIds` });
      }
    }
    const resolvedToolIds = new Set(task.requiredToolIds);
    for (const toolset of task.requiredToolsets) {
      const registrations = request.tools.filter((tool) => tool.metadata.toolsets.includes(toolset));
      if (!registrations.length) reasons.push({ code: "unknown_toolset", message: `Unknown or empty toolset: ${toolset}.`, path: `tasks.${task.id}.requiredToolsets` });
      for (const registration of registrations) resolvedToolIds.add(registration.toolId);
    }
    if (resolvedToolIds.size > bounds.maxToolsPerTask) reasons.push({ code: "tool_limit_exceeded", message: `Task ${task.id} exceeds its resolved tool limit.`, path: `tasks.${task.id}.requiredToolIds` });
    const selectedSkills = task.requiredSkillIds.map((skillId) => skillCatalog.get(skillId)).filter((skill): skill is OrchestrationSkill => Boolean(skill));
    const requiresLocalExecution = selectedSkills.some((skill) => skill.safetyClass === "local_execution");
    const toolEnvironments = new Set<string>();
    for (const toolId of resolvedToolIds) {
      for (const skill of selectedSkills) {
        if (!(skill.allowedTools ?? []).includes(toolId)) {
          reasons.push({ code: "skill_tool_denied", message: `Skill ${skill.id} does not permit tool: ${toolId}.`, path: `tasks.${task.id}.requiredSkillIds` });
        }
      }
      const registration = toolCatalog.get(toolId);
      if (!registration) {
        reasons.push({ code: "unknown_tool", message: `Unknown tool registration: ${toolId}.`, path: `tasks.${task.id}.requiredToolIds` });
        continue;
      }
      if (registration.metadata.availability !== "available") {
        reasons.push({ code: "tool_unavailable", message: `Required tool is unavailable: ${toolId}.`, path: `tasks.${task.id}.requiredToolIds` });
      }
      const toolRequiresApproval = registration.metadata.requiresApproval || registration.metadata.risk !== "read";
      if (toolRequiresApproval && (!task.requiresApproval || !parent.approvalPolicy.requiredBeforeExecution)) {
        reasons.push({ code: "tool_approval_required", message: `Tool requires approval: ${toolId}.`, path: `tasks.${task.id}.requiredToolIds` });
      }
      const operationAliases = registration.metadata.risk === "read"
        ? ["read"]
        : registration.metadata.risk === "write"
          ? ["write", "internal_write"]
          : registration.metadata.risk === "privileged"
            ? ["privileged"]
            : ["external_write", "external-side-effect"];
      const permittedOperations = new Set([toolId, ...operationAliases]);
      if (!parent.approvalPolicy.allowedOperations.some((operation) => permittedOperations.has(operation))) {
        reasons.push({ code: "tool_operation_denied", message: `Tool operation is not allowed: ${toolId}.`, path: `envelope.approvalPolicy.allowedOperations` });
      }
      toolEnvironments.add(registration.metadata.executionEnvironment);
      if (task.executorRequirement.environment !== "any" && registration.metadata.executionEnvironment !== task.executorRequirement.environment) {
        reasons.push({ code: "tool_environment_mismatch", message: `Tool ${toolId} does not satisfy the execution environment constraint.`, path: `tasks.${task.id}.executorRequirement.environment` });
      }
      if (registration.metadata.timeoutMs > task.budget.timeoutMs) {
        reasons.push({ code: "tool_timeout_exceeded", message: `Tool ${toolId} exceeds the task timeout budget.`, path: `tasks.${task.id}.budget.timeoutMs` });
      }
    }
    let effectiveRequirement = task.executorRequirement;
    if (task.executorRequirement.environment === "any" && toolEnvironments.size > 1) {
      reasons.push({ code: "tool_environment_mismatch", message: `Task ${task.id} requires tools from incompatible environments.`, path: `tasks.${task.id}.requiredToolIds` });
    } else if (task.executorRequirement.environment === "any" && toolEnvironments.size === 1) {
      const toolEnvironment = [...toolEnvironments][0];
      if (!EXECUTION_ENVIRONMENTS.has(toolEnvironment as ExecutionEnvironmentConstraint) || toolEnvironment === "any") {
        reasons.push({ code: "tool_environment_mismatch", message: `Task ${task.id} requires an unknown tool environment.`, path: `tasks.${task.id}.requiredToolIds` });
      } else {
        effectiveRequirement = { ...task.executorRequirement, environment: toolEnvironment as ExecutionEnvironmentConstraint };
      }
    }
    if (requiresLocalExecution && effectiveRequirement.environment !== "local-worker") {
      if (task.executorRequirement.environment === "any" && (toolEnvironments.size === 0 || (toolEnvironments.size === 1 && toolEnvironments.has("local-worker")))) {
        effectiveRequirement = { ...effectiveRequirement, environment: "local-worker" };
      } else {
        reasons.push({ code: "skill_environment_mismatch", message: `Task ${task.id} requires a local-execution skill.`, path: `tasks.${task.id}.executorRequirement.environment` });
      }
    }
    if (requiresLocalExecution) effectiveRequirement = { ...effectiveRequirement, allowExternalModels: false };
    const executor = resolveExecutor(effectiveRequirement, dataClass, parent.taskClass, registry);
    if (!executor) {
      if (task.executorRequirement.environment === "any" && toolEnvironments.size) {
        reasons.push({ code: "tool_environment_mismatch", message: `No executor can host the required tool environment for task ${task.id}.`, path: `tasks.${task.id}.requiredToolIds` });
      }
      reasons.push({ code: "executor_requirement_unavailable", message: `No executor satisfies task ${task.id}.`, path: `tasks.${task.id}.executorRequirement` });
    }
    const availableProviders = effectiveRequirement.allowExternalModels
      ? request.availableModelProviders
      : MODEL_PROVIDER_REGISTRY
        .filter((entry) => entry.routing.location === "local" && request.availableModelProviders.includes(entry.family))
        .map((entry) => entry.family);
    const modelRoute = routeModelCandidates({
      dataClass,
      requiredCapabilities: task.requiredCapabilities,
      availableProviders,
      maxEstimatedCostUsd: task.budget.maxEstimatedCostUsd ?? undefined,
      estimatedInputTokens: task.budget.maxInputTokens,
      requestedOutputTokens: task.budget.maxOutputTokens,
      maxTimeoutMs: task.budget.timeoutMs,
    });
    if (modelRoute.status !== "eligible") reasons.push({ code: "model_requirement_unavailable", message: `No model capability route satisfies task ${task.id}.`, path: `tasks.${task.id}.requiredCapabilities` });
    const effectiveReviewerRequirement = task.reviewerRequirement
      ? requiresLocalExecution
        ? { ...task.reviewerRequirement, environment: "local-worker" as const, allowExternalModels: false }
        : task.reviewerRequirement
      : undefined;
    if (requiresLocalExecution && task.reviewerRequirement?.environment === "external-service") {
      reasons.push({ code: "contradictory_reviewer_requirement", message: "Task requires local execution but declares an external reviewer.", path: "tasks." + task.id + ".reviewerRequirement.environment" });
    }
    if (effectiveReviewerRequirement?.required) {
      const reviewerProviders = MODEL_PROVIDER_REGISTRY
        .filter((entry) => effectiveReviewerRequirement.allowExternalModels ? true : entry.routing.location === "local")
        .filter((entry) => {
          if (effectiveReviewerRequirement.environment === "any") return true;
          if (effectiveReviewerRequirement.environment === "local-worker") return entry.routing.location === "local";
          if (effectiveReviewerRequirement.environment === "external-service") return entry.routing.location === "external";
          return false;
        })
        .map((entry) => entry.family)
        .filter((providerId) => request.availableModelProviders === undefined || request.availableModelProviders.includes(providerId));
      const reviewerRoute = routeModelCandidates({
        dataClass,
        requiredCapabilities: effectiveReviewerRequirement.capabilities,
        availableProviders: reviewerProviders,
        includeOptionalReviewers: true,
        maxEstimatedCostUsd: task.budget.maxEstimatedCostUsd ?? undefined,
        estimatedInputTokens: task.budget.maxInputTokens,
        requestedOutputTokens: task.budget.maxOutputTokens,
        maxTimeoutMs: task.budget.timeoutMs,
      });
      if (!reviewerRoute.candidates.length && !reviewerRoute.optionalReviewers.length) {
        reasons.push({ code: "reviewer_unavailable", message: `No optional reviewer satisfies task ${task.id}.`, path: `tasks.${task.id}.reviewerRequirement` });
      }
    }
    return { task, dataClass, executor, effectiveRequirement, effectiveReviewerRequirement, resolvedToolIds: [...resolvedToolIds].sort() };
  });
  const budgetMultiplier = (task: DelegationTaskRequest) => task.reviewerRequirement?.required ? 2 : 1;
  const aggregateTimeout = request.tasks.reduce((sum, task) => sum + (Number.isFinite(task.budget?.timeoutMs) ? task.budget.timeoutMs * budgetMultiplier(task) : 0), 0);
  const aggregateInput = request.tasks.reduce((sum, task) => sum + (Number.isFinite(task.budget?.maxInputTokens) ? task.budget.maxInputTokens * budgetMultiplier(task) : 0), 0);
  const aggregateOutput = request.tasks.reduce((sum, task) => sum + (Number.isFinite(task.budget?.maxOutputTokens) ? task.budget.maxOutputTokens * budgetMultiplier(task) : 0), 0);
  const aggregateCost = request.tasks
    .map((task) => typeof task.budget?.maxEstimatedCostUsd === "number" && Number.isFinite(task.budget.maxEstimatedCostUsd) ? task.budget.maxEstimatedCostUsd * budgetMultiplier(task) : 0)
    .sort((left, right) => left - right)
    .reduce((sum, cost) => sum + cost, 0);
  const aggregateCostOverflow = parent.limits.maxEstimatedCostUsd !== null && aggregateCost > parent.limits.maxEstimatedCostUsd;
  if (aggregateTimeout > parent.limits.timeoutMs
    || (parent.limits.maxInputTokens !== undefined && aggregateInput > parent.limits.maxInputTokens)
    || (parent.limits.maxOutputTokens !== undefined && aggregateOutput > parent.limits.maxOutputTokens)
    || aggregateCostOverflow) {
    reasons.push({ code: "aggregate_budget_exceeded", message: "Task decomposition exceeds the parent aggregate budget.", path: "tasks" });
  }
  if (reasons.length || resolved.some((entry) => !entry.executor)) return rejected(reasons);
  const totalBudget: TaskBudgetV1 = {
    timeoutMs: parent.limits.timeoutMs,
    maxInputTokens: parent.limits.maxInputTokens ?? aggregateInput,
    maxOutputTokens: parent.limits.maxOutputTokens ?? aggregateOutput,
    maxEstimatedCostUsd: parent.limits.maxEstimatedCostUsd,
  };
  const primaryExecutor = resolved[0].executor as ExecutorId;
  const plan: DelegationPlanV1 = {
    version: "1",
    disposition: parent.approvalPolicy.requiredBeforeExecution || resolved.some(({ task }) => task.requiresApproval) ? "approval_required" : resolved.length > 1 ? "delegate" : "answer",
    summary: parent.requestedOutcome,
    skillIds: Array.from(new Set(resolved.flatMap(({ task }) => task.requiredSkillIds))).sort(),
    primaryExecutor,
    reviewerExecutors: [],
    steps: resolved.map(({ task, dataClass, executor, effectiveRequirement, effectiveReviewerRequirement, resolvedToolIds }) => ({
      id: task.id, executor: executor as ExecutorId, purpose: task.description,
      capability: task.requiredCapabilities[0] ?? task.executorRequirement.role,
      requiredContext: [...parent.contextRequest.allowedSources].sort(), expectedOutput: task.expectedOutput,
      requiresApproval: parent.approvalPolicy.requiredBeforeExecution || task.requiresApproval, dependsOn: [...task.dependencies].sort(),
      requiredCapabilities: [...task.requiredCapabilities].sort(), requiredSkillIds: [...task.requiredSkillIds].sort(),
      requiredToolIds: resolvedToolIds, requiredToolsets: [...task.requiredToolsets].sort(), dataClass,
      executorRequirement: { ...effectiveRequirement, capabilities: [...effectiveRequirement.capabilities].sort() },
      reviewerRequirement: effectiveReviewerRequirement ? { ...effectiveReviewerRequirement, capabilities: [...effectiveReviewerRequirement.capabilities].sort() } : undefined,
      budget: { ...task.budget },
    })),
    finalValidation: ["code", "operate"].includes(parent.taskClass) ? ["hermes"] : [], userFacingStatus: "Planning complete. Execution has not started.",
    planning: {
      parentDataClass: parent.dataClass,
      totalBudget,
      orderedTaskIds: resolved.map(({ task }) => task.id),
      requiredReviewerTaskIds: resolved.filter(({ task }) => task.reviewerRequirement?.required).map(({ task }) => task.id),
      maxDependencyDepth: orderedTasks.maxDepth,
      executionAuthorized: false,
    },
  };
  const legacyPolicy = validateDelegationPlan(parent, plan, { skills: [...request.skills], executors: registry });
  if (!legacyPolicy.ok) return rejected(legacyPolicy.reasons);
  return deepFreeze({ accepted: true, plan, validation: { valid: true, reasons: [] }, executionStatus: "not_started" as const });
}
