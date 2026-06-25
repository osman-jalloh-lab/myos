import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prisma } from "@/lib/db";
import { createEngineeringTask, updateEngineeringTaskStatus } from "@/lib/engineeringTasks";
import { createProjectTask, ensureBuildProject, updateProjectStatus, updateProjectTask } from "@/lib/memory-context";
import type { ExecutionArtifact, ToolContext } from "./types";

type PageRequest = { route: string; heading: string; button: string };

function isServerlessRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
}

function quotedAfter(message: string, label: string): string | null {
  const match = message.match(new RegExp(`${label}\\s*[\\\"'“”‘’]([^\\\"'“”‘’]+)[\\\"'“”‘’]`, "i"));
  return match?.[1]?.trim() ?? null;
}

export function parseSafePageRequest(message: string): PageRequest | null {
  const route = message.match(/\/(?!api(?:\/|\b)|auth(?:\/|\b))([a-z0-9][a-z0-9-]*(?:\/[a-z0-9][a-z0-9-]*)*)/i)?.[0];
  if (!route || !/\b(build|create|add|make)\b.*\b(page|route)\b/i.test(message)) return null;
  return {
    route,
    heading: quotedAfter(message, "heading(?:\\s+(?:that\\s+)?(?:says|reads))?") ?? "New page",
    button: quotedAfter(message, "button(?:\\s+(?:that\\s+)?(?:says|reads))?") ?? "Continue",
  };
}

function cleanText(value: string): string {
  return value.replace(/[<>{}]/g, "");
}

function pageSource(request: PageRequest): string {
  return `export default function Page() {\n  return (\n    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "2rem" }}>\n      <section style={{ textAlign: "center" }}>\n        <h1>${cleanText(request.heading)}</h1>\n        <button type="button">${cleanText(request.button)}</button>\n      </section>\n    </main>\n  );\n}\n`;
}

async function run(command: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? (process.env.ComSpec ?? "cmd.exe") : command;
    const commandArgs = isWindows ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(executable, commandArgs, { cwd, shell: false, env: process.env });
    let output = "";
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => resolve({ ok: false, output: error.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.trim().slice(-4000) }));
  });
}

export async function buildLocalPage(message: string, ctx: ToolContext): Promise<{ answer: string; artifacts: ExecutionArtifact[] } | null> {
  const request = parseSafePageRequest(message);
  if (!request) return null;
  if (isServerlessRuntime()) return null;

  const root = process.cwd();
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
  const relativeFile = path.posix.join("src/app", request.route.slice(1), "page.tsx");
  const absoluteFile = path.resolve(root, ...relativeFile.split("/"));
  if (!absoluteFile.startsWith(path.resolve(root, "src", "app") + path.sep)) throw new Error("Unsafe route path rejected.");

  const project = await ensureBuildProject(ctx.sessionId ?? `${ctx.source}:${ctx.userId}`, ctx.userId, request.route, message);
  const projectTask = await createProjectTask(project.id, ctx.userId, `Build ${request.route}`, { description: message, assignedAgent: "hermes-execution", nextStep: "Create route and validate build" });
  await updateProjectTask(projectTask.id, { status: "in_progress" });
  const build = await createEngineeringTask({ userId: ctx.userId, title: `Build ${request.route}`, repositorySlug: "local/hermes-os", operationType: "safe_isolated_page_build", riskLevel: "low", approvalRequired: false, approvalStatus: "auto_approved", approvedAt: new Date(), approvedBy: "hermes-safe-build-policy" });
  await prisma.engineeringTask.update({ where: { id: build.id }, data: { status: "implementation_running", startedAt: new Date(), executorName: "hermes-execution" } });

  try {
    const source = pageSource(request);
    await mkdir(path.dirname(absoluteFile), { recursive: true });
    await writeFile(absoluteFile, source, "utf8");
    await prisma.engineeringTask.update({ where: { id: build.id }, data: { status: "validation_running" } });

    const checks = [{ label: "npm run build", args: ["run", "build"] }];
    if (packageJson.scripts?.lint) checks.push({ label: "npm run lint", args: ["run", "lint"] });
    if (packageJson.scripts?.typecheck) checks.push({ label: "npm run typecheck", args: ["run", "typecheck"] });
    const results: string[] = [];
    for (const check of checks) {
      const result = await run("npm", check.args, root);
      results.push(`${check.label}: ${result.ok ? "PASSED" : "FAILED"}`);
      if (!result.ok) throw new Error(`${check.label} failed\n${result.output}`);
    }

    const summary = [`Created ${relativeFile}`, ...results].join("\n");
    await updateEngineeringTaskStatus(build.id, { status: "completed", resultSummary: summary, implementationSummary: `Changed files:\n${relativeFile}`, validationResults: results.join("\n") });
    await updateProjectTask(projectTask.id, { status: "done", nextStep: "Build complete" });
    await updateProjectStatus(project.id, "completed");
    return {
      answer: `Build completed without approval.\n\nChanged files:\n- ${relativeFile}\n\nValidation:\n${results.map((item) => `- ${item}`).join("\n")}\n\nCommand Center: project ${project.projectName}, task ${projectTask.id}, build ${build.id}.`,
      artifacts: [{ type: "file", title: relativeFile, content: source, metadata: { projectId: project.id, taskId: projectTask.id, buildId: build.id } }],
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateEngineeringTaskStatus(build.id, { status: "failed", resultSummary: `Failed: ${detail}`, sanitizedError: detail.slice(0, 2000) });
    await updateProjectTask(projectTask.id, { status: "pending", nextStep: `Fix first validation error: ${detail.slice(0, 300)}` });
    await updateProjectStatus(project.id, "blocked");
    throw error;
  }
}
