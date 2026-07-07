import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FUGU_NOT_CONNECTED_MESSAGE,
  runFuguDesignCritique,
  runFuguDesignGate,
  validateFuguDesignGatePayload,
} from "../fugu-design-critic";
import { canStartBuildWithFuguGate } from "../local-builder";

const originalKey = process.env.SAKANA_API_KEY;
const originalPassScore = process.env.FUGU_DESIGN_PASS_SCORE;
const originalGateMode = process.env.FUGU_DESIGN_GATE_MODE;

afterEach(() => {
  process.env.SAKANA_API_KEY = originalKey;
  process.env.FUGU_DESIGN_PASS_SCORE = originalPassScore;
  process.env.FUGU_DESIGN_GATE_MODE = originalGateMode;
  vi.restoreAllMocks();
});

describe("runFuguDesignCritique", () => {
  it("returns a graceful not-connected message without SAKANA_API_KEY", async () => {
    delete process.env.SAKANA_API_KEY;

    const result = await runFuguDesignCritique({
      projectInfo: "Project: Test",
      pageSummary: "No generated app files found yet.",
      buildNotes: "No build notes yet.",
    });

    expect(result).toEqual({
      connected: false,
      score: null,
      review: FUGU_NOT_CONNECTED_MESSAGE,
    });
  });
});

describe("Fugu design gate", () => {
  const gateInput = {
    originalIdea: "Build a premium project planner",
    buildBrief: "Create a useful planner",
    intendedUsers: "Small teams",
    firstReleaseGoal: "Ship a polished dashboard",
    featurePriorities: "Cards, filters, saved state",
    visualDirection: "Editorial but practical",
    pagesAndComponents: "Dashboard, project cards, detail panel",
    athenaResearchBrief: "Audience, design, feature, and build plan.",
  };

  it("derives pass and revise verdicts from the configured threshold", () => {
    process.env.FUGU_DESIGN_PASS_SCORE = "8";

    expect(validateFuguDesignGatePayload({ score: 8, summary: "Ready" }).verdict).toBe("pass");
    const revise = validateFuguDesignGatePayload({ score: 7, summary: "Needs work" });

    expect(revise.verdict).toBe("revise");
    expect(revise.mustFixBeforeBuild.length).toBeGreaterThan(0);
  });

  it("returns unavailable without exposing or requiring SAKANA_API_KEY", async () => {
    delete process.env.SAKANA_API_KEY;

    const gate = await runFuguDesignGate(gateInput);

    expect(gate.verdict).toBe("unavailable");
    expect(gate.score).toBeNull();
    expect(gate.summary).toBe(FUGU_NOT_CONNECTED_MESSAGE);
  });

  it("fails safely when Fugu returns malformed gate JSON", async () => {
    process.env.SAKANA_API_KEY = "test-key";
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "not json" } }] }),
    })));

    const gate = await runFuguDesignGate(gateInput);

    expect(gate.verdict).toBe("error");
    expect(gate.mustFixBeforeBuild.join(" ")).toMatch(/Retry Fugu|override/i);
  });

  it("blocks required-mode builds until Fugu passes or an override is recorded", () => {
    expect(canStartBuildWithFuguGate({ fuguGateStatus: "revise" }, "required")).toMatchObject({ allowed: false });
    expect(canStartBuildWithFuguGate({ fuguGateStatus: "pass" }, "required")).toMatchObject({ allowed: true });
    expect(canStartBuildWithFuguGate({ fuguGateStatus: "error", fuguGateOverrideReason: "Owner accepted visual risk for prototype." }, "required")).toMatchObject({ allowed: true });
    expect(canStartBuildWithFuguGate({ fuguGateStatus: "revise" }, "recommended")).toMatchObject({ allowed: true });
  });
});
