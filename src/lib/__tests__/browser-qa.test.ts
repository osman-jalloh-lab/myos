import { describe, expect, it } from "vitest";
import { browserQaPassed } from "../browser-qa";

describe("browser QA helpers", () => {
  it("passes when all checks pass", () => {
    expect(browserQaPassed([{ key: "a", label: "A", status: "passed", detail: "ok" }])).toBe(true);
  });

  it("fails when any check fails", () => {
    expect(browserQaPassed([{ key: "a", label: "A", status: "failed", detail: "bad" }])).toBe(false);
  });
});
