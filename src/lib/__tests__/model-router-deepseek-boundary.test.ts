import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: { modelUsage: { create: vi.fn() } },
}));

import { pickProvider, PROVIDER_FALLBACK } from "@/lib/modelRouter";

const originalOllamaBaseUrl = process.env.OLLAMA_BASE_URL;

afterEach(() => {
  if (originalOllamaBaseUrl === undefined) delete process.env.OLLAMA_BASE_URL;
  else process.env.OLLAMA_BASE_URL = originalOllamaBaseUrl;
});

describe("modelRouter DeepSeek boundary", () => {
  it("does not include DeepSeek in the normal provider fallback list", () => {
    expect(PROVIDER_FALLBACK).toEqual(["groq", "openai", "anthropic", "ollama"]);
    expect(PROVIDER_FALLBACK).not.toContain("deepseek");
  });

  it("keeps PRIVATE routing on Groq or Ollama", () => {
    delete process.env.OLLAMA_BASE_URL;
    expect(pickProvider("chat", "PRIVATE")).toBe("groq");

    process.env.OLLAMA_BASE_URL = "http://ollama.test";
    expect(pickProvider("chat", "PRIVATE")).toBe("ollama");
  });
});
