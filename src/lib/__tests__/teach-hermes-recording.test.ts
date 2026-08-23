import { createServer, type Server } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databasePath = path.join(os.tmpdir(), `teach-hermes-recording-${process.pid}.db`).replace(/\\/g, "/");
process.env.TURSO_DATABASE_URL = `file:${databasePath}`;

let prisma: typeof import("@/lib/db")["prisma"];
let phase1: typeof import("@/lib/teach-hermes");
let recording: typeof import("@/lib/teach-hermes-recording");
let server: Server;
let origin: string;

const fixture = `<!doctype html><html><head><title>Roofing CRM</title></head><body><h1>Dashboard</h1><button id="leads">Leads</button><button aria-label="Add Lead">Add Lead</button><form id="lead-form"><label>Name <input name="name"></label><label>Email <input name="email" type="email"></label><label>Status <select name="status"><option value="new">New</option><option value="qualified">Qualified</option></select></label><label>Access Token <input name="apiKey" autocomplete="current-password"></label><button type="submit">Save</button></form><script>document.querySelector('form').addEventListener('submit',e=>e.preventDefault())</script></body></html>`;

async function executeSqlScript(sql: string) { for (const statement of sql.split(";").map((part) => part.trim()).filter(Boolean)) await prisma.$executeRawUnsafe(statement); }

beforeAll(async () => {
  server = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end(fixture); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server failed.");
  origin = `http://127.0.0.1:${address.port}`;
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
  await prisma.user.createMany({ data: [{ id: "owner", primaryEmail: "owner@recording.test" }, { id: "other", primaryEmail: "other@recording.test" }] });
  await prisma.project.createMany({ data: [
    { id: "owner-project", userId: "owner", projectName: "Owner", localFolderPath: "C:/approved/owner-project", localDevUrl: origin, localPreviewStatus: "online" },
    { id: "sibling-project", userId: "owner", projectName: "Sibling", localDevUrl: "http://127.0.0.1:65530", localPreviewStatus: "online" },
    { id: "other-project", userId: "other", projectName: "Other", localDevUrl: origin, localPreviewStatus: "online" },
  ] });
  phase1 = await import("@/lib/teach-hermes");
  recording = await import("@/lib/teach-hermes-recording");
});

afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await prisma.$disconnect(); });

