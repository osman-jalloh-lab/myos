import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    agentRun: { create: vi.fn().mockResolvedValue({}) },
    memory: { create: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock("@/lib/approvals", () => ({
  createApproval: vi.fn(async (_userId: string, actionType: string, payload: Record<string, unknown>) => ({
    id: `approval-${String(payload.candidateName).toLowerCase()}`,
    actionType,
    payload,
    status: "pending",
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  })),
}));

import { createApproval } from "@/lib/approvals";
import { runSkillScout } from "@/lib/skill-scout/github";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("runSkillScout", () => {
  it("finds high-value candidates and creates approval requests without importing files", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          full_name: "wshobson/agents",
          description: "Agent resources",
          default_branch: "main",
          stargazers_count: 100,
          language: "Markdown",
          topics: ["agents"],
          html_url: "https://github.com/wshobson/agents",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          truncated: false,
          tree: [
            { path: "plugins/ui-design/skills/design-system-patterns/SKILL.md", type: "blob" },
            { path: "plugins/ui-design/skills/accessibility-compliance/SKILL.md", type: "blob" },
            { path: "plugins/frontend-mobile-development/skills/nextjs-app-router-patterns/SKILL.md", type: "blob" },
            { path: "package-lock.json", type: "blob" },
            { path: ".env.example", type: "blob" },
          ],
        }),
      }) as unknown as typeof fetch;

    const result = await runSkillScout("user_1", "\uFEFFhttps://github.com/wshobson/agents ");

    expect(result.repo.fullName).toBe("wshobson/agents");
    expect(result.inspected.scriptsRun).toBe(false);
    expect(result.inspected.filesImported).toBe(false);
    expect(result.candidates.map((candidate) => candidate.name)).toEqual(
      expect.arrayContaining(["design-system-patterns", "accessibility-compliance"])
    );
    expect(result.candidates.some((candidate) => candidate.sourcePath === "package-lock.json")).toBe(false);
    expect(result.candidates.some((candidate) => candidate.sourcePath === ".env.example")).toBe(false);
    expect(createApproval).toHaveBeenCalledWith(
      "user_1",
      "skill_scout_import",
      expect.objectContaining({
        sourceRepo: "wshobson/agents",
        safety: expect.arrayContaining(["Do not run external repo scripts."]),
      })
    );
    expect(result.approvals.length).toBeGreaterThan(0);
  });

  it("rejects non-GitHub URLs before calling GitHub", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;

    await expect(runSkillScout("user_1", "https://example.com/repo")).rejects.toThrow("github.com");

    expect(fetch).not.toHaveBeenCalled();
  });
});
