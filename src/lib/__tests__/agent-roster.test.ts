import { describe, expect, it } from "vitest";
import {
  AGENT_COLORS,
  CHAT_ROSTER_AGENTS,
  COMMAND_AGENT_PREFIXES,
  TASK_ASSIGNABLE_AGENT_KEYS,
  agentColor,
  chatTargetForAgent,
  isTaskAssignableAgent,
  normalizeAgentKey,
} from "@/lib/agent-roster";

const CANONICAL_AGENT_KEYS = [
  "hermes",
  "iris",
  "kairos",
  "argus",
  "plutus",
  "athena",
  "mnemosyne",
  "sophos",
  "tyche",
  "themis",
  "prometheus",
  "mercury",
] as const;

describe("agent roster", () => {
  it("keeps the canonical agent keys stable", () => {
    expect(Object.keys(AGENT_COLORS).sort()).toEqual([...CANONICAL_AGENT_KEYS].sort());
  });

  it("normalizes aliases, casing, and whitespace", () => {
    expect(normalizeAgentKey("mnemo")).toBe("mnemosyne");
    expect(normalizeAgentKey(" MnEmO ")).toBe("mnemosyne");
    expect(normalizeAgentKey("athena")).toBe("athena");
    expect(normalizeAgentKey(" Athena ")).toBe("athena");
  });

  it("does not treat unknown values as valid task assignments", () => {
    expect(isTaskAssignableAgent("made-up-agent")).toBe(false);
    expect(isTaskAssignableAgent(" mercury ")).toBe(false);
    expect(agentColor("made-up-agent")).toBe("#94A3B8");
  });

  it("derives task-assignable agents from the chat roster only", () => {
    const normalizedChatRoster = CHAT_ROSTER_AGENTS.map((agent) => normalizeAgentKey(agent.id));

    expect(TASK_ASSIGNABLE_AGENT_KEYS).toEqual(normalizedChatRoster);
    expect(TASK_ASSIGNABLE_AGENT_KEYS).not.toContain("mnemo");
    expect(TASK_ASSIGNABLE_AGENT_KEYS).not.toContain("mercury");
    expect(TASK_ASSIGNABLE_AGENT_KEYS.every((agent) => isTaskAssignableAgent(agent))).toBe(true);
  });

  it("keeps chat roster metadata complete for the UI", () => {
    for (const agent of CHAT_ROSTER_AGENTS) {
      expect(agent.id).toBeTruthy();
      expect(agent.letter).toEqual(expect.any(String));
      expect(agent.name).toEqual(expect.any(String));
      expect(agent.role).toEqual(expect.any(String));
      expect(agent.color).toMatch(/^#[0-9A-F]{6}$/i);
      expect(agent.emptyStateText).toEqual(expect.any(String));
      expect(agent.emptyStateText?.length).toBeGreaterThan(10);
    }
  });

  it("maps chat targets through canonical keys", () => {
    expect(chatTargetForAgent("hermes")).toBeNull();
    expect(chatTargetForAgent("mnemo")).toBe("mnemosyne");
    expect(chatTargetForAgent(" Themis ")).toBe("themis");
  });

  it("keeps Telegram prefixes on valid canonical agent keys", () => {
    expect(COMMAND_AGENT_PREFIXES).toContain("mercury");
    expect(COMMAND_AGENT_PREFIXES).not.toContain("hermes");
    expect(COMMAND_AGENT_PREFIXES.every((agent) => CANONICAL_AGENT_KEYS.includes(agent))).toBe(true);
  });

  it("keeps dispatcher health-check references inside the canonical roster", () => {
    expect(TASK_ASSIGNABLE_AGENT_KEYS.length).toBeGreaterThan(0);
    expect(TASK_ASSIGNABLE_AGENT_KEYS.every((agent) => CANONICAL_AGENT_KEYS.includes(agent))).toBe(true);
  });
});