describe.sequential("Teach Hermes Phase 2", () => {
  it("enforces active owner/project sessions and approved local Builder origins", async () => {
    const session = await phase1.startTeachingSession("owner", { goal: "Teach CRM entry", projectId: "owner-project" });
    await expect(recording.startTeachingRecording("other", session.id)).rejects.toThrow("not found");
    await expect(phase1.startTeachingSession("owner", { goal: "foreign", projectId: "other-project" })).rejects.toThrow("Project not found");
    for (const url of ["https://example.com", "file:///tmp/form.html", "javascript:alert(1)", "http://127.0.0.1:65531"]) {
      await prisma.project.updateMany({ where: { id: "owner-project" }, data: { localDevUrl: url } });
      await expect(recording.startTeachingRecording("owner", session.id)).rejects.toThrow();
    }
    await prisma.project.updateMany({ where: { id: "owner-project" }, data: { localDevUrl: origin } });
    const active = await recording.startTeachingRecording("owner", session.id);
    expect(active).toMatchObject({ projectId: "owner-project", origin });
    await expect(recording.appendRecordedBrowserEvent("owner", { sessionId: "missing", nonce: active.nonce, browserSequence: 1, event: { kind: "click", pageUrl: origin } })).rejects.toThrow("not found");
    await expect(recording.appendRecordedBrowserEvent("owner", { sessionId: session.id, nonce: active.nonce, browserSequence: 1, event: { kind: "mousemove" as never, pageUrl: origin } })).rejects.toThrow("Unsupported");
    await expect(recording.appendRecordedBrowserEvent("owner", { sessionId: session.id, nonce: active.nonce, browserSequence: 1, event: { kind: "click", pageUrl: "https://example.com" } })).rejects.toThrow("outside");
  });

  it("records a real semantic browser workflow without mutating the project", async () => {
    const session = await phase1.getCurrentTeachingSession("owner", "owner-project");
    const active = await recording.startTeachingRecording("owner", session!.id);
    const { chromium } = await import("playwright");
    const { TeachHermesPlaywrightRecorder } = await import("@/lib/teach-hermes-playwright-recorder");
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    let retry: { sequence: number; event: import("@/lib/teach-hermes-recording").RecordedBrowserEvent } | undefined;
    const recorder = new TeachHermesPlaywrightRecorder(page, active.origin, async (browserSequence, event) => {
      retry = { sequence: browserSequence, event };
      return recording.appendRecordedBrowserEvent("owner", { sessionId: session!.id, nonce: active.nonce, browserSequence, event });
    });
    const sourceBefore = createHash("sha256").update(fixture).digest("hex");
    await recorder.navigate("/");
    await recorder.click(page.getByRole("button", { name: "Add Lead" }));
    await recorder.fill(page.getByLabel("Name"), "Ada Roofer");
    await recorder.fill(page.getByLabel("Email"), "ada@example.test");
    await recorder.select(page.getByLabel("Status"), "qualified");
    await recorder.fill(page.getByLabel("Access Token"), "secret-original-token");
    await recorder.submit(page.locator("form"));
    await recorder.checkpoint("Lead saved");
    const duplicate = await recording.appendRecordedBrowserEvent("owner", { sessionId: session!.id, nonce: active.nonce, browserSequence: retry!.sequence, event: retry!.event });
    expect(duplicate.duplicate).toBe(true);
    await recording.stopTeachingRecording("owner", session!.id);
    await browser.close();
    const events = await prisma.skillTeachingEvent.findMany({ where: { sessionId: session!.id }, orderBy: { sequence: "asc" } });
    expect(events.map((event) => event.kind)).toEqual(["navigate", "click", "fill", "fill", "select", "fill", "submit", "checkpoint"]);
    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const persisted = events.map((event) => event.payload).join("\n");
    expect(persisted).toContain("[REDACTED]");
    expect(persisted).not.toContain("secret-original-token");
    expect(persisted).toContain("Add Lead");
    expect(persisted).not.toMatch(/mousemove|keydown|mouseX|mouseY/);
    expect(createHash("sha256").update(fixture).digest("hex")).toBe(sourceBefore);
    expect(await prisma.skillDraft.count({ where: { sessionId: session!.id } })).toBe(0);
    expect(await prisma.userSkill.count()).toBe(0);
  });

  it("suppresses every supported sensitive field signal and server-redacts suspicious values", async () => {
    for (const target of [
      { inputType: "password" }, { name: "password" }, { name: "apiKey" }, { label: "Access Token" },
      { autocomplete: "current-password" }, { name: "authorization" }, { label: "Cookie" },
    ]) expect(recording.sanitizeBrowserValue("must-not-leave-browser", target)).toBe("[REDACTED]");
    expect(phase1.sanitizeSemanticTeachingEvent({ kind: "fill", target: { name: "notes" }, value: "Authorization: Bearer abc.def.secret" }).value).toBe("[REDACTED]");
  });

  it("rejects expired and stopped recording while leaving the Phase 1 session unpromoted", async () => {
    const expired = await phase1.startTeachingSession("owner", { goal: "Expired", projectId: "sibling-project" });
    await prisma.skillTeachingSession.update({ where: { id: expired.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await expect(recording.startTeachingRecording("owner", expired.id)).rejects.toThrow("expired");
    const session = await phase1.getCurrentTeachingSession("owner", "owner-project");
    expect(session?.status).toBe("recording");
    expect(session?.recordingActive).toBe(false);
  });
});
