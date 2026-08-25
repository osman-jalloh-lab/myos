import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaughtSkillCandidate } from "@/lib/teach-hermes";

const databasePath = path.join(os.tmpdir(), `teach-hermes-review-${process.pid}.db`).replace(/\\/g, "/");
process.env.TURSO_DATABASE_URL = `file:${databasePath}`;

let prisma: typeof import("@/lib/db")["prisma"];
let teach: typeof import("@/lib/teach-hermes");
let reviewApi: typeof import("@/lib/teach-hermes-review");
let approveAction: typeof import("@/lib/approvals")["approveAction"];
let getRegisteredSkills: typeof import("@/lib/skills/registry")["getRegisteredSkills"];
let resolveRelevantSkills: typeof import("@/lib/skills/routing")["resolveRelevantSkills"];

const candidate = (id: string, name: string): TaughtSkillCandidate => ({
  id, name, description: "Create a CRM lead from user-provided contact details and verify the result.", category: "workflow",
  ownerAgents: ["hermes"], tags: ["crm", "lead"], purpose: "Reliably create a supplied lead in the approved CRM while respecting normal My OS policy.",
  whenToUse: ["When creating a CRM lead", "When entering a new prospect", "When supplied lead details are ready"],
  whenNotToUse: ["When required details are missing", "When the target is not the approved CRM"],
  strongSignals: ["create a lead", "add CRM lead", "new prospect", "enter lead"], weakSignals: ["lead entry"],
  negativeSignals: ["delete every lead", "export contacts", "change permissions"], requiredContext: ["lead name", "lead email", "lead status"],
  missingContextQuestions: ["What is the lead name and email?", "What status should be used?"],
  outputContract: { format: "Completion result with verification.", mustInclude: ["submission result", "verification status"], mustAvoid: ["credentials", "invented values"] },
  safetyRules: ["Use only the approved project", "Never expose credentials", "Respect required approvals"], approvalRequiredFor: ["external CRM writes"],
  positiveExamples: ["Create this lead", "Add this prospect", "Enter a CRM lead"], negativeExamples: ["Delete leads", "Reveal tokens", "Use another website"],
  evaluationPrompts: [1, 2, 3, 4, 5].map((number) => ({ input: `Create CRM lead ${number}`, shouldMatch: true, reason: "This requests the demonstrated lead workflow." })),
  version: "1.0.0", instructions: "Open Leads. Click Add Lead. Populate the provided values. Submit. Verify success. If validation fails, report the missing or invalid field.",
});

async function executeSqlScript(sql: string) { for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement); }

async function draftFixture(id: string, name: string) {
  const session = await teach.startTeachingSession("owner", { goal: `Teach ${name}`, projectId: "owner-project" });
  const events = [
    { kind: "navigate", url: "/leads" }, { kind: "click", target: { name: "Add Lead", role: "button" } },
    { kind: "fill", target: { label: "Name" }, value: "a provided value" }, { kind: "fill", target: { label: "Email" }, value: "a provided value" },
    { kind: "select", target: { label: "Status" }, value: "a provided option" }, { kind: "fill", target: { label: "Access Token", inputType: "password" }, value: "secret-original-token" },
    { kind: "submit", target: { name: "Lead form" } }, { kind: "checkpoint", text: "Lead saved" },
  ] as const;
  for (let index = 0; index < events.length; index++) await teach.appendTeachingEvent("owner", session.id, `${id}-${index}`, events[index]);
  await teach.stopTeachingSession("owner", session.id);
  return teach.createSkillDraft("owner", { sessionId: session.id, candidate: candidate(id, name), confidence: .82, provenance: { qualityScore: 100, qualityBand: "Excellent", reviewState: "ready_for_review", warnings: "Review validation evidence." } });
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
  await prisma.user.createMany({ data: [{ id: "owner", primaryEmail: "owner@review.test" }, { id: "other", primaryEmail: "other@review.test" }] });
  await prisma.project.createMany({ data: [{ id: "owner-project", userId: "owner", projectName: "Roofing CRM" }, { id: "other-project", userId: "other", projectName: "Other CRM" }] });
  teach = await import("@/lib/teach-hermes"); reviewApi = await import("@/lib/teach-hermes-review"); ({ approveAction } = await import("@/lib/approvals"));
  ({ getRegisteredSkills } = await import("@/lib/skills/registry")); ({ resolveRelevantSkills } = await import("@/lib/skills/routing"));
});

afterAll(async () => { await prisma.$disconnect(); });

