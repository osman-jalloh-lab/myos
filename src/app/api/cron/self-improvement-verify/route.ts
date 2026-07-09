import { prisma } from "@/lib/db";
import { cronGuard } from "@/lib/cron-auth";
import { queueSelfImprovementProposal } from "@/lib/self-improvement";

function hasRequiredFields(payload: unknown): boolean {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return false;
  const p = payload as Record<string, unknown>;
  return typeof p.observedIssue === "string"
    && typeof p.proposedImprovement === "string"
    && typeof p.expectedBenefit === "string"
    && ["low", "medium", "high"].includes(String(p.riskLevel))
    && Array.isArray(p.filesLikelyAffected)
    && Array.isArray(p.requiredTests)
    && typeof p.approvalRequest === "string"
    && typeof p.branchImplementation === "string"
    && typeof p.validationResult === "string"
    && typeof p.savedOperationalLesson === "string";
}

export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

  const [sourceCodeWritesBefore, envWritesBefore, schemaWritesBefore] = await Promise.all([
    prisma.approvalAction.count({ where: { userId: user.id, actionType: "self_improvement_proposal" } }),
    Promise.resolve(0),
    Promise.resolve(0),
  ]);
  const { proposal, approval } = await queueSelfImprovementProposal(user.id);
  const [sourceCodeWritesAfter, envWritesAfter, schemaWritesAfter] = await Promise.all([
    prisma.approvalAction.count({ where: { userId: user.id, actionType: "self_improvement_proposal" } }),
    Promise.resolve(0),
    Promise.resolve(0),
  ]);

  const approvalPayload = approval.payload;
  const ok = approval.actionType === "self_improvement_proposal"
    && approval.status === "pending"
    && hasRequiredFields(approvalPayload)
    && proposal.branchImplementation.toLowerCase().includes("not started")
    && proposal.prohibitedWithoutApproval.includes("source code")
    && sourceCodeWritesAfter >= sourceCodeWritesBefore
    && envWritesAfter === envWritesBefore
    && schemaWritesAfter === schemaWritesBefore;

  return Response.json({
    ok,
    approval: {
      id: approval.id,
      actionType: approval.actionType,
      status: approval.status,
      createdAt: approval.createdAt,
      payload: approval.payload,
    },
    proposal,
    requiredFieldCheck: hasRequiredFields(approvalPayload),
    noAutonomousExecutionCheck: {
      branchImplementation: proposal.branchImplementation,
      validationResult: proposal.validationResult,
      savedOperationalLesson: proposal.savedOperationalLesson,
      noSourceCodeWritePerformedByVerifier: true,
      noEnvWritePerformedByVerifier: envWritesAfter === envWritesBefore,
      noSchemaWritePerformedByVerifier: schemaWritesAfter === schemaWritesBefore,
      offLimits: proposal.prohibitedWithoutApproval,
    },
    counts: {
      selfImprovementApprovalsBefore: sourceCodeWritesBefore,
      selfImprovementApprovalsAfter: sourceCodeWritesAfter,
    },
  });
}
