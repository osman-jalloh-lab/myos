import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearToolRegistryForTests,
  getTool,
  getToolRegistration,
  getToolset,
  hasTool,
  hasToolRegistration,
  listToolRegistrations,
  listToolsets,
  registerTool,
  type ToolRegistration,
} from "@/lib/hermes-execution/tool-registry";
import type { ToolDefinition } from "@/lib/hermes-execution/types";

function tool(name: string, risk: ToolDefinition["risk"] = "read"): ToolDefinition {
  return {
    name,
    description: `${name} description`,
    risk,
    requiresApproval: risk === "external_write" || risk === "dangerous",
    execute: vi.fn(async () => ({ ok: true })),
  };
}

function registration(
  name: string,
  overrides: Partial<ToolRegistration["metadata"]> = {},
): ToolRegistration {
  return {
    tool: tool(name),
    metadata: {
      source: "native",
      toolsets: ["search"],
      risk: "read",
      availability: "available",
      permissions: ["authenticated", "authorized"],
      requiresApproval: false,
      timeoutMs: 30_000,
      maxResultBytes: 128_000,
      executionEnvironment: "server",
      description: `${name} policy metadata`,
      capabilityTags: ["lookup"],
      ...overrides,
    },
  };
}

describe("policy-aware tool registry", () => {
  beforeEach(() => clearToolRegistryForTests());

  it("keeps legacy tool IDs and executable resolution compatible", () => {
    const existing = tool("internal.existing");
    registerTool(existing);

    expect(getTool("internal.existing")).toBe(existing);
    expect(listToolRegistrations().map((entry) => entry.toolId)).toEqual(["internal.existing"]);
  });

  it("applies deterministic conservative compatibility metadata", () => {
    registerTool(tool("internal.write", "internal_write"));

    expect(getToolRegistration("internal.write")?.metadata).toEqual({
      source: "native",
      toolsets: ["legacy"],
      risk: "write",
      availability: "available",
      permissions: ["authenticated", "authorized"],
      requiresApproval: false,
      timeoutMs: 30_000,
      maxResultBytes: 262_144,
      executionEnvironment: "server",
      description: "internal.write description",
      capabilityTags: [],
    });
  });

  it("describes legacy dangerous tools conservatively without changing their ID", () => {
    const dangerous = tool("internal.dangerous", "dangerous");
    dangerous.requiresApproval = false;
    registerTool(dangerous);

    expect(getTool("internal.dangerous")).toBe(dangerous);
    expect(getToolRegistration("internal.dangerous")?.metadata).toMatchObject({
      risk: "privileged",
      requiresApproval: true,
      permissions: ["authenticated", "authorized", "approval"],
    });
  });

  it("enumerates deterministic toolsets without duplicate registrations", () => {
    registerTool(registration("native.shared", { toolsets: ["search", "memory", "search"] }));
    registerTool(registration("native.second", { toolsets: ["search"] }));

    expect(getToolset("search").map((entry) => entry.toolId)).toEqual(["native.second", "native.shared"]);
    expect(getToolset("memory").map((entry) => entry.toolId)).toEqual(["native.shared"]);
    expect(listToolRegistrations()).toHaveLength(2);
    expect(listToolsets()).toEqual([
      { name: "memory", toolIds: ["native.shared"] },
      { name: "search", toolIds: ["native.second", "native.shared"] },
    ]);
  });

  it("keeps unknown tools unavailable", () => {
    expect(getTool("missing.tool")).toBeUndefined();
    expect(getToolRegistration("missing.tool")).toBeUndefined();
    expect(getToolset("missing")).toEqual([]);
  });

  it.each(["privileged", "external-side-effect"] as const)(
    "does not make %s policy-gated registrations executable",
    (risk) => {
      registerTool(registration(`hermes.${risk}`, {
        source: "hermes-derived",
        risk,
        availability: "available",
        permissions: [],
        requiresApproval: false,
      }));

        const descriptor = getToolRegistration(`hermes.${risk}`);
      expect(descriptor?.metadata.availability).toBe("available");
      expect(descriptor).not.toHaveProperty("tool");
      expect(hasToolRegistration(`hermes.${risk}`)).toBe(true);
      expect(hasTool(`hermes.${risk}`)).toBe(false);
      expect(getTool(`hermes.${risk}`)).toBeUndefined();
    },
  );

  it("reconciles policy metadata upward with the executable definition risk", () => {
    const mismatched = registration("hermes.mismatched-risk", {
      source: "hermes-derived",
      risk: "read",
      requiresApproval: false,
    });
    mismatched.tool.risk = "dangerous";
    mismatched.tool.requiresApproval = false;

    registerTool(mismatched);

    expect(getToolRegistration("hermes.mismatched-risk")?.metadata).toMatchObject({
      risk: "privileged",
      requiresApproval: true,
      permissions: ["authenticated", "authorized", "approval"],
    });
  });

  it("snapshots tool identity instead of trusting caller mutation", () => {
    const mutable = tool("native.alpha");
    registerTool(mutable);

    mutable.name = "native.beta";

    expect(getToolRegistration("native.alpha")?.toolId).toBe("native.alpha");
    expect(getTool("native.alpha")).toBe(mutable);
    expect(getToolRegistration("native.beta")).toBeUndefined();
    expect(getToolset("legacy").map((entry) => entry.toolId)).toEqual(["native.alpha"]);
  });

  it("uses locale-independent code-point ordering", () => {
    registerTool(registration("native.zeta", { toolsets: ["zeta"] }));
    registerTool(registration("native.a-umlaut", { toolsets: ["äther"] }));

    expect(listToolsets().map((toolset) => toolset.name)).toEqual(["zeta", "äther"]);
  });

  it("does not allow the test reset outside a test environment", () => {
    registerTool(registration("hermes.reset-guard", { source: "hermes-derived" }));
    vi.stubEnv("NODE_ENV", "production");
    try {
      expect(() => clearToolRegistryForTests()).toThrow("test environments");
    } finally {
      vi.unstubAllEnvs();
    }
    expect(hasToolRegistration("hermes.reset-guard")).toBe(true);
  });

  it("fails incomplete policy metadata closed at runtime", () => {
    registerTool({
      tool: tool("hermes.incomplete"),
      metadata: { source: "hermes-derived" },
    } as ToolRegistration);

    expect(getToolRegistration("hermes.incomplete")?.metadata).toMatchObject({
      source: "hermes-derived",
      risk: "privileged",
      availability: "unavailable",
      permissions: ["authenticated", "authorized", "approval"],
      requiresApproval: true,
      executionEnvironment: "unknown",
    });
    expect(getTool("hermes.incomplete")).toBeUndefined();
  });

  it("does not allow a test reset to downgrade the same policy-gated definition", () => {
    const guarded = registration("hermes.reset-downgrade", { source: "hermes-derived" });
    registerTool(guarded);
    clearToolRegistryForTests();

    expect(() => registerTool(guarded.tool)).toThrow("cannot be downgraded");
    expect(getTool("hermes.reset-downgrade")).toBeUndefined();
  });

  it("never allows a policy-gated registration to be downgraded to legacy execution", () => {
    registerTool(registration("hermes.no-downgrade", { source: "hermes-derived" }));

    expect(() => registerTool(tool("hermes.no-downgrade"), {
      allowOverride: true,
      reason: "Attempted compatibility downgrade",
    })).toThrow("cannot be downgraded");
    expect(getTool("hermes.no-downgrade")).toBeUndefined();
    expect(getToolRegistration("hermes.no-downgrade")?.registrationMode).toBe("policy-gated");
  });

  it("rejects policy-aware collisions unless an explicit reason authorizes replacement", () => {
    registerTool(registration("native.collision"));

    expect(() => registerTool(registration("native.collision"))).toThrow("already registered");
    expect(() => registerTool(registration("native.collision"), { allowOverride: true })).toThrow("override reason");

    registerTool(registration("native.collision", { description: "replacement" }), {
      allowOverride: true,
      reason: "Replace stale registration during controlled refresh",
    });
    expect(getToolRegistration("native.collision")?.metadata.description).toBe("replacement");
  });
});
