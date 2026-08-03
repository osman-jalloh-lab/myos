import { createPlanPreview } from "./plan-preview";

export async function createTelegramPlanPreview(userId: string, chatId: string, message: string, updateId?: number) {
  return createPlanPreview(userId, { message, conversationId: chatId, idempotencyKey: updateId === undefined ? undefined : `telegram:${chatId}:${updateId}` });
}

export function formatTelegramPlanPreview(preview: Awaited<ReturnType<typeof createTelegramPlanPreview>>): string {
  if (!preview.accepted || !preview.plan) return `Planning preview rejected: ${preview.policy.reasons.join(", ") || "policy validation failed"}.\n\nExecution has not started.`;
  const skills = preview.matchedSkills.length ? preview.matchedSkills.map((skill) => `- ${skill.name}`).join("\n") : "- No specific skill matched";
  return [`I classified this as a ${preview.envelope.taskClass} task.`, "", `Recommended executor: ${preview.plan.primaryExecutor}`, "Suggested skills:", skills, "", "Proposed flow:", ...preview.plan.steps.map((step, index) => `${index + 1}. ${step.purpose}`), "", preview.plan.disposition === "approval_required" ? "Approval will be required before future work can run." : "This is a read-only planning preview.", "Execution has not started."].join("\n");
}
