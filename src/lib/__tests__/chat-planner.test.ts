import { describe, expect, it, vi } from "vitest";
import { classifyTask } from "@/lib/orchestration/classify-task";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), preview: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/orchestration/chat-planner", () => ({ createPlanPreview: mocks.preview }));
import { POST } from "@/app/api/orchestration/plan/route";

describe("read-only chat planner", () => {
  it("classifies deterministic request types and recommends safe future executors", () => {
    expect(classifyTask("Explain this project")).toMatchObject({ taskClass: "answer", primaryExecutor: "hermes", requiresApproval: false });
    expect(classifyTask("Research SEO options")).toMatchObject({ taskClass: "research", primaryExecutor: "claude" });
    expect(classifyTask("Create a plan for my website")).toMatchObject({ taskClass: "plan", primaryExecutor: "claude" });
    expect(classifyTask("Write an email")).toMatchObject({ taskClass: "write", requiresApproval: true });
    expect(classifyTask("Build a website")).toMatchObject({ taskClass: "code", primaryExecutor: "codex", requiresFinalValidation: true });
    expect(classifyTask("Review this architecture")).toMatchObject({ taskClass: "review", primaryExecutor: "claude", reviewers: ["deepseek"] });
  });
  it("rejects unauthenticated requests without invoking planning", async () => {
    mocks.auth.mockResolvedValue(null); mocks.preview.mockClear();
    const response = await POST(new Request("http://localhost/api/orchestration/plan", { method: "POST", body: JSON.stringify({ message: "Explain this" }) }));
    expect(response.status).toBe(401); expect(mocks.preview).not.toHaveBeenCalled();
  });
  it("derives user identity from the session and rejects SECRET input", async () => {
    mocks.auth.mockResolvedValue({ user: { id: "session-user" } }); mocks.preview.mockResolvedValue({ accepted: true, executionStatus: "not_started" });
    const response = await POST(new Request("http://localhost/api/orchestration/plan", { method: "POST", body: JSON.stringify({ message: "Explain this", userId: "attacker" }) }));
    expect(response.status).toBe(200); expect(mocks.preview).toHaveBeenCalledWith("session-user", expect.objectContaining({ message: "Explain this" }));
    const secret = await POST(new Request("http://localhost/api/orchestration/plan", { method: "POST", body: JSON.stringify({ message: "Explain this", dataClass: "SECRET" }) }));
    expect(secret.status).toBe(400);
  });
});
