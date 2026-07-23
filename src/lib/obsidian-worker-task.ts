export const OBSIDIAN_WORKER_EXECUTOR = "obsidian_worker";

export const OBSIDIAN_OPERATIONS = [
  "obsidian.listNotes",
  "obsidian.readNote",
  "obsidian.searchNotes",
  "obsidian.writeNote",
] as const;

export type ObsidianOperation = (typeof OBSIDIAN_OPERATIONS)[number];

export type ObsidianWorkerPayload = {
  operation: ObsidianOperation;
  path?: string;
  query?: string;
  content?: string;
  mode?: "overwrite" | "append";
};

export function isObsidianOperation(value: unknown): value is ObsidianOperation {
  return typeof value === "string"
    && (OBSIDIAN_OPERATIONS as readonly string[]).includes(value);
}
