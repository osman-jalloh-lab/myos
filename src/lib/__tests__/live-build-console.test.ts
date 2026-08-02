import { describe, expect, it } from "vitest";
import { canonicalBuilderStageLabel } from "../builder-stage-display";
import type { CanonicalBuilderStage } from "../builder-lifecycle";
import { buildStatusMeaning, canonicalLiveBuildTimeline, extractBuildFiles, inferAppType, latestCanonicalBuilderStage, redactBuildText, shouldPollLiveBuild } from "../live-build-console";

describe("live build console helpers", () => {
  it("classifies a watch website without inventing a marketplace", () => expect(inferAppType("Build a watch website called ChronoTest")).toBe("watch website"));
  it("extracts generated app files", () => expect(extractBuildFiles("Files created: package.json, src/app/page.tsx, src/app/layout.tsx")).toEqual(["package.json", "src/app/page.tsx", "src/app/layout.tsx"]));
  it("redacts credential-shaped log values", () => expect(redactBuildText("GITHUB_TOKEN=secret-value")).toBe("GITHUB_TOKEN=[redacted]"));
  it("uses plain status language", () => expect(buildStatusMeaning("Building", "local_worker", "npm run build", false)).toBe("Running build check"));

  it("renders every canonical stage with the live-build label contract", () => {
    const expected: Record<CanonicalBuilderStage, string> = {
      queued: "Queued",
      researching: "Researching",
      building: "Building",
      qa_pending: "Preparing QA",
      qa_running: "Running QA",
      completed: "Completed",
      failed: "Failed",
    };
    expect(Object.fromEntries(Object.keys(expected).map((stage) => [stage, canonicalBuilderStageLabel(stage as CanonicalBuilderStage)]))).toEqual(expected);
  });

  it("continues polling for every non-terminal canonical stage, including QA", () => {
    expect(["queued", "researching", "building", "qa_pending", "qa_running"].every((stage) => shouldPollLiveBuild(stage as CanonicalBuilderStage))).toBe(true);
  });

  it("stops polling for completed and failed builds", () => {
    expect(shouldPollLiveBuild("completed")).toBe(false);
    expect(shouldPollLiveBuild("failed")).toBe(false);
  });

  it("uses the five provider-neutral progress steps and no review steps", () => {
    expect(canonicalLiveBuildTimeline("qa_pending", "2026-08-01T00:00:00.000Z").map((step) => step.label)).toEqual(["Queued", "Research", "Build", "QA", "Complete"]);
    expect(canonicalLiveBuildTimeline("failed", null).every((step) => step.status === "pending")).toBe(true);
  });

  it("does not allow duplicate or late events to regress a terminal stage", () => {
    expect(latestCanonicalBuilderStage("completed", "building")).toBe("completed");
    expect(latestCanonicalBuilderStage("failed", "qa_running")).toBe("failed");
  });

  it("does not infer a lifecycle change from provider-neutral event details", () => {
    const eventDetail = "worker disconnected while npm run build was still producing output";
    expect(eventDetail).toContain("worker");
    expect(latestCanonicalBuilderStage("building", "building")).toBe("building");
  });
});
