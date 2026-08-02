import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  BUILDER_LIFECYCLE_COMPATIBILITY,
  CANONICAL_BUILDER_STAGES,
  isTerminalBuilderStage,
  deriveCanonicalBuilderStage,
  normalizeBuilderLifecycle,
  withCanonicalBuilderStage,
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

  it("adds the same canonicalStage to API-shaped records without changing legacy fields", () => {
    const cases = [
      [{ status: "queued" }, "queued"],
      [{ status: "Researching" }, "researching"],
      [{ status: "Building" }, "building"],
      [{ status: "Fugu Design Gate" }, "building"],
      [{ status: "waiting_for_fugu_polish" }, "qa_pending"],
      [{ status: "Build Passed", localQaStatus: "qa_running" }, "qa_running"],
      [{ status: "Build Passed", localQaStatus: "qa_passed" }, "completed"],
      [{ status: "Building", localQaStatus: "qa_failed" }, "failed"],
      [{ status: "unrecognized legacy state" }, "queued"],
    ] as const;

    for (const [record, canonicalStage] of cases) {
      const serialized = withCanonicalBuilderStage(record);
      expect(serialized).toMatchObject({ ...record, canonicalStage });
      expect(record).not.toHaveProperty("canonicalStage");
    }
  });

  it("keeps every Builder API serializer on the shared canonical-stage decorator", () => {
    const routes = [
      "src/app/api/command-center/local-builds/route.ts",
      "src/app/api/command-center/projects/route.ts",
      "src/app/api/command-center/live-build/route.ts",
    ];

    for (const route of routes) {
      expect(readFileSync(path.join(process.cwd(), route), "utf8"), route).toContain("withCanonicalBuilderStage");
    }
  });
});
