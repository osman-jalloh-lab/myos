import { describe, expect, it } from "vitest";
import { browserQaPassed, type BrowserQaCheck } from "../browser-qa";

describe("browserQaPassed", () => {
  it("allows passed and skipped checks", () => {
    const checks: BrowserQaCheck[] = [
      { key: "home", label: "Home", status: "passed", detail: "ok" },
      { key: "button", label: "Button", status: "skipped", detail: "none" },
    ];
    expect(browserQaPassed(checks)).toBe(true);
  });

  it("fails when any browser check fails", () => {
    expect(browserQaPassed([{ key: "console", label: "Console", status: "failed", detail: "error" }])).toBe(false);
  });
});
