import { describe, expect, it, vi } from "vitest";
import {
  executeBuilderCoderWorkflow,
  parseBuilderBlockedQuestion,
  type BuilderCoderAttempt,
} from "@/lib/builder-coder-workflow";

describe("Builder coder workflow", () => {
  it("uses Codex CLI as the preferred coder when it is available", async () => {
    const runCoder = vi.fn(async (): Promise<BuilderCoderAttempt<string>> => ({ status: "completed", value: "built" }));
    const result = await executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Build a CRM dashboard",
      availableCoders: { codex_cli: true, hermes_agent: true },
      availableResearchers: { deepseek: true, claude: true, openai: true },
      runCoder,
      runResearch: vi.fn(),
    });
    expect(result).toMatchObject({ projectId: "project-1", coder: "codex_cli", value: "built", fallbackUsed: false, research: null });
    expect(runCoder).toHaveBeenCalledWith({ executor: "codex_cli", projectId: "project-1", request: "Build a CRM dashboard", researchFindings: null });
  });

  it("falls back to Hermes when Codex is unavailable", async () => {
    const runCoder = vi.fn(async (): Promise<BuilderCoderAttempt<string>> => ({ status: "completed", value: "fallback build" }));
    const result = await executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Build a CRM dashboard",
      availableCoders: { codex_cli: false, hermes_agent: true },
      availableResearchers: { deepseek: false, claude: false, openai: false },
      runCoder,
      runResearch: vi.fn(),
    });
    expect(result.coder).toBe("hermes_agent");
    expect(result.fallbackUsed).toBe(true);
    expect(runCoder).toHaveBeenCalledOnce();
  });

  it("falls back to Hermes when Codex fails", async () => {
    const runCoder = vi.fn().mockRejectedValueOnce(new Error("Codex unavailable")).mockResolvedValueOnce({ status: "completed", value: "fallback build" });
    const events: string[] = [];
    const result = await executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Build a CRM dashboard",
      availableCoders: { codex_cli: true, hermes_agent: true },
      availableResearchers: { deepseek: false, claude: false, openai: false },
      runCoder,
      runResearch: vi.fn(),
      onEvent: (event) => { events.push(event.type); },
    });
    expect(result.coder).toBe("hermes_agent");
    expect(result.fallbackUsed).toBe(true);
    expect(events).toContain("coder_failed");
    expect(events).toContain("fallback_started");
  });

  it("delegates a focused BLOCKED question to DeepSeek and continues the same project", async () => {
    const runCoder = vi.fn()
      .mockResolvedValueOnce({ status: "blocked", question: "Which activity fields best support a small roofing CRM dashboard?" })
      .mockResolvedValueOnce({ status: "completed", value: "continued build" });
    const runResearch = vi.fn(async () => "Use timestamp, actor, action, entity, status, and short detail fields.");
    const events: string[] = [];
    const result = await executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Add Recent Activity",
      availableCoders: { codex_cli: true, hermes_agent: true },
      availableResearchers: { deepseek: true, claude: true, openai: true },
      runCoder,
      runResearch,
      onEvent: (event) => { events.push(event.type); },
    });
    expect(result).toMatchObject({
      projectId: "project-1",
      coder: "codex_cli",
      value: "continued build",
      fallbackUsed: false,
      research: { executor: "deepseek", question: "Which activity fields best support a small roofing CRM dashboard?" },
    });
    expect(runResearch).toHaveBeenCalledWith({ executor: "deepseek", projectId: "project-1", question: "Which activity fields best support a small roofing CRM dashboard?" });
    expect(runCoder).toHaveBeenNthCalledWith(2, {
      executor: "codex_cli",
      projectId: "project-1",
      request: "Add Recent Activity",
      researchFindings: "Use timestamp, actor, action, entity, status, and short detail fields.",
    });
    expect(events).toEqual(expect.arrayContaining(["coder_started", "research_requested", "research_completed", "coding_resumed", "coder_completed"]));
  });

  it("uses Claude when DeepSeek research is unavailable", async () => {
    const runCoder = vi.fn().mockResolvedValueOnce({ status: "blocked", question: "What should this flow do?" }).mockResolvedValueOnce({ status: "completed", value: "done" });
    const runResearch = vi.fn(async () => "Actionable findings");
    const result = await executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Continue",
      availableCoders: { codex_cli: true, hermes_agent: true },
      availableResearchers: { deepseek: false, claude: true, openai: true },
      runCoder,
      runResearch,
    });
    expect(result.research?.executor).toBe("claude");
  });

  it("falls through from a failed DeepSeek call to Claude and resumes the same project", async () => {
    const runCoder = vi.fn()
      .mockResolvedValueOnce({ status: "blocked", question: "Which fields should the activity feed include?" })
      .mockResolvedValueOnce({ status: "completed", value: "built with Claude findings" });
    const runResearch = vi.fn()
      .mockRejectedValueOnce(new Error("DeepSeek timeout"))
      .mockResolvedValueOnce("Include actor, action, timestamp, entity, and status.");

    const result = await executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Add activity feed",
      availableCoders: { codex_cli: true, hermes_agent: true },
      availableResearchers: { deepseek: true, claude: true, openai: true },
      runCoder,
      runResearch,
    });

    expect(result.research).toEqual({ executor: "claude", question: "Which fields should the activity feed include?" });
    expect(runResearch).toHaveBeenNthCalledWith(1, { executor: "deepseek", projectId: "project-1", question: "Which fields should the activity feed include?" });
    expect(runResearch).toHaveBeenNthCalledWith(2, { executor: "claude", projectId: "project-1", question: "Which fields should the activity feed include?" });
    expect(runCoder).toHaveBeenNthCalledWith(2, {
      executor: "codex_cli",
      projectId: "project-1",
      request: "Add activity feed",
      researchFindings: "Include actor, action, timestamp, entity, and status.",
    });
  });

  it("awaits asynchronous progress events before resolving", async () => {
    const persisted: string[] = [];
    const result = await executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Build",
      availableCoders: { codex_cli: true, hermes_agent: false },
      availableResearchers: { deepseek: false, claude: false, openai: false },
      runCoder: async () => ({ status: "completed", value: "done" }),
      runResearch: vi.fn(),
      onEvent: async (event) => { await Promise.resolve(); persisted.push(event.type); },
    });
    expect(result.value).toBe("done");
    expect(persisted).toEqual(["coder_started", "coder_completed"]);
  });

  it("does not fall back and duplicate edits when completion telemetry fails", async () => {
    const runCoder = vi.fn(async (): Promise<BuilderCoderAttempt<string>> => ({ status: "completed", value: "changed once" }));
    await expect(executeBuilderCoderWorkflow({
      projectId: "project-1",
      request: "Build",
      availableCoders: { codex_cli: true, hermes_agent: true },
      availableResearchers: { deepseek: false, claude: false, openai: false },
      runCoder,
      runResearch: vi.fn(),
      onEvent: (event) => {
        if (event.type === "coder_completed") throw new Error("telemetry persistence unavailable");
      },
    })).rejects.toThrow("telemetry persistence unavailable");
    expect(runCoder).toHaveBeenCalledOnce();
    expect(runCoder).toHaveBeenCalledWith({ executor: "codex_cli", projectId: "project-1", request: "Build", researchFindings: null });
  });

  it("extracts only an explicit focused research marker", () => {
    expect(parseBuilderBlockedQuestion("I cannot continue.\nBUILDER_BLOCKED_RESEARCH: Which public API behavior should the implementation preserve?\n")).toBe("Which public API behavior should the implementation preserve?");
    expect(parseBuilderBlockedQuestion("A normal successful coder response.")).toBeNull();
  });
});
