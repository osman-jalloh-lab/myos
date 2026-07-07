import { describe, expect, it } from "vitest";
import { parseHermesChatOutput, sanitizeHermesOutput } from "@/lib/hermes-nous-cli";

describe("Hermes Nous CLI output helpers", () => {
  it("extracts the native session id and keeps only the visible reply", () => {
    const parsed = parseHermesChatOutput("Hello from Nous\n\nsession_id: 20260707_155331_4d7f30\n");

    expect(parsed).toEqual({
      reply: "Hello from Nous",
      sessionId: "20260707_155331_4d7f30",
    });
  });

  it("removes resume notices from quiet chat output", () => {
    const parsed = parseHermesChatOutput("Same session reply\nResumed session 20260707_155331_4d7f30 (1 user message)\nsession_id: 20260707_155331_4d7f30");

    expect(parsed.reply).toBe("Same session reply");
    expect(parsed.sessionId).toBe("20260707_155331_4d7f30");
  });

  it("redacts credential-shaped output before it can be logged", () => {
    const sanitized = sanitizeHermesOutput("Bearer abc.def.ghi\nOPENAI_API_KEY=sk-test\nnormal");

    expect(sanitized).toContain("Bearer [redacted]");
    expect(sanitized).toContain("OPENAI_API_KEY=[redacted]");
    expect(sanitized).toContain("normal");
    expect(sanitized).not.toContain("abc.def.ghi");
    expect(sanitized).not.toContain("sk-test");
  });
});
