import { describe, expect, it } from "vitest";
import { diagnoseBuildFailure } from "../build-failure-diagnostics";

describe("build failure diagnostics", () => {
  it("uses the required priority order", () => {
    expect(diagnoseBuildFailure(["npm run build failed", "EACCES: permission denied"]).category).toBe("filesystem");
  });

  it("does not invent repository failure from a generic message", () => {
    const result = diagnoseBuildFailure(["Repo connection blocked", "Cannot continue"]);
    expect(result.category).toBe("unknown");
    expect(result.repositoryAccessTested).toBe(false);
    expect(result.exactError).toBe("Build stopped for an unknown reason. View technical logs.");
  });

  it("reports GitHub only after a concrete access failure", () => {
    const result = diagnoseBuildFailure(["GitHub repo metadata fetch failed with status 403."]);
    expect(result.category).toBe("github");
    expect(result.repositoryAccessTested).toBe(true);
  });
});
