import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBuilderProgressStep, canonicalBuilderStageLabel } from "../builder-stage-display";

describe("Builder Office canonical lifecycle display", () => {
  it.each([
    ["queued", "Queued"],
    ["researching", "Researching"],
    ["building", "Building"],
    ["qa_pending", "Preparing QA"],
    ["qa_running", "Running QA"],
    ["completed", "Completed"],
    ["failed", "Failed"],
  ] as const)("renders %s as %s", (stage, label) => {
    expect(canonicalBuilderStageLabel(stage)).toBe(label);
  });

  it("maps canonical stages to the five-step Builder progression", () => {
    expect(canonicalBuilderProgressStep("queued")).toBe(0);
    expect(canonicalBuilderProgressStep("researching")).toBe(1);
    expect(canonicalBuilderProgressStep("building")).toBe(2);
    expect(canonicalBuilderProgressStep("qa_pending")).toBe(3);
    expect(canonicalBuilderProgressStep("qa_running")).toBe(3);
    expect(canonicalBuilderProgressStep("completed")).toBe(4);
    expect(canonicalBuilderProgressStep("failed")).toBeNull();
  });

  it("uses the API canonical stage and retains provider-neutral Builder Office information", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/command-center/BuilderOffice.tsx"), "utf8");
    expect(source).toContain("canonicalStage: CanonicalBuilderStage");
    expect(source).toContain("canonicalBuilderStageLabel(project.canonicalStage)");
    expect(source).toContain("<BuilderProgress stage={canonicalStage} />");
    expect(source).toContain("Loading Builder projects...");
    expect(source).toContain("No Builder project yet.");
    expect(source).toContain("Open Preview");
    expect(source).toContain("Local QA checklist");
    expect(source).toContain("project?.buildError");
    expect(source).not.toMatch(/fugu|sakana/i);
  });
});
