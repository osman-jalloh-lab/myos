export type ProviderFamily = "openai" | "anthropic" | "deepseek" | "gemini" | "ollama" | "groq";

export type ProviderRole =
  | "engineering"
  | "architecture"
  | "challenger"
  | "multimodal_strategy"
  | "local_reviewer"
  | "fallback";

export type ProviderEnvironment = "Local" | "Vercel" | "Both";
export type ModelDataClass = "PUBLIC" | "PERSONAL" | "PRIVATE" | "SECRET";
export type ModelCapability =
  | "general_reasoning"
  | "architecture_review"
  | "coding"
  | "structured_planning"
  | "summarization"
  | "vision"
  | "challenger_reviewer"
  | "local_private_inference"
  | "tool_calling"
  | "structured_output";
export type ModelReasoningSupport = "none" | "standard" | "advanced";
export type ModelContextWindowClass = "compact" | "standard" | "long" | "very_long";
export type ModelCostClass = "free" | "low" | "medium" | "high";
export type ModelAvailability = "enabled" | "disabled";
export type ModelLocation = "local" | "external";
export type ModelRouteRole = "primary" | "fallback" | "optional_reviewer";

export type ModelRoutingMetadata = {
  capabilities: readonly ModelCapability[];
  reasoningSupport: ModelReasoningSupport;
  toolCalling: boolean;
  structuredOutput: boolean;
  contextWindowClass: ModelContextWindowClass;
  contextWindowTokens: number;
  modalities: readonly ("text" | "image")[];
  location: ModelLocation;
  permittedDataClasses: readonly ModelDataClass[];
  timeoutMs: number;
  maxOutputTokens: number;
  cost: Readonly<{ class: ModelCostClass; inputUsdPerMillion: number; outputUsdPerMillion: number }>;
  availability: ModelAvailability;
  fallbackEligible: boolean;
  optionalReviewer: boolean;
};

export type ProviderRegistryEntry = {
  family: ProviderFamily;
  provider: string;
  role: ProviderRole;
  roleLabel: string;
  env: string[];
  modelEnv?: string;
  defaultModel?: string;
  baseUrlEnv?: string;
  environment: ProviderEnvironment;
  council: boolean;
  testable: boolean;
  routePreview: string;
  routing: ModelRoutingMetadata;
};

export type ModelRouteRequest = {
  dataClass: unknown;
  requiredCapabilities?: readonly ModelCapability[];
  availableProviders?: readonly string[];
  includeOptionalReviewers?: boolean;
  maxCostClass?: ModelCostClass;
  maxEstimatedCostUsd?: number;
  estimatedInputTokens?: number;
  requestedOutputTokens?: number;
  maxTimeoutMs?: number;
};

export type ModelRouteCandidate = Readonly<{
  providerId: ProviderFamily;
  modelId: string;
  routeRole: ModelRouteRole;
  estimatedCostUsd: number;
  metadata: ModelRoutingMetadata;
}>;

export type ModelRouteRejection = Readonly<{
  providerId: string;
  reason: string;
}>;

export type ModelRouteDecision = Readonly<{
  status: "eligible" | "blocked";
  dataClass: ModelDataClass | null;
  candidates: readonly ModelRouteCandidate[];
  optionalReviewers: readonly ModelRouteCandidate[];
  rejections: readonly ModelRouteRejection[];
  reasons: readonly string[];
}>;

const MODEL_CAPABILITIES = new Set<ModelCapability>([
  "general_reasoning",
  "architecture_review",
  "coding",
  "structured_planning",
  "summarization",
  "vision",
  "challenger_reviewer",
  "local_private_inference",
  "tool_calling",
  "structured_output",
]);
const DATA_CLASSES = new Set<ModelDataClass>(["PUBLIC", "PERSONAL", "PRIVATE", "SECRET"]);
const COST_RANK: Record<ModelCostClass, number> = { free: 0, low: 1, medium: 2, high: 3 };

function freezeRouting(metadata: ModelRoutingMetadata): ModelRoutingMetadata {
  return Object.freeze({
    ...metadata,
    capabilities: Object.freeze([...metadata.capabilities]),
    modalities: Object.freeze([...metadata.modalities]),
    permittedDataClasses: Object.freeze([...metadata.permittedDataClasses]),
    cost: Object.freeze({ ...metadata.cost }),
  });
}

