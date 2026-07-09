import { prisma } from "@/lib/db";
import { createApproval, type ApprovalActionView } from "@/lib/approvals";

export type SelfImprovementRisk = "low" | "medium" | "high";

export type SelfImprovementProposal = {
  mode: "dreaming";
  observedIssue: string;
  proposedImprovement: string;
  expectedBenefit: string;
  riskLevel: SelfImprovementRisk;
  filesLikelyAffected: string[];
  requiredTests: string[];
  approvalRequest: string;
  branchImplementation: string;
  validationResult: string;
  savedOperationalLesson: string;
  evidence: Array<{
    source: "skill_usage" | "run_inspector" | "memory_center";
    summary: string;
    count?: number;
    lastObservedAt?: string | null;
  }>;
  prohibitedWithoutApproval: string[];
};

type SkillUsageRow = {
  skillId: string;
  skillName: string | null;
  usageCount: number | bigint;
  avoidedCount: number | bigint | null;
  lastUsedAt: Date | string | null;
};

type StaleRunRow = {
  id: string;
  currentPhase: string | null;
  currentActivity: string | null;
  status: string | null;
  lastSafeError: string | null;
  startedAt: Date | string | null;
};

type LessonRow = {
  id: string;
  fact: string;
  source: string | null;
  createdAt: Date | string | null;
};

const OFF_LIMITS = [
  "source code",
  "system prompts",
  "agent permissions",
  "API keys",
  ".env files",
  "database schema",
  "production deployment settings",
  "approval thresholds",
  "GitHub branches",
  "external integrations",
];

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function baseProposal(input: Omit<SelfImprovementProposal, "mode" | "approvalRequest" | "branchImplementation" | "validationResult" | "savedOperationalLesson" | "prohibitedWithoutApproval">): SelfImprovementProposal {
  return {
    mode: "dreaming",
    ...input,
    approvalRequest: "Approve this proposal only to record Osman’s review intent. Implementation still requires an explicit follow-up branch/build request.",
    branchImplementation: "Not started. No branch will be created and no files will be edited from dreaming mode.",
    validationResult: "Not run. Validation is listed here as required future evidence before merging any approved implementation.",
    savedOperationalLesson: "Not saved yet. After a separately approved implementation validates, save the lesson through the existing Memory approval path.",
    prohibitedWithoutApproval: OFF_LIMITS,
  };
}

async function proposalFromSkillUsage(userId: string): Promise<SelfImprovementProposal | null> {
  const rows = await prisma.$queryRawUnsafe<SkillUsageRow[]>(
    `SELECT skillId, skillName, COUNT(*) AS usageCount, SUM(modelCallAvoided) AS avoidedCount, MAX(createdAt) AS lastUsedAt
     FROM SkillUsageTelemetry
     WHERE userId = ? AND skillId != 'none'
     GROUP BY skillId, skillName
     ORDER BY usageCount DESC, lastUsedAt DESC
     LIMIT 1`,
    userId,
  ).catch(() => []);
  const top = rows[0];
  if (!top || Number(top.usageCount) < 1) return null;
  const skillLabel = top.skillName || top.skillId;
  const usageCount = Number(top.usageCount);
  const avoidedCount = Number(top.avoidedCount ?? 0);
  return baseProposal({
    observedIssue: `Skill routing repeatedly selected ${skillLabel} from real SkillUsageTelemetry (${usageCount} selection${usageCount === 1 ? "" : "s"}${avoidedCount ? `, ${avoidedCount} model/API call${avoidedCount === 1 ? "" : "s"} avoided` : ""}).`,
    proposedImprovement: `Add a small regression guard or routing note for ${top.skillId} so future changes preserve this successful match pattern without loading every skill file.`,
    expectedBenefit: "Keeps skill-first routing reliable and cheap while making the repeated pattern visible to future maintainers.",
    riskLevel: "low",
    filesLikelyAffected: [
      "src/lib/skills/routing.ts",
      "src/lib/__tests__/skills-routing.test.ts",
    ],
    requiredTests: [
      "npx tsc --noEmit",
      "npm run lint",
      "npx vitest run src/lib/__tests__/skills-routing.test.ts",
      "npm test",
      "npm run build",
    ],
    evidence: [{
      source: "skill_usage",
      summary: `${top.skillId} selected ${usageCount} time(s); model/API calls avoided: ${avoidedCount}.`,
      count: usageCount,
      lastObservedAt: iso(top.lastUsedAt),
    }],
  });
}

