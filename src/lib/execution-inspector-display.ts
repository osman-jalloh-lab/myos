export const ACTIVE_AGENT_OFFICES = ["hermes", "athena", "builder", "iris"] as const;

export type ActiveAgentOffice = (typeof ACTIVE_AGENT_OFFICES)[number];

export type ExecutionTraceDisplayEvent = {
  phase: string;
  severity: "info" | "warning" | "error";
  message: string;
  source: string;
  safeDetails?: Record<string, unknown>;
};

const LEGACY_REVIEW_PATTERN = /\bfugu\b|\bsakana\b|design review|polish review/i;

/** Redirect obsolete saved office values to the active Command Center default. */
export function normalizeAgentOfficeView(value: unknown): ActiveAgentOffice {
  return typeof value === "string" && (ACTIVE_AGENT_OFFICES as readonly string[]).includes(value) ? value as ActiveAgentOffice : "hermes";
}

/** Preserve historical audit ordering without presenting retired review tooling as active. */
export function normalizeExecutionTraceForDisplay<T extends ExecutionTraceDisplayEvent>(event: T): T & { legacyReview: boolean } {
  const legacyReview = LEGACY_REVIEW_PATTERN.test(`${event.phase} ${event.message} ${event.source}`);
  return legacyReview
    ? { ...event, phase: "legacy_review", message: "Legacy review event", source: "Historical record", safeDetails: undefined, legacyReview }
    : { ...event, legacyReview };
}
