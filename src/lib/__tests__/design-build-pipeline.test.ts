import { describe, expect, it } from "vitest";
import {
  resolveResearchToolProfile,
  resolveBuildToolProfile,
  resolveQaToolProfile,
  validateStageTransition,
  validateArtifactPathing,
  browserQaPassed,
  normalizeBrowserPolicyHost,
  type BuildArtifacts,
} from "../design-build-pipeline";

describe("design-build-pipeline tool profiles", () => {
  it("returns research stage and tools", () => {
    expect(resolveResearchToolProfile()).toEqual({
      stage: "stage_1_research",
      tools: ["web_search", "browser", "vision", "file"],
    });
  });

  it("returns build stage and tools", () => {
    expect(resolveBuildToolProfile()).toEqual({
      stage: "stage_2_build",
      tools: ["terminal", "file"],
    });
  });

  it("returns QA stage and tools", () => {
    expect(resolveQaToolProfile()).toEqual({
      stage: "stage_3_qa",
      tools: ["browser", "vision", "terminal", "file"],
    });
  });
});

describe("design-build-pipeline policy enforcement", () => {
  it("blocks research output outside approved artifacts", () => {
    expect(() => validateArtifactPathing("/research/output", "research")).toThrow(/DESIGN_RESEARCH\.md/);
  });

  it("requires screenshot artifact fields for qa", () => {
    const artifact = {
      desktopScreenshotPath: "",
      mobileScreenshotPath: undefined,
    } satisfies Partial<BuildArtifacts>;

    expect(() => validateArtifactPathing(JSON.stringify(artifact), "qa")).toThrow(
      /desktopScreenshotPath|mobileScreenshotPath/
    );
  });

  it("rejects non-localhost browser policy hosts", () => {
    expect(() => normalizeBrowserPolicyHost("https://example.com")).toThrow(
      /Browser QA policy rejected non-localhost origin/
    );
  });

  it("allows localhost browser policy hosts", () => {
    expect(normalizeBrowserPolicyHost("http://localhost:3000")).toEqual("localhost:3000");
    expect(normalizeBrowserPolicyHost("http://127.0.0.1:4000")).toEqual("127.0.0.1:4000");
  });
});

describe("design-build-pipeline browser checks and state transitions", () => {
  it("browserQaPassed returns false when a check failed", () => {
    expect(
      browserQaPassed([{ key: "a", label: "A", status: "failed", detail: "x" }])
    ).toBe(false);
  });

  it("validates stage transitions", () => {
    expect(() => validateStageTransition("complete", "stage_1_research")).toThrow(/Cannot transition from complete/);
    expect(() => validateStageTransition("stage_1_research", "stage_3_qa")).toThrow(
      /Builder QA requires completed build stage/
    );
  });
});
