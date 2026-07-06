import { createClient } from "@libsql/client";
import { randomUUID, createHash } from "node:crypto";

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
  fingerprint: string;
  status: "planned" | "approved" | "consumed" | "expired" | "rejected" | "failed";
  createdAt: string;
  expiresAt: string;
}

export interface ImproveApproval {
  id: string;
  planId: string;
  userId: string;
  fingerprint: string;
  status: "pending" | "approved" | "rejected" | "expired";
  createdAt: string;
  resolvedAt: string | null;
}

export interface ImproveTask {
  planId: string;
  approvalId?: string;
  title: string;
  description: string;
  executor: string;
  executionProfile: string;
  branch: string;
}

export function riskClassFor(text: string): { risk: RiskClass; reason: string; permissions: string[]; likelyFiles: string[]; tests: string[]; rollback: string; executor: string; executionProfile: string } {
  const t = text.toLowerCase();
  const hasAuth = /\b(auth|oauth|login|signin|session|cookie|secret|token|password|credential)\b/i.test(t);
  const hasDb = /\b(database|migration|migrate|schema|sql|prisma|turso)\b/i.test(t);
  const hasDeploy = /\b(deploy|production|vercel|main|merge)\b/i.test(t);
  const hasBuild = /\b(build|create|make|scaffold|generate|add|implement)\b/i.test(t);
  const hasEmail = /\b(email|gmail|send|message|notify)\b/i.test(t);
  const hasCalendar = /\b(calendar|event|meeting)\b/i.test(t);

  if (hasAuth || hasDb || hasDeploy) {
    return {
      risk: "red",
      reason: hasAuth ? "Authentication or secret-related change." : hasDb ? "Database or migration change." : "Production deployment or main branch change.",
      permissions: hasAuth ? ["auth:read", "auth:write"] : hasDb ? ["database:write"] : ["deploy:write"],
      likelyFiles: ["src/lib/auth.ts", "prisma/schema.prisma", "vercel.json"],
      tests: ["auth unit tests", "integration tests", "security review"],
      rollback: "Revert branch; do not migrate production without manual review.",
      executor: "manual",
      executionProfile: "none",
    };
  }

  if (hasEmail || hasCalendar) {
    return {
      risk: "yellow",
      reason: "External write capability requested.",
      permissions: hasEmail ? ["gmail.send"] : ["calendar.write"],
      likelyFiles: ["src/lib/email.ts", "src/app/api/email/route.ts"],
      tests: ["approval audit", "scope check"],
      rollback: "Delete task/approval; no side effects if blocked by scope.",
      executor: "hermes",
      executionProfile: "local_qa",
    };
  }

  if (hasBuild) {
    return {
      risk: "yellow",
      reason: "New code, route, or integration work.",
      permissions: ["filesystem:write", "build"],
      likelyFiles: ["src/app/...", "src/lib/..."],
      tests: ["unit tests", "lint", "build", "preview"],
      rollback: "Revert branch; delete created folder/files.",
      executor: "local_worker",
      executionProfile: "build",
    };
  }

  return {
    risk: "green",
    reason: "Low-risk styling, docs, tests, or isolated component change.",
    permissions: ["filesystem:write"],
    likelyFiles: ["src/...", "docs/..."],
    tests: ["lint", "unit tests"],
    rollback: "Revert branch.",
    executor: "local_worker",
    executionProfile: "research",
  };
}

export function normalizeIntent(text: string): string {
  const t = text.trim().toLowerCase();
  if (/voice|speech|microphone|listen/.test(t)) return "add_voice_capability";
  if (/dashboard|design|layout|ui|style/.test(t)) return "improve_dashboard_design";
  if (/tracker|project|task|manage/.test(t)) return "create_project_tracker";
  if (/email|summarize/.test(t)) return "summarize_email";
  if (/build|create|make|scaffold/.test(t)) return "create_new_capability";
  return "general_improvement";
}

export function capabilityName(text: string): string {
  const intent = normalizeIntent(text);
  const map: Record<string, string> = {
    add_voice_capability: "Voice Command Center",
    improve_dashboard_design: "Dashboard Design Refresh",
    create_project_tracker: "Project Tracker",
    summarize_email: "Email Summarizer",
    create_new_capability: "New Internal Tool",
    general_improvement: "MyOS Improvement",
  };
  return map[intent] ?? "MyOS Improvement";
}

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

