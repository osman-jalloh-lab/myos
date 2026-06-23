/**
 * Applies the Hermes persistent memory system DDL to Turso.
 * Creates: AgentSession, Project, ProjectTask tables.
 *
 * Usage: npx tsx scripts/migrate-memory-system.ts
 */
import { createClient } from "@libsql/client";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  console.log("Applying memory system migration...");

  // Working memory: one session per Telegram chat, tracks active project + goal
  await db.execute(`
    CREATE TABLE IF NOT EXISTS AgentSession (
      id          TEXT PRIMARY KEY,
      chatId      TEXT NOT NULL UNIQUE,
      userId      TEXT NOT NULL,
      activeProjectId TEXT,
      currentGoal TEXT,
      currentTask TEXT,
      lastSummary TEXT,
      lastUpdated TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_agent_session_user ON AgentSession(userId)`);
  console.log("  AgentSession — ok");

  // Project memory: active build projects Hermes is tracking for the user
  await db.execute(`
    CREATE TABLE IF NOT EXISTS Project (
      id                TEXT PRIMARY KEY,
      userId            TEXT NOT NULL,
      projectName       TEXT NOT NULL,
      description       TEXT,
      route             TEXT,
      localFolderPath   TEXT,
      localBuildLog     TEXT,
      localBuildError   TEXT,
      localDevUrl       TEXT,
      localDevPid       INTEGER,
      status            TEXT NOT NULL DEFAULT 'planning',
      latestInstruction TEXT,
      assignedAgent     TEXT,
      createdAt         TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt         TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`ALTER TABLE Project ADD COLUMN localFolderPath TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildLog TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildError TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevUrl TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevPid INTEGER`).catch(() => undefined);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_user ON Project(userId, status)`);
  console.log("  Project — ok");

  // Task memory: tasks belonging to a project
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ProjectTask (
      id            TEXT PRIMARY KEY,
      projectId     TEXT NOT NULL,
      userId        TEXT NOT NULL,
      title         TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'pending',
      assignedAgent TEXT,
      nextStep      TEXT,
      updatedAt     TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  await db.execute(`CREATE INDEX IF NOT EXISTS idx_project_task_project ON ProjectTask(projectId, status)`);
  console.log("  ProjectTask — ok");

  console.log("\nMemory system migration complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
