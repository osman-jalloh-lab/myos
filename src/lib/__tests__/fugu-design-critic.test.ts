import { afterEach, describe, expect, it } from "vitest";
import { FUGU_NOT_CONNECTED_MESSAGE, runFuguDesignCritique } from "../fugu-design-critic";

const originalKey = process.env.SAKANA_API_KEY;

afterEach(() => {
  process.env.SAKANA_API_KEY = originalKey;
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