async function proposalFromStaleRun(userId: string): Promise<SelfImprovementProposal | null> {
  const rows = await prisma.$queryRawUnsafe<StaleRunRow[]>(
    `SELECT id, currentPhase, currentActivity, status, lastSafeError, startedAt
     FROM ExecutionRun
     WHERE userId = ? AND (
       status = 'stalled'
       OR currentPhase = 'stalled'
       OR currentActivity LIKE '%stale%'
       OR lastSafeError IS NOT NULL
     )
     ORDER BY startedAt DESC
     LIMIT 1`,
    userId,
  ).catch(() => []);
  const run = rows[0];
  if (!run) return null;
  return baseProposal({
    observedIssue: `Run Inspector recorded a recoverability signal on run ${run.id.slice(0, 8)}: ${run.lastSafeError || run.currentActivity || run.status || run.currentPhase}.`,
    proposedImprovement: "Add a focused worker-stale diagnostic or clearer recovery prompt around this run state, without changing worker OAuth, credentials, or deployment settings.",
    expectedBenefit: "Makes unattended build recovery easier to understand before anyone reaches for a manual fix.",
    riskLevel: "medium",
    filesLikelyAffected: [
      "src/lib/execution-runs.ts",
      "src/lib/build-failure-diagnostics.ts",
      "src/lib/__tests__/execution-runs.test.ts",
    ],
    requiredTests: [
      "npx tsc --noEmit",
      "npm run lint",
      "npx vitest run src/lib/__tests__/execution-runs.test.ts src/lib/__tests__/build-failure-diagnostics.test.ts",
      "npm test",
      "npm run build",
    ],
    evidence: [{
      source: "run_inspector",
      summary: `${run.status ?? "unknown"} / ${run.currentPhase ?? "unknown"} / ${run.currentActivity ?? run.lastSafeError ?? "no detail"}`,
      lastObservedAt: iso(run.startedAt),
    }],
  });
}

async function proposalFromOperationalLesson(userId: string): Promise<SelfImprovementProposal | null> {
  const rows = await prisma.$queryRawUnsafe<LessonRow[]>(
    `SELECT id, fact, source, createdAt
     FROM Memory
     WHERE userId = ? AND approvedAt IS NOT NULL AND (
       source LIKE 'tool-health:%'
       OR source LIKE 'memory-center-verify:%'
       OR fact LIKE '%lesson%'
       OR fact LIKE '%verifier%'
     )
     ORDER BY createdAt DESC
     LIMIT 1`,
    userId,
  ).catch(() => []);
  const lesson = rows[0];
  if (!lesson) return null;
  return baseProposal({
    observedIssue: `Memory Center contains an operational lesson worth reviewing: ${lesson.fact.slice(0, 220)}.`,
    proposedImprovement: "Promote this repeated operational lesson into an explicit documented guardrail or verifier expectation after Osman approves the implementation scope.",
    expectedBenefit: "Turns a recovered operational pattern into a repeatable safety check while preserving Memory approval boundaries.",
    riskLevel: "low",
    filesLikelyAffected: [
      "src/lib/memory-center.ts",
      "src/lib/__tests__/memory-center.test.ts",
    ],
    requiredTests: [
      "npx tsc --noEmit",
      "npm run lint",
      "npx vitest run src/lib/__tests__/memory-center.test.ts",
      "npm test",
      "npm run build",
    ],
    evidence: [{
      source: "memory_center",
      summary: `${lesson.source ?? "memory"}: ${lesson.fact.slice(0, 180)}`,
      lastObservedAt: iso(lesson.createdAt),
    }],
  });
}

export async function generateSelfImprovementProposal(userId: string): Promise<SelfImprovementProposal> {
  const proposal =
    await proposalFromSkillUsage(userId)
    ?? await proposalFromStaleRun(userId)
    ?? await proposalFromOperationalLesson(userId);
  if (proposal) return proposal;
  return baseProposal({
    observedIssue: "No strong recurring pattern was found yet in SkillUsageTelemetry, Run Inspector, or Memory Center.",
    proposedImprovement: "Keep collecting telemetry until a real repeated signal appears; do not manufacture a code change.",
    expectedBenefit: "Avoids speculative self-improvement work without evidence.",
    riskLevel: "low",
    filesLikelyAffected: [],
    requiredTests: ["No implementation tests required until a real proposal is approved."],
    evidence: [{
      source: "memory_center",
      summary: "No qualifying live signal found.",
      count: 0,
      lastObservedAt: null,
    }],
  });
}

export async function queueSelfImprovementProposal(userId: string): Promise<{ proposal: SelfImprovementProposal; approval: ApprovalActionView }> {
  const proposal = await generateSelfImprovementProposal(userId);
  const approval = await createApproval(userId, "self_improvement_proposal", proposal);
  return { proposal, approval };
}
