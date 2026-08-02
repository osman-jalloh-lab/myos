import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { serializeLocalBuildProject, type LocalBuildProject } from "../local-builder";

const project: LocalBuildProject = {
  id: "project-1",
  projectName: "Legacy project",
  localFolderPath: "C:/projects/legacy-project",
  status: "Building",
  createdAt: "2026-08-01T00:00:00.000Z",
  currentTask: "Build app",
  taskId: "task-1",
  buildLog: "legacy log",
  buildError: null,
  localDevUrl: null,
  localDevPid: null,
  researchBrief: "brief",
  qaStatus: null,
  qaChecklist: null,
};

describe("local Builder API contract", () => {
  it("serializes current records with a canonical stage without mutation", () => {
    const before = JSON.stringify(project);
    const serialized = serializeLocalBuildProject(project) as Record<string, unknown>;
    expect(serialized.canonicalStage).toBe("building");
    expect(JSON.stringify(project)).toBe(before);
  });

  it("keeps only provider-neutral local-build actions and rejects obsolete actions", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/command-center/local-builds/route.ts"), "utf8");
    expect(source).toContain("SUPPORTED_LOCAL_BUILD_ACTIONS");
    expect(source).toContain("Unsupported local builder action.");
    expect(source).toContain('"runQa"');
    expect(source).not.toMatch(/runLocalFugu|overrideFugu|fuguDesignReview|fuguGateOverride|fuguGate/);
  });

  it("keeps current project serialization canonical and free of retired fields", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/command-center/projects/route.ts"), "utf8");
    expect(source).toContain("withCanonicalBuilderStage");
    expect(source).not.toMatch(/fugu|sakana|designReview|polishReview|designScore/i);
  });
});
