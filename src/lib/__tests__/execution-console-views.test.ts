import { describe, expect, it } from "vitest";
import { EXECUTION_CONSOLE_VIEWS } from "@/lib/execution-console";

describe("Live Console information architecture", () => {
  it("exposes the locked Mission Code Trace top-level contract", () => {
    expect(EXECUTION_CONSOLE_VIEWS).toEqual(["mission", "code", "trace"]);
  });
});
