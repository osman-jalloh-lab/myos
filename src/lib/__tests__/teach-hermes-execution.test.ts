import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TaughtSkillCandidate } from "@/lib/teach-hermes";

const databasePath = path.join(os.tmpdir(), `teach-hermes-execution-${process.pid}.db`).replace(/\\/g, "/");
process.env.TURSO_DATABASE_URL = `file:${databasePath}`;

let server: Server | null = null;
let origin: string;
let prisma: typeof import("@/lib/db")["prisma"];
let teach: typeof import("@/lib/teach-hermes");
let approveAction: typeof import("@/lib/approvals")["approveAction"];
let resolveRelevantSkills: typeof import("@/lib/skills/routing")["resolveRelevantSkills"];
let clearSkillRegistryCache: typeof import("@/lib/skills/registry")["clearSkillRegistryCache"];

const candidate: TaughtSkillCandidate = {
  id: "create-a-lead", name: "Create a Lead", description: "Create a CRM lead from user-provided details and verify it.", category: "workflow",
  ownerAgents: ["hermes"], tags: ["crm", "lead"], purpose: "Create a supplied lead in the approved CRM and verify the saved record.",
  whenToUse: ["When asked to create a CRM lead", "When entering a new prospect"], whenNotToUse: ["When details are missing", "When the target is not the approved CRM"],
  strongSignals: ["create a new lead", "add CRM lead", "new prospect"], weakSignals: ["lead entry"], negativeSignals: ["delete leads", "export contacts", "change permissions"],
  requiredContext: ["lead name", "lead email", "lead status"], missingContextQuestions: ["What is the lead name?", "What is the lead email?", "What status should be used?"],
  outputContract: { format: "Truthful completion result with verification evidence.", mustInclude: ["verification status"], mustAvoid: ["credentials", "unverified success"] },
  safetyRules: ["Use only the approved project", "Never expose credentials", "Report verification failure truthfully"], approvalRequiredFor: ["non-local or external writes"],
  positiveExamples: ["Create a lead named Alex", "Add a new CRM prospect"], negativeExamples: ["Delete all leads", "Use another website"],
  evaluationPrompts: [1, 2, 3, 4, 5].map((n) => ({ input: `Create a new lead ${n}`, shouldMatch: true, reason: "Requests the approved lead workflow." })),
  version: "1.0.0", instructions: "Open Leads. Click Add Lead. Populate the provided lead name, email, and status. Submit. Verify the new lead appears. If verification fails, report failure.",
};

function pageHtml() {
  return `<!doctype html><html><head><title>Controlled Lead CRM</title></head><body><h1>Leads</h1><button aria-label="Add Lead">Add Lead</button><form aria-label="Lead form"><label>Name <input name="name"></label><label>Email <input name="email"></label><label>Status <select name="status"><option>New</option><option>Qualified</option></select></label><button type="submit">Save</button></form><section id="leads"></section><script>document.querySelector('form').addEventListener('submit',e=>{e.preventDefault();const f=e.currentTarget;const row=document.createElement('p');row.textContent=[f.elements.name.value,f.elements.email.value,f.elements.status.value].join(' | ');document.querySelector('#leads').append(row)});</script></body></html>`;
}

