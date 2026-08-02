import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBuilderProgressStep, canonicalBuilderStageGroup, canonicalBuilderStageLabel, canonicalBuilderStageMatchesFilter, canonicalBuilderStageOrder } from "../builder-stage-display";

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

  it("groups, filters, and orders Command Center projects from canonical stages", () => {
    expect(canonicalBuilderStageGroup("queued")).toBe("queued");
    expect(canonicalBuilderStageGroup("researching")).toBe("active");
    expect(canonicalBuilderStageGroup("building")).toBe("active");
    expect(canonicalBuilderStageGroup("qa_pending")).toBe("active");
    expect(canonicalBuilderStageGroup("qa_running")).toBe("active");
    expect(canonicalBuilderStageGroup("completed")).toBe("completed");
    expect(canonicalBuilderStageGroup("failed")).toBe("failed");
    expect(canonicalBuilderStageMatchesFilter("qa_pending", "qa")).toBe(true);
    expect(canonicalBuilderStageMatchesFilter("qa_running", "qa")).toBe(true);
    expect(canonicalBuilderStageMatchesFilter("qa_pending", "completed")).toBe(false);
    expect(canonicalBuilderStageOrder("queued")).toBeLessThan(canonicalBuilderStageOrder("building"));
    expect(canonicalBuilderStageOrder("building")).toBeLessThan(canonicalBuilderStageOrder("completed"));
  });

  it("uses the API canonical stage and retains provider-neutral Builder Office information", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/command-center/BuilderOffice.tsx"), "utf8");
    expect(source).toContain("canonicalStage: CanonicalBuilderStage");
    expect(source).toContain("canonicalBuilderStageLabel(project.canonicalStage)");
    expect(source).toContain("<BuilderProgress stage={canonicalStage} />");
    expect(source).toContain("Loading Builder projects...");
    expect(source).toContain("No Builder project yet.");
    expect(source).toContain("href={project.localDevUrl}");
    expect(source).toContain("Local QA checklist");
    expect(source).toContain("project?.buildError");
    expect(source).not.toMatch(/fugu|sakana/i);
  });

  it("keeps Command Center overview and project cards on canonical lifecycle state", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/command-center/CommandCenterClient.tsx"), "utf8");
    const projectPanel = source.slice(source.indexOf("function ProjectsPanel"), source.indexOf("function qaColor"));
    expect(source).toContain("canonicalBuilderStageGroup(project.canonicalStage)");
    expect(source).toContain("canonicalBuilderStageLabel(project.canonicalStage)");
    expect(projectPanel).toContain("canonicalBuilderStageMatchesFilter(project.canonicalStage, filter)");
    expect(projectPanel).toContain("canonicalBuilderStageOrder(left.canonicalStage)");
    expect(source).toContain("href={project.localDevUrl}");
    expect(projectPanel).toContain("p.buildError");
    expect(projectPanel).toContain("p.qaChecklist");
    expect(projectPanel).not.toMatch(/fugu|sakana/i);
  });
});