describe.sequential("Teach Hermes Phase 4", () => {
  it("loads an owner-isolated safe review DTO without rendering secrets", async () => {
    const draft = await draftFixture("create-a-lead", "Create a Lead");
    const review = await reviewApi.getTeachingDraftReview("owner", draft.id);
    expect(review).toMatchObject({ trustLabel: "DRAFT — NOT ACTIVE", projectName: "Roofing CRM", evidence: { eventCount: 8 } });
    expect(review.editable.requiredContext).toEqual(["lead name", "lead email", "lead status"]);
    expect(review.evidence.summary.join(" ")).toContain("[REDACTED]");
    expect(JSON.stringify(review)).not.toContain("secret-original-token");
    expect(review).not.toHaveProperty("effectiveCapabilities"); expect(review).not.toHaveProperty("provenance");
    await expect(reviewApi.getTeachingDraftReview("other", draft.id)).rejects.toThrow("not found");
  });

  it("edits only safe fields, increments revisions, and rejects stale or foreign writes", async () => {
    const draft = await prisma.skillDraft.findFirstOrThrow({ where: { userId: "owner", status: "draft" } });
    const current = await reviewApi.getTeachingDraftReview("owner", draft.id);
    const updated = await reviewApi.updateTeachingDraftReview("owner", draft.id, current.revision, {
      ...current.editable, name: "Create a Qualified Lead", instructions: `${current.editable.instructions} Return a concise confirmation.`,
      requiresApproval: false, execution: { tool: "shell" }, risk: "read", filesystemScope: "C:/" as string,
    } as typeof current.editable);
    expect(updated.revision).toBe(current.revision + 1); expect(updated.editable.name).toBe("Create a Qualified Lead");
    expect(updated.effectiveCapabilitySummary).toContain("No executable tool granted");
    expect(JSON.parse((await prisma.skillDraft.findUniqueOrThrow({ where: { id: draft.id } })).effectiveCapabilities)).toMatchObject({ tool: null, permissions: [] });
    await expect(reviewApi.updateTeachingDraftReview("owner", draft.id, current.revision, current.editable)).rejects.toThrow("stale");
    await expect(reviewApi.updateTeachingDraftReview("other", draft.id, updated.revision, updated.editable)).rejects.toThrow("not found");
    expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "create-a-lead")).toBe(false);
  });

  it("uses normal approval/promotion, routes only afterward, and remains idempotent", async () => {
    const draft = await prisma.skillDraft.findFirstOrThrow({ where: { userId: "owner", status: "draft" } });
    const pending = await teach.requestSkillDraftApproval("owner", draft.id);
    expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "create-a-lead")).toBe(false);
    expect((await resolveRelevantSkills({ userId: "owner", message: "Create a lead in the CRM", agentName: "hermes" })).skills.some((skill) => skill.id === "create-a-lead")).toBe(false);
    await expect(approveAction("other", pending.approval!.id)).rejects.toThrow();
    const approved = await approveAction("owner", pending.approval!.id);
    expect(approved.status).toBe("executed");
    expect(await prisma.userSkill.count({ where: { userId: "owner", skillId: "create-a-lead" } })).toBe(1);
    expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "create-a-lead")).toBe(true);
    expect((await resolveRelevantSkills({ userId: "owner", message: "Create a lead in the CRM", agentName: "hermes" })).skills.some((skill) => skill.id === "create-a-lead")).toBe(true);
    await teach.promoteApprovedSkillDraft("owner", draft.id, pending.approval!.id);
    expect(await prisma.userSkill.count({ where: { userId: "owner", skillId: "create-a-lead" } })).toBe(1);
  });

  it("keeps rejected, obsolete, and malformed drafts safely unpromoted", async () => {
    const rejected = await draftFixture("rejected-lead", "Rejected Lead"); await teach.rejectSkillDraft("owner", rejected.id);
    await expect(teach.rejectSkillDraft("other", rejected.id)).rejects.toThrow("not found");
    expect((await getRegisteredSkills("owner", true)).some((skill) => skill.id === "rejected-lead")).toBe(false);

    const obsolete = await draftFixture("obsolete-lead", "Obsolete Lead"); const oldApproval = await teach.requestSkillDraftApproval("owner", obsolete.id);
    await prisma.skillDraft.update({ where: { id: obsolete.id }, data: { revision: { increment: 1 } } });
    await expect(approveAction("owner", oldApproval.approval!.id)).rejects.toThrow("latest skill draft revision");
    expect((await prisma.approvalAction.findUniqueOrThrow({ where: { id: oldApproval.approval!.id } })).status).toBe("pending");
    expect(await prisma.userSkill.count({ where: { userId: "owner", skillId: "obsolete-lead" } })).toBe(0);

    const malformed = await draftFixture("malformed-lead", "Malformed Lead"); const malformedApproval = await teach.requestSkillDraftApproval("owner", malformed.id);
    await prisma.skillDraft.update({ where: { id: malformed.id }, data: { definition: "{not-json" } });
    await expect(approveAction("owner", malformedApproval.approval!.id)).rejects.toThrow();
    expect(await prisma.userSkill.count({ where: { userId: "owner", skillId: "malformed-lead" } })).toBe(0);
    const availability = await reviewApi.listTeachingDraftReviewAvailability("owner");
    expect(availability.unavailableCount).toBeGreaterThanOrEqual(1);
    expect(availability.reviews.every((review) => review.id !== malformed.id)).toBe(true);
  });

  it("keeps the component functional, explicit about trust, and free of raw secret surfaces", async () => {
    const source = await readFile(path.join(process.cwd(), "src/app/command-center/TeachHermesReviewPanel.tsx"), "utf8");
    for (const text of ["review.trustLabel", "Hermes cannot use it yet", "Approve Skill", "Reject Draft", "Source demonstration", "Failure handling"]) expect(source).toContain(text);
    expect(source).not.toMatch(/cookies|browserStorage|rawHtml|authorizationHeader|secret-original-token/i);
    const routeSource = await readFile(path.join(process.cwd(), "src/app/api/command-center/teach/route.ts"), "utf8");
    expect(routeSource).toContain("Teach Hermes storage is not initialized in this local environment");
    expect(routeSource).toContain("status: 503");
  });
});
