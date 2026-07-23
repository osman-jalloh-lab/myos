import { createApproval } from "@/lib/approvals";
import { createExecutionQueueTask } from "@/lib/execution-queue";
import {
  OBSIDIAN_WORKER_EXECUTOR,
  type ObsidianOperation,
  type ObsidianWorkerPayload,
} from "@/lib/obsidian-worker-task";
import { registerTool } from "../tool-registry";
import type { ToolContext } from "../types";

function optionalPath(input: Record<string, unknown>): string | undefined {
  const value = input.path;
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new Error("path must be a non-empty string when provided.");
  return value.trim();
}

function requiredString(input: Record<string, unknown>, key: "path" | "query" | "content"): string {
  const value = input[key];
  if (typeof value !== "string" || !value.trim()) throw new Error(`${key} is required.`);
  return value.trim();
}

async function queueObsidianTask(
  ctx: ToolContext,
  operation: Exclude<ObsidianOperation, "obsidian.writeNote">,
  payload: ObsidianWorkerPayload,
) {
  const task = await createExecutionQueueTask({
    userId: ctx.userId,
    title: `Obsidian: ${operation}`,
    description: JSON.stringify(payload),
    priority: "medium",
    assignedExecutor: OBSIDIAN_WORKER_EXECUTOR,
    initialLog: `Queued ${operation} for the local worker.`,
  });
  return {
    answer: `${operation} is queued for the local worker (task ${task.id.slice(0, 8)}).`,
    artifacts: [{ type: "task" as const, title: `Obsidian ${operation}`, id: task.id }],
  };
}

export function registerObsidianTools(): void {
  registerTool({
    name: "obsidian.listNotes",
    description: "List Markdown notes in the local Obsidian vault.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx) => queueObsidianTask(ctx, "obsidian.listNotes", {
      operation: "obsidian.listNotes",
      path: optionalPath(input),
    }),
  });

  registerTool({
    name: "obsidian.readNote",
    description: "Read one Markdown note from the local Obsidian vault.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx) => queueObsidianTask(ctx, "obsidian.readNote", {
      operation: "obsidian.readNote",
      path: requiredString(input, "path"),
    }),
  });

  registerTool({
    name: "obsidian.searchNotes",
    description: "Search the text of Markdown notes in the local Obsidian vault.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx) => queueObsidianTask(ctx, "obsidian.searchNotes", {
      operation: "obsidian.searchNotes",
      query: requiredString(input, "query"),
      path: optionalPath(input),
    }),
  });

  registerTool({
    name: "obsidian.writeNote",
    description: "Request an approved overwrite or append to a local Obsidian note.",
    risk: "internal_write",
    requiresApproval: true,
    execute: async (input, ctx) => {
      const mode = input.mode === "append" ? "append" : input.mode === "overwrite" ? "overwrite" : null;
      if (!mode) throw new Error('mode must be "overwrite" or "append".');
      const approval = await createApproval(ctx.userId, "obsidian_write_note", {
        operation: "obsidian.writeNote",
        path: requiredString(input, "path"),
        content: requiredString(input, "content"),
        mode,
      });
      return {
        answer: `Obsidian write queued for approval (id: ${approval.id.slice(0, 8)}).`,
        artifacts: [{ type: "task" as const, title: "Obsidian write pending approval", id: approval.id }],
      };
    },
  });
}
