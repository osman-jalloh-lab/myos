import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  modelUsageCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    modelUsage: {
      create: mocks.modelUsageCreate,
    },
  },
}));

type EnvSnapshot = Pick<NodeJS.ProcessEnv, "OPENAI_API_KEY" | "GROQ_API_KEY" | "OLLAMA_BASE_URL" | "MODEL_ROUTER_DEFAULT_PROVIDER">;

const originalEnv: EnvSnapshot = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  OLLAMA_BASE_URL: process.env.OLLAMA_BASE_URL,
  MODEL_ROUTER_DEFAULT_PROVIDER: process.env.MODEL_ROUTER_DEFAULT_PROVIDER,
};

function restoreEnv(): void {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key as keyof EnvSnapshot];
    } else {
      process.env[key as keyof EnvSnapshot] = value;
    }
  }
}

function groqResponse(text: string): Response {
  return new Response(JSON.stringify({
    choices: [{ message: { content: text } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function ollamaResponse(text: string): Response {
  return new Response(JSON.stringify({ message: { content: text } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("model router provider timeouts", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    mocks.modelUsageCreate.mockReset();
    mocks.modelUsageCreate.mockResolvedValue({});
    process.env.OPENAI_API_KEY = "test-openai";
    process.env.GROQ_API_KEY = "test-groq";
    process.env.OLLAMA_BASE_URL = "http://ollama.test";
    delete process.env.MODEL_ROUTER_DEFAULT_PROVIDER;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    restoreEnv();
  });

  it("falls back to Ollama when a hosted provider aborts within its timeout budget", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchSpy = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("aborted"), { name: "AbortError" }))
      .mockResolvedValueOnce(ollamaResponse("local fallback"));
    vi.stubGlobal("fetch", fetchSpy);

    const { callModel } = await import("@/lib/modelRouter");
    const result = await callModel({
      userId: "user_1",
      taskType: "chat-agent-athena",
      dataClass: "PERSONAL",
      systemPrompt: "system",
      userPrompt: "user",
      providerOverride: "openai",
    });

    expect(result).toEqual({ text: "local fallback", provider: "ollama" });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(timeoutSpy).toHaveBeenNthCalledWith(1, 30_000);
    expect(timeoutSpy).toHaveBeenNthCalledWith(2, 60_000);
    expect(mocks.modelUsageCreate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ provider: "ollama" }),
    }));
  });

  it("uses the tight memory-extraction timeout for hosted providers", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(groqResponse("[]")));

    const { callModel } = await import("@/lib/modelRouter");
    const result = await callModel({
      taskType: "memory-extraction",
      dataClass: "PERSONAL",
      systemPrompt: "extract facts",
      userPrompt: "remember this",
      providerOverride: "groq",
    });

    expect(result).toEqual({ text: "[]", provider: "groq" });
    expect(timeoutSpy).toHaveBeenCalledWith(5_000);
  });
});
