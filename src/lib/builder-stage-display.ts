import type { CanonicalBuilderStage } from "@/lib/builder-lifecycle";

export const BUILDER_PROGRESS_STEPS = ["Queued", "Research", "Build", "QA", "Complete"] as const;

export function canonicalBuilderStageLabel(stage: CanonicalBuilderStage): string {
  return {
    queued: "Queued",
    researching: "Researching",
    building: "Building",
    qa_pending: "Preparing QA",
    qa_running: "Running QA",
    completed: "Completed",
    failed: "Failed",
  }[stage];
}

/** The active provider-neutral progress step for a canonical Builder stage. */
export function canonicalBuilderProgressStep(stage: CanonicalBuilderStage): number | null {
  if (stage === "queued") return 0;
  if (stage === "researching") return 1;
  if (stage === "building") return 2;
  if (stage === "qa_pending" || stage === "qa_running") return 3;
  if (stage === "completed") return 4;
  return null;
}
