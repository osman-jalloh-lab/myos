import { describe, expect, it } from "vitest";
import { formatExecutionResponseForUser, userSafeFailureMessage } from "@/lib/hermes-execution/response-formatter";

describe("response formatter", () => {
  it("turns hidden-character ByteString errors into plain English", () => {
    expect(userSafeFailureMessage("Execution failed at step \"internal.github.inspectRepo\": Cannot convert argument to a ByteString because the character at index 7 has a value of 65279"))
      .toBe("I could not complete that request because the input contained a hidden character. I can retry it with the cleaned value.");
  });

  it("redacts internal tool names, local paths, ids, and metadata from public responses", () => {
    const formatted = formatExecutionResponseForUser({
      status: "failed",
      answer: "Execution failed at step \"internal.github.inspectRepo\": C:\\Users\\osman\\repo failed",
      plan: {
        intent: "github_repo_review",
        confidence: 1,
        steps: [{ id: "step_1", tool: "internal.github.inspectRepo", input: { repoUrl: "x" }, risk: "read", requiresApproval: false }],
      },
      toolCalls: [{
        id: "step_1",
        tool: "internal.github.inspectRepo",
        status: "failed",
        error: "internal.github.inspectRepo failed",
      }],
      artifacts: [{
        type: "text",
        title: "Debug",
        id: "0b8cbd49-1111-2222-3333-ae2c348bcb47",
        content: "{\"status\":\"failed\",\"tool\":\"internal.github.inspectRepo\"}",
        metadata: { projectId: "0b8cbd49-1111-2222-3333-ae2c348bcb47" },
      }],
    });

    expect(formatted.answer).not.toContain("internal.github.inspectRepo");
    expect(formatted.answer).not.toContain("C:\\Users");
    expect(formatted.toolCalls[0].tool).toBe("internal");
    expect(formatted.artifacts[0].metadata).toBeUndefined();
    expect(formatted.plan?.steps[0].input).toEqual({});
  });
});
