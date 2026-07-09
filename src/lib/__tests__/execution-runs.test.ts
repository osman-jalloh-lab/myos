import { describe, expect, it } from "vitest";
import { redactExecutionText } from "@/lib/execution-runs";

describe("execution run trace redaction", () => {
  it("redacts bearer tokens, API keys, connection strings, and env filenames", () => {
    const redacted = redactExecutionText(`
      Authorization: Bearer abc.def.ghi
      OPENAI_API_KEY=sk-live-should-not-appear-1234567890
      DATABASE_URL=postgres://user:password@example.com/db
      loaded .env.local
    `);

    expect(redacted).toContain("Authorization=[redacted]");
    expect(redacted).toContain("OPENAI_API_KEY=[redacted]");
    expect(redacted).toContain("[redacted-connection-string]");
    expect(redacted).toContain("[env-file]");
    expect(redacted).not.toContain("sk-live-should-not-appear");
    expect(redacted).not.toContain("postgres://user");
    expect(redacted).not.toContain(".env.local");
  });

  it("truncates large trace payloads", () => {
    expect(redactExecutionText("x".repeat(500), 100)).toHaveLength(100);
  });
});
