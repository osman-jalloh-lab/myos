// Shared skill definition type — used by both the MCP gateway and the execution layer.
// Skills live in /skills/*.json and are readable by Claude Desktop and Parawi alike.

export interface SkillInputSchema {
  type: string;
  description: string;
}

export interface SkillExecution {
  tool: string;
  risk: "read" | "internal_write" | "external_write";
  requiresApproval: boolean;
  pipeline?: string[];
  note?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  category: string;
  agent: string;
  inputs: Record<string, SkillInputSchema>;
  required: string[];
  execution: SkillExecution;
  examples?: string[];
}