async function sql(script: string) { for (const statement of script.split(";").map((value) => value.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement); }

async function makeDraft(id = "create-a-lead", status: "draft" | "rejected" = "draft") {
  const session = await teach.startTeachingSession("owner", { goal: "Teach Create a Lead", projectId: "owner-project" });
  const events = [
    { kind: "navigate", url: "/leads" }, { kind: "click", target: { role: "button", name: "Add Lead" } },
    { kind: "fill", target: { label: "Name" }, value: "Demonstration Person" }, { kind: "fill", target: { label: "Email" }, value: "demonstration@example.test" },
    { kind: "select", target: { label: "Status" }, value: "New" }, { kind: "fill", target: { label: "Access Token", inputType: "password" }, value: "secret-original-token" },
    { kind: "submit", target: { role: "form", name: "Lead form" } }, { kind: "checkpoint", text: "Lead appears in list" },
  ] as const;
  for (let index = 0; index < events.length; index++) await teach.appendTeachingEvent("owner", session.id, `${id}-${index}`, events[index]);
  await teach.stopTeachingSession("owner", session.id);
  const draft = await teach.createSkillDraft("owner", { sessionId: session.id, candidate: { ...candidate, id, name: id === "create-a-lead" ? candidate.name : id }, confidence: .9, provenance: { qualityScore: 100 } });
  if (status === "rejected") await teach.rejectSkillDraft("owner", draft.id);
  return draft;
}

beforeAll(async () => {
  const acceptanceOrigin = process.env.TEACH_HERMES_ACCEPTANCE_ORIGIN;
  if (acceptanceOrigin) origin = acceptanceOrigin;
  else {
    server = createServer((_req, res) => { res.writeHead(200, { "content-type": "text/html" }); res.end(pageHtml()); });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address(); if (!address || typeof address === "string") throw new Error("Fixture server failed.");
    origin = `http://127.0.0.1:${address.port}`;
  }
  ({ prisma } = await import("@/lib/db"));
  await sql(`
    CREATE TABLE "User" ("id" TEXT NOT NULL PRIMARY KEY, "primaryEmail" TEXT NOT NULL UNIQUE, "name" TEXT, "picture" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "Project" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "projectName" TEXT NOT NULL, "description" TEXT, "route" TEXT, "status" TEXT NOT NULL DEFAULT 'planning', "latestInstruction" TEXT, "assignedAgent" TEXT, "localFolderPath" TEXT, "localBuildLog" TEXT, "localBuildError" TEXT, "localDevUrl" TEXT, "localDevPid" INTEGER, "localPreviewStatus" TEXT, "localPreviewCheckedAt" TEXT, "localResearchBrief" TEXT, "localQaStatus" TEXT, "localQaChecklist" TEXT, "createdAt" DATETIME, "updatedAt" DATETIME);
    CREATE TABLE "ApprovalAction" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "actionType" TEXT NOT NULL, "payload" TEXT NOT NULL, "status" TEXT NOT NULL DEFAULT 'pending', "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "resolvedAt" DATETIME);
    CREATE TABLE "UserSkill" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "skillId" TEXT NOT NULL, "name" TEXT NOT NULL, "description" TEXT NOT NULL, "category" TEXT NOT NULL DEFAULT 'workflow', "definition" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" DATETIME NOT NULL, UNIQUE("userId", "skillId"));
    CREATE TABLE "AuditLog" ("id" TEXT NOT NULL PRIMARY KEY, "userId" TEXT NOT NULL, "action" TEXT NOT NULL, "resourceType" TEXT NOT NULL, "resourceId" TEXT, "detail" TEXT, "ipHash" TEXT, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE "AgentRun" ("id" TEXT NOT NULL PRIMARY KEY, "agentName" TEXT NOT NULL, "inputSummary" TEXT NOT NULL, "outputSummary" TEXT, "modelProvider" TEXT, "status" TEXT NOT NULL, "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP);
  `);
  await sql(await readFile(path.join(process.cwd(), "prisma/migrations/20260823000000_add_teach_hermes_phase1/migration.sql"), "utf8"));
  await sql(await readFile(path.join(process.cwd(), "prisma/migrations/20260824000000_add_teach_hermes_recording/migration.sql"), "utf8"));
  await prisma.user.createMany({ data: [{ id: "owner", primaryEmail: "owner@phase5.test" }, { id: "other", primaryEmail: "other@phase5.test" }] });
  await prisma.project.create({ data: { id: "owner-project", userId: "owner", projectName: "Controlled Lead CRM", localDevUrl: origin, localPreviewStatus: "online" } });
  teach = await import("@/lib/teach-hermes"); ({ approveAction } = await import("@/lib/approvals"));
  ({ resolveRelevantSkills } = await import("@/lib/skills/routing")); ({ clearSkillRegistryCache } = await import("@/lib/skills/registry"));
});

afterAll(async () => { if (server) await new Promise<void>((resolve, reject) => server!.close((error) => error ? reject(error) : resolve())); await prisma.$disconnect(); });

describe.sequential("Teach Hermes Phase 5 normal execution", () => {
  it("keeps drafts and rejected skills out of ordinary routing", async () => {
    await makeDraft("draft-lead"); await makeDraft("rejected-lead", "rejected");
    const resolution = await resolveRelevantSkills({ userId: "owner", message: "Create a new lead named Hidden with email hidden@example.test and status New", agentName: "hermes" });
    expect(resolution.skills.map((skill) => skill.id)).not.toContain("draft-lead");
    expect(resolution.skills.map((skill) => skill.id)).not.toContain("rejected-lead");
  });

  it("promotes once, routes a normal request, executes, and verifies", async () => {
    const draft = await makeDraft();
    const pending = await teach.requestSkillDraftApproval("owner", draft.id); await approveAction("owner", pending.approval!.id); clearSkillRegistryCache("owner");
    const { getRegisteredSkills } = await import("@/lib/skills/registry");
    expect((await getRegisteredSkills("owner", true)).map((skill) => skill.id)).toContain("create-a-lead");
    const { skillResolutionToExecutionPlan } = await import("@/lib/hermes-execution/execution-bridge");
    const { runHermesExecutionPlan } = await import("@/lib/hermes-execution/run");
    const request = "Create a new lead named Phase Five Test Lead with email phase5@example.test and status New.";
    const resolution = await resolveRelevantSkills({ userId: "owner", message: request, agentName: "hermes" });
    expect(resolution.primarySkill?.id).toBe("create-a-lead");
    const plan = skillResolutionToExecutionPlan(resolution, request); expect(plan?.steps[0].tool).toBe("internal.browser.executeFormWorkflow");
    expect(plan?.steps[0].requiresApproval).toBe(false);
    const result = await runHermesExecutionPlan("owner", request, "chat", plan!);
    expect(result.status).toBe("completed"); expect(result.answer).toContain("verified"); expect(result.answer).toContain("Phase Five Test Lead");
    const persisted = JSON.stringify(await prisma.userSkill.findUniqueOrThrow({ where: { userId_skillId: { userId: "owner", skillId: "create-a-lead" } } }));
    const audit = JSON.stringify(await prisma.auditLog.findMany({ where: { userId: "owner" } }));
    expect(`${persisted}${audit}`).not.toContain("secret-original-token");
    expect(await prisma.auditLog.count({ where: { action: "skill.execution.verified" } })).toBe(1);
    await teach.promoteApprovedSkillDraft("owner", draft.id, pending.approval!.id);
    expect(await prisma.userSkill.count({ where: { userId: "owner", skillId: "create-a-lead" } })).toBe(1);
  });

  it("reuses the same approved skill with generalized input values", async () => {
    const request = "Create another lead named Second Learned Lead with email second@example.test and status Qualified.";
    const resolution = await resolveRelevantSkills({ userId: "owner", message: request, agentName: "hermes" });
    expect(resolution.primarySkill?.id).toBe("create-a-lead");
    const { skillResolutionToExecutionPlan } = await import("@/lib/hermes-execution/execution-bridge"); const { runHermesExecutionPlan } = await import("@/lib/hermes-execution/run");
    const result = await runHermesExecutionPlan("owner", request, "chat", skillResolutionToExecutionPlan(resolution, request)!);
    expect(result.status).toBe("completed"); expect(result.answer).toContain("Second Learned Lead"); expect(result.answer).toContain("second@example.test");
    expect(result.answer).not.toContain("Demonstration Person"); expect(result.answer).not.toContain("demonstration@example.test");
    expect(await prisma.auditLog.count({ where: { action: "skill.execution.verified" } })).toBe(2);
  });

  it("fails truthfully when the semantic target changed and never reports verified success", async () => {
    const stored = await prisma.userSkill.findUniqueOrThrow({ where: { userId_skillId: { userId: "owner", skillId: "create-a-lead" } } });
    const changed = JSON.parse(stored.definition) as { browserWorkflow: { steps: Array<{ kind: string; target?: { name?: string } }> } };
    const click = changed.browserWorkflow.steps.find((step) => step.kind === "click"); if (click?.target) click.target.name = "Missing Lead Action";
    await prisma.userSkill.update({ where: { id: stored.id }, data: { definition: JSON.stringify(changed) } }); clearSkillRegistryCache("owner");
    const request = "Create a new lead named Failure Test with email failure@example.test and status New.";
    const resolution = await resolveRelevantSkills({ userId: "owner", message: request, agentName: "hermes" });
    const { skillResolutionToExecutionPlan } = await import("@/lib/hermes-execution/execution-bridge");
    const { runHermesExecutionPlan } = await import("@/lib/hermes-execution/run");
    const result = await runHermesExecutionPlan("owner", request, "chat", skillResolutionToExecutionPlan(resolution, request)!);
    expect(result.status).toBe("failed"); expect(result.answer).toContain("Execution failed"); expect(result.answer).not.toContain("completed and verified");
    expect(await prisma.auditLog.findFirst({ where: { action: "skill.execution.failed" }, orderBy: { createdAt: "desc" } })).toBeTruthy();
    await prisma.userSkill.update({ where: { id: stored.id }, data: { definition: stored.definition } }); clearSkillRegistryCache("owner");
  });

  it("preserves owner/origin policy and stops routing a disabled promoted UserSkill", async () => {
    await prisma.userSkill.update({ where: { userId_skillId: { userId: "owner", skillId: "create-a-lead" } }, data: { enabled: false } }); clearSkillRegistryCache("owner");
    const disabled = await resolveRelevantSkills({ userId: "owner", message: "Create a new lead named Disabled with email disabled@example.test and status New", agentName: "hermes" });
    expect(disabled.skills.map((skill) => skill.id)).not.toContain("create-a-lead");
    await prisma.userSkill.update({ where: { userId_skillId: { userId: "owner", skillId: "create-a-lead" } }, data: { enabled: true } }); clearSkillRegistryCache("owner");
    await prisma.project.update({ where: { id: "owner-project" }, data: { localDevUrl: "https://example.com" } });
    const request = "Create a new lead named Escaped with email escaped@example.test and status New";
    const resolution = await resolveRelevantSkills({ userId: "owner", message: request, agentName: "hermes" });
    const { skillResolutionToExecutionPlan } = await import("@/lib/hermes-execution/execution-bridge"); const { runHermesExecutionPlan } = await import("@/lib/hermes-execution/run");
    const result = await runHermesExecutionPlan("owner", request, "chat", skillResolutionToExecutionPlan(resolution, request)!);
    expect(result.status).toBe("failed"); expect(result.answer).toContain("owned localhost Builder preview");
    await prisma.project.update({ where: { id: "owner-project" }, data: { localDevUrl: origin } });
  });
});
