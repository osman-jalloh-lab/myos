import { createClient } from "@libsql/client";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const databases: string[] = [];

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => rm(database, { force: true }).catch(() => undefined)));
});

describe("Fugu schema-removal migration", () => {
  it("removes only retired review columns while preserving legacy project records", async () => {
    const database = path.join(os.tmpdir(), `hermes-fugu-removal-${crypto.randomUUID()}.db`);
    databases.push(database);
    const db = createClient({ url: `file:${database}` });
    await db.execute(`CREATE TABLE Project (
      id TEXT PRIMARY KEY, userId TEXT NOT NULL, projectName TEXT NOT NULL, description TEXT, route TEXT,
      status TEXT NOT NULL, latestInstruction TEXT, assignedAgent TEXT, localFolderPath TEXT,
      localBuildLog TEXT, localBuildError TEXT, localDevUrl TEXT, localDevPid INTEGER,
      localPreviewStatus TEXT, localPreviewCheckedAt TEXT, localResearchBrief TEXT,
      localDesignReview TEXT, localPolishReview TEXT, designScore INTEGER,
      fuguGateStatus TEXT, fuguGateScore INTEGER, fuguGateReview TEXT,
      fuguGateReviewedAt TEXT, fuguGateOverrideReason TEXT, fuguPolishStatus TEXT,
      localQaStatus TEXT, localQaChecklist TEXT, createdAt DATETIME, updatedAt DATETIME
    )`);
    await db.execute({
      sql: `INSERT INTO Project (id, userId, projectName, status, localResearchBrief, localQaStatus, localQaChecklist, localDesignReview, localPolishReview, designScore, fuguGateStatus, fuguGateScore, fuguGateReview, fuguGateReviewedAt, fuguGateOverrideReason, fuguPolishStatus) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: ["old", "user-1", "Old project", "fugu_design_complete", "research", "qa_pending", "[]", "review", "polish", 9, "pass", 9, "{}", "2026-08-01", "legacy override", "completed"],
    });
    await db.execute({
      sql: `INSERT INTO Project (id, userId, projectName, status, localResearchBrief, localQaStatus, localQaChecklist) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: ["modern", "user-1", "Modern project", "completed", "research", "qa_passed", "[]"],
    });

    const migration = readFileSync(path.join(process.cwd(), "prisma", "migrations", "20260802000000_remove_fugu_schema", "migration.sql"), "utf8");
    await db.executeMultiple(migration);

    const columns = await db.execute(`PRAGMA table_info("Project")`);
    const names = columns.rows.map((column) => String((column as Record<string, unknown>).name));
    expect(names).toEqual(expect.arrayContaining(["id", "userId", "projectName", "status", "localResearchBrief", "localQaStatus", "localQaChecklist"]));
    expect(names.join(" ")).not.toMatch(/fugu|designreview|polishreview|designscore/i);

    const projects = await db.execute(`SELECT id, projectName, status, localResearchBrief, localQaStatus FROM Project ORDER BY id`);
    expect(projects.rows).toEqual([
      { id: "modern", projectName: "Modern project", status: "completed", localResearchBrief: "research", localQaStatus: "qa_passed" },
      { id: "old", projectName: "Old project", status: "fugu_design_complete", localResearchBrief: "research", localQaStatus: "qa_pending" },
    ]);
  });
});
