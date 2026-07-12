import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentExecutionInput } from "./task-context";
import type { AcceptanceEvidence, AgentProducedArtifact } from "./task-artifacts";
import type { AgentExecutionResult } from "./agent-runtime-registry";

const execFileAsync = promisify(execFile);
const OUTPUT_LIMIT = 6_000;

type CommandEvidence = {
  command: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number;
  passed: boolean;
  stdoutSummary: string;
  stderrSummary: string;
};

function cleanOutput(value: string): string {
  return value
    .replace(/(?:[a-z][a-z0-9+.-]*):\/\/[^\s:@]+:[^\s@]+@/gi, "$1://[redacted]@")
    .replace(/\b(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S+/gi, "$1=[redacted]")
    .slice(-OUTPUT_LIMIT);
}

function artifact(type: AgentProducedArtifact["type"], title: string, summary: string, content: string, metadata?: Record<string, unknown>): AgentProducedArtifact {
  return { type, title, summary, content, metadata };
}

function evidence(type: string, summary: string, artifactTitle: string, passed = true): AcceptanceEvidence {
  return { type, summary, artifactTitle, passed };
}

async function workspace(input: AgentExecutionInput): Promise<string> {
  const value = input.projectContext.workspace.path;
  if (!value) throw new Error("No approved workspace is attached to this task.");
  const resolved = path.resolve(value);
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("Approved workspace is not a directory.");
  return resolved;
}

async function run(command: string, cwd: string): Promise<CommandEvidence> {
  const startedAt = new Date().toISOString();
  const allowed = new Set(["npx tsc --noEmit", "npx vitest run", "npm run build"]);
  if (!allowed.has(command)) throw new Error(`Refusing non-allowlisted validation command: ${command}`);
  const [rawProgram, ...rawArgs] = command.split(" ");
  const program = process.platform === "win32" ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe") : rawProgram;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : rawArgs;
  const childEnv = { ...process.env };
  delete childEnv.HERMES_ALLOW_LOCAL_MIGRATION;
  delete childEnv.HERMES_PROJECT_WORKSPACE;
  try {
    const result = await execFileAsync(program, args, { cwd, env: childEnv, windowsHide: true, timeout: 10 * 60_000, maxBuffer: 10 * 1024 * 1024 });
    return { command, startedAt, finishedAt: new Date().toISOString(), exitCode: 0, passed: true, stdoutSummary: cleanOutput(result.stdout), stderrSummary: cleanOutput(result.stderr) };
  } catch (error) {
    const failure = error as Error & { code?: number; stdout?: string; stderr?: string };
    return { command, startedAt, finishedAt: new Date().toISOString(), exitCode: typeof failure.code === "number" ? failure.code : 1, passed: false, stdoutSummary: cleanOutput(failure.stdout ?? ""), stderrSummary: cleanOutput(failure.stderr ?? failure.message) };
  }
}

async function discoverAppRoot(root: string): Promise<string> {
  for (const candidate of [path.join(root, "src", "app"), path.join(root, "app")]) {
    if (await fs.stat(candidate).then((item) => item.isDirectory()).catch(() => false)) return candidate;
  }
  throw new Error("Approved workspace has no Next.js app or src/app directory.");
}

function requestedRoute(input: AgentExecutionInput): string {
  const text = [input.acceptanceCriteria, input.description, input.projectContext.latestInstruction, input.projectContext.description].filter(Boolean).join("\n");
  const route = text.match(/\/(?!command-center\b)[a-z0-9][a-z0-9-]*/i)?.[0] ?? "/project-control-demo";
  if (!/^\/[a-z0-9][a-z0-9-]*$/i.test(route)) throw new Error(`Unsafe requested route: ${route}`);
  return route;
}

function demoSource(route: string): string {
  const smoke = route === "/project-control-smoke";
  if (smoke) return `import Link from "next/link";

const statuses = ["Planning", "Building", "Complete"];

export default function ProjectControlSmokePage() {
  return (
    <main style={{ minHeight: "100vh", background: "#07110e", color: "#f3f7f2", padding: "clamp(24px, 7vw, 80px)", fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <p style={{ color: "#a8d5ba", fontFamily: "ui-monospace, monospace", fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>Hermes delivery signal</p>
        <h1 style={{ fontSize: "clamp(2.5rem, 8vw, 5.75rem)", lineHeight: .92, margin: "18px 0 42px", maxWidth: 820 }}>Project Control Smoke Test</h1>
        <section aria-label="Project statuses" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
          {statuses.map((status, index) => (
            <article key={status} style={{ border: "1px solid #36594a", borderRadius: 4, padding: "24px 22px", background: index === 1 ? "#173f31" : "#0d2019" }}>
              <span style={{ color: "#8eb7a0", fontFamily: "ui-monospace, monospace" }}>0{index + 1}</span>
              <h2 style={{ margin: "42px 0 0", fontSize: "clamp(1.35rem, 3vw, 2rem)" }}>{status}</h2>
            </article>
          ))}
        </section>
        <section aria-label="Overall progress" style={{ margin: "44px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 20, marginBottom: 12, fontFamily: "ui-monospace, monospace" }}><span>Overall progress</span><strong>60%</strong></div>
          <div role="progressbar" aria-label="Overall progress" aria-valuenow={60} aria-valuemin={0} aria-valuemax={100} style={{ height: 14, border: "1px solid #4d7663", background: "#0d2019", overflow: "hidden" }}>
            <div style={{ width: "60%", height: "100%", background: "#d8f28f" }} />
          </div>
        </section>
        <Link href="/command-center" style={{ color: "#d8f28f", fontFamily: "ui-monospace, monospace", fontWeight: 700, textUnderlineOffset: 6 }}>Back to Command Center</Link>
      </div>
    </main>
  );
}
`;
  return `import Link from "next/link";

const projects = [
  { name: "Discovery", status: "Complete", progress: 100 },
  { name: "Implementation", status: "In progress", progress: 68 },
  { name: "Validation", status: "Queued", progress: 20 },
];

export default function ProjectControlDemoPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#07111f", color: "#f8fafc", padding: "clamp(24px, 6vw, 72px)" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <p style={{ color: "#7dd3fc", fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Project control</p>
        <h1 style={{ fontSize: "clamp(2.25rem, 7vw, 5rem)", lineHeight: 1, margin: "12px 0 18px" }}>Work, made visible.</h1>
        <p style={{ color: "#bac7d8", maxWidth: 620, fontSize: "1.1rem" }}>A live view of delivery from first decision through verified completion.</p>
        <section aria-label="Project statuses" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, margin: "42px 0" }}>
          {projects.map((project) => (
            <article key={project.name} style={{ border: "1px solid #28415e", borderRadius: 18, padding: 22, background: "#0d1b2d" }}>
              <p style={{ color: "#93a7bf", margin: 0 }}>{project.status}</p>
              <h2 style={{ margin: "10px 0 24px" }}>{project.name}</h2>
              <div role="progressbar" aria-label={\`${'${project.name}'} progress\`} aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100} style={{ height: 10, borderRadius: 99, background: "#21344a", overflow: "hidden" }}>
                <div style={{ width: \`${'${project.progress}'}%\`, height: "100%", background: "#38bdf8" }} />
              </div>
              <p style={{ marginBottom: 0 }}>{project.progress}%</p>
            </article>
          ))}
        </section>
        <Link href="/command-center" style={{ color: "#7dd3fc", fontWeight: 700, textUnderlineOffset: 5 }}>Back to Command Center</Link>
      </div>
    </main>
  );
}
`;
}

export async function executePrometheusLive(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const root = await workspace(input);
  if (!input.planId) throw new Error("Prometheus requires an accepted plan.");
  const appRoot = await discoverAppRoot(root);
  const route = requestedRoute(input);
  const routeDir = path.join(appRoot, route.slice(1));
  const routeFile = path.join(routeDir, "page.tsx");
  if (routeFile.includes(`${path.sep}.env`)) throw new Error("Refusing to write an environment file.");
  const inspected = [path.relative(root, appRoot), "package.json"];
  const before = await fs.readFile(routeFile, "utf8").catch(() => null);
  const source = demoSource(route);
  await fs.mkdir(routeDir, { recursive: true });
  if (before !== source) await fs.writeFile(routeFile, source, "utf8");
  const after = await fs.readFile(routeFile, "utf8");
  if (after !== source) throw new Error("Filesystem verification failed after writing the route.");
  const relative = path.relative(root, routeFile).replaceAll("\\", "/");
  const changedFiles = [relative];
  const contentHash = crypto.createHash("sha256").update(after).digest("hex");
  const summary = `${before === null ? "Created" : before === after ? "Verified" : "Modified"} ${relative}; physical file hash ${contentHash}.`;
  return {
    status: "completed",
    summary,
    artifacts: [
      artifact("code_diff", "Project control implementation", summary, after, { route, changedFiles, diffSummary: summary, contentHash, workspace: root, executionRunId: input.executionRunId, planId: input.planId, correlationId: input.correlationId }),
      artifact("build_result", "Prometheus implementation record", "Filesystem implementation completed; validation remains assigned to Argus.", JSON.stringify({ filesInspected: inspected, filesCreated: before === null ? changedFiles : [], filesModified: before !== null && before !== after ? changedFiles : [], commandsPerformed: [], implementationSummary: summary, remainingConcerns: ["Production validation and design review are separate gates."] }, null, 2)),
    ],
    evidence: [
      evidence("route_file", `A page exists at ${route} in ${relative}.`, "Project control implementation"),
      evidence("heading", "The implementation contains a visible h1 heading.", "Project control demo implementation"),
      evidence("status_cards", "The implementation maps exactly three project status cards.", "Project control demo implementation"),
      evidence("progress", "The implementation contains accessible progressbar elements.", "Project control demo implementation"),
      evidence("navigation", "The implementation links to /command-center.", "Project control demo implementation"),
    ],
  };
}

export async function executeFuguLive(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const root = await workspace(input);
  const implementation = input.previousArtifacts.find((item) => item.type === "code_diff");
  if (!implementation) return { status: "blocked", summary: "Fugu requires a real code_diff artifact.", artifacts: [], evidence: [], blocker: { type: "missing_implementation_artifact", reason: "No code_diff artifact was available." } };
  const routePath = requestedRoute(input);
  const route = path.join(await discoverAppRoot(root), routePath.slice(1), "page.tsx");
  const source = await fs.readFile(route, "utf8").catch(() => "");
  if (!source) return { status: "blocked", summary: "The implementation artifact points to no readable route source.", artifacts: [], evidence: [], blocker: { type: "missing_source", reason: "Route source was not readable." } };
  const required: string[] = [];
  if ((source.match(/<article\b/g) ?? []).length < 1 || !/\.map\(\(.*(?:project|status)/.test(source)) required.push("Render the three status cards consistently.");
  if (!source.includes('role="progressbar"') || !source.includes("aria-valuenow")) required.push("Expose progress semantics to assistive technology.");
  if (!source.includes('href="/command-center"')) required.push("Add an accessible Command Center link.");
  if (!source.includes("repeat(auto-fit")) required.push("Add responsive card layout behavior.");
  const verdict = required.length ? "revision_required" : "passed";
  const review = { verdict, requiredFindings: required.map((description, index) => ({ id: `required-${index + 1}`, description })), optionalFindings: [{ id: "optional-1", description: "Consider adding a browser-rendered screenshot when preview infrastructure is available." }], evidenceReviewed: [implementation.id, path.relative(root, route).replaceAll("\\", "/")] };
  return {
    status: required.length ? "in_review" : "completed",
    summary: required.length ? `Fugu found ${required.length} required design issue(s).` : "Fugu passed the real implementation evidence with no required findings.",
    artifacts: [artifact("design_review", "Fugu project control demo review", `Verdict: ${verdict}.`, JSON.stringify(review, null, 2), review)],
    evidence: [evidence("design_review", `Design review ${verdict}; evidence reviewed: ${review.evidenceReviewed.join(", ")}.`, "Fugu project control demo review", !required.length)],
    followUpTasks: required.map((description) => ({ title: `Resolve Fugu finding: ${description}`, description, assignedAgent: "prometheus", acceptanceCriteria: description, outputContract: "code_diff" })),
  };
}

export async function executeArgusLive(input: AgentExecutionInput): Promise<AgentExecutionResult> {
  const root = await workspace(input);
  const commands = ["npx tsc --noEmit", "npx vitest run", "npm run build"];
  const results: CommandEvidence[] = [];
  for (const command of commands) results.push(await run(command, root));
  const artifacts = results.map((result, index) => artifact(index === 2 ? "build_result" : "test_result", index === 0 ? "TypeScript result" : index === 1 ? "Test result" : "Production build result", `${result.command} exited ${result.exitCode}.`, JSON.stringify(result, null, 2), result));
  const passed = results.every((result) => result.passed);
  artifacts.push(artifact("completion_report", "Argus final readiness verdict", passed ? "All required validation commands passed." : "One or more validation commands failed.", JSON.stringify({ verdict: passed ? "passed" : "failed", commands: results }, null, 2)));
  return {
    status: passed ? "completed" : "failed",
    summary: passed ? "Argus ran TypeScript, tests, and the production build successfully." : `Argus validation failed: ${results.filter((item) => !item.passed).map((item) => `${item.command} (${item.exitCode})`).join(", ")}.`,
    artifacts,
    evidence: results.map((result) => evidence(result.command.includes("build") ? "build" : result.command.includes("tsc") ? "typecheck" : "test", `${result.command} exited ${result.exitCode}.`, result.command.includes("build") ? "Production build result" : result.command.includes("tsc") ? "TypeScript result" : "Test result", result.passed)),
  };
}
