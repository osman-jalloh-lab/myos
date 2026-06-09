// Skill registry — loads /skills/*.json and makes them available to the execution layer.
// Both the MCP gateway (external) and Parawi's execution layer (internal) use these definitions.

import type { SkillDefinition } from "./types";

// Cache so we don't re-read on every request
let _skills: SkillDefinition[] | null = null;

export function loadSkills(): SkillDefinition[] {
  if (_skills) return _skills;

  // In Next.js App Router (server-side), we can read the filesystem at runtime.
  // The skills/ directory is at the repo root, two levels above src/lib/skills/.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");

    const skillsDir = path.join(process.cwd(), "skills");
    if (!fs.existsSync(skillsDir)) return [];

    _skills = fs
      .readdirSync(skillsDir)
      .filter((f: string) => f.endsWith(".json"))
      .map((f: string) => {
        const raw = fs.readFileSync(path.join(skillsDir, f), "utf-8");
        return JSON.parse(raw) as SkillDefinition;
      });

    return _skills;
  } catch {
    return [];
  }
}

export function getSkill(name: string): SkillDefinition | undefined {
  return loadSkills().find((s) => s.name === name);
}

export function listSkillNames(): string[] {
  return loadSkills().map((s) => s.name);
}

export function getSkillsByAgent(agent: string): SkillDefinition[] {
  return loadSkills().filter((s) => s.agent === agent);
}

export function getSkillsByCategory(category: string): SkillDefinition[] {
  return loadSkills().filter((s) => s.category === category);
}

export type { SkillDefinition } from "./types";
