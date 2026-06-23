import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

type Db = ReturnType<typeof createClient>;

export type LocalBuildProject = {
  id: string;
  projectName: string;
  localFolderPath: string;
  status: string;
  createdAt: string;
  currentTask: string;
  taskId: string;
  buildLog: string | null;
  buildError: string | null;
  localDevUrl: string | null;
  localDevPid: number | null;
  files?: string[];
};

export type LocalBuilderRootInfo = {
  root: string;
  exists: boolean;
  projectCount: number;
  warning: string | null;
};

const LOCAL_BUILD_STATUS = "Ready to Build";
const LOCAL_BUILDER_AGENT = "hermes-local-builder";
const devServers = new Map<string, { child: ReturnType<typeof spawn>; url: string; pid: number | null }>();

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function getLocalProjectsRoot(): Promise<string> {
  if (process.env.HERMES_LOCAL_PROJECTS_ROOT?.trim()) {
    return path.resolve(process.env.HERMES_LOCAL_PROJECTS_ROOT.trim());
  }

  const candidates = [
    "C:\\Users\\osman\\OneDrive\\Desktop\\Hermes Project",
    "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject",
  ];

  const preferred = path.resolve(candidates[0]);
  if (await exists(preferred)) return preferred;
  if (await exists(path.dirname(preferred))) return preferred;

  const legacy = path.resolve(candidates[1]);
  if (await exists(legacy)) return legacy;

  return preferred;
}

export async function getLocalBuilderRootInfo(): Promise<LocalBuilderRootInfo> {
  const root = await getLocalProjectsRoot();
  const rootExists = await exists(root);
  const entries = rootExists ? await readdir(root, { withFileTypes: true }).catch(() => []) : [];
  const projectCount = entries.filter((entry) => entry.isDirectory()).length;

  return {
    root,
    exists: rootExists,
    projectCount,
    warning: rootExists ? null : "Local builder root folder is missing.",
  };
}

