import { describe, expect, it } from "vitest";
import { apiProviderSeverity, cleanProviderCredential } from "../health-center";

describe("provider health safety", () => {
  it("removes whitespace, BOM, and zero-width characters from credentials", () => {
    expect(cleanProviderCredential(" \uFEFF\u200Btoken\u200C-value\u200D \n")).toBe("token-value");
  });

  it("does not treat configured but untested providers as failures", () => {
    expect(apiProviderSeverity({ provider: "Sakana / Fugu", status: "configured_untested" })).toBe("healthy");
  });

  it("treats optional missing providers as warnings", () => {
    expect(apiProviderSeverity({ provider: "Amadeus Travel Fallback", status: "missing" })).toBe("warning");
    expect(apiProviderSeverity({ provider: "Google APIs", status: "missing" })).toBe("warning");
  });
});
