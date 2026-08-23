import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaughtSkillCandidate } from "@/lib/teach-hermes";

const databasePath = path.join(os.tmpdir(), `teach-hermes-${process.pid}.db`).replace(/\\/g, "/");
process.env.TURSO_DATABASE_URL = `file:${databasePath}`;

let api: typeof import("@/lib/teach-hermes");
let prisma: typeof import("@/lib/db")["prisma"];
let approveAction: typeof import("@/lib/approvals")["approveAction"];
let rejectAction: typeof import("@/lib/approvals")["rejectAction"];
let getRegisteredSkills: typeof import("@/lib/skills/registry")["getRegisteredSkills"];
let resolveRelevantSkills: typeof import("@/lib/skills/routing")["resolveRelevantSkills"];

const candidate = (overrides: Partial<TaughtSkillCandidate> = {}): TaughtSkillCandidate => ({
  id: "roofing-follow-up",
  name: "Roofing Follow-up",
  description: "Prepare a consistent roofing lead follow-up response after reviewing the customer record.",
  category: "workflow",
  ownerAgents: ["hermes"],
  tags: ["roofing", "follow-up"],
  purpose: "Help the user consistently prepare roofing lead follow-up guidance while preserving normal approval and tool policy.",
  whenToUse: ["When the user asks for roofing lead follow-up", "When a roofing customer needs a response", "When reviewing roofing CRM leads"],
  whenNotToUse: ["When no customer context is available", "When the request is unrelated to roofing"],
  strongSignals: ["roofing follow-up", "roofing lead", "customer estimate", "roofing CRM"],
  weakSignals: ["follow up"],
  negativeSignals: ["unrelated sales", "personal email", "delete customer"],
  requiredContext: ["customer name", "lead status"],
  missingContextQuestions: ["Which customer?", "What is the current lead status?"],
  outputContract: { format: "Concise follow-up guidance.", mustInclude: ["next step"], mustAvoid: ["unsupported promises"] },
  safetyRules: ["Never send without approval", "Do not expose secrets", "Respect registered tool policy"],
  approvalRequiredFor: ["sending messages"],
  positiveExamples: ["Follow up with this roofing lead", "Draft next steps for the estimate", "Review this roofing CRM lead"],
  negativeExamples: ["Delete the database", "Send without approval", "Read my password"],
  evaluationPrompts: [1, 2, 3, 4, 5].map((number) => ({ input: `Roofing follow-up request ${number}`, shouldMatch: true, reason: "This is a roofing lead follow-up workflow." })),
  version: "1.0.0",
  instructions: "Review the supplied customer context and return a concise follow-up with a clear next step.",
  ...overrides,
});

