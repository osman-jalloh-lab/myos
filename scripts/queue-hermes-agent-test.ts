import { createClient } from "@libsql/client";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

function loadEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match || process.env[match[1]]) continue;
    process.env[match[1]] = match[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
}

async function main(): Promise<void> {
  loadEnv(path.resolve(".env.local"));
  loadEnv(path.resolve(".env"));
  if (!process.env.TURSO_DATABASE_URL) throw new Error("TURSO_DATABASE_URL is required.");

  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  const users = await db.execute("SELECT id FROM User ORDER BY rowid ASC LIMIT 1");
  const userId = String(users.rows[0]?.id ?? "");
  if (!userId) throw new Error("No Parawi user exists for the test task.");

  const request = "Build a clean modern website called Clone for a personal productivity app.";
  const builder = await import("../src/lib/local-builder");
  const project = await builder.prepareLocalBuildProject(userId, request);
  if (!project) throw new Error("Builder could not prepare Clone.");
  await db.execute({
    sql: `UPDATE AgentTask SET status = 'failed', error = 'Test worker was interrupted during validation.', updatedAt = datetime('now') WHERE project_id = ? AND assigned_executor = 'hermes_agent' AND status = 'executing'`,
    args: [project.id],
  });
  const queued = await builder.queueLocalBuilderWorkerTask(userId, "generate", request, project.id, "hermes_agent");
  if (!queued) throw new Error("Could not queue Clone.");
  console.log(`Queued Clone: task=${queued.taskId} executor=hermes_agent folder=${queued.localFolderPath}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
