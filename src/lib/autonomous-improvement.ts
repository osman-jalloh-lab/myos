import { createApproval, type ApprovalActionView } from "@/lib/approvals";
import { councilProviderEntries, runCouncilProvider } from "@/lib/council-providers";
import { selectDynamicCouncil, synthesizeCouncil, type CouncilSynthesis, type DynamicCouncilSelection } from "@/lib/dynamic-council";
import { appendExecutionEvent, createExecutionRun } from "@/lib/execution-runs";
import { resolveRelevantSkills } from "@/lib/skills/routing";

export const IMPROVEMENT_STATES = [
  "REQUESTED", "CONTEXT_GATHERING", "PLANNING", "COUNCIL_REVIEW", "PLAN_READY",
  "AWAITING_APPROVAL", "APPROVED", "IMPLEMENTING", "VALIDATING", "REVIEWING",
  "READY_FOR_USER", "COMPLETED", "BLOCKED", "REJECTED", "CANCELLED", "FAILED", "ROLLBACK_READY",
] as const;
export type ImprovementState = typeof IMPROVEMENT_STATES[number];

export type ImprovementPlan = {
  objective: string;
  affectedWorkspace: { id: "my-os"; label: "My OS"; protected: true; registered: true };
  whyThisApproach: string;
  likelyFiles: string[];
  selectedAgents: string[];
  selectedExecutors: string[];
  selectedSkills: string[];
  requiredTools: string[];
  risk: "medium" | "high";
  reversible: true;
  validationPlan: string[];
  approvalScope: string;
  excludedActions: string[];
};

export type PreparedImprovement = {
  state: "AWAITING_APPROVAL";
  runId: string;
  approval: ApprovalActionView;
  plan: ImprovementPlan;
  council: { selection: DynamicCouncilSelection; synthesis: CouncilSynthesis | null };
};

export function isSelfImprovementIntent(message: string): boolean {
  const text = message.toLowerCase();
  const target = /\b(my os|myos|hermes os|your own|your command console|builder)\b/.test(text);
  const change = /\b(add|build|change|improve|fix|implement|integrate|install|replace|remove|redesign|upgrade)\b/.test(text);
  return target && change;
}

function inferLikelyFiles(objective: string): string[] {
  const text = objective.toLowerCase();
  const files = ["src/lib/orchestration/", "src/lib/__tests__/orchestration-*.test.ts"];
  if (/voice|audio|microphone/.test(text)) files.push("src/app/command-center/", "src/app/api/chat/");
  if (/council|model|provider/.test(text)) files.push("src/lib/model-council-chat.ts", "src/lib/council-providers.ts");
  if (/builder/.test(text)) files.push("src/lib/local-builder.ts", "src/app/command-center/BuilderOffice.tsx");
  if (/ui|console|dashboard|office/.test(text)) files.push("src/app/command-center/", "src/app/globals.css");
  return [...new Set(files)].slice(0, 8);
}

export function buildImprovementPlan(objective: string, selection: DynamicCouncilSelection, skillIds: string[]): ImprovementPlan {
  const protectedArea = /auth|secret|token|permission|policy|database|production|deploy/i.test(objective);
  return {
    objective,
    affectedWorkspace: { id: "my-os", label: "My OS", protected: true, registered: true },
    whyThisApproach: "Extend the existing My OS orchestration and UI contracts in an isolated worktree, then validate the smallest bounded change.",
    likelyFiles: inferLikelyFiles(objective),
    selectedAgents: selection.specialists,
    selectedExecutors: ["Prometheus", "Codex CLI", ...(selection.providerFamilies.includes("anthropic") ? ["Claude review when available"] : [])],
    selectedSkills: skillIds,
    requiredTools: ["registered workspace read", "isolated Git worktree", "existing test/build commands"],
    risk: protectedArea ? "high" : "medium",
    reversible: true,
    validationPlan: ["focused tests", "TypeScript", "lint", "full tests", "production build", "git diff --check", "targeted browser QA when UI changes"],
    approvalScope: "Implementation and validation in the registered isolated My OS workspace only.",
    excludedActions: ["merge", "deployment", "push", "force push", "production credential changes", "approval-policy bypass"],
  };
}

