import type { CanonicalBuilderStage } from "@/lib/builder-lifecycle";

export const BUILDER_PROGRESS_STEPS = ["Queued", "Research", "Build", "QA", "Complete"] as const;
export const BUILDER_STAGE_FILTERS = ["all", "queued", "active", "qa", "completed", "failed"] as const;

export type BuilderStageFilter = (typeof BUILDER_STAGE_FILTERS)[number];

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

export function canonicalBuilderStageColor(stage: CanonicalBuilderStage): string {
  if (stage === "completed") return "#34D399";
  if (stage === "failed") return "#F87171";
  if (stage === "queued" || stage === "qa_pending") return "#60A5FA";
  return "#A78BFA";
}

export function canonicalBuilderStageOrder(stage: CanonicalBuilderStage): number {
  return ["queued", "researching", "building", "qa_pending", "qa_running", "completed", "failed"].indexOf(stage);
}

export function canonicalBuilderStageMatchesFilter(stage: CanonicalBuilderStage, filter: BuilderStageFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return stage === "researching" || stage === "building";
  if (filter === "qa") return stage === "qa_pending" || stage === "qa_running";
  return stage === filter;
}

export function canonicalBuilderStageGroup(stage: CanonicalBuilderStage): "queued" | "active" | "completed" | "failed" {
  if (stage === "queued") return "queued";
  if (stage === "completed") return "completed";
  if (stage === "failed") return "failed";
  return "active";
}
