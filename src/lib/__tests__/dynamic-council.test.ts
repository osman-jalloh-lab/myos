import { describe, expect, it } from "vitest";
import { selectDynamicCouncil, synthesizeCouncil } from "@/lib/dynamic-council";

describe("dynamic Council", () => {
  it("selects software specialists and the DeepSeek challenger without seating every provider", () => {
    const selection = selectDynamicCouncil("Add a harmless UI enhancement to My OS");
    expect(selection.domain).toBe("software");
    expect(selection.specialists).toEqual(expect.arrayContaining(["Hermes", "Prometheus", "Codex"]));
    expect(selection.providerFamilies).toContain("deepseek");
    expect(selection.providerFamilies).not.toContain("ollama");
  });

  it("escalates material disagreement", () => {
    const synthesis = synthesizeCouncil([
      { family: "openai", provider: "OpenAI", roleLabel: "Engineering", model: "test", status: "answered", text: "Recommendation: use the existing seam. Concern: migration cost.", safeError: null, latencyMs: 1 },
      { family: "deepseek", provider: "DeepSeek", roleLabel: "Challenger", model: "test", status: "answered", text: "I disagree; instead keep the current implementation because of risk.", safeError: null, latencyMs: 1 },
    ]);
    expect(synthesis.disagreement).toBe("material");
    expect(synthesis.needsUserDecision).toBe(true);
  });
});
