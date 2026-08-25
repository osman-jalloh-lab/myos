import { describe, expect, it } from "vitest";
import { agentOfficeIdentity, agentTextMatches } from "@/lib/agent-office";

describe("agent office identity", () => {
  it("keeps Prometheus separate from its coding provider", () => {
    const prometheus = agentOfficeIdentity("prometheus");
    expect(prometheus.name).toBe("Prometheus");
    expect(prometheus.role).toContain("Builder");
    expect(prometheus.role).not.toContain("Codex");
  });

  it("marks Plutus as visibly read-only", () => {
    expect(agentOfficeIdentity("plutus")).toMatchObject({ readOnly: true });
    expect(agentOfficeIdentity("plutus").safetyLabel).toContain("transactions disabled");
  });

  it("matches real execution aliases to the owning agent", () => {
    expect(agentTextMatches("prometheus", "local_worker completed Docker build")).toBe(true);
    expect(agentTextMatches("iris", "Gmail draft awaiting approval")).toBe(true);
    expect(agentTextMatches("athena", "Gmail draft awaiting approval")).toBe(false);
  });
});
