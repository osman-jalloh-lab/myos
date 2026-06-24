/**
 * Hermes persistent memory system.
 * Manages AgentSession, Project, and ProjectTask rows (created via migration script).
 * Uses raw libSQL for the 3 new tables and Prisma for ChatMessage.
 *
 * Entry points used by the Telegram webhook:
 *   buildContextBlock()         — build the memory context string before each LLM call
 *   updateSessionAfterResponse() — update session goal + maybe summarize after each reply
 */
import { createClient } from "@libsql/client";
import { prisma } from "@/lib/db";
import crypto from "node:crypto";
import { getContextCards, readMemory } from "@/agents/mnemosyne";

// ── DB client (lazy singleton) ────────────────────────────────────────────────

let _db: ReturnType<typeof createClient> | null = null;

function getDb() {
  if (!_db) {
    _db = createClient({
      url: process.env.TURSO_DATABASE_URL!,
      authToken: process.env.TURSO_AUTH_TOKEN,
    });
  }
  return _db;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AgentSession {
  id: string;
  chatId: string;
  userId: string;
  activeProjectId: string | null;
  currentGoal: string | null;
  currentTask: string | null;
  lastSummary: string | null;
  lastUpdated: string;
}

export interface Project {
  id: string;
  userId: string;
  projectName: string;
  description: string | null;
  route: string | null;
  status: string;
  latestInstruction: string | null;
  assignedAgent: string | null;
}

export interface ProjectTask {
  id: string;
  projectId: string;
  userId: string;
  title: string;
  description: string | null;
  status: string;
  assignedAgent: string | null;
  nextStep: string | null;
}

type DbRow = Record<string, string | number | null | undefined>;

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function rowToSession(r: DbRow): AgentSession {
  return {
    id: str(r.id) ?? "",
    chatId: str(r.chatId) ?? "",
    userId: str(r.userId) ?? "",
    activeProjectId: str(r.activeProjectId),
    currentGoal: str(r.currentGoal),
    currentTask: str(r.currentTask),
    lastSummary: str(r.lastSummary),
    lastUpdated: str(r.lastUpdated) ?? new Date().toISOString(),
  };
}

function rowToProject(r: DbRow): Project {
  return {
    id: str(r.id) ?? "",
    userId: str(r.userId) ?? "",
    projectName: str(r.projectName) ?? "",
    description: str(r.description),
    route: str(r.route),
    status: str(r.status) ?? "planning",
    latestInstruction: str(r.latestInstruction),
    assignedAgent: str(r.assignedAgent),
  };
}

function rowToTask(r: DbRow): ProjectTask {
  return {
    id: str(r.id) ?? "",
    projectId: str(r.projectId) ?? "",
    userId: str(r.userId) ?? "",
    title: str(r.title) ?? "",
    description: str(r.description),
    status: str(r.status) ?? "pending",
    assignedAgent: str(r.assignedAgent),
    nextStep: str(r.nextStep),
  };
}

// ── Session ───────────────────────────────────────────────────────────────────

export async function getOrCreateSession(chatId: string, userId: string): Promise<AgentSession> {
  const db = getDb();
  const res = await db.execute({ sql: `SELECT * FROM AgentSession WHERE chatId = ? LIMIT 1`, args: [chatId] });
  if (res.rows.length > 0) return rowToSession(res.rows[0] as unknown as DbRow);

  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO AgentSession (id, chatId, userId) VALUES (?, ?, ?)`,
    args: [id, chatId, userId],
  });
  return { id, chatId, userId, activeProjectId: null, currentGoal: null, currentTask: null, lastSummary: null, lastUpdated: new Date().toISOString() };
}

export async function updateSession(
  chatId: string,
  updates: Partial<Pick<AgentSession, "activeProjectId" | "currentGoal" | "currentTask" | "lastSummary">>
): Promise<void> {
  const db = getDb();
  const fields: string[] = [];
  const args: (string | null)[] = [];
  if (updates.activeProjectId !== undefined) { fields.push("activeProjectId = ?"); args.push(updates.activeProjectId); }
  if (updates.currentGoal !== undefined) { fields.push("currentGoal = ?"); args.push(updates.currentGoal); }
  if (updates.currentTask !== undefined) { fields.push("currentTask = ?"); args.push(updates.currentTask); }
  if (updates.lastSummary !== undefined) { fields.push("lastSummary = ?"); args.push(updates.lastSummary); }
  if (fields.length === 0) return;
  fields.push("lastUpdated = datetime('now')");
  args.push(chatId);
  await db.execute({ sql: `UPDATE AgentSession SET ${fields.join(", ")} WHERE chatId = ?`, args });
}

// ── Project ───────────────────────────────────────────────────────────────────

async function getProject(projectId: string): Promise<Project | null> {
  const db = getDb();
  const res = await db.execute({ sql: `SELECT * FROM Project WHERE id = ? LIMIT 1`, args: [projectId] });
  if (!res.rows.length) return null;
  return rowToProject(res.rows[0] as unknown as DbRow);
}

export async function getProjectTasks(projectId: string): Promise<ProjectTask[]> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM ProjectTask WHERE projectId = ? ORDER BY updatedAt DESC LIMIT 15`,
    args: [projectId],
  });
  return res.rows.map((r) => rowToTask(r as unknown as DbRow));
}

