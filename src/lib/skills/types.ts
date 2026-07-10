// Shared skill definition types used by the MCP gateway, registry, and execution layer.
// Skills may still be simple /skills/*.json files. V2 fields are optional on the
// legacy definition so older skills keep loading while richer skills can provide
// routing, safety, output, and evaluation metadata.

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

export interface SkillOutputContract {
  format: string;
  mustInclude: string[];
  mustAvoid: string[];
  tone?: string;
}

export interface SkillEvaluationPrompt {
  input: string;
  shouldMatch: boolean;
  minimumScore?: number;
  expectedSkill?: string;
  reason: string;
}

export type SkillQualityBand = "Excellent" | "Strong" | "Usable" | "Weak" | "Needs upgrade";

export interface SkillDefinitionV2 {
  id: string;
  name: string;
  description: string;
  category: string;
  ownerAgents: string[];
  tags: string[];
  purpose: string;
  whenToUse: string[];
  whenNotToUse: string[];
  strongSignals: string[];
  weakSignals: string[];
  negativeSignals: string[];
  requiredContext: string[];
  missingContextQuestions: string[];
  outputContract: SkillOutputContract;
  safetyRules: string[];
  approvalRequiredFor: string[];
  positiveExamples: string[];
  negativeExamples: string[];
  evaluationPrompts: SkillEvaluationPrompt[];
  version: string;
  lastReviewedAt?: string;
}

export interface SkillDefinition extends Partial<SkillDefinitionV2> {
  name: string;
  description: string;
  category: string;
  agent: string;
  inputs: Record<string, SkillInputSchema>;
  required: string[];
  execution: SkillExecution;
  examples?: string[];
}
