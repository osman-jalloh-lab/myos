import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MODEL_PROVIDER_REGISTRY,
  routeModelCandidates,
  validateModelProviderRegistry,
  type ModelCapability,
} from "@/lib/model-provider-registry";
import { pickProvider, PROVIDER_FALLBACK } from "@/lib/modelRouter";

const originalEnv = {
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  MODEL_ROUTER_DEFAULT_PROVIDER: process.env.MODEL_ROUTER_DEFAULT_PROVIDER,
};

function restoreEnv(): void {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  restoreEnv();
});

describe("provider-neutral model routing", () => {
  it("preserves legacy router choices and provider order", () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "configured");
    vi.stubEnv("OPENAI_API_KEY", "configured");
    delete process.env.OLLAMA_BASE_URL;
    delete process.env.MODEL_ROUTER_DEFAULT_PROVIDER;

    expect(pickProvider("chat-jobs", "PERSONAL")).toBe("openai");
    expect(pickProvider("daily-brief", "PERSONAL")).toBe("anthropic");
    expect(pickProvider("ordinary", "PUBLIC")).toBe("groq");
    expect(PROVIDER_FALLBACK).toEqual(["groq", "openai", "anthropic", "ollama"]);
    expect(MODEL_PROVIDER_REGISTRY.map((entry) => entry.family)).toEqual([
      "openai",
      "anthropic",
      "deepseek",
      "gemini",
      "ollama",
      "groq",
    ]);
  });

  it("routes deterministically by normalized capability without changing legacy order", () => {
    const decision = routeModelCandidates({
      dataClass: "PUBLIC",
      requiredCapabilities: ["general_reasoning"],
      availableProviders: ["openai", "anthropic", "groq"],
    });

    expect(decision.status).toBe("eligible");
    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual([
      "openai",
      "anthropic",
      "groq",
    ]);
    expect(decision.optionalReviewers).toEqual([]);
  });
});


