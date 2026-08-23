import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaughtSkillCandidate } from "@/lib/teach-hermes";

const databasePath = path.join(os.tmpdir(), `teach-hermes-generation-${process.pid}.db`).replace(/\\/g, "/");
process.env.TURSO_DATABASE_URL = `file:${databasePath}`;

let prisma: typeof import("@/lib/db")["prisma"];
let teach: typeof import("@/lib/teach-hermes");
let generation: typeof import("@/lib/teach-hermes-generation");
let getRegisteredSkills: typeof import("@/lib/skills/registry")["getRegisteredSkills"];
let resolveRelevantSkills: typeof import("@/lib/skills/routing")["resolveRelevantSkills"];

const candidate = (overrides: Partial<TaughtSkillCandidate> = {}): TaughtSkillCandidate => ({
  id: "create-a-lead", name: "Create a Lead",
  description: "Create a new CRM lead from user-provided contact and status information, then verify submission.",
  category: "workflow", ownerAgents: ["hermes"], tags: ["crm", "lead", "browser"],
  purpose: "Help the user consistently add a supplied lead to the approved CRM workflow without hardcoded customer data.",
  whenToUse: ["When the user asks to create a CRM lead", "When a new prospect must be entered", "When lead details are ready"],
  whenNotToUse: ["When required lead data is missing", "When the target is not the approved CRM"],
  strongSignals: ["create a lead", "add CRM lead", "new prospect", "enter lead details"], weakSignals: ["lead entry"],
  negativeSignals: ["delete lead", "export all contacts", "change CRM permissions"],
  requiredContext: ["lead name", "lead email", "lead status"],
  missingContextQuestions: ["What is the lead name and email?", "What status should the lead have?"],
  outputContract: { format: "A concise completion result with validation evidence.", mustInclude: ["submission result", "verification status"], mustAvoid: ["credentials", "hardcoded fixture values"] },
  safetyRules: ["Use only the approved project surface", "Never persist credentials", "Respect normal write approvals"],
  approvalRequiredFor: ["submitting external CRM changes"],
  positiveExamples: ["Create a lead for these details", "Add this prospect", "Enter a new CRM lead"],
  negativeExamples: ["Delete every lead", "Reveal access tokens", "Open an unrelated website"],
  evaluationPrompts: [1, 2, 3, 4, 5].map((number) => ({ input: `Create CRM lead example ${number}`, shouldMatch: true, reason: "This requests the demonstrated lead-creation workflow." })),
  version: "1.0.0",
  instructions: "Open Leads. Choose Add Lead. Populate the provided lead name, email, and status. Submit. Verify the new lead appears. If validation fails, report the field that needs correction and do not invent values.",
  execution: { tool: "shell", risk: "read", requiresApproval: false },
  ...overrides,
});

function modelResult(value: unknown, provider = "anthropic" as const) { return async () => ({ text: typeof value === "string" ? value : JSON.stringify(value), provider }); }
async function executeSqlScript(sql: string) { for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement); }

async function completedSession(goal = "Teach how to create a CRM lead", withEvents = true) {
  const session = await teach.startTeachingSession("owner", { goal, projectId: "owner-project" });
  if (withEvents) {
    const events = [
      { kind: "navigate", url: "/leads" }, { kind: "click", target: { role: "button", name: "Add Lead" } },
      { kind: "fill", target: { label: "Name" }, value: "Jane Smith" }, { kind: "fill", target: { label: "Email" }, value: "jane@example.test" },
      { kind: "select", target: { label: "Status" }, value: "New" }, { kind: "fill", target: { label: "Access Token", inputType: "password" }, value: "secret-original-token" },
      { kind: "submit", target: { role: "form", name: "Lead form" } }, { kind: "checkpoint", text: "Lead saved" },
    ] as const;
    for (let index = 0; index < events.length; index++) await teach.appendTeachingEvent("owner", session.id, `event-${session.id}-${index}`, events[index]);
  }
  return teach.stopTeachingSession("owner", session.id);
}

