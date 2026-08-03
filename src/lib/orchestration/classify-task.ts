import type { ExecutorId, TaskClass } from "./types";

export type TaskClassification = { taskClass: TaskClass; requestedOutcome: string; primaryExecutor: ExecutorId; reviewers: ExecutorId[]; requiresApproval: boolean; requiresFinalValidation: boolean };
export function classifyTask(message: string): TaskClassification {
  const text = message.toLowerCase();
  if (/\b(review|assess|audit|evaluate)\b/.test(text)) return { taskClass: "review", requestedOutcome: "A read-only review and recommendations.", primaryExecutor: "claude", reviewers: ["deepseek"], requiresApproval: false, requiresFinalValidation: false };
  if (/\b(research|investigate|compare|find)\b/.test(text)) return { taskClass: "research", requestedOutcome: "A research plan and grounded answer outline.", primaryExecutor: "claude", reviewers: [], requiresApproval: false, requiresFinalValidation: false };
  if (/\b(plan|roadmap|architecture|design|seo)\b/.test(text)) return { taskClass: "plan", requestedOutcome: "A structured planning recommendation.", primaryExecutor: "claude", reviewers: [], requiresApproval: false, requiresFinalValidation: false };
  if (/\b(build|implement|create.*(website|app|feature)|fix|code|develop)\b/.test(text)) return { taskClass: "code", requestedOutcome: "A proposed implementation plan; no code will run.", primaryExecutor: "codex", reviewers: [], requiresApproval: true, requiresFinalValidation: true };
  if (/\b(write|draft|email|reply|recommendation)\b/.test(text)) return { taskClass: "write", requestedOutcome: "A writing recommendation or draft plan.", primaryExecutor: "claude", reviewers: [], requiresApproval: true, requiresFinalValidation: false };
  return { taskClass: "answer", requestedOutcome: "A read-only answer and next steps.", primaryExecutor: "hermes", reviewers: [], requiresApproval: false, requiresFinalValidation: false };
}
