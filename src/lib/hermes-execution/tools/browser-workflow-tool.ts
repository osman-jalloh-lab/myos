import { prisma } from "@/lib/db";
import { redactTeachingText, type SemanticTeachingEvent } from "@/lib/teach-hermes";
import { registerTool } from "../tool-registry";

export const BROWSER_WORKFLOW_TOOL = "internal.browser.executeFormWorkflow";

export type ApprovedBrowserWorkflowStep = {
  kind: "navigate" | "click" | "fill" | "select" | "submit" | "checkpoint";
  path?: string;
  target?: NonNullable<SemanticTeachingEvent["target"]>;
  inputKey?: string;
  expected?: string;
};

export type ApprovedBrowserWorkflow = {
  projectId: string;
  steps: ApprovedBrowserWorkflowStep[];
};

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);
const SENSITIVE = /password|passcode|secret|token|api[-_ ]?key|authorization|credential|session|cookie|private[-_ ]?key|access[-_ ]?key/i;

function clean(value: unknown, max = 200): string {
  return redactTeachingText(value, "browserWorkflow", max);
}

function safeOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error("The owned Builder preview URL is invalid."); }
  if (url.protocol !== "http:" || !LOCAL_HOSTS.has(url.hostname) || !url.port || url.username || url.password) {
    throw new Error("Browser execution requires an owned localhost Builder preview.");
  }
  return url.origin;
}

function targetText(target?: ApprovedBrowserWorkflowStep["target"]): string {
  return [target?.label, target?.name, target?.stableId].filter(Boolean).join(" ").toLowerCase();
}

function inputKeyFor(target: ApprovedBrowserWorkflowStep["target"], requiredContext: string[]): string | null {
  const descriptor = targetText(target);
  if (!descriptor || SENSITIVE.test(descriptor) || target?.inputType === "password") return null;
  return requiredContext.find((item) => {
    const words = item.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 2);
    return words.some((word) => descriptor.includes(word));
  }) ?? (descriptor.includes("email") ? "lead email" : descriptor.includes("status") ? "lead status" : descriptor.includes("name") ? "lead name" : null);
}

export function deriveApprovedBrowserWorkflow(input: {
  projectId: string;
  requiredContext: string[];
  events: Array<{ kind: string; payload: string }>;
}): ApprovedBrowserWorkflow | null {
  const steps: ApprovedBrowserWorkflowStep[] = [];
  for (const row of input.events) {
    let event: SemanticTeachingEvent;
    try { event = JSON.parse(row.payload) as SemanticTeachingEvent; } catch { continue; }
    if (event.kind === "observe") continue;
    if (event.kind === "navigate") steps.push({ kind: "navigate", path: clean(event.url || "/", 1000) });
    if (event.kind === "click") steps.push({ kind: "click", target: event.target });
    if (event.kind === "fill" || event.kind === "select") {
      const inputKey = inputKeyFor(event.target, input.requiredContext);
      if (inputKey) steps.push({ kind: event.kind, target: event.target, inputKey });
    }
    if (event.kind === "submit") steps.push({ kind: "submit", target: event.target });
    if (event.kind === "checkpoint") steps.push({ kind: "checkpoint", expected: clean(event.text, 300) });
  }
  const usable = steps.some((step) => step.kind === "submit") && steps.some((step) => step.kind === "fill");
  return usable ? { projectId: input.projectId, steps } : null;
}

function extractInputs(message: string, required: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const email = message.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i)?.[0];
  const name = message.match(/\bnamed\s+(.+?)\s+with\s+email\b/i)?.[1]?.trim();
  const status = message.match(/\bstatus\s+(?:is\s+|to\s+)?([a-z][a-z -]*?)(?:[.!?,]|$)/i)?.[1]?.trim();
  for (const key of required) {
    const normalized = key.toLowerCase();
    const value = normalized.includes("email") ? email : normalized.includes("status") ? status : normalized.includes("name") ? name : undefined;
    if (value) values[key] = value;
  }
  const missing = required.filter((key) => !values[key]);
  if (missing.length) throw new Error(`Required skill inputs are missing: ${missing.join(", ")}.`);
  return values;
}

function locatorFor(page: import("playwright").Page, target: NonNullable<ApprovedBrowserWorkflowStep["target"]>) {
  if (target.role && target.name) return page.getByRole(target.role as never, { name: target.name, exact: true });
  if (target.label) {
    const semanticName = target.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    return page.getByLabel(target.label, { exact: true }).or(page.locator(`[name=${JSON.stringify(semanticName)}]`)).first();
  }
  if (target.stableId) return page.locator(`[id=${JSON.stringify(target.stableId)}]`);
  if (target.selectorHint) return page.locator(target.selectorHint);
  throw new Error("The approved skill contains no stable semantic target for a browser step.");
}

