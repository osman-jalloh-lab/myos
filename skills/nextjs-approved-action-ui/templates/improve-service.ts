import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import { createExecutionQueueTask } from "@/lib/execution-queue";

type RiskClass = "green" | "yellow" | "red";

export interface ImprovePlan {
  id: string;
  userId: string;
  requestText: string;
  normalizedIntent: string;
  capabilityName: string;
  summary: string;
  risk: RiskClass;
  riskReason: string;
  requestedPermissions: string[];
  filesLikelyAffected: string[];
  requiredTests: string[];
  rollback: string;
  executor: string;
  executionProfile: string;
  requiresApproval: boolean;
  status: string;
  createdAt: string;
}

export interface ImproveTask {
  taskId: string;
  status: string;
  executor: string;
  executionProfile: string;
  branch: string;
}

// For production, replace with deterministic prompt or tags.
function classifyRisk(text: string): { risk: RiskClass; reason: string } {
  if (/\b(build|deploy|send|email|calendar|event|meeting|delete|remove|update|change|write|save|publish|post)\b/i.test(text)) {
    return { risk: "yellow", reason: "Request touches build, write, or external action" };
  }
  if (/\b(read|view|show|list|search|find|check)\b/i.test(text)) {
    return { risk: "green", reason: "Request is read-only" };
  }
  return { risk: "yellow", reason: "Unknown action defaults to cautious classification" };
}

export async function createPlan(params: { requestText: string; userId: string }): Promise<ImprovePlan> {
  const risk = classifyRisk(params.requestText).risk;
  return {
    id: crypto.randomUUID(),
    userId: params.userId,
    requestText: params.requestText,
    normalizedIntent: params.requestText.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    capabilityName: `capability:${params.requestText.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    summary: params.requestText.trim(),
    risk,
    riskReason: classifyRisk(params.requestText).reason,
    requestedPermissions: risk === "green" ? ["read"] : ["write"],
    filesLikelyAffected: [],
    requiredTests: risk === "green" ? ["lint"] : ["lint", "test", "build"],
    rollback: risk === "green" ? "none" : "git revert",
    executor: "local-builder",
    executionProfile: "write",
    requiresApproval: risk !== "green",
    status: "draft",
    createdAt: new Date().toISOString(),
  };
}

// Stub: persist plan via libsql/d1/etc.
export async function getPlan(id: string, userId: string): Promise<ImprovePlan | null> {
  return null;
}

export async function createApproval(params: { planId: string; userId: string }): Promise<{ id: string; status: string; createdAt: string }> {
  return { id: crypto.randomUUID(), status: "approved", createdAt: new Date().toISOString() };
}

export async function approveAndConsume(planId: string, approvalId: string): Promise<boolean> {
  // Stub: verify approval ownership/code matches
  return true;
}

export async function createImproveTask(params: ImproveTask & { userId: string; planId: string; approvalId?: string }): Promise<{ taskId: string }> {
  await createExecutionQueueTask({
    userId: params.userId,
    kind: "improve",
    payload: { planId: params.planId, approvalId: params.approvalId },
  });
  return { taskId: params.taskId };
}
