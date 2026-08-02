import { describe, expect, it } from "vitest";
import {
  BUILDER_LIFECYCLE_COMPATIBILITY,
  CANONICAL_BUILDER_STAGES,
  isTerminalBuilderStage,
  deriveCanonicalBuilderStage,
  normalizeBuilderLifecycle,
} from "../builder-lifecycle";

describe("builder lifecycle compatibility", () => {
  it("maps every documented legacy state to a canonical stage", () => {
    for (const [legacy, canonical] of Object.entries(BUILDER_LIFECYCLE_COMPATIBILITY)) {
      expect(normalizeBuilderLifecycle(legacy)).toBe(canonical);
    }
  });

  it("has no provider-specific canonical stages", () => {
    expect(CANONICAL_BUILDER_STAGES).not.toContain("fugu");
    expect(CANONICAL_BUILDER_STAGES.every((stage) => !/fugu|sakana/i.test(stage))).toBe(true);
  });

  it("keeps terminal states terminal and preserves build and QA distinctions", () => {
    expect(isTerminalBuilderStage("completed")).toBe(true);
    expect(isTerminalBuilderStage("failed")).toBe(true);
    expect(normalizeBuilderLifecycle("Build Failed")).toBe("failed");
    expect(normalizeBuilderLifecycle("qa_pending")).toBe("qa_pending");
    expect(normalizeBuilderLifecycle("qa_running")).toBe("qa_running");
  });

  it("loads old records and fails unknown states safely", () => {
    expect(normalizeBuilderLifecycle({ status: "fugu_design_gate" })).toBe("building");
    expect(normalizeBuilderLifecycle("Fugu Design Gate")).toBe("building");
    expect(normalizeBuilderLifecycle("unrecognized legacy state")).toBe("queued");
  });

  it("prioritizes persisted QA state over an older project status", () => {
    expect(deriveCanonicalBuilderStage({ status: "Fugu Design Gate", localQaStatus: "qa_running" })).toBe("qa_running");
  });
});