export async function getActiveProject(chatId: string): Promise<Project | null> {
  const db = getDb();
  const sessionRes = await db.execute({ sql: `SELECT activeProjectId FROM AgentSession WHERE chatId = ? LIMIT 1`, args: [chatId] });
  if (!sessionRes.rows.length) return null;
  const activeProjectId = str((sessionRes.rows[0] as unknown as DbRow).activeProjectId);
  if (!activeProjectId) return null;
  return getProject(activeProjectId);
}

export async function updateProjectStatus(projectId: string, status: string): Promise<void> {
  const db = getDb();
  await db.execute({
    sql: `UPDATE Project SET status = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [status, projectId],
  });
}

export async function createProjectTasksFromPlan(
  projectId: string,
  userId: string,
  steps: Array<{ title: string; assignedAgent?: string; description?: string }>
): Promise<ProjectTask[]> {
  // Avoid duplicating tasks that already exist for this project
  const existing = await getProjectTasks(projectId);
  const existingTitles = new Set(existing.map((t) => t.title.toLowerCase()));
  const toCreate = steps.filter((s) => !existingTitles.has(s.title.toLowerCase()));
  return Promise.all(
    toCreate.map((s) => createProjectTask(projectId, userId, s.title, { assignedAgent: s.assignedAgent, description: s.description }))
  );
}

// Detects explicit build intent and extracts a project name from natural language
const BUILD_INTENT_RE = /\b(build|create|make|start|design|develop|working on|let'?s build|let'?s make|i want to build|i want to create)\b/i;
const PROJECT_EXTRACT_RE = /\b(?:build|create|make|start|design|develop)\s+(?:a\s+|an\s+|the\s+)?(.{3,50}?)(?:\s+(?:for\s+me|that|with|using|in|and\s)|[.!?\n]|$)/i;

async function detectOrCreateProject(userId: string, text: string): Promise<Project | null> {
  if (!BUILD_INTENT_RE.test(text)) return null;
  const match = text.match(PROJECT_EXTRACT_RE);
  if (!match) return null;

  const rawName = match[1].replace(/\s+/g, " ").trim();
  if (rawName.length < 3 || rawName.length > 60) return null;

  const projectName = rawName.replace(/\b\w/g, (c) => c.toUpperCase());
  const route = `/${rawName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`;

  const db = getDb();
  const existing = await db.execute({
    sql: `SELECT * FROM Project WHERE userId = ? AND lower(projectName) LIKE lower(?) LIMIT 1`,
    args: [userId, `%${projectName.toLowerCase().slice(0, 15)}%`],
  });

  if (existing.rows.length > 0) {
    const project = rowToProject(existing.rows[0] as unknown as DbRow);
    await db.execute({
      sql: `UPDATE Project SET status = 'building', latestInstruction = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [text.slice(0, 500), project.id],
    });
    return { ...project, status: "building", latestInstruction: text.slice(0, 500) };
  }

  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO Project (id, userId, projectName, route, status, latestInstruction, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'planning', ?, datetime('now'), datetime('now'))`,
    args: [id, userId, projectName, route, text.slice(0, 500)],
  });

  return {
    id, userId, projectName, route, status: "planning",
    latestInstruction: text.slice(0, 500), description: null, assignedAgent: null,
  };
}

/** Create or reactivate the concrete project behind an execution-layer build. */
export async function ensureBuildProject(chatId: string, userId: string, route: string, instruction: string): Promise<Project> {
  const db = getDb();
  const normalizedRoute = `/${route.replace(/^\/+|\/+$/g, "")}`;
  const existing = await db.execute({ sql: `SELECT * FROM Project WHERE userId = ? AND route = ? LIMIT 1`, args: [userId, normalizedRoute] });
  let project: Project;
  if (existing.rows.length) {
    project = rowToProject(existing.rows[0] as unknown as DbRow);
    await db.execute({ sql: `UPDATE Project SET status = 'building', latestInstruction = ?, assignedAgent = 'hermes-execution', updatedAt = datetime('now') WHERE id = ?`, args: [instruction.slice(0, 500), project.id] });
    project = { ...project, status: "building", latestInstruction: instruction.slice(0, 500), assignedAgent: "hermes-execution" };
  } else {
    const id = crypto.randomUUID();
    const projectName = normalizedRoute.slice(1).split("-").map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(" ") || "Hermes Build";
    await db.execute({ sql: `INSERT INTO Project (id, userId, projectName, route, status, latestInstruction, assignedAgent, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'building', ?, 'hermes-execution', datetime('now'), datetime('now'))`, args: [id, userId, projectName, normalizedRoute, instruction.slice(0, 500)] });
    project = { id, userId, projectName, route: normalizedRoute, status: "building", latestInstruction: instruction.slice(0, 500), description: null, assignedAgent: "hermes-execution" };
  }
  await getOrCreateSession(chatId, userId);
  await updateSession(chatId, { activeProjectId: project.id, currentTask: instruction.slice(0, 500) });
  return project;
}

// ── Context block builder ─────────────────────────────────────────────────────

/**
 * Builds the MEMORY CONTEXT block prepended to every Telegram LLM call.
 * Loads: session, active project + tasks, last 20 Telegram chat messages.
 * Returns empty string when there is nothing meaningful to inject.
 */
export async function buildContextBlock(chatId: string, userId: string, newMessage: string): Promise<string> {
  const [session, recentMessages, pendingApprovals, recentMemories, relevantMemories] = await Promise.all([
    getOrCreateSession(chatId, userId),
    prisma.chatMessage.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { role: true, content: true, createdAt: true },
    }),
    prisma.approvalAction.findMany({
      where: { userId, status: "pending" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: { id: true, actionType: true, payload: true, createdAt: true },
    }),
    readMemory(userId).catch(() => []),
    getContextCards(userId, newMessage, 8).catch(() => []),
  ]);

  let activeProject: Project | null = null;
  let tasks: ProjectTask[] = [];

  if (session.activeProjectId) {
    activeProject = await getProject(session.activeProjectId);
    if (activeProject) {
      tasks = await getProjectTasks(activeProject.id);
      // Keep latestInstruction fresh on every follow-up message
      const db = getDb();
      await db.execute({
        sql: `UPDATE Project SET latestInstruction = ?, updatedAt = datetime('now') WHERE id = ?`,
        args: [newMessage.slice(0, 500), activeProject.id],
      });
      activeProject = { ...activeProject, latestInstruction: newMessage.slice(0, 500) };
    }
  } else {
    // Try to detect a new project from this message
    activeProject = await detectOrCreateProject(userId, newMessage).catch(() => null);
    if (activeProject) {
      await updateSession(chatId, { activeProjectId: activeProject.id });
      tasks = await getProjectTasks(activeProject.id);
    }
  }

  const lines: string[] = [];

  if (activeProject) {
    lines.push(`ACTIVE PROJECT: ${activeProject.projectName} [${activeProject.status}]`);
    lines.push(`PROJECT_ID: ${activeProject.id}`);
    if (activeProject.route) lines.push(`Route: ${activeProject.route}`);
    if (activeProject.latestInstruction) {
      lines.push(`Last instruction: ${activeProject.latestInstruction.slice(0, 300)}`);
    }
    if (tasks.length > 0) {
      lines.push("Tasks:");
      for (const t of tasks) {
        lines.push(`  - [${t.status}] ${t.title}${t.nextStep ? ` (next: ${t.nextStep})` : ""}`);
      }
    }
    lines.push("");
  }

  if (pendingApprovals.length > 0) {
    lines.push(`PENDING APPROVALS (${pendingApprovals.length}):`);
    for (const a of pendingApprovals) {
      let summary = a.actionType;
      try {
        const p = JSON.parse(a.payload) as Record<string, unknown>;
        if (a.actionType === "engineering_plan") summary = `Build plan: ${String(p.projectName ?? "").slice(0, 60)}`;
        else if (a.actionType === "save_memory") summary = `Remember: "${String(p.fact ?? "").slice(0, 60)}"`;
        else if (a.actionType === "create_task") summary = `Task: "${String(p.title ?? "").slice(0, 60)}"`;
      } catch { /* ignore parse errors */ }
      lines.push(`  - ${summary} (id:${a.id})`);
    }
    lines.push("");
  }

  const memoryLines = [
    ...relevantMemories.map((m) => `  - ${m.fact}${m.source ? ` (source: ${m.source})` : ""}`),
    ...recentMemories
      .filter((m) => !relevantMemories.some((r) => r.fact === m.fact))
      .slice(0, 5)
      .map((m) => `  - ${m.fact}${m.source ? ` (source: ${m.source})` : ""}`),
  ].slice(0, 10);
  if (memoryLines.length > 0) {
    lines.push("APPROVED MEMORY:");
    lines.push(...memoryLines);
    lines.push("");
  }

  if (session.lastSummary) {
    lines.push(`CONVERSATION SUMMARY: ${session.lastSummary}`);
    lines.push("");
  }

  if (session.currentGoal && session.currentGoal.slice(0, 100) !== newMessage.slice(0, 100)) {
    lines.push(`SESSION GOAL: ${session.currentGoal}`);
    lines.push("");
  }

  // Last 20 messages chronologically (fetched desc, so reverse)
  const ordered = recentMessages.reverse().slice(-20);
  if (ordered.length > 1) {
    lines.push("RECENT CONVERSATION:");
    for (const m of ordered) {
      const speaker = m.role === "user" ? "osman" : "hermes";
      lines.push(`  [${speaker}]: ${m.content.slice(0, 250)}`);
    }
    lines.push("");
  }

  if (lines.length === 0) return "";
  return lines.join("\n").trim();
}

// ── Post-response session update ──────────────────────────────────────────────

export async function updateSessionAfterResponse(chatId: string, userId: string, userMessage: string): Promise<void> {
  await updateSession(chatId, { currentGoal: userMessage.slice(0, 200) }).catch(() => {});
  await maybeSummarize(chatId, userId).catch(() => {});
}

// ── Auto-summarization (every 20 Telegram messages) ───────────────────────────

async function maybeSummarize(chatId: string, userId: string): Promise<void> {
  const count = await prisma.chatMessage.count({ where: { userId } });
  if (count < 20 || count % 20 !== 0) return;

  const recent = await prisma.chatMessage.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { role: true, content: true },
  });

  const conversation = recent
    .reverse()
    .map((m) => `${m.role === "user" ? "osman" : "hermes"}: ${m.content.slice(0, 300)}`)
    .join("\n");

  const { callModel } = await import("@/lib/modelRouter");
  const result = await callModel({
    userId,
    taskType: "memory-summarize",
    dataClass: "PERSONAL",
    systemPrompt: "Compress this conversation into a concise memory note. Include: decisions made, work completed, blockers, next actions. Max 200 words. Be specific.",
    userPrompt: conversation,
  });

  await updateSession(chatId, { lastSummary: result.text.slice(0, 800) });
}

// ── Public task helpers (for use by agents) ───────────────────────────────────

export async function createProjectTask(
  projectId: string,
  userId: string,
  title: string,
  options?: { description?: string; assignedAgent?: string; nextStep?: string }
): Promise<ProjectTask> {
  const db = getDb();
  const id = crypto.randomUUID();
  await db.execute({
    sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [id, projectId, userId, title, options?.description ?? null, options?.assignedAgent ?? null, options?.nextStep ?? null],
  });
  return {
    id, projectId, userId, title,
    description: options?.description ?? null,
    status: "pending",
    assignedAgent: options?.assignedAgent ?? null,
    nextStep: options?.nextStep ?? null,
  };
}

export async function listProjects(userId: string): Promise<Project[]> {
  const db = getDb();
  const res = await db.execute({
    sql: `SELECT * FROM Project WHERE userId = ? ORDER BY updatedAt DESC LIMIT 20`,
    args: [userId],
  });
  return res.rows.map((r) => rowToProject(r as unknown as DbRow));
}

export async function updateProjectTask(
  taskId: string,
  updates: Partial<Pick<ProjectTask, "status" | "nextStep" | "assignedAgent">>
): Promise<void> {
  const db = getDb();
  const fields: string[] = [];
  const args: (string | null)[] = [];
  if (updates.status !== undefined) { fields.push("status = ?"); args.push(updates.status); }
  if (updates.nextStep !== undefined) { fields.push("nextStep = ?"); args.push(updates.nextStep); }
  if (updates.assignedAgent !== undefined) { fields.push("assignedAgent = ?"); args.push(updates.assignedAgent); }
  if (fields.length === 0) return;
  fields.push("updatedAt = datetime('now')");
  args.push(taskId);
  await db.execute({ sql: `UPDATE ProjectTask SET ${fields.join(", ")} WHERE id = ?`, args });
}
