import { describe, expect, it, vi, afterEach } from "vitest";
import {
  mergeContextFromMessage,
  resolveMessageWithContext,
  toolHealthFromEnvironment,
  type SessionContextState,
} from "@/lib/context-persistence";

function emptyState(): SessionContextState {
  return {
    activeIntent: null,
    rememberedEntities: {},
    toolHealth: [],
    recentFailures: [],
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("context persistence", () => {
  it("resolves flight price follow-ups from active travel context", () => {
    const state = mergeContextFromMessage(
      emptyState(),
      "looking for flights from Austin to Atlanta Aug 14-16"
    );

    const resolved = resolveMessageWithContext("show me prices", state);

    expect(state.activeIntent).toBe("active_travel_search");
    expect(state.rememberedEntities.travelSearch).toMatchObject({
      origin: "Austin",
      destination: "Atlanta",
      dateRange: "Aug 14-16",
    });
    expect(resolved.resolvedText).toContain("Austin to Atlanta");
    expect(resolved.resolvedText).toContain("Aug 14-16");
    expect(resolved.reason).toMatch(/flight follow-up/i);
  });

  it("marks web search unavailable when no search API key exists", () => {
    vi.stubEnv("FIRECRAWL_API_KEY", "");

    const webSearch = toolHealthFromEnvironment().find((tool) => tool.tool === "Web Search");

    expect(webSearch?.status).toBe("unavailable");
    expect(webSearch?.reason).toMatch(/FIRECRAWL_API_KEY/);
  });

  it("resolves build pronoun follow-ups from active build context", () => {
    const state = mergeContextFromMessage(emptyState(), "build a watch website");

    const resolved = resolveMessageWithContext("make it better", state);

    expect(state.activeIntent).toBe("active_build_project");
    expect(state.rememberedEntities.buildProject?.projectName).toBe("Watch Website");
    expect(resolved.resolvedText).toContain("Watch Website");
    expect(resolved.resolvedText).toContain("make it better");
    expect(resolved.reason).toMatch(/active build project/i);
  });
});
