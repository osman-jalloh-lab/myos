import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerInternalTools,
  sanitizeGitHubHeaderValue,
  sanitizeGitHubRepoInput,
} from "@/lib/hermes-execution/tools/internal-tools";
import { getTool } from "@/lib/hermes-execution/tool-registry";
import type { ToolContext } from "@/lib/hermes-execution/types";

const ctx: ToolContext = {
  userId: "user_1",
  source: "api",
  previousResults: {},
  env: { NODE_ENV: "test" },
};

beforeEach(() => {
  vi.clearAllMocks();
  registerInternalTools();
});

describe("internal.github.inspectRepo", () => {
  it("removes BOM and zero-width characters before inspecting a repo", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          full_name: "wshobson/agents",
          description: "Agentic plugin marketplace",
          language: "Python",
          default_branch: "main",
          stargazers_count: 1,
          forks_count: 2,
          open_issues_count: 3,
          topics: ["agents"],
          html_url: "https://github.com/wshobson/agents",
          homepage: null,
          license: { spdx_id: "MIT" },
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-06-25T00:00:00Z",
          size: 10,
          visibility: "public",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          encoding: "base64",
          content: Buffer.from("# Agents\n\nReference repo").toString("base64"),
        }),
      }) as unknown as typeof fetch;

    const tool = getTool("internal.github.inspectRepo");
    const result = await tool?.execute(
      { repoUrl: "\uFEFFhttps://github.com/wshobson/\u200Bagents" },
      ctx
    ) as { answer: string; artifacts: { title: string }[] };

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/wshobson/agents",
      expect.any(Object)
    );
    expect(result.answer).toContain("wshobson/agents");
    expect(result.artifacts[0].title).toBe("wshobson/agents");
  });

  it("removes hidden Unicode characters from the GitHub token header", async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          full_name: "wshobson/agents",
          description: null,
          language: null,
          default_branch: "main",
          stargazers_count: 0,
          forks_count: 0,
          open_issues_count: 0,
          topics: [],
          html_url: "https://github.com/wshobson/agents",
          homepage: null,
          license: null,
          created_at: "2026-01-01T00:00:00Z",
          updated_at: "2026-06-25T00:00:00Z",
          size: 10,
          visibility: "public",
        }),
      })
      .mockResolvedValueOnce({ ok: false }) as unknown as typeof fetch;

    const tool = getTool("internal.github.inspectRepo");
    await tool?.execute(
      { repoUrl: "https://github.com/wshobson/agents" },
      { ...ctx, env: { NODE_ENV: "test", GITHUB_TOKEN: "\uFEFFghp_test\u200B " } }
    );

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://api.github.com/repos/wshobson/agents",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer ghp_test",
        }),
      })
    );
  });

  it("returns a clear error for non-HTTPS GitHub URLs before fetch", async () => {
    global.fetch = vi.fn() as unknown as typeof fetch;

    const tool = getTool("internal.github.inspectRepo");
    const result = await tool?.execute(
      { repoUrl: "http://github.com/wshobson/agents" },
      ctx
    ) as { answer: string; artifacts: unknown[] };

    expect(fetch).not.toHaveBeenCalled();
    expect(result.answer).toContain("Invalid GitHub URL");
    expect(result.artifacts).toEqual([]);
  });
});

describe("sanitizeGitHubRepoInput", () => {
  it("trims whitespace and removes hidden Unicode characters", () => {
    expect(sanitizeGitHubRepoInput(" \uFEFFhttps://github.com/a/\u200Bb\u200C\u200D ")).toBe(
      "https://github.com/a/b"
    );
  });
});

describe("sanitizeGitHubHeaderValue", () => {
  it("trims whitespace and removes hidden Unicode characters", () => {
    expect(sanitizeGitHubHeaderValue(" \uFEFFghp_test\u200B\u200C\u200D ")).toBe("ghp_test");
  });
});

describe("internal.capabilities.answer", () => {
  it("registers the capability answer tool as read-only", () => {
    const tool = getTool("internal.capabilities.answer");
    expect(tool).toMatchObject({
      name: "internal.capabilities.answer",
      risk: "read",
      requiresApproval: false,
    });
  });
});

describe("internal.research.deepseek", () => {
  it("registers the direct DeepSeek tool as read-only and non-writing", () => {
    const tool = getTool("internal.research.deepseek");
    expect(tool).toMatchObject({
      name: "internal.research.deepseek",
      risk: "read",
      requiresApproval: false,
    });
  });
});

describe("internal.agent.handoff", () => {
  it("registers the agent handoff tool as an internal write", () => {
    const tool = getTool("internal.agent.handoff");
    expect(tool).toMatchObject({
      name: "internal.agent.handoff",
      risk: "internal_write",
      requiresApproval: false,
    });
  });
});