describe("model routing policy gates", () => {
  it("excludes disabled and unavailable providers", () => {
    const unavailable = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["gemini"],
      requiredCapabilities: ["vision"],
    });

    expect(unavailable.status).toBe("blocked");
    expect(unavailable.rejections).toContainEqual({ providerId: "gemini", reason: "provider_unavailable" });
  });

  it("excludes providers that lack every required capability", () => {
    const decision = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["groq"],
      requiredCapabilities: ["vision"],
    });

    expect(decision.status).toBe("blocked");
    expect(decision.rejections).toContainEqual({ providerId: "groq", reason: "capability_unsupported" });
  });

  it("fails closed for SECRET, missing, and malformed classifications", () => {
    const secret = routeModelCandidates({
      dataClass: "SECRET",
      availableProviders: ["openai", "anthropic", "deepseek", "groq"],
    });
    const missing = routeModelCandidates({ dataClass: undefined });
    const malformed = routeModelCandidates({ dataClass: "private" });

    expect(secret.status).toBe("blocked");
    expect(secret.candidates).toEqual([]);
    expect(secret.rejections.every((item) => item.reason === "data_class_denied" || item.reason === "provider_unavailable" || item.reason === "optional_reviewer_not_requested")).toBe(true);
    expect(missing.reasons).toEqual(["invalid_data_class"]);
    expect(malformed.reasons).toEqual(["invalid_data_class"]);
  });

  it("allows an explicitly available local provider for PRIVATE data", () => {
    const decision = routeModelCandidates({
      dataClass: "PRIVATE",
      availableProviders: ["ollama"],
      requiredCapabilities: ["local_private_inference"],
    });

    expect(decision.candidates.map((candidate) => candidate.providerId)).toEqual(["ollama"]);
    expect(decision.candidates[0].metadata.location).toBe("local");
  });

  it("excludes candidates outside cost and timeout budgets", () => {
    const overBudget = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["openai"],
      estimatedInputTokens: 100_000,
      requestedOutputTokens: 10_000,
      maxEstimatedCostUsd: 0.01,
    });
    const tooSlow = routeModelCandidates({
      dataClass: "PRIVATE",
      availableProviders: ["ollama"],
      maxTimeoutMs: 30_000,
    });
    const combinedContextOverflow = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["openai"],
      estimatedInputTokens: 120_000,
      requestedOutputTokens: 10_000,
    });

    expect(overBudget.rejections).toContainEqual({ providerId: "openai", reason: "budget_ineligible" });
    expect(tooSlow.rejections).toContainEqual({ providerId: "ollama", reason: "timeout_ineligible" });
    expect(combinedContextOverflow.rejections).toContainEqual({
      providerId: "openai",
      reason: "context_window_exceeded",
    });
  });

  it("keeps primary and fallback candidates in deterministic registry order", () => {
    const decision = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["anthropic", "ollama", "groq"],
      requiredCapabilities: ["summarization"],
    });

    expect(decision.candidates.map((candidate) => [candidate.providerId, candidate.routeRole])).toEqual([
      ["anthropic", "primary"],
      ["ollama", "primary"],
      ["groq", "fallback"],
    ]);
  });

  it("never lets a fallback bypass classification policy", () => {
    const privateDecision = routeModelCandidates({
      dataClass: "PRIVATE",
      availableProviders: ["openai", "groq"],
      requiredCapabilities: ["summarization"],
    });
    const secretDecision = routeModelCandidates({
      dataClass: "SECRET",
      availableProviders: ["groq"],
    });

    expect(privateDecision.candidates.map((candidate) => candidate.providerId)).toEqual(["groq"]);
    expect(privateDecision.rejections).toContainEqual({ providerId: "openai", reason: "data_class_denied" });
    expect(secretDecision.status).toBe("blocked");
  });

  it("keeps challenger and reviewer providers optional", () => {
    const defaultDecision = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["deepseek"],
      requiredCapabilities: ["challenger_reviewer"],
    });
    const reviewDecision = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["deepseek"],
      requiredCapabilities: ["challenger_reviewer"],
      includeOptionalReviewers: true,
    });

    expect(defaultDecision.status).toBe("blocked");
    expect(defaultDecision.candidates).toEqual([]);
    expect(reviewDecision.status).toBe("blocked");
    expect(reviewDecision.candidates).toEqual([]);
    expect(reviewDecision.optionalReviewers.map((candidate) => candidate.providerId)).toEqual(["deepseek"]);
    expect(reviewDecision.reasons).toEqual(["no_eligible_provider"]);
  });

  it("freezes metadata and never carries execution authority", () => {
    const entry = MODEL_PROVIDER_REGISTRY[0];
    expect(Object.isFrozen(MODEL_PROVIDER_REGISTRY)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.routing)).toBe(true);
    expect(Object.isFrozen(entry.routing.capabilities)).toBe(true);
    expect(entry.routing).not.toHaveProperty("execute");
    expect(() => (entry.routing.capabilities as ModelCapability[]).push("vision")).toThrow();
    expect(entry.routing.capabilities).not.toContain("vision");
  });

  it("fails closed for malformed cost policy instead of bypassing the budget gate", () => {
    const decision = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["openai"],
      maxCostClass: "unknown" as never,
    });

    expect(decision.status).toBe("blocked");
    expect(decision.reasons).toEqual(["invalid_route_budget"]);
  });

  it("fails safely for unknown and duplicate provider IDs", () => {
    const unknown = routeModelCandidates({
      dataClass: "PUBLIC",
      availableProviders: ["unknown-provider"],
    });
    const duplicate = validateModelProviderRegistry([
      MODEL_PROVIDER_REGISTRY[0],
      MODEL_PROVIDER_REGISTRY[0],
    ]);
    const fallbackMismatch = validateModelProviderRegistry(MODEL_PROVIDER_REGISTRY.map((entry) =>
      entry.family === "groq"
        ? { ...entry, routing: { ...entry.routing, fallbackEligible: false } }
        : entry));

    expect(unknown.reasons).toEqual(["unknown_provider"]);
    expect(duplicate).toEqual(["duplicate_provider_id"]);
    expect(fallbackMismatch).toContain("fallback_role_not_eligible");
  });
});

describe("legacy model router security compatibility", () => {
  it("rejects missing or malformed classification before provider selection", () => {
    expect(() => pickProvider("chat", undefined as never)).toThrow(/classification/i);
    expect(() => pickProvider("chat", "private" as never)).toThrow(/classification/i);
  });

  it("rejects SECRET even when an external provider override is supplied", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { callModel } = await import("@/lib/modelRouter");

    await expect(callModel({
      taskType: "chat",
      dataClass: "SECRET",
      systemPrompt: "system",
      userPrompt: "secret",
      providerOverride: "openai",
    })).rejects.toThrow(/SECRET data must never reach an LLM/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});


describe("legacy streaming router classification gate", () => {
  it("rejects SECRET before a streaming override can execute", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { callModelStream } = await import("@/lib/modelRouter");
    const stream = callModelStream({
      taskType: "chat",
      dataClass: "SECRET",
      systemPrompt: "system",
      userPrompt: "secret",
      providerOverride: "anthropic",
    });

    await expect(stream.next()).rejects.toThrow(/SECRET data must never reach an LLM/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