export async function ensureImproveTables(): Promise<void> {
  const db = getDb();
  await db.execute(`
    CREATE TABLE IF NOT EXISTS ImprovePlan (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      requestText TEXT NOT NULL,
      normalizedIntent TEXT NOT NULL,
      capabilityName TEXT NOT NULL,
      summary TEXT NOT NULL,
      risk TEXT NOT NULL,
      riskReason TEXT NOT NULL,
      requestedPermissions TEXT NOT NULL,
      filesLikelyAffected TEXT NOT NULL,
      requiredTests TEXT NOT NULL,
      rollback TEXT NOT NULL,
      executor TEXT NOT NULL,
      executionProfile TEXT NOT NULL,
      requiresApproval INTEGER NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      createdAt TEXT DEFAULT (datetime('now')),
      expiresAt TEXT NOT NULL
    )
  `);
  await db.execute(`ALTER TABLE ImprovePlan ADD COLUMN executor TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE ImprovePlan ADD COLUMN executionProfile TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE ImprovePlan ADD COLUMN requiresApproval INTEGER`).catch(() => undefined);

  await db.execute(`
    CREATE TABLE IF NOT EXISTS ImproveApproval (
      id TEXT PRIMARY KEY,
      planId TEXT NOT NULL,
      userId TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      createdAt TEXT DEFAULT (datetime('now')),
      resolvedAt TEXT
    )
  `);
}

