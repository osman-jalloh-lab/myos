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

/** The persisted fields needed to derive the API-facing Builder stage. */
export type BuilderLifecycleRecord = {
  status?: unknown;
  qaStatus?: unknown;
  localQaStatus?: unknown;
};

/** Additive response contract shared by Builder and local-build APIs. */
export type CanonicalBuilderStageResponse = {
  canonicalStage: CanonicalBuilderStage;
};

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
export function deriveCanonicalBuilderStage(record: BuilderLifecycleRecord): CanonicalBuilderStage {
  return normalizeBuilderLifecycle(record.qaStatus ?? record.localQaStatus ?? record.status);
}

/**
 * Decorate a serialized response without changing the original persistence
 * record. API routes use this instead of reproducing legacy-state mappings.
 */
export function withCanonicalBuilderStage<T extends BuilderLifecycleRecord>(record: T): T & CanonicalBuilderStageResponse {
  return { ...record, canonicalStage: deriveCanonicalBuilderStage(record) };
}

export function isTerminalBuilderStage(stage: CanonicalBuilderStage): boolean {
  return stage === "completed" || stage === "failed";
}

export const BUILDER_LIFECYCLE_COMPATIBILITY = LEGACY_STAGE_MAP;
