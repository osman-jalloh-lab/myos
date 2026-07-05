import { describe, expect, it } from "vitest";
import { isLocalPreviewHost, enforceLocalPreviewOrigin, sanitizeUrlForLogging } from "../browser-qa";

describe("local preview host rules", () => {
  it("allows localhost and its aliases", () => {
    expect(isLocalPreviewHost(new URL("http://localhost:3000"))).toBe(true);
    expect(isLocalPreviewHost(new URL("http://127.0.0.1:3000"))).toBe(true);
    expect(isLocalPreviewHost(new URL("http://0.0.0.0:3000"))).toBe(true);
    expect(isLocalPreviewHost(new URL("http://[::1]:3000"))).toBe(true);
  });

  it("rejects external URLs", () => {
    expect(isLocalPreviewHost(new URL("https://example.com"))).toBe(false);
    expect(isLocalPreviewHost(new URL("https://parawi.com"))).toBe(false);
  });

  it("rejects assigned preview mismatches", async () => {
    await expect(enforceLocalPreviewOrigin("http://localhost:3000", "http://127.0.0.1:4000")).rejects.toThrow(/is not the assigned preview/);
    await expect(enforceLocalPreviewOrigin("https://example.com")).rejects.toThrow(/Blocked browser navigation/);
  });
});

describe("url logging sanitizer", () => {
  it("strips query and fragment from logged urls", () => {
    expect(sanitizeUrlForLogging("https://example.com/path?a=1#f")).toBe("https://example.com/path");
  });
});