export function parseLocalBuildRequest(message: string): { projectName: string; folderName: string } | null {
  const trimmed = message.trim();
  if (!/\b(build|create|make|start|scaffold)\b/i.test(trimmed)) return null;
  if (!/\b(website|site|app|web app|landing page|project)\b/i.test(trimmed)) return null;

  const explicitName =
    trimmed.match(/\b(?:called|named)\s+["']?([a-z0-9][a-z0-9 _-]{1,70})["']?/i)?.[1] ??
    trimmed.match(/\b(?:website|site|app|web app|landing page|project)\s+["']?([a-z0-9][a-z0-9 _-]{1,70})["']?/i)?.[1];

  if (!explicitName) return null;

  const projectName = explicitName
    .replace(/\s+(?:for|with|that|using|in)\b.*$/i, "")
    .replace(/[.!?].*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (projectName.length < 2) return null;

  const folderName = projectName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!folderName) return null;
  return { projectName, folderName };
}

async function ensureLocalBuilderColumns(db: Db): Promise<void> {
  await db.execute(`ALTER TABLE Project ADD COLUMN localFolderPath TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildLog TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildError TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevUrl TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevPid INTEGER`).catch(() => undefined);
}

function rowString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quotedAfter(message: string, label: string): string | null {
  const quoteChars = "\\\"'\\u201c\\u201d\\u2018\\u2019";
  const match = message.match(new RegExp(`${label}\\s*[${quoteChars}]([^${quoteChars}]+)[${quoteChars}]`, "i"));
  return match?.[1]?.trim() ?? null;
}

function cleanDisplayText(value: string): string {
  return value.replace(/[<>{}]/g, "").trim();
}

function packageName(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "hermes-local-app";
}

function appFiles(projectName: string, message: string): Record<string, string> {
  const heading = cleanDisplayText(
    quotedAfter(message, "heading(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    quotedAfter(message, "landing page(?:\\s+that\\s+says)?") ??
    `${projectName} is live`
  );
  const button = cleanDisplayText(
    quotedAfter(message, "one\\s+button(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    quotedAfter(message, "button(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    "Start"
  );
  const safeName = cleanDisplayText(projectName);

  return {
    "package.json": `${JSON.stringify({
      name: packageName(projectName),
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
      },
      dependencies: {
        next: "^16.0.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {
        "@types/node": "^22.0.0",
        "@types/react": "^19.0.0",
        typescript: "^5.6.0",
      },
    }, null, 2)}\n`,
    "README.md": `# ${safeName}\n\nGenerated by Hermes Local Builder.\n\n## Commands\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm run dev\n\`\`\`\n`,
    "next.config.mjs": `const nextConfig = {};\n\nexport default nextConfig;\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }, null, 2)}\n`,
    "next-env.d.ts": `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// This file is generated by Next.js. Do not edit it directly.\n`,
    "src/app/layout.tsx": `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: "${safeName}",\n  description: "Generated by Hermes Local Builder",\n};\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    "src/app/page.tsx": `export default function Home() {\n  return (\n    <main className="page">\n      <section className="hero" aria-label="${safeName} landing page">\n        <p className="eyebrow">${safeName}</p>\n        <h1>${heading}</h1>\n        <button type="button">${button}</button>\n      </section>\n    </main>\n  );\n}\n`,
    "src/app/globals.css": `:root {\n  color-scheme: dark;\n  background: #101820;\n  color: #f7fbff;\n  font-family: Arial, Helvetica, sans-serif;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n}\n\n.page {\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  padding: 32px;\n  background: linear-gradient(135deg, #101820 0%, #1f3a3d 52%, #f2b84b 100%);\n}\n\n.hero {\n  width: min(760px, 100%);\n  display: grid;\n  gap: 22px;\n  text-align: center;\n}\n\n.eyebrow {\n  margin: 0;\n  color: #f2b84b;\n  font-size: 13px;\n  font-weight: 700;\n  letter-spacing: 0.14em;\n  text-transform: uppercase;\n}\n\nh1 {\n  margin: 0;\n  color: #ffffff;\n  font-size: clamp(44px, 9vw, 84px);\n  line-height: 0.95;\n  letter-spacing: 0;\n}\n\nbutton {\n  justify-self: center;\n  min-width: 132px;\n  border: 0;\n  border-radius: 8px;\n  padding: 14px 22px;\n  background: #ffffff;\n  color: #101820;\n  font-size: 16px;\n  font-weight: 800;\n  cursor: pointer;\n}\n`,
  };
}

async function run(command: string, args: string[], cwd: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? (process.env.ComSpec ?? "cmd.exe") : command;
    const commandArgs = isWindows ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(executable, commandArgs, { cwd, shell: false, env: process.env });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output: `${output}\nCommand timed out.`.trim().slice(-8000) });
    }, 180_000);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, output: output.trim().slice(-8000) });
    });
  });
}

