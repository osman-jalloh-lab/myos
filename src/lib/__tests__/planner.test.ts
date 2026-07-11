import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { plan } from "@/lib/hermes-execution/planner";
import type { ExecutionRequest } from "@/lib/hermes-execution/types";

const originalGroqKey = process.env.GROQ_API_KEY;

function request(message: string): ExecutionRequest {
  return {
    userId: "user_1",
    message,
    source: "chat",
  };
}

function llmResponse(intent: string, confidence = 0.85): Response {
  return new Response(JSON.stringify({
    choices: [{
      message: {
        content: JSON.stringify({ intent, confidence, extractedUrl: null }),
      },
    }],
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("Hermes execution planner", () => {
  beforeEach(() => {
    process.env.GROQ_API_KEY = "test-groq-key";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(llmResponse("email_draft")));
  });

  afterEach(() => {
    if (originalGroqKey === undefined) {
      delete process.env.GROQ_API_KEY;
    } else {
      process.env.GROQ_API_KEY = originalGroqKey;
    }
    vi.unstubAllGlobals();
  });

  it.each([
    ["GitHub URL", "Inspect https://github.com/osman-jalloh-lab/myos", "github_repo_review"],
    ["npm run command", "npm run build", "run_command"],
    ["reminder", "remind me to submit the payroll form tomorrow", "task_create"],
    ["deployment status", "check deployment status", "deploy"],
    ["explicit deploy", "deploy the latest build", "deploy"],
  ])("plans %s with regex and 0 LLM calls", async (_label, message, expectedIntent) => {
    const fetchSpy = vi.mocked(fetch);

    const result = await plan(request(message));

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result.intent).toBe(expectedIntent);
    expect(result.confidence).toBeGreaterThanOrEqual(0.98);
  });

  it("keeps ambiguous messages on the LLM-first path", async () => {
    const fetchSpy = vi.mocked(fetch);

    const result = await plan(request("Can you help me with this reply?"));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(result.intent).toBe("email_draft");
    expect(result.confidence).toBe(0.85);
  });
});