function provider(entry: ProviderRegistryEntry): ProviderRegistryEntry {
  return Object.freeze({
    ...entry,
    env: Object.freeze([...entry.env]) as unknown as string[],
    routing: freezeRouting(entry.routing),
  });
}

export const MODEL_PROVIDER_REGISTRY: readonly ProviderRegistryEntry[] = Object.freeze([
  provider({
    family: "openai",
    provider: "OpenAI / ChatGPT / Codex",
    role: "engineering",
    roleLabel: "Engineering Reviewer",
    env: ["OPENAI_API_KEY"],
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
    environment: "Both",
    council: true,
    testable: true,
    routePreview: "Code plans, repository review, implementation checks.",
    routing: {
      capabilities: ["general_reasoning", "coding", "structured_planning", "summarization", "tool_calling", "structured_output"],
      reasoningSupport: "advanced",
      toolCalling: true,
      structuredOutput: true,
      contextWindowClass: "long",
      contextWindowTokens: 128_000,
      modalities: ["text", "image"],
      location: "external",
      permittedDataClasses: ["PUBLIC", "PERSONAL"],
      timeoutMs: 30_000,
      maxOutputTokens: 16_384,
      cost: { class: "low", inputUsdPerMillion: 0.15, outputUsdPerMillion: 0.60 },
      availability: "enabled",
      fallbackEligible: true,
      optionalReviewer: false,
    },
  }),
  provider({
    family: "anthropic",
    provider: "Anthropic / Claude",
    role: "architecture",
    roleLabel: "Architecture Reviewer",
    env: ["ANTHROPIC_API_KEY"],
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-haiku-4-5-20251001",
    environment: "Both",
    council: true,
    testable: true,
    routePreview: "Architecture, tradeoffs, long-form reasoning.",
    routing: {
      capabilities: ["general_reasoning", "architecture_review", "coding", "structured_planning", "summarization", "vision", "tool_calling", "structured_output"],
      reasoningSupport: "advanced",
      toolCalling: true,
      structuredOutput: true,
      contextWindowClass: "very_long",
      contextWindowTokens: 200_000,
      modalities: ["text", "image"],
      location: "external",
      permittedDataClasses: ["PUBLIC", "PERSONAL"],
      timeoutMs: 30_000,
      maxOutputTokens: 8_192,
      cost: { class: "medium", inputUsdPerMillion: 0.80, outputUsdPerMillion: 4.00 },
      availability: "enabled",
      fallbackEligible: true,
      optionalReviewer: false,
    },
  }),
  provider({
    family: "deepseek",
    provider: "DeepSeek",
    role: "challenger",
    roleLabel: "Independent Challenger",
    env: ["DEEPSEEK_API_KEY"],
    modelEnv: "DEEPSEEK_MODEL",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultModel: "deepseek-chat",
    environment: "Both",
    council: true,
    testable: true,
    routePreview: "Independent challenge, alternative reasoning, and dissent in whole-Council debates.",
    routing: {
      capabilities: ["general_reasoning", "coding", "structured_planning", "challenger_reviewer", "structured_output"],
      reasoningSupport: "advanced",
      toolCalling: false,
      structuredOutput: true,
      contextWindowClass: "long",
      contextWindowTokens: 64_000,
      modalities: ["text"],
      location: "external",
      permittedDataClasses: ["PUBLIC"],
      timeoutMs: 30_000,
      maxOutputTokens: 8_192,
      cost: { class: "low", inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.10 },
      availability: "enabled",
      fallbackEligible: false,
      optionalReviewer: true,
    },
  }),
  provider({
    family: "gemini",
    provider: "Google Gemini",
    role: "multimodal_strategy",
    roleLabel: "Strategy / Multimodal Reviewer",
    env: ["GEMINI_API_KEY"],
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-1.5-flash",
    environment: "Both",
    council: false,
    testable: false,
    routePreview: "Deferred future reviewer for PDFs, screenshots, visual context, and long documents.",
    routing: {
      capabilities: ["general_reasoning", "structured_planning", "summarization", "vision", "structured_output"],
      reasoningSupport: "standard",
      toolCalling: false,
      structuredOutput: true,
      contextWindowClass: "very_long",
      contextWindowTokens: 1_000_000,
      modalities: ["text", "image"],
      location: "external",
      permittedDataClasses: ["PUBLIC", "PERSONAL"],
      timeoutMs: 30_000,
      maxOutputTokens: 8_192,
      cost: { class: "low", inputUsdPerMillion: 0.075, outputUsdPerMillion: 0.30 },
      availability: "disabled",
      fallbackEligible: false,
      optionalReviewer: true,
    },
  }),
  provider({
    family: "ollama",
    provider: "Ollama / Qwen",
    role: "local_reviewer",
    roleLabel: "Local Private Reviewer",
    env: ["OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_MODEL_FAMILY"],
    modelEnv: "OLLAMA_MODEL",
    baseUrlEnv: "OLLAMA_BASE_URL",
    defaultModel: "qwen3:4b",
    environment: "Local",
    council: true,
    testable: false,
    routePreview: "Simple, low-cost, private local review through the worker.",
    routing: {
      capabilities: ["general_reasoning", "structured_planning", "summarization", "local_private_inference", "structured_output"],
      reasoningSupport: "standard",
      toolCalling: false,
      structuredOutput: true,
      contextWindowClass: "standard",
      contextWindowTokens: 32_768,
      modalities: ["text"],
      location: "local",
      permittedDataClasses: ["PUBLIC", "PERSONAL", "PRIVATE"],
      timeoutMs: 60_000,
      maxOutputTokens: 4_096,
      cost: { class: "free", inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      availability: "enabled",
      fallbackEligible: true,
      optionalReviewer: false,
    },
  }),
  provider({
    family: "groq",
    provider: "Groq",
    role: "fallback",
    roleLabel: "Existing Low-Cost Fallback",
    env: ["GROQ_API_KEY"],
    defaultModel: "llama-3.1-8b-instant",
    environment: "Both",
    council: false,
    testable: false,
    routePreview: "Preserved existing fallback behavior only.",
    routing: {
      capabilities: ["general_reasoning", "structured_planning", "summarization", "structured_output"],
      reasoningSupport: "standard",
      toolCalling: false,
      structuredOutput: true,
      contextWindowClass: "long",
      contextWindowTokens: 128_000,
      modalities: ["text"],
      location: "external",
      permittedDataClasses: ["PUBLIC", "PERSONAL", "PRIVATE"],
      timeoutMs: 30_000,
      maxOutputTokens: 8_192,
      cost: { class: "low", inputUsdPerMillion: 0.05, outputUsdPerMillion: 0.08 },
      availability: "enabled",
      fallbackEligible: true,
      optionalReviewer: false,
    },
  }),
]);

function frozenDecision(decision: Omit<ModelRouteDecision, "candidates" | "optionalReviewers" | "rejections" | "reasons"> & {
  candidates: ModelRouteCandidate[];
  optionalReviewers: ModelRouteCandidate[];
  rejections: ModelRouteRejection[];
  reasons: string[];
}): ModelRouteDecision {
  return Object.freeze({
    ...decision,
    candidates: Object.freeze(decision.candidates),
    optionalReviewers: Object.freeze(decision.optionalReviewers),
    rejections: Object.freeze(decision.rejections),
    reasons: Object.freeze(decision.reasons),
  });
}

function blocked(reason: string, rejections: ModelRouteRejection[] = []): ModelRouteDecision {
  return frozenDecision({
    status: "blocked",
    dataClass: null,
    candidates: [],
    optionalReviewers: [],
    rejections,
    reasons: [reason],
  });
}

function validNonNegative(value: number | undefined): boolean {
  return value === undefined || (Number.isFinite(value) && value >= 0);
}

export function validateModelProviderRegistry(
  registry: readonly ProviderRegistryEntry[],
): readonly string[] {
  const errors: string[] = [];
  const providerIds = registry.map((entry) => entry.family);
  if (new Set(providerIds).size !== providerIds.length) errors.push("duplicate_provider_id");
  if (registry.some((entry) => entry.role === "fallback" && !entry.routing.fallbackEligible)) {
    errors.push("fallback_role_not_eligible");
  }
  return Object.freeze(errors);
}

export function routeModelCandidates(request: ModelRouteRequest): ModelRouteDecision {
  const registry = MODEL_PROVIDER_REGISTRY;
  if (!DATA_CLASSES.has(request.dataClass as ModelDataClass)) return blocked("invalid_data_class");
  const dataClass = request.dataClass as ModelDataClass;
  const requiredCapabilities = request.requiredCapabilities ?? [];
  if (!Array.isArray(requiredCapabilities) || requiredCapabilities.some((capability) => !MODEL_CAPABILITIES.has(capability))) {
    return blocked("invalid_capability_requirement");
  }
  if (request.maxCostClass !== undefined
    && !Object.prototype.hasOwnProperty.call(COST_RANK, request.maxCostClass)) {
    return blocked("invalid_route_budget");
  }
  if (!validNonNegative(request.maxEstimatedCostUsd)
    || !validNonNegative(request.estimatedInputTokens)
    || !validNonNegative(request.requestedOutputTokens)
    || !validNonNegative(request.maxTimeoutMs)) {
    return blocked("invalid_route_budget");
  }
  if (request.maxEstimatedCostUsd !== undefined
    && (request.estimatedInputTokens === undefined || request.requestedOutputTokens === undefined)) {
    return blocked("budget_estimate_required");
  }

  const registryErrors = validateModelProviderRegistry(registry);
  if (registryErrors.length) return blocked(registryErrors[0]);
  const knownIds = new Set(registry.map((entry) => entry.family));
  const availability = request.availableProviders === undefined ? null : new Set(request.availableProviders);
  if (availability && [...availability].some((providerId) => !knownIds.has(providerId as ProviderFamily))) {
    return blocked("unknown_provider");
  }

  const candidates: ModelRouteCandidate[] = [];
  const optionalReviewers: ModelRouteCandidate[] = [];
  const rejections: ModelRouteRejection[] = [];
  const inputTokens = request.estimatedInputTokens ?? 0;
  const outputTokens = request.requestedOutputTokens ?? 0;

  for (const entry of registry) {
    const metadata = entry.routing;
    const reject = (reason: string) => rejections.push(Object.freeze({ providerId: entry.family, reason }));
    if (metadata.availability !== "enabled" || (availability && !availability.has(entry.family))) { reject("provider_unavailable"); continue; }
    if (!metadata.permittedDataClasses.includes(dataClass)) { reject("data_class_denied"); continue; }
    if (dataClass === "SECRET" && metadata.location === "external") { reject("secret_external_denied"); continue; }
    if (requiredCapabilities.some((capability) => !metadata.capabilities.includes(capability))) { reject("capability_unsupported"); continue; }
    if (inputTokens + outputTokens > metadata.contextWindowTokens) { reject("context_window_exceeded"); continue; }
    if (outputTokens > metadata.maxOutputTokens) { reject("output_limit_exceeded"); continue; }
    if (request.maxTimeoutMs !== undefined && metadata.timeoutMs > request.maxTimeoutMs) { reject("timeout_ineligible"); continue; }
    if (request.maxCostClass !== undefined && COST_RANK[metadata.cost.class] > COST_RANK[request.maxCostClass]) { reject("cost_class_ineligible"); continue; }
    const estimatedCostUsd = (inputTokens / 1_000_000) * metadata.cost.inputUsdPerMillion
      + (outputTokens / 1_000_000) * metadata.cost.outputUsdPerMillion;
    if (request.maxEstimatedCostUsd !== undefined && estimatedCostUsd > request.maxEstimatedCostUsd) { reject("budget_ineligible"); continue; }

    const routeRole: ModelRouteRole = metadata.optionalReviewer
      ? "optional_reviewer"
      : entry.role === "fallback" ? "fallback" : "primary";
    const candidate = Object.freeze({
      providerId: entry.family,
      modelId: selectedProviderModel(entry),
      routeRole,
      estimatedCostUsd,
      metadata,
    });
    if (routeRole === "optional_reviewer") {
      if (request.includeOptionalReviewers) optionalReviewers.push(candidate);
      else reject("optional_reviewer_not_requested");
    } else {
      candidates.push(candidate);
    }
  }

  return frozenDecision({
    status: candidates.length ? "eligible" : "blocked",
    dataClass,
    candidates,
    optionalReviewers,
    rejections,
    reasons: candidates.length ? [] : ["no_eligible_provider"],
  });
}

export function getModelProvider(providerId: string): ProviderRegistryEntry | undefined {
  return MODEL_PROVIDER_REGISTRY.find((entry) => entry.family === providerId);
}

export function providerComponent(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function selectedProviderModel(entry: ProviderRegistryEntry): string {
  if (!entry.modelEnv) return entry.defaultModel ?? "default";
  return process.env[entry.modelEnv]?.trim() || entry.defaultModel || "not selected";
}
