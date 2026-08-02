/**
 * Canonical Builder lifecycle.
 *
 * This is intentionally independent of provider, UI, and persistence details so
 * Fugu-era project rows can be rendered and scheduled without preserving their
 * historical review stages in new code.
 */
export const CANONICAL_BUILDER_STAGES = [
  "queued",
  "researching",
  "building",
  "qa_pending",
  "qa_running",
  "completed",
  "failed",
] as const;

export type CanonicalBuilderStage = (typeof CANONICAL_BUILDER_STAGES)[number];

const LEGACY_STAGE_MAP: Record<string, CanonicalBuilderStage> = {
  queued: "queued",
  planned: "queued",
  ready: "queued",
  researching: "researching",
  "brief ready": "building",
  "ready to build": "building",
  "design ready": "building",
  generating: "building",
  installing: "building",
  building: "building",
  "dev server running": "building",
  qa_pending: "qa_pending",
  "build passed": "qa_pending",
  waiting_for_fugu_design: "building",
  fugu_design_complete: "building",
  fugu_design_gate: "building",
  "fugu design gate": "building",
  "fugu unavailable": "building",
  "fugu error": "failed",
  "design revision needed": "building",
  fugu_polish_review: "qa_pending",
  waiting_for_fugu_polish: "qa_pending",
  fugu_polish_complete: "completed",
  qa_running: "qa_running",
  browser_qa: "qa_running",
  qa_passed: "completed",
  completed: "completed",
  deployed: "completed",
  failed: "failed",
  "build failed": "failed",
  qa_failed: "failed",
  cancelled: "failed",
  stalled: "failed",
};

function keyFor(value: unknown): string {
  if (value && typeof value === "object") {
    const record = value as { qaStatus?: unknown; localQaStatus?: unknown; status?: unknown };
    return keyFor(record.qaStatus ?? record.localQaStatus ?? record.status);
  }
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ").toLowerCase() : "";
}

/** Unknown legacy states fail safely by remaining queued for explicit handling. */
export function normalizeBuilderLifecycle(value: unknown): CanonicalBuilderStage {
  return LEGACY_STAGE_MAP[keyFor(value)] ?? "queued";
}

/** Prefer a QA-specific state when a persisted project row supplies one. */
export function deriveCanonicalBuilderStage(record: {
  status?: unknown;
  qaStatus?: unknown;
  localQaStatus?: unknown;
}): CanonicalBuilderStage {
  return normalizeBuilderLifecycle(record.qaStatus ?? record.localQaStatus ?? record.status);
}

export function isTerminalBuilderStage(stage: CanonicalBuilderStage): boolean {
  return stage === "completed" || stage === "failed";
}

export const BUILDER_LIFECYCLE_COMPATIBILITY = LEGACY_STAGE_MAP;