async function updateProjectBuildState(db: Db, projectId: string, status: string, log: string, error: string | null = null): Promise<void> {
  await db.execute({
    sql: `UPDATE Project SET status = ?, localBuildLog = ?, localBuildError = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [status, log.slice(-12000), error?.slice(0, 4000) ?? null, projectId],
  });
}

async function updateProjectDevState(db: Db, projectId: string, status: string, url: string | null, pid: number | null, log: string): Promise<void> {
  await db.execute({
    sql: `UPDATE Project SET status = ?, localDevUrl = ?, localDevPid = ?, localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ?`,
    args: [status, url, pid, log.slice(-12000), projectId],
  });
}

async function findLocalBuildProject(db: Db, userId: string, projectId: string): Promise<Record<string, unknown>> {
  await ensureLocalBuilderColumns(db);
  const res = await db.execute({
    sql: `SELECT * FROM Project WHERE id = ? AND userId = ? LIMIT 1`,
    args: [projectId, userId],
  });
  if (!res.rows.length) throw new Error("Prepared local project was not found.");
  return res.rows[0] as Record<string, unknown>;
}

async function resolveProjectFolder(project: Record<string, unknown>): Promise<{ projectName: string; folder: string; createdAt: string }> {
  const projectName = rowString(project.projectName);
  const localFolderPath = rowString(project.localFolderPath);
  const createdAt = rowString(project.createdAt) || new Date().toISOString();
  if (!projectName || !localFolderPath) throw new Error("Project is missing its local folder path.");

  const root = await getLocalProjectsRoot();
  const resolvedRoot = path.resolve(root);
  const resolvedFolder = path.resolve(localFolderPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedFolder !== resolvedRoot && !resolvedFolder.startsWith(rootWithSep)) {
    throw new Error("Unsafe local project folder path rejected.");
  }

  return { projectName, folder: resolvedFolder, createdAt };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function nextAvailablePort(start = 3000): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("No available localhost port found between 3000 and 3049.");
}

async function killProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = process.platform === "win32"
      ? spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, stdio: "ignore" })
      : spawn("kill", ["-TERM", String(pid)], { shell: false, stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

async function logLocalBuilderRun(db: Db, status: string, input: string, output: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'none', ?, datetime('now'))`,
    args: [crypto.randomUUID(), LOCAL_BUILDER_AGENT, input, output.slice(0, 2000), status],
  }).catch(() => undefined);
}

