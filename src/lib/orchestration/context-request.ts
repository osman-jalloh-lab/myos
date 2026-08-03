import type { DataClass, OrchestrationEnvelopeV1, PolicyReason } from "./types";

export const MAX_CONTEXT_ITEMS = 50;
export const ALLOWED_CONTEXT_SOURCES = ["memory", "work_knowledge", "approved_documents", "task_history"] as const;
export function validateContextRequest(envelope: OrchestrationEnvelopeV1, dataClasses: DataClass[]): PolicyReason[] {
  const request = envelope.contextRequest; const reasons: PolicyReason[] = [];
  if (!request.query.trim()) reasons.push({ code: "context_query_required", message: "Context requests require a task-specific query.", path: "contextRequest.query" });
  if (!Number.isInteger(request.maximumItems) || request.maximumItems < 1 || request.maximumItems > MAX_CONTEXT_ITEMS) reasons.push({ code: "context_unbounded", message: `Context maximumItems must be between 1 and ${MAX_CONTEXT_ITEMS}.`, path: "contextRequest.maximumItems" });
  if (!request.allowedSources.length || request.allowedSources.some((source) => !(ALLOWED_CONTEXT_SOURCES as readonly string[]).includes(source))) reasons.push({ code: "context_source_denied", message: "Context request contains a non-permitted source.", path: "contextRequest.allowedSources" });
  if (request.allowedSources.some((source) => /vault|secret/i.test(source))) reasons.push({ code: "context_full_store_denied", message: "Vault and secret-store context access is not available through orchestration.", path: "contextRequest.allowedSources" });
  if (envelope.dataClass === "SECRET" || !dataClasses.includes(envelope.dataClass)) reasons.push({ code: "context_data_class_denied", message: "The selected executor cannot receive this data class.", path: "dataClass" });
  return reasons;
}
