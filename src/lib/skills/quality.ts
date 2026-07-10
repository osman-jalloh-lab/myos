import type {
  SkillDefinitionV2,
  SkillEvaluationPrompt,
  SkillOutputContract,
  SkillQualityBand,
} from "./types";

export type SkillQualityInput = Partial<SkillDefinitionV2> & {
  description?: string;
  triggerExamples?: string[];
};

export type SkillQualityResult = {
  score: number;
  band: SkillQualityBand;
  warnings: string[];
};

export const DEFAULT_OUTPUT_CONTRACT: SkillOutputContract = {
  format: "Concise guidance with next steps.",
  mustInclude: [],
  mustAvoid: [],
};

function hasText(value: unknown, minLength = 12): boolean {
  return typeof value === "string" && value.trim().length >= minLength;
}

function count(items: unknown): number {
  return Array.isArray(items) ? items.filter((item) => hasText(item, 3)).length : 0;
}

function outputContractReady(contract: SkillOutputContract | undefined): boolean {
  return Boolean(
    contract
      && hasText(contract.format, 8)
      && count(contract.mustInclude) > 0
      && count(contract.mustAvoid) > 0
  );
}

function evaluationPromptsReady(prompts: SkillEvaluationPrompt[] | undefined): boolean {
  if (!Array.isArray(prompts)) return false;
  const usable = prompts.filter((prompt) =>
    hasText(prompt.input, 8)
    && typeof prompt.shouldMatch === "boolean"
    && hasText(prompt.reason, 8)
  );
  return usable.length >= 5;
}

export function qualityBand(score: number): SkillQualityBand {
  if (score >= 90) return "Excellent";
  if (score >= 75) return "Strong";
  if (score >= 60) return "Usable";
  if (score >= 40) return "Weak";
  return "Needs upgrade";
}

export function calculateSkillQualityScore(skill: SkillQualityInput): SkillQualityResult {
  let score = 0;
  const warnings: string[] = [];

  if (hasText(skill.purpose ?? skill.description, 24)) score += 15;
  else warnings.push("Add a clear purpose.");

  if (count(skill.whenToUse) >= 3) score += 10;
  else warnings.push("Add whenToUse examples.");

  if (count(skill.whenNotToUse) >= 2) score += 10;
  else warnings.push("Add whenNotToUse examples.");

  if (count(skill.strongSignals) >= 4) score += 10;
  else warnings.push("Add strong routing signals.");

  if (count(skill.negativeSignals) >= 3) score += 10;
  else warnings.push("Add negative routing signals.");

  if (outputContractReady(skill.outputContract)) score += 10;
  else warnings.push("Add an output contract with includes and avoids.");

  if (count(skill.safetyRules) >= 3) score += 10;
  else warnings.push("Add explicit safety rules.");

  if (evaluationPromptsReady(skill.evaluationPrompts)) score += 10;
  else warnings.push("Add evaluation prompts.");

  if (count(skill.requiredContext) >= 2) score += 5;
  else warnings.push("Add required context.");

  if (count(skill.missingContextQuestions) >= 2) score += 5;
  else warnings.push("Add missing-context questions.");

  const exampleCount = Math.max(count(skill.positiveExamples) + count(skill.negativeExamples), count(skill.triggerExamples));
  if (exampleCount >= 6) score += 5;
  else warnings.push("Add positive and negative examples.");

  const bounded = Math.max(0, Math.min(100, score));
  return {
    score: bounded,
    band: qualityBand(bounded),
    warnings,
  };
}