export async function prepareLocalBuildProject(userId: string, message: string): Promise<LocalBuildProject | null> {
  const parsed = parseLocalBuildRequest(message);
  if (!parsed) return null;

  const root = await getLocalProjectsRoot();
  await mkdir(root, { recursive: true });

  const localFolderPath = path.resolve(root, parsed.folderName);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (localFolderPath !== root && !localFolderPath.startsWith(rootWithSep)) {
    throw new Error("Unsafe local project folder path rejected.");
  }
  await mkdir(localFolderPath, { recursive: true });

  const db = getDb();
  await ensureLocalBuilderColumns(db);

  const now = new Date().toISOString();
  const existing = await db.execute({
    sql: `SELECT * FROM Project WHERE userId = ? AND (lower(projectName) = lower(?) OR localFolderPath = ?) LIMIT 1`,
    args: [userId, parsed.projectName, localFolderPath],
  });

  let projectId: string;
  let createdAt = now;

  if (existing.rows.length) {
    const row = existing.rows[0] as Record<string, unknown>;
    projectId = rowString(row.id);
    createdAt = rowString(row.createdAt) || now;
    await db.execute({
      sql: `UPDATE Project SET projectName = ?, status = ?, latestInstruction = ?, assignedAgent = ?, localFolderPath = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [parsed.projectName, LOCAL_BUILD_STATUS, message.slice(0, 500), LOCAL_BUILDER_AGENT, localFolderPath, projectId],
    });
  } else {
    projectId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO Project (id, userId, projectName, route, status, latestInstruction, assignedAgent, localFolderPath, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [projectId, userId, parsed.projectName, null, LOCAL_BUILD_STATUS, message.slice(0, 500), LOCAL_BUILDER_AGENT, localFolderPath],
    });
  }

  const currentTask = `Prepare local build folder for ${parsed.projectName}`;
  const taskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, currentTask],
  });

  let taskId: string;
  if (taskExisting.rows.length) {
    taskId = rowString((taskExisting.rows[0] as Record<string, unknown>).id);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'pending', assignedAgent = ?, nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [LOCAL_BUILDER_AGENT, "Generate the app when Local Builder v2 is enabled", taskId],
    });
  } else {
    taskId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
      args: [taskId, projectId, userId, currentTask, message.slice(0, 500), LOCAL_BUILDER_AGENT, "Generate the app when Local Builder v2 is enabled"],
    });
  }

  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'none', 'completed', datetime('now'))`,
    args: [
      crypto.randomUUID(),
      LOCAL_BUILDER_AGENT,
      `local_build_prepare project=${parsed.projectName}`,
      `Prepared ${localFolderPath}`,
    ],
  }).catch(() => undefined);

  return {
    id: projectId,
    projectName: parsed.projectName,
    localFolderPath,
    status: LOCAL_BUILD_STATUS,
    createdAt,
    currentTask,
    taskId,
    buildLog: null,
    buildError: null,
    localDevUrl: null,
    localDevPid: null,
  };
}

export async function generateLocalStarterApp(userId: string, projectId: string, message: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder: resolvedFolder, createdAt } = await resolveProjectFolder(project);

  const taskTitle = `Generate starter app for ${projectName}`;
  const taskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, taskTitle],
  });
  const taskId = taskExisting.rows.length ? rowString((taskExisting.rows[0] as Record<string, unknown>).id) : crypto.randomUUID();
  if (taskExisting.rows.length) {
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'in_progress', assignedAgent = ?, nextStep = 'Generate starter app files', updatedAt = datetime('now') WHERE id = ?`,
      args: [LOCAL_BUILDER_AGENT, taskId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, 'Generate starter app files', datetime('now'))`,
      args: [taskId, projectId, userId, taskTitle, message.slice(0, 500), LOCAL_BUILDER_AGENT],
    });
  }

  let log = "Ready to Build\n";
  const files = appFiles(projectName, message);
  const changedFiles = Object.keys(files);

  try {
    await updateProjectBuildState(db, projectId, "Generating", log);
    await mkdir(resolvedFolder, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.resolve(resolvedFolder, ...relativePath.split("/"));
      const folderWithSep = resolvedFolder.endsWith(path.sep) ? resolvedFolder : `${resolvedFolder}${path.sep}`;
      if (absolutePath !== resolvedFolder && !absolutePath.startsWith(folderWithSep)) {
        throw new Error(`Unsafe generated file path rejected: ${relativePath}`);
      }
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }
    log += `Generating: wrote ${changedFiles.join(", ")}\n`;

    await updateProjectBuildState(db, projectId, "Installing", log);
    const install = await run("npm", ["install"], resolvedFolder);
    log += `\nInstalling: ${install.ok ? "passed" : "failed"}\n${install.output}\n`;
    if (!install.ok) throw new Error(`npm install failed\n${install.output}`);

    await updateProjectBuildState(db, projectId, "Building", log);
    const build = await run("npm", ["run", "build"], resolvedFolder);
    log += `\nBuilding: ${build.ok ? "passed" : "failed"}\n${build.output}\n`;
    if (!build.ok) throw new Error(`npm run build failed\n${build.output}`);

    await updateProjectBuildState(db, projectId, "Build Passed", log);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'done', nextStep = 'Build passed', updatedAt = datetime('now') WHERE id = ?`,
      args: [taskId],
    });
    await logLocalBuilderRun(db, "completed", `local_build_generate project=${projectName}`, `Build Passed: ${resolvedFolder}`);

    return {
      id: projectId,
      projectName,
      localFolderPath: resolvedFolder,
      status: "Build Passed",
      createdAt,
      currentTask: taskTitle,
      taskId,
      buildLog: log.slice(-12000),
      buildError: null,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      files: changedFiles,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateProjectBuildState(db, projectId, "Build Failed", log, detail);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'pending', nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [`Fix first build error: ${detail.slice(0, 300)}`, taskId],
    }).catch(() => undefined);
    await logLocalBuilderRun(db, "failed", `local_build_generate project=${projectName}`, detail.slice(0, 2000));
    return {
      id: projectId,
      projectName,
      localFolderPath: resolvedFolder,
      status: "Build Failed",
      createdAt,
      currentTask: taskTitle,
      taskId,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      files: changedFiles,
    };
  }
}

export async function rebuildLocalStarterApp(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const taskId = crypto.randomUUID();
  let log = `${rowString(project.localBuildLog)}\nRebuild requested\n`.trim();

  try {
    await updateProjectBuildState(db, projectId, "Building", log);
    const build = await run("npm", ["run", "build"], folder);
    log += `\n\nRebuild: ${build.ok ? "passed" : "failed"}\n${build.output}\n`;
    if (!build.ok) throw new Error(`npm run build failed\n${build.output}`);
    await updateProjectBuildState(db, projectId, "Build Passed", log);
    await logLocalBuilderRun(db, "completed", `local_build_rebuild project=${projectName}`, `Build Passed: ${folder}`);
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Build Passed",
      createdAt,
      currentTask: `Rebuild ${projectName}`,
      taskId,
      buildLog: log.slice(-12000),
      buildError: null,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateProjectBuildState(db, projectId, "Build Failed", log, detail);
    await logLocalBuilderRun(db, "failed", `local_build_rebuild project=${projectName}`, detail);
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Build Failed",
      createdAt,
      currentTask: `Rebuild ${projectName}`,
      taskId,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
    };
  }
}

export async function openLocalProjectFolder(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  let log = `${rowString(project.localBuildLog)}\nOpen Folder: ${folder}`.trim();
  try {
    const child = spawn("code", [folder], { detached: true, shell: process.platform === "win32", stdio: "ignore" });
    child.unref();
    log += "\nVS Code open command sent.";
  } catch (error) {
    log += `\nVS Code open failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await updateProjectBuildState(db, projectId, rowString(project.status) || "Build Passed", log, null);
  await logLocalBuilderRun(db, "completed", `local_build_open_folder project=${projectName}`, folder);
  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: rowString(project.status) || "Build Passed",
    createdAt,
    currentTask: `Open folder for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: rowString(project.localDevUrl) || null,
    localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
  };
}

export async function startLocalDevServer(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const existing = devServers.get(projectId);
  if (existing && !existing.child.killed) {
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Dev Server Running",
      createdAt,
      currentTask: `Preview ${projectName}`,
      taskId: crypto.randomUUID(),
      buildLog: rowString(project.localBuildLog),
      buildError: null,
      localDevUrl: existing.url,
      localDevPid: existing.pid,
    };
  }

  const port = await nextAvailablePort(3000);
  const url = `http://localhost:${port}`;
  let output = `${rowString(project.localBuildLog)}\nStarting dev server at ${url}\n`.trim();
  const child = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd: folder,
    shell: process.platform === "win32",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  devServers.set(projectId, { child, url, pid: child.pid ?? null });
  child.stdout?.on("data", (chunk) => { output = `${output}\n${String(chunk)}`.slice(-12000); });
  child.stderr?.on("data", (chunk) => { output = `${output}\n${String(chunk)}`.slice(-12000); });
  child.on("exit", () => {
    const current = devServers.get(projectId);
    if (current?.child === child) devServers.delete(projectId);
  });

  await new Promise((resolve) => setTimeout(resolve, 2500));
  await updateProjectDevState(db, projectId, "Dev Server Running", url, child.pid ?? null, output);
  await logLocalBuilderRun(db, "completed", `local_build_start_dev project=${projectName}`, `Dev Server Running: ${url}`);

  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: "Dev Server Running",
    createdAt,
    currentTask: `Preview ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: output.slice(-12000),
    buildError: null,
    localDevUrl: url,
    localDevPid: child.pid ?? null,
  };
}

export async function stopLocalDevServer(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const running = devServers.get(projectId);
  if (running?.pid) await killProcessTree(running.pid);
  else if (typeof project.localDevPid === "number") await killProcessTree(project.localDevPid);
  devServers.delete(projectId);
  const log = `${rowString(project.localBuildLog)}\nDev Server Stopped`.trim();
  await updateProjectDevState(db, projectId, "Dev Server Stopped", null, null, log);
  await logLocalBuilderRun(db, "completed", `local_build_stop_dev project=${projectName}`, "Dev Server Stopped");
  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: "Dev Server Stopped",
    createdAt,
    currentTask: `Stop preview for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: null,
    localDevPid: null,
  };
}