export function formatImprovementPlan(plan: ImprovementPlan, selection: DynamicCouncilSelection, synthesis: CouncilSynthesis | null): string {
  return [
    `I can make this improvement safely. I inspected the existing capability map and prepared one bounded plan; no source files have been changed.`,
    `## Objective\n${plan.objective}`,
    `## Why this approach\n${plan.whyThisApproach}`,
    `**Affected workspace:** ${plan.affectedWorkspace.label} · protected, registered workspace`,
    `**Likely files/components:** ${plan.likelyFiles.join(", ")}`,
    `**Agents:** ${plan.selectedAgents.join(", ")}`,
    `**Executors/providers:** ${plan.selectedExecutors.join(", ")}`,
    `**Skills:** ${plan.selectedSkills.length ? plan.selectedSkills.join(", ") : "No registry skill required"}`,
    `**Risk:** ${plan.risk} · **Reversible:** yes`,
    `## Validation\n${plan.validationPlan.map((item) => `- ${item}`).join("\n")}`,
    `## Council\n${selection.reason}\n${synthesis ? `Confidence: ${synthesis.confidence}. Disagreement: ${synthesis.disagreement}. ${synthesis.recommendation}` : "Reviewers were unavailable; the approval gate remains closed to implementation."}`,
    `Approve Plan authorizes implementation and validation only. It does not authorize merge, deployment, release, or push.`,
  ].join("\n\n");
}

export async function prepareSelfImprovement(userId: string, objective: string): Promise<PreparedImprovement> {
  const run = await createExecutionRun({ userId, executor: "internal", currentPhase: "planning", currentActivity: "Gathering bounded My OS context for a protected self-improvement request." });
  const skillResolution = await resolveRelevantSkills({ userId, message: objective, maxSkills: 3 }).catch(() => null);
  await appendExecutionEvent(run.id, { phase: "planning", source: "web", message: "Bounded context authorized: registered My OS architecture, relevant skill metadata, and current provider registry only.", safeDetails: { contextSources: ["registered My OS workspace metadata", "skill registry metadata", "provider registry"], maximumItems: 12 }, meaningful: true });
  const selection = selectDynamicCouncil(objective);
  const entries = councilProviderEntries().filter((entry) => selection.providerFamilies.includes(entry.family));
  const responses = await Promise.all(entries.map((entry) => runCouncilProvider(entry, objective)));
  const synthesis = responses.length ? synthesizeCouncil(responses) : null;
  await appendExecutionEvent(run.id, { phase: "planning", source: "web", message: `Dynamic Council selected ${selection.specialists.join(", ")}; providers: ${entries.map((entry) => entry.family).join(", ") || "none"}.`, safeDetails: { selection, synthesis }, meaningful: true });
  const plan = buildImprovementPlan(objective, selection, skillResolution?.skills.map((skill) => skill.id) ?? []);
  const approval = await createApproval(userId, "engineering_plan", {
    projectName: "My OS self-improvement",
    projectId: null,
    route: "self_improvement",
    repositorySlug: "local/my-os",
    objective: plan.objective,
    plan,
    executionRunId: run.id,
    approvalMeaning: plan.approvalScope,
    excludedActions: plan.excludedActions,
  });
  await appendExecutionEvent(run.id, { phase: "waiting_for_approval", source: "web", status: "waiting_approval", message: "Plan ready. Explicit Approve Plan is required before any My OS source write.", safeDetails: { approvalId: approval.id, plan }, meaningful: true });
  return { state: "AWAITING_APPROVAL", runId: run.id, approval, plan, council: { selection, synthesis } };
}
