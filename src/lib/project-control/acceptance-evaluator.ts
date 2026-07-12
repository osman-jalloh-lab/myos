import type { AcceptanceEvidence } from "./task-artifacts";

export type AcceptanceCriterionResult = {
  criterion: string;
  status: "passed" | "failed" | "not_proven";
  evidenceArtifactIds: string[];
  reason: string;
};

export type AcceptanceEvaluation = {
  complete: boolean;
  requiresReview: boolean;
  results: AcceptanceCriterionResult[];
};

function normalizeCriteria(criteria: string[]): string[] {
  return criteria.map((criterion) => criterion.trim()).filter(Boolean);
}

function evidenceMatches(criterion: string, evidence: AcceptanceEvidence[], artifactIds: string[]): AcceptanceCriterionResult {
  const text = criterion.toLowerCase();
  const hasEvidence = evidence.some((item) => {
    const haystack = `${item.type} ${item.summary} ${item.artifactTitle ?? ""}`.toLowerCase();
    if (item.passed === false) return false;
    if (text.includes("build") || text.includes("typecheck") || text.includes("lint") || text.includes("test")) {
      return /(build|typecheck|lint|test|validation|command)/.test(haystack);
    }
    if (text.includes("review") || text.includes("qa") || text.includes("design")) {
      return /(review|qa|design|accessibility|verdict)/.test(haystack);
    }
    if (text.includes("research") || text.includes("brief")) {
      return /(research|brief|source|report)/.test(haystack);
    }
    if (text.includes("code") || text.includes("diff") || text.includes("file") || text.includes("implementation")) {
      return /(code|diff|file|implementation|commit|build_result)/.test(haystack);
    }
    return haystack.length > 0;
  });
  return {
    criterion,
    status: hasEvidence && artifactIds.length > 0 ? "passed" : "not_proven",
    evidenceArtifactIds: hasEvidence ? artifactIds : [],
    reason: hasEvidence ? "Matched structured evidence and persisted artifact." : "No persisted artifact/evidence proves this criterion yet.",
  };
}

export function evaluateAcceptanceCriteria(params: {
  criteria: string[];
  outputContract: string | null;
  evidence: AcceptanceEvidence[];
  artifactIds: string[];
  status: string;
}): AcceptanceEvaluation {
  const criteria = normalizeCriteria(params.criteria);
  const requiresReview = Boolean(params.outputContract && /(review|qa|design)/i.test(params.outputContract));
  if (params.status === "blocked" || params.status === "failed") {
    return {
      complete: false,
      requiresReview,
      results: criteria.map((criterion) => ({ criterion, status: "failed", evidenceArtifactIds: [], reason: `Agent returned ${params.status}.` })),
    };
  }
  if (!criteria.length) {
    const proven = params.evidence.length > 0 && params.artifactIds.length > 0;
    return {
      complete: proven,
      requiresReview,
      results: [{
        criterion: "Task produced durable evidence.",
        status: proven ? "passed" : "not_proven",
        evidenceArtifactIds: proven ? params.artifactIds : [],
        reason: proven ? "At least one artifact and evidence record were persisted." : "Completion requires an artifact and evidence record.",
      }],
    };
  }
  const results = criteria.map((criterion) => evidenceMatches(criterion, params.evidence, params.artifactIds));
  return {
    complete: results.every((result) => result.status === "passed"),
    requiresReview,
    results,
  };
}
