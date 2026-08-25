import { describe, expect, it } from "vitest";
import { commandLogs, executionEngineLabel, testLogs } from "@/lib/execution-console";
import type { LiveBuildLog } from "@/lib/live-build-console";

const log = (source: string, message: string): LiveBuildLog => ({ timestamp: null, source, message, technical: false, status: "info" });

describe("execution console presentation", () => {
  it("derives providers only from recorded evidence", () => {
    expect(executionEngineLabel("Local Builder", [log("Builder", "Codex install passed")])).toBe("Codex CLI");
    expect(executionEngineLabel("Local Worker", [])).toBe("Local worker");
    expect(executionEngineLabel("local_worker", [log("hermes", "Claude discussed a separate task")])).toBe("Local worker");
  });

  it("separates command and verification evidence", () => {
    const logs = [log("npm run build", "Build completed"), log("Browser QA", "Homepage passed"), log("Builder", "Created src/app/page.tsx")];
    expect(commandLogs(logs)).toHaveLength(1);
    expect(testLogs(logs)).toHaveLength(2);
  });
});