beforeAll(async () => {
  ({ prisma } = await import("@/lib/db"));
  await executeSqlScript(`
    CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "primaryEmail" TEXT NOT NULL UNIQUE, "name" TEXT, "picture" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "Project" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "projectName" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'planning', "localFolderPath" TEXT, "localDevUrl" TEXT, "localPreviewStatus" TEXT);
    CREATE TABLE "ApprovalAction" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "actionType" TEXT NOT NULL, "payload" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" DATETIME);
    CREATE TABLE "UserSkill" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "skillId" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT NOT NULL, "category" TEXT NOT NULL DEFAULT 'workflow', "definition" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, UNIQUE("userId", "skillId"));
    CREATE TABLE "AuditLog" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "action" TEXT NOT NULL, "resourceType" TEXT NOT NULL, "resourceId" TEXT, "detail" TEXT, "ipHash" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  await executeSqlScript(await readFile(path.join(process.cwd(), "prisma/migrations/20260823000000_add_teach_hermes_phase1/migration.sql"), "utf8"));
  await executeSqlScript(await readFile(path.join(process.cwd(), "prisma/migrations/20260824000000_add_teach_hermes_recording/migration.sql"), "utf8"));
  await prisma.user.createMany({ data: [{ id: "owner", primaryEmail: "owner@generation.test" }, { id: "other", primaryEmail: "other@generation.test" }] });
  await prisma.project.createMany({ data: [{ id: "owner-project", userId: "owner", projectName: "Roofing CRM" }, { id: "other-project", userId: "other", projectName: "Other CRM" }] });
  teach = await import("@/lib/teach-hermes"); generation = await import("@/lib/teach-hermes-generation");
  ({ getRegisteredSkills } = await import("@/lib/skills/registry")); ({ resolveRelevantSkills } = await import("@/lib/skills/routing"));
});

afterAll(async () => { await prisma.$disconnect(); });

describe.sequential("Teach Hermes Phase 3", () => {
  it("assembles bounded, ordered, re-redacted server-owned evidence", async () => {
    const session = await completedSession(); const evidence = await generation.assembleTeachingEvidence("owner", session.id);
    expect(evidence.actions.map((action) => action.kind)).toEqual(["navigate", "click", "fill", "fill", "select", "fill", "submit", "checkpoint"]);
    expect(evidence.actions.map((action) => action.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(JSON.stringify(evidence)).not.toContain("secret-original-token"); expect(evidence.actions[5].summary).toContain("[REDACTED]");
    await expect(generation.assembleTeachingEvidence("other", session.id)).rejects.toThrow("not found");
  });

  it("fails closed on malformed output and provider timeout while preserving evidence for retry", async () => {
    const session = await prisma.skillTeachingSession.findFirstOrThrow({ where: { userId: "owner", status: "processing" } });
    await expect(generation.generateTeachingSkillDraft("owner", { sessionId: session.id, requestKey: "malformed" }, modelResult("not-json"))).rejects.toThrow("structured JSON");
    await expect(generation.generateTeachingSkillDraft("owner", { sessionId: session.id, requestKey: "timeout" }, async () => { throw new Error("provider timeout"); })).rejects.toThrow("provider timeout");
    expect(await prisma.skillTeachingEvent.count({ where: { sessionId: session.id } })).toBe(8);
    expect((await prisma.skillTeachingSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("processing");
    expect(await prisma.skillDraft.count({ where: { sessionId: session.id } })).toBe(0);
  });

  it("generates a reusable, policy-constrained, unroutable draft and handles retries/revisions", async () => {
    const session = await prisma.skillTeachingSession.findFirstOrThrow({ where: { userId: "owner", status: "processing" } });
    const envelope = { candidate: candidate({ description: "Create a reusable lead from provided values; never persist secret-original-token." }), confidence: 0.86, warnings: [] };
    const first = await generation.generateTeachingSkillDraft("owner", { sessionId: session.id, requestKey: "acceptance-1" }, modelResult(envelope));
    const definition = JSON.parse(first.draft.definition) as TaughtSkillCandidate;
    expect(first.duplicate).toBe(false); expect(definition.name).toBe("Create a Lead");
    expect(definition.requiredContext).toEqual(expect.arrayContaining(["lead name", "lead email", "lead status"])); expect(definition.instructions).toContain("provided lead name");
    expect(first.draft.definition).not.toMatch(/Jane Smith|jane@example\.test|secret-original-token/);
    expect(JSON.parse(first.draft.effectiveCapabilities)).toMatchObject({ tool: null, permissions: [], requiresApproval: false });
    expect(first.draft.provenance).toContain("Requested tool shell was not granted");
    const duplicate = await generation.generateTeachingSkillDraft("owner", { sessionId: session.id, requestKey: "acceptance-1" }, modelResult(envelope));
    expect(duplicate.duplicate).toBe(true); expect(duplicate.draft.revision).toBe(first.draft.revision);
    const regenerated = await generation.generateTeachingSkillDraft("owner", { sessionId: session.id, requestKey: "acceptance-2" }, modelResult({ candidate: candidate({ name: "Create a CRM Lead" }), confidence: 0.4, warnings: ["Sparse success evidence"] }));
    expect(regenerated.draft.revision).toBe(first.draft.revision + 1); expect(regenerated.draft.provenance).toContain("needs_review"); expect(regenerated.draft.confidence).toBe(0.4);
    expect(await prisma.userSkill.count()).toBe(0); expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "create-a-lead")).toBe(false);
    const routed = await resolveRelevantSkills({ userId: "owner", message: "Create a lead in the CRM", agentName: "hermes" });
    expect(routed.skills.some((skill) => skill.id === "create-a-lead")).toBe(false);
  });

  it("rejects no-event, active, expired, rejected, wrong-user, and wrong-project sessions", async () => {
    const noEvents = await completedSession("No evidence", false);
    await expect(generation.generateTeachingSkillDraft("owner", { sessionId: noEvents.id, requestKey: "none" }, modelResult({ candidate: candidate(), confidence: 0.8 }))).rejects.toThrow("no recorded evidence");
    const active = await teach.startTeachingSession("owner", { goal: "Still active", projectId: "owner-project" });
    await expect(generation.generateTeachingSkillDraft("owner", { sessionId: active.id, requestKey: "active" }, modelResult({ candidate: candidate(), confidence: 0.8 }))).rejects.toThrow("Stop and finalize");
    await expect(generation.generateTeachingSkillDraft("other", { sessionId: active.id, requestKey: "foreign" }, modelResult({ candidate: candidate(), confidence: 0.8 }))).rejects.toThrow("not found");
    await prisma.skillTeachingSession.update({ where: { id: active.id }, data: { status: "expired", recordingActive: false, activeScopeKey: null } });
    await expect(generation.generateTeachingSkillDraft("owner", { sessionId: active.id, requestKey: "expired" }, modelResult({ candidate: candidate(), confidence: 0.8 }))).rejects.toThrow("expired");
    await prisma.skillTeachingSession.update({ where: { id: active.id }, data: { status: "rejected" } });
    await expect(generation.generateTeachingSkillDraft("owner", { sessionId: active.id, requestKey: "rejected" }, modelResult({ candidate: candidate(), confidence: 0.8 }))).rejects.toThrow("rejected");
    await prisma.skillTeachingSession.update({ where: { id: noEvents.id }, data: { projectId: "other-project" } });
    await expect(generation.generateTeachingSkillDraft("owner", { sessionId: noEvents.id, requestKey: "wrong-project" }, modelResult({ candidate: candidate(), confidence: 0.8 }))).rejects.toThrow("Project not found");
  });
});