async function executeSqlScript(sql: string) {
  for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement);
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db"));
  await executeSqlScript(`
    CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "primaryEmail" TEXT NOT NULL UNIQUE, "name" TEXT, "picture" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "Project" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "projectName" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'planning');
    CREATE TABLE "ApprovalAction" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "actionType" TEXT NOT NULL, "payload" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" DATETIME);
    CREATE TABLE "UserSkill" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "skillId" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT NOT NULL, "category" TEXT NOT NULL DEFAULT 'workflow', "definition" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, UNIQUE("userId", "skillId"));
    CREATE TABLE "AuditLog" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "action" TEXT NOT NULL, "resourceType" TEXT NOT NULL, "resourceId" TEXT, "detail" TEXT, "ipHash" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  const migration = await readFile(path.join(process.cwd(), "prisma/migrations/20260823000000_add_teach_hermes_phase1/migration.sql"), "utf8");
  await executeSqlScript(migration);
  const recordingMigration = await readFile(path.join(process.cwd(), "prisma/migrations/20260824000000_add_teach_hermes_recording/migration.sql"), "utf8");
  await executeSqlScript(recordingMigration);
  await prisma.user.createMany({ data: [{ id: "owner", primaryEmail: "owner@example.test" }, { id: "other", primaryEmail: "other@example.test" }] });
  await prisma.project.createMany({ data: [{ id: "owner-project", userId: "owner", projectName: "Owner project" }, { id: "other-project", userId: "other", projectName: "Other project" }] });
  api = await import("@/lib/teach-hermes");
  ({ approveAction, rejectAction } = await import("@/lib/approvals"));
  ({ getRegisteredSkills } = await import("@/lib/skills/registry"));
  ({ resolveRelevantSkills } = await import("@/lib/skills/routing"));
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe.sequential("Teach Hermes Phase 1", () => {
  it("creates one owner/project-isolated active session and expires stale sessions", async () => {
    const first = await api.startTeachingSession("owner", { goal: "Teach roofing follow-up", projectId: "owner-project" });
    const duplicate = await api.startTeachingSession("owner", { goal: "Duplicate", projectId: "owner-project" });
    expect(duplicate.id).toBe(first.id);
    await expect(api.startTeachingSession("owner", { goal: "Cross-project", projectId: "other-project" })).rejects.toThrow("Project not found");
    await expect(api.appendTeachingEvent("other", first.id, "foreign", { kind: "click" })).rejects.toThrow("not found");
    await prisma.skillTeachingSession.update({ where: { id: first.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await api.getCurrentTeachingSession("owner", "owner-project")).toBeNull();
    expect((await prisma.skillTeachingSession.findUniqueOrThrow({ where: { id: first.id } })).status).toBe("expired");
  });

  it("validates semantic events, deduplicates event keys, and redacts before persistence", async () => {
    const session = await api.startTeachingSession("owner", { goal: "Teach secure form completion", projectId: "owner-project" });
    await expect(api.appendTeachingEvent("owner", session.id, "bad", { kind: "mousemove" as never })).rejects.toThrow("Unsupported");
    const password = await api.appendTeachingEvent("owner", session.id, "password-1", { kind: "fill", target: { name: "account password", inputType: "password" }, value: "never-store-me" });
    expect(password.duplicate).toBe(false);
    expect(password.event.payload).toContain("[REDACTED]");
    expect(password.event.payload).not.toContain("never-store-me");
    const token = await api.appendTeachingEvent("owner", session.id, "token-1", { kind: "observe", text: "Authorization: Bearer abc.def.secret", metadata: { clipboard: "sk-secret-token-123456789" } });
    expect(token.event.payload).not.toMatch(/abc\.def\.secret|sk-secret-token/);
    const retry = await api.appendTeachingEvent("owner", session.id, "token-1", { kind: "observe", text: "different" });
    expect(retry.duplicate).toBe(true);
    expect(await prisma.skillTeachingEvent.count({ where: { sessionId: session.id } })).toBe(2);
  });

  it("keeps drafts unroutable, enforces revisions, and prevents metadata capability escalation", async () => {
    const session = await api.getCurrentTeachingSession("owner", "owner-project");
    expect(session).not.toBeNull();
    await api.stopTeachingSession("owner", session!.id);
    const draft = await api.createSkillDraft("owner", { sessionId: session!.id, candidate: candidate({ instructions: "Use API_KEY=never-persist-this", execution: { tool: "invented.docker.root", risk: "read", requiresApproval: false } }), observedCapabilities: ["docker", "external-write"], confidence: 0.8, provenance: { clipboard: "Bearer never-persist-this-either" } });
    expect(JSON.parse(draft.effectiveCapabilities)).toMatchObject({ tool: null, requiresApproval: false, availability: "unavailable" });
    expect(draft.definition).not.toContain("never-persist-this");
    expect(draft.provenance).not.toContain("never-persist-this-either");
    expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "roofing-follow-up")).toBe(false);
    await expect(api.getSkillDraft("other", draft.id)).rejects.toThrow("not found");
    const updated = await api.updateSkillDraft("owner", draft.id, draft.revision, candidate({ execution: { tool: "internal.email.createDraft", risk: "read", requiresApproval: false } }));
    const effective = JSON.parse(updated.effectiveCapabilities);
    expect(effective).toMatchObject({ tool: "internal.email.createDraft", risk: "external_write", requiresApproval: true });
    expect(effective.permissions).toContain("approval");
    await expect(api.updateSkillDraft("owner", draft.id, draft.revision, candidate())).rejects.toThrow("stale");
  });

  it("requires normal approval, promotes idempotently, and routes only the approved UserSkill", async () => {
    const draft = await prisma.skillDraft.findFirstOrThrow({ where: { userId: "owner", status: "draft" } });
    const pending = await api.requestSkillDraftApproval("owner", draft.id);
    expect(pending.draft.status).toBe("pending_approval");
    expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "roofing-follow-up")).toBe(false);
    await expect(api.promoteApprovedSkillDraft("owner", draft.id, pending.approval!.id)).rejects.toThrow("approved Teach Hermes promotion");
    const approved = await approveAction("owner", pending.approval!.id);
    expect(approved.status).toBe("executed");
    const promoted = await api.promoteApprovedSkillDraft("owner", draft.id, pending.approval!.id);
    expect(await prisma.userSkill.count({ where: { userId: "owner", skillId: promoted.skillId } })).toBe(1);
    const registered = await getRegisteredSkills("owner", true);
    const skill = registered.find((item) => item.id === promoted.skillId);
    expect(skill).toMatchObject({ source: "user", enabled: true, executionRisk: "external_write", executionRequiresApproval: true });
    const routed = await resolveRelevantSkills({ userId: "owner", message: "Please prepare a roofing follow-up for this roofing CRM lead", agentName: "hermes" });
    expect(routed.skills.some((item) => item.id === promoted.skillId)).toBe(true);
    expect(routed.skills.find((item) => item.id === promoted.skillId)).toMatchObject({ executionRisk: "external_write", executionRequiresApproval: true });
    expect((await getRegisteredSkills("other")).some((item) => item.id === promoted.skillId)).toBe(false);
  });

  it("keeps rejected pending drafts out of the registry", async () => {
    const session = await api.startTeachingSession("owner", { goal: "Teach rejected workflow" });
    await api.stopTeachingSession("owner", session.id);
    const draft = await api.createSkillDraft("owner", { sessionId: session.id, candidate: candidate({ id: "rejected-workflow", name: "Rejected Workflow" }), confidence: 0.5 });
    const pending = await api.requestSkillDraftApproval("owner", draft.id);
    await rejectAction("owner", pending.approval!.id);
    const rejected = await api.getSkillDraft("owner", draft.id);
    expect(rejected.status).toBe("rejected");
    expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "rejected-workflow")).toBe(false);
  });
});