export async function createPlan(params: {
  userId: string;
  requestText: string;
  ttlMs?: number;
}): Promise<ImprovePlan> {
  await ensureImproveTables();
  const db = getDb();
  const id = randomUUID();
  const requestText = params.requestText.trim();
  const risk = riskClassFor(requestText);
  const normalizedIntent = normalizeIntent(requestText);
  const capability = capabilityName(requestText);
  const fingerprint = createHash("sha256").update(`${params.userId}:${requestText}:${normalizedIntent}:${capability}`).digest("hex");
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + (params.ttlMs ?? 60 * 60 * 1000)).toISOString();

  await db.execute({
    sql: `INSERT INTO ImprovePlan (id, userId, requestText, normalizedIntent, capabilityName, summary, risk, riskReason, requestedPermissions, filesLikelyAffected, requiredTests, rollback, executor, executionProfile, requiresApproval, fingerprint, status, createdAt, expiresAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      id,
      params.userId,
      requestText,
      normalizedIntent,
      capability,
      requestText,
      risk.risk,
      risk.reason,
      JSON.stringify(risk.permissions),
      JSON.stringify(risk.likelyFiles),
      JSON.stringify(risk.tests),
      risk.rollback,
      risk.executor,
      risk.executionProfile,
      risk.risk !== "green" ? 1 : 0,
      fingerprint,
      "planned",
      createdAt,
      expiresAt,
    ],
  });

  return {
    id,
    userId: params.userId,
    requestText,
    normalizedIntent,
    capabilityName: capability,
    summary: requestText,
    risk: risk.risk,
    riskReason: risk.reason,
    requestedPermissions: risk.permissions,
    filesLikelyAffected: risk.likelyFiles,
    requiredTests: risk.tests,
    rollback: risk.rollback,
    executor: risk.executor,
    executionProfile: risk.executionProfile,
    requiresApproval: risk.risk !== "green",
    fingerprint,
    status: "planned",
    createdAt,
    expiresAt,
  };
}

export async function getPlan(planId: string): Promise<ImprovePlan | null> {
  const db = getDb();
  const rows = await db.execute({ sql: `SELECT * FROM ImprovePlan WHERE id = ? LIMIT 1`, args: [planId] });
  if (!rows.rows.length) return null;
  const r = rows.rows[0] as Record<string, unknown>;
  return {
    id: String(r.id),
    userId: String(r.userId),
    requestText: String(r.requestText),
    normalizedIntent: String(r.normalizedIntent),
    capabilityName: String(r.capabilityName),
    summary: String(r.summary),
    risk: r.risk as RiskClass,
    riskReason: String(r.riskReason),
    requestedPermissions: JSON.parse(String(r.requestedPermissions)),
    filesLikelyAffected: JSON.parse(String(r.filesLikelyAffected)),
    requiredTests: JSON.parse(String(r.requiredTests)),
    rollback: String(r.rollback),
    executor: String(r.executor),
    executionProfile: String(r.executionProfile),
    requiresApproval: Boolean(r.requiresApproval),
    fingerprint: String(r.fingerprint),
    status: r.status as ImprovePlan["status"],
    createdAt: String(r.createdAt),
    expiresAt: String(r.expiresAt),
  };
}

export async function createApproval(params: { planId: string; userId: string }): Promise<ImproveApproval> {
  await ensureImproveTables();
  const plan = await getPlan(params.planId);
  if (!plan) throw new Error("Plan not found");
  if (plan.userId !== params.userId) throw new Error("Forbidden");
  if (plan.status !== "planned") throw new Error("Plan is not approvable");
  if (new Date(plan.expiresAt).getTime() < Date.now()) throw new Error("Plan expired");

  const db = getDb();
  const id = randomUUID();
  await db.execute({
    sql: `INSERT INTO ImproveApproval (id, planId, userId, fingerprint, status, createdAt) VALUES (?, ?, ?, ?, 'pending', datetime('now'))`,
    args: [id, params.planId, params.userId, plan.fingerprint],
  });
  return { id, planId: params.planId, userId: params.userId, fingerprint: plan.fingerprint, status: "pending", createdAt: new Date().toISOString(), resolvedAt: null };
}

export async function getApproval(approvalId: string): Promise<ImproveApproval | null> {
  const db = getDb();
  const rows = await db.execute({ sql: `SELECT * FROM ImproveApproval WHERE id = ? LIMIT 1`, args: [approvalId] });
  if (!rows.rows.length) return null;
  const r = rows.rows[0] as Record<string, unknown>;
  return { id: String(r.id), planId: String(r.planId), userId: String(r.userId), fingerprint: String(r.fingerprint), status: r.status as ImproveApproval["status"], createdAt: String(r.createdAt), resolvedAt: r.resolvedAt ? String(r.resolvedAt) : null };
}

export async function approveAndConsume(approvalId: string): Promise<{ approval: ImproveApproval; plan: ImprovePlan }> {
  const db = getDb();
  const approval = await getApproval(approvalId);
  if (!approval) throw new Error("Approval not found");
  if (approval.status !== "pending") throw new Error("Approval already resolved");
  const plan = await getPlan(approval.planId);
  if (!plan) throw new Error("Plan not found");
  if (plan.userId !== approval.userId) throw new Error("Wrong user");
  if (plan.status !== "planned") throw new Error("Plan not approvable");
  if (plan.fingerprint !== approval.fingerprint) throw new Error("Fingerprint mismatch");
  if (new Date(plan.expiresAt).getTime() < Date.now()) throw new Error("Plan expired");

  await db.execute({
    sql: `UPDATE ImproveApproval SET status = 'approved', resolvedAt = datetime('now') WHERE id = ?`,
    args: [approvalId],
  });
  await db.execute({
    sql: `UPDATE ImprovePlan SET status = 'approved' WHERE id = ?`,
    args: [approval.planId],
  });
  const approvedPlan = await getPlan(approval.planId);
  if (!approvedPlan) throw new Error("Plan missing after approval");
  return {
    approval: { ...approval, status: "approved", resolvedAt: new Date().toISOString() },
    plan: approvedPlan,
  };
}

export async function createImproveTask(params: ImproveTask & { userId: string }): Promise<{ taskId: string }> {
  const { createExecutionQueueTask } = await import("./execution-queue");
  const task = await createExecutionQueueTask({
    userId: params.userId,
    title: params.title,
    description: params.description,
    priority: "medium",
    assignedExecutor: params.executor,
    initialLog: `planId=${params.planId}${params.approvalId ? ` approvalId=${params.approvalId}` : ""} profile=${params.executionProfile} branch=${params.branch}`,
  });
  return { taskId: task.id };
}
