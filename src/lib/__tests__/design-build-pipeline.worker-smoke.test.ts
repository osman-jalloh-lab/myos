import { describe, expect, it } from "vitest";
import { resolveProfileForAction, TOOL_PROFILES } from "@/lib/design-build-pipeline";

describe("design-build-pipeline runtime smoke", () => {
  it("research uses public web browsing and search", () => {
    const resolved = resolveProfileForAction("web research", "research");
    expect(resolved.profile).toBe("research");
    expect(resolved.tools).toEqual(TOOL_PROFILES.research);
    expect(resolved.tools).toContain("browser");
    expect(resolved.tools).toContain("web_search");
  });

  it("build cannot use browser or web_search", () => {
    const resolved = resolveProfileForAction("generate", "build");
    expect(resolved.profile).toBe("build");
    expect(resolved.tools).toEqual(TOOL_PROFILES.build);
    expect(resolved.tools).not.toContain("browser");
    expect(resolved.tools).not.toContain("web_search");
  });

  it("local QA rejects browser by policy and keeps vision", () => {
    const resolved = resolveProfileForAction("browser qa", "local_qa");
    expect(resolved.profile).toBe("qa");
    expect(resolved.tools).not.toContain("browser");
    expect(resolved.tools).toContain("vision");
    expect(resolved.tools).toContain("terminal");
    expect(resolved.tools).toContain("file");
  });

  it("visual review grants vision but not browser", () => {
    const resolved = resolveProfileForAction("screenshot review", "visual_review");
    expect(resolved.profile).toBe("visual_review");
    expect(resolved.tools).toContain("vision");
    expect(resolved.tools).not.toContain("browser");
  });

  it("unknown profile falls back to build", () => {
    const resolved = resolveProfileForAction("unknown action", "rogue_profile");
    expect(resolved.profile).toBe("build");
    expect(resolved.tools).toEqual(TOOL_PROFILES.build);
  });
});
