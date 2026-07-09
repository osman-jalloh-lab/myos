import { describe, expect, it } from "vitest";
import { MODEL_PROVIDER_REGISTRY } from "../model-provider-registry";

describe("model provider registry", () => {
  it("keeps each provider family unique", () => {
    const families = MODEL_PROVIDER_REGISTRY.map((entry) => entry.family);
    expect(new Set(families).size).toBe(families.length);
  });

  it("maps the council providers to their intended roles", () => {
    expect(MODEL_PROVIDER_REGISTRY.filter((entry) => entry.council).map((entry) => [entry.family, entry.role])).toEqual([
      ["openai", "engineering"],
      ["anthropic", "architecture"],
      ["ollama", "local_reviewer"],
    ]);
  });

  it("keeps DeepSeek and Gemini out of Council v1", () => {
    expect(MODEL_PROVIDER_REGISTRY.find((entry) => entry.family === "deepseek")).toMatchObject({ council: false });
    expect(MODEL_PROVIDER_REGISTRY.find((entry) => entry.family === "gemini")).toMatchObject({ council: false, testable: false });
  });

  it("keeps Groq as fallback instead of a voting council family", () => {
    const groq = MODEL_PROVIDER_REGISTRY.find((entry) => entry.family === "groq");
    expect(groq).toMatchObject({ role: "fallback", council: false });
  });

  it("marks Ollama as local-only and deferred for direct tests", () => {
    const ollama = MODEL_PROVIDER_REGISTRY.find((entry) => entry.family === "ollama");
    expect(ollama).toMatchObject({ environment: "Local", testable: false });
  });
});
