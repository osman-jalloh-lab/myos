export type BuilderCoderExecutor = "codex_cli" | "hermes_agent";
export type BuilderResearchExecutor = "deepseek" | "claude" | "openai";
export type BuilderCoderAttempt<T> = { status: "completed"; value: T } | { status: "blocked"; question: string };

export type BuilderCoderWorkflowEvent = { type: "coder_started" | "coder_failed" | "fallback_started" | "research_requested" | "research_completed" | "coding_resumed" | "coder_completed"; executor?: BuilderCoderExecutor | BuilderResearchExecutor; question?: string; error?: string };

export class BuilderBlockedResearchError extends Error {
  constructor(readonly question: string) { super(`BUILDER_BLOCKED_RESEARCH: ${question}`); this.name = "BuilderBlockedResearchError"; }
}

export function parseBuilderBlockedQuestion(output: string): string | null {
  const match = output.match(/^BUILDER_BLOCKED_RESEARCH:\s*(.+?)\s*$/m);
  return match?.[1]?.trim() || null;
}

export async function executeBuilderCoderWorkflow<T>(params: {
  projectId: string; request: string;
  availableCoders: Record<BuilderCoderExecutor, boolean>;
  availableResearchers: Record<BuilderResearchExecutor, boolean>;
  runCoder: (input: { executor: BuilderCoderExecutor; projectId: string; request: string; researchFindings: string | null }) => Promise<BuilderCoderAttempt<T>>;
  runResearch: (input: { executor: BuilderResearchExecutor; projectId: string; question: string }) => Promise<string>;
  onEvent?: (event: BuilderCoderWorkflowEvent) => void | Promise<void>;
}): Promise<{ projectId: string; coder: BuilderCoderExecutor; value: T; fallbackUsed: boolean; research: { executor: BuilderResearchExecutor; question: string } | null }> {
  const emit = async (event: BuilderCoderWorkflowEvent) => { await params.onEvent?.(event); };
  let lastError: unknown = null;
  for (const coder of ["codex_cli", "hermes_agent"] as const) {
    if (!params.availableCoders[coder]) continue;
    const fallbackUsed = coder === "hermes_agent";
    if (fallbackUsed) await emit({ type: "fallback_started", executor: coder });
    let completed: { projectId: string; coder: BuilderCoderExecutor; value: T; fallbackUsed: boolean; research: { executor: BuilderResearchExecutor; question: string } | null } | null = null;
    try {
      await emit({ type: "coder_started", executor: coder });
      let attempt = await params.runCoder({ executor: coder, projectId: params.projectId, request: params.request, researchFindings: null });
      let research: { executor: BuilderResearchExecutor; question: string } | null = null;
      if (attempt.status === "blocked") {
        const question = attempt.question.trim();
        const researchers = (["deepseek", "claude", "openai"] as const).filter((candidate) => params.availableResearchers[candidate]);
        if (!question || !researchers.length) throw new Error("No eligible Council research provider is available for the Builder blocker.");
        let researchFindings: string | null = null;
        let lastResearchError: unknown = null;
        for (const researcher of researchers) {
          await emit({ type: "research_requested", executor: researcher, question });
          try {
            const findings = (await params.runResearch({ executor: researcher, projectId: params.projectId, question })).trim();
            if (!findings) throw new Error(`${researcher} returned unusable Builder research findings.`);
            researchFindings = findings;
            research = { executor: researcher, question };
            await emit({ type: "research_completed", executor: researcher, question });
            break;
          } catch (error) {
            lastResearchError = error;
          }
        }
        if (!researchFindings) {
          throw lastResearchError instanceof Error
            ? lastResearchError
            : new Error("No eligible Council research provider returned usable Builder research findings.");
        }
        await emit({ type: "coding_resumed", executor: coder });
        attempt = await params.runCoder({ executor: coder, projectId: params.projectId, request: params.request, researchFindings });
      }
      if (attempt.status === "blocked") throw new Error(`Builder remained blocked: ${attempt.question}`);
      completed = { projectId: params.projectId, coder, value: attempt.value, fallbackUsed, research };
    } catch (error) {
      lastError = error;
      await emit({ type: "coder_failed", executor: coder, error: error instanceof Error ? error.message : String(error) });
      continue;
    }
    // Completion telemetry is deliberately outside the coder failure boundary.
    // A persistence outage after a successful edit must never rerun another
    // coder against the same project as a fallback.
    await emit({ type: "coder_completed", executor: coder });
    return completed;
  }
  throw lastError instanceof Error ? lastError : new Error("No eligible Builder coder is available.");
}
