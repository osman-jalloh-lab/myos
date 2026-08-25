import { describe, expect, it } from "vitest";
import { commandCenterNavigation } from "../AppSidebar";

describe("production command center navigation", () => {
  it("exposes only real command-center destinations", () => {
    const labels = commandCenterNavigation.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toContain("Ask Hermes");
    expect(labels).toContain("Builder Office");
    expect(labels).toContain("Live Console");
    expect(labels).toContain("Teach Hermes");
    expect(labels).toContain("Knowledge Graph");
    expect(labels).toContain("Problems & Solutions");
    expect(labels).not.toContain("Finance");
    expect(labels).not.toContain("Calendar");
    expect(labels).not.toContain("Inbox");
  });

  it("keeps every destination inside the implemented UI surface", () => {
    const implemented = new Set(["overview", "chat", "agents", "runs", "projects", "approvals", "builder", "live", "skills", "teach", "health", "logs", "memory", "knowledge", "troubleshooting"]);
    for (const item of commandCenterNavigation.flatMap((group) => group.items)) expect(implemented.has(item.id)).toBe(true);
  });
});
