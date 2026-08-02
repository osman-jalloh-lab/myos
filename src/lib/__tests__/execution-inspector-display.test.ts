import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeAgentOfficeView, normalizeExecutionTraceForDisplay } from "../execution-inspector-display";

describe("execution inspector display normalization", () => {
  it("keeps only active offices and safely falls back from obsolete saved views", () => {
    expect(normalizeAgentOfficeView("builder")).toBe("builder");
    expect(normalizeAgentOfficeView("fugu")).toBe("hermes");
    expect(normalizeAgentOfficeView("unknown")).toBe("hermes");
  });

  it("neutralizes legacy review traces without changing provider-neutral events", () => {
    expect(normalizeExecutionTraceForDisplay({ phase: "fugu_design_gate", severity: "info", message: "Fugu review completed", source: "fugu" })).toMatchObject({ legacyReview: true, phase: "legacy_review", message: "Legacy review event", source: "Historical record" });
    expect(normalizeExecutionTraceForDisplay({ phase: "qa_running", severity: "info", message: "Browser QA started", source: "qa" })).toMatchObject({ legacyReview: false, phase: "qa_running", message: "Browser QA started", source: "qa" });
  });

  it("keeps the Command Center inspector canonical and provider-neutral", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/command-center/CommandCenterClient.tsx"), "utf8");
    const inspector = source.slice(source.indexOf("function RunInspectorPanel"), source.indexOf("function ActivitySection"));
    expect(source).not.toMatch(/fugu|sakana/i);
    expect(inspector).toContain("canonicalBuilderStageLabel(selected.canonicalStage)");
    expect(inspector).toContain("normalizeExecutionTraceForDisplay");
    expect(inspector).toContain("Last safe error");
    expect(inspector).toContain("timeAgo(event.createdAt)");
    expect(inspector).toContain("Safe details");
    expect(inspector).toContain("onRetry(selected.id)");
    expect(inspector).not.toMatch(/approval|override|design review|polish review/i);
  });

  it("adds the canonical stage at the runs API boundary", () => {
    const source = readFileSync(path.join(process.cwd(), "src/app/api/command-center/runs/route.ts"), "utf8");
    expect(source).toContain("canonicalStage: deriveCanonicalBuilderStage");
  });
});
