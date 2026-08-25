import { createPlanPreview } from "./plan-preview";
import { createApproval } from "@/lib/approvals";
import type { InlineButton } from "@/lib/telegram";

export async function createTelegramPlanPreview(userId: string, chatId: string, message: string, updateId?: number) {
  const preview = await createPlanPreview(userId, { message, conversationId: chatId, idempotencyKey: updateId === undefined ? undefined : `telegram:${chatId}:${updateId}` });

  // A plan-only preview does not authorize anything by itself. We still queue
  // an ApprovalAction the moment the preview is accepted so "Approve Plan" has
  // something to act on — the existing engineering_plan/self_improvement
  // execution path (src/lib/approvals.ts) already excludes merge/deploy/push.
  let approvalId: string | null = null;
  if (preview.accepted && preview.plan) {
    const approval = await createApproval(userId, "engineering_plan", {
      projectName: message.slice(0, 120),
      projectId: null,
      route: "self_improvement",
      objective: message,
      plan: preview.plan,
      excludedActions: ["merge", "deploy", "push"],
    });
    approvalId = approval.id;
  }

  return { ...preview, approvalId };
}

export function formatTelegramPlanPreview(preview: Awaited<ReturnType<typeof createTelegramPlanPreview>>): string {
  if (!preview.accepted || !preview.plan) return `Planning preview rejected: ${preview.policy.reasons.join(", ") || "policy validation failed"}.\n\nExecution has not started.`;
  const skills = preview.matchedSkills.length ? preview.matchedSkills.map((skill) => `- ${skill.name}`).join("\n") : "- No specific skill matched";
  return [`I classified this as a ${preview.envelope.taskClass} task.`, "", `Recommended executor: ${preview.plan.primaryExecutor}`, "Suggested skills:", skills, "", "Proposed flow:", ...preview.plan.steps.map((step, index) => `${index + 1}. ${step.purpose}`), "", preview.plan.disposition === "approval_required" ? "Approval will be required before future work can run." : "This is a read-only planning preview.", "Execution has not started."].join("\n");
}

/** Approve Plan / Revise / Ask Council / Reject buttons for a pending plan approval. */
export function telegramPlanButtonsForApproval(approvalId: string): InlineButton[][] {
  return [
    [{ text: "✅ Approve Plan", callback_data: `approve ${approvalId}` }],
    [{ text: "✏️ Revise", callback_data: `plan_revise ${approvalId}` }, { text: "🧠 Ask Council", callback_data: `plan_council ${approvalId}` }],
    [{ text: "❌ Reject", callback_data: `reject ${approvalId}` }],
  ];
}

/** Approve Plan / Revise / Ask Council / Reject — only rendered when a preview was accepted and an approval was queued. */
export function telegramPlanButtons(preview: Awaited<ReturnType<typeof createTelegramPlanPreview>>): InlineButton[][] | undefined {
  if (!preview.approvalId) return undefined;
  return telegramPlanButtonsForApproval(preview.approvalId);
}
