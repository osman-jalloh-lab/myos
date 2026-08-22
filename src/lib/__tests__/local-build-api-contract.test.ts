import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseLocalBuildRequest, serializeLocalBuildProject, type LocalBuildProject } from "../local-builder";

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
  it("recognizes the production CRM dashboard smoke request as build intent", () => {
    expect(parseLocalBuildRequest("Build me a small CRM dashboard for a roofing company. Include leads, customers, jobs, estimates, and a dashboard. Use a modern responsive interface.")).toMatchObject({
      projectName: "small CRM dashboard",
      appType: "dashboard app",
      questions: [],
    });
  });

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

  it("routes production Codex tasks through the Builder coder workflow", () => {
    const source = readFileSync(path.join(process.cwd(), "scripts/hermes-local-worker.ts"), "utf8");
    expect(source).toMatch(/import\s+\{[^}]*executeBuilderCoderWorkflow[^}]*\}\s+from\s+["']\.\.\/src\/lib\/builder-coder-workflow["']/);
    expect(source).toMatch(/ALLOWED_ACTIONS\s*=\s*new Set\([^\n]*["']runCodex["']/);
    expect(source).toMatch(/if\s*\(task\.assignedExecutor\s*===\s*["']codex_cli["']\)\s*\{\s*await executeCodexWorkflowTask\(db, task\)/);
    expect(source).toMatch(/executeBuilderCoderWorkflow\s*\(/);
    expect(source).toMatch(/startPreviewAndRunBrowserQa\s*\(/);
    expect(source).toContain("preview.qaStatus !== \"qa_passed\"");
    expect(source).toContain("preview.previewStatus !== \"online\"");
    expect(source).toContain("prepareLocalBuildProject(task.userId, message, task.projectId)");
    expect(source).toMatch(/await heartbeat\(db, capabilities, apiBaseUrl\)\.catch/);
    const builderSource = readFileSync(path.join(process.cwd(), "src/lib/local-builder.ts"), "utf8");
    const runtimeSource = readFileSync(path.join(process.cwd(), "src/lib/builder-sandbox-runtime.ts"), "utf8");
    expect(builderSource).toContain('runBuilderDockerCommand(');
    expect(builderSource).toContain("createDockerBuilderSandboxRuntime");
    expect(runtimeSource).toContain('"node:22-bookworm-slim"');
    expect(runtimeSource).toContain('"--cap-drop", "ALL"');
    expect(runtimeSource).toContain('"--security-opt", "no-new-privileges"');
    expect(runtimeSource).toContain('`127.0.0.1:${params.hostPort}:3000`');
    expect(builderSource).not.toContain('spawn(localNextExecutable');
    expect(source).toContain('runBuilderDockerCommand(folder, task.projectId!');
    expect(source).not.toContain('function runNpm(');
    expect(source).not.toContain('function runNext(');
    expect(builderSource).toContain('["src/app/page.tsx", "app/page.tsx"]');
  });

  it("keeps current project serialization canonical and free of retired fields", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/command-center/projects/route.ts"), "utf8");
    expect(source).toContain("withCanonicalBuilderStage");
    expect(source).not.toMatch(/fugu|sakana|designReview|polishReview|designScore/i);
  });
});