async function executeBrowserWorkflow(input: Record<string, unknown>, userId: string) {
  const skillId = clean(input.skillId, 120);
  const message = clean(input.message, 4000);
  const skill = await prisma.userSkill.findFirst({ where: { userId, skillId, enabled: true } });
  if (!skill) throw new Error("The selected UserSkill is unavailable or disabled.");
  const definition = JSON.parse(skill.definition) as Record<string, unknown>;
  const workflow = definition.browserWorkflow as ApprovedBrowserWorkflow | undefined;
  const requiredContext = Array.isArray(definition.requiredContext) ? definition.requiredContext.map(String) : [];
  if (!workflow?.projectId || !Array.isArray(workflow.steps)) throw new Error("The selected skill has no approved browser workflow.");
  const project = await prisma.project.findFirst({ where: { id: workflow.projectId, userId }, select: { id: true, localDevUrl: true, localPreviewStatus: true } });
  if (!project || project.localPreviewStatus !== "online" || !project.localDevUrl) throw new Error("The owned Builder preview is unavailable.");
  const origin = safeOrigin(project.localDevUrl);
  const values = extractInputs(message, requiredContext);
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  const actionKinds: string[] = [];
  try {
    const page = await browser.newPage();
    for (const step of workflow.steps) {
      console.log(`[browser-workflow] skill=${skillId} step=${step.kind}`);
      if (step.kind === "navigate") {
        const destination = new URL(step.path || "/", origin);
        if (destination.origin !== origin) throw new Error("Skill navigation left the owned preview origin.");
        await page.goto(destination.href, { waitUntil: "domcontentloaded", timeout: 5_000 });
      } else if (step.kind === "click" && step.target) await locatorFor(page, step.target).click({ timeout: 1_500 });
      else if (step.kind === "fill" && step.target && step.inputKey) await locatorFor(page, step.target).fill(values[step.inputKey], { timeout: 1_500 });
      else if (step.kind === "select" && step.target && step.inputKey) {
        const desired = values[step.inputKey];
        await locatorFor(page, step.target).evaluate((element, requested) => {
          const select = element as HTMLSelectElement;
          const option = Array.from(select.options).find((item) => item.label.toLowerCase() === requested.toLowerCase() || item.value.toLowerCase() === requested.toLowerCase());
          if (!option) throw new Error(`No matching option exists for ${requested}.`);
          select.value = option.value;
          select.dispatchEvent(new Event("input", { bubbles: true }));
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }, desired);
      }
      else if (step.kind === "submit") {
        const form = step.target ? locatorFor(page, step.target) : page.locator("form");
        await form.evaluate((element) => (element as HTMLFormElement).requestSubmit());
      }
      actionKinds.push(step.kind);
    }
    await page.waitForTimeout(100);
    const visibleText = await page.locator("body").innerText({ timeout: 2_000 });
    const verificationValues = Object.values(values);
    const missing = verificationValues.filter((value) => !visibleText.toLowerCase().includes(value.toLowerCase()));
    if (missing.length) throw new Error("Submission completed, but the resulting page did not verify every supplied value.");
    await prisma.auditLog.create({ data: { userId, action: "skill.execution.verified", resourceType: "UserSkill", resourceId: skill.id, detail: `skill=${skillId}; project=${project.id}; actions=${actionKinds.join(",")}; verification=passed` } });
    return { answer: `${skill.name} completed and verified in the owned Builder preview. ${verificationValues.join(" · ")}`, artifacts: [] };
  } catch (error) {
    await prisma.auditLog.create({ data: { userId, action: "skill.execution.failed", resourceType: "UserSkill", resourceId: skill.id, detail: `skill=${skillId}; project=${project.id}; actions=${actionKinds.join(",")}; verification=failed` } }).catch(() => undefined);
    throw error;
  } finally {
    await browser.close();
  }
}

export function registerBrowserWorkflowTool(): void {
  registerTool({
    name: BROWSER_WORKFLOW_TOOL,
    description: "Execute an approved semantic form workflow against its owner-scoped localhost Builder preview and verify supplied values in the result.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx) => executeBrowserWorkflow(input, ctx.userId),
  });
}
