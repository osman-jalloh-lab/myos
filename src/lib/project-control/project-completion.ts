export type CompletionEvidenceType =
  | "code_diff"
  | "commit"
  | "build_result"
  | "test_result"
  | "research_artifact"
  | "review_artifact"
  | "qa_result"
  | "deployed_url"
  | "approved_draft"
  | "database_record"
  | "user_acceptance";

export type CompletionEvidence = {
  type: CompletionEvidenceType;
  summary: string;
  uri?: string;
  commitSha?: string;
  passed?: boolean;
  createdAt?: string;
};

export function normalizeCompletionEvidence(evidence: CompletionEvidence): CompletionEvidence {
  return {
    ...evidence,
    summary: evidence.summary.trim(),
    createdAt: evidence.createdAt ?? new Date().toISOString(),
  };
}

export function isValidCompletionEvidence(value: unknown): value is CompletionEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const evidence = value as Partial<CompletionEvidence>;
  return Boolean(evidence.type && evidence.summary?.trim());
}

export function taskHasCompletionEvidence(task: { status: string; completedAt: Date | string | null; nextStep?: string | null }): boolean {
  return task.status === "completed" && Boolean(task.completedAt) && Boolean(task.nextStep?.includes("Evidence:"));
}

export function completionEvidenceSummary(tasks: Array<{ status: string; completedAt: Date | string | null; nextStep?: string | null }>) {
  const required = tasks.filter((task) => task.status !== "cancelled");
  const evidenced = required.filter(taskHasCompletionEvidence);
  return {
    requiredTaskCount: required.length,
    evidencedTaskCount: evidenced.length,
    complete: required.length > 0 && required.length === evidenced.length,
  };
}

export { verifyProjectCompletion } from "./project-manager";
