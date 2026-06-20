import crypto from "node:crypto";
import { prisma } from "./db";

export type EngineeringTaskStatus =
  | "created"
  | "queued"
  | "inspection_running"
  | "blocked_no_executor"
  | "blocked_repo_not_connected"
  | "blocked_missing_credentials"
  | "completed"
  | "failed";

export interface EngineeringTaskView {
  id: string;
  title: string;
  repositorySlug: string;
  operationType: string;
  riskLevel: string;
  approvalRequired: boolean;
  status: EngineeringTaskStatus;
  correlationId: string | null;
  executorName: string | null;
  executorJobId: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  resultSummary: string | null;
  errorReference: string | null;
  sanitizedError: string | null;
}

function toView(row: {
  id: string;
  title: string;
  repositorySlug: string;
  operationType: string;
  riskLevel: string;
  approvalRequired: boolean;
  status: string;
  correlationId: string | null;
  executorName: string | null;
  executorJobId: string | null;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  resultSummary: string | null;
  errorReference: string | null;
  sanitizedError: string | null;
}): EngineeringTaskView {
  return {
    id: row.id,
    title: row.title,
    repositorySlug: row.repositorySlug,
    operationType: row.operationType,
    riskLevel: row.riskLevel,
    approvalRequired: row.approvalRequired,
    status: row.status as EngineeringTaskStatus,
    correlationId: row.correlationId,
    executorName: row.executorName,
    executorJobId: row.executorJobId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    resultSummary: row.resultSummary,
    errorReference: row.errorReference,
    sanitizedError: row.sanitizedError,
  };
}

export async function createEngineeringTask(params: {
  userId: string;
  title: string;
  repositorySlug: string;
  operationType: string;
  riskLevel: string;
  approvalRequired: boolean;
}): Promise<EngineeringTaskView> {
  const row = await prisma.engineeringTask.create({
    data: {
      userId: params.userId,
      title: params.title.slice(0, 200),
      repositorySlug: params.repositorySlug,
      operationType: params.operationType,
      riskLevel: params.riskLevel,
      approvalRequired: params.approvalRequired,
      status: "queued",
      correlationId: null,
      executorName: null,
      executorJobId: null,
      resultSummary: null,
      errorReference: null,
      sanitizedError: null,
    },
  });
  return toView(row);
}

export async function claimQueuedTask(
  executorName: string,
  executorJobId: string
): Promise<EngineeringTaskView | null> {
  const task = await prisma.engineeringTask.findFirst({
    where: {
      status: { in: ["created", "queued"] },
      operationType: "read_only_repo_inspection",
      approvalRequired: false,
      repositorySlug: "osman-jalloh-lab/parawi",
    },
    orderBy: { createdAt: "asc" },
  });

  if (!task) {
    console.log(JSON.stringify({
      event: "engineering-executor.claim",
      result: "no-matching-task",
      executorName,
      executorJobId,
    }));
    return null;
  }

  console.log(JSON.stringify({
    event: "engineering-executor.claim",
    result: "task-claimed",
    taskId: task.id,
    repositorySlug: task.repositorySlug,
    executorName,
    executorJobId,
  }));

  try {
    const row = await prisma.engineeringTask.update({
      where: { id: task.id },
      data: {
        status: "inspection_running",
        correlationId: crypto.randomUUID(),
        executorName: executorName.slice(0, 100),
        executorJobId: executorJobId.slice(0, 100),
        startedAt: new Date(),
      },
    });
    return toView(row);
  } catch (error) {
    console.error(JSON.stringify({
      event: "engineering-executor.claim",
      result: "claim-failed",
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

export async function updateEngineeringTaskStatus(
  taskId: string,
  updates: {
    status: EngineeringTaskStatus;
    resultSummary?: string | null;
    errorReference?: string | null;
    sanitizedError?: string | null;
  }
): Promise<EngineeringTaskView> {
  const row = await prisma.engineeringTask.update({
    where: { id: taskId },
    data: {
      status: updates.status,
      completedAt: updates.status === "completed" || updates.status === "failed" ? new Date() : undefined,
      resultSummary: updates.resultSummary ?? undefined,
      errorReference: updates.errorReference ?? undefined,
      sanitizedError: updates.sanitizedError ?? undefined,
    },
  });
  return toView(row);
}

interface RepoMetadata {
  title: string;
  repoHtmlUrl: string;
  description: string;
  defaultBranch: string;
  visibility: string;
  license: string;
  language: string;
  stars: number;
  forks: number;
  openIssues: number;
  topics: string[];
  packageManager: string;
  buildCommands: string[];
  appRoutes: string[];
  featureFolders: string[];
  likelyFilesForWatches: string[];
  topLevelFiles: string[];
  readmePreview: string;
}

async function fetchGithubJson(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "hermes-os-engineering-executor",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return fetch(`https://api.github.com${path}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
}

function normalizeFilePath(path: string): string {
  return path.replace(/^\.\//, "");
}

async function inspectRepository(repoSlug: string): Promise<{
  status: "ok" | "blocked_missing_credentials" | "blocked_repo_not_connected" | "failed";
  result?: RepoMetadata;
  errorReference?: string;
  sanitizedError?: string;
}> {
  if (repoSlug !== "osman-jalloh-lab/parawi") {
    return {
      status: "failed",
      errorReference: `Engineering executor only supports osman-jalloh-lab/parawi, got ${repoSlug}.`,
      sanitizedError: "Unsupported repository for this worker.",
    };
  }

  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log(JSON.stringify({
      event: "engineering-executor.github",
      result: "missing-credentials",
      repoSlug,
    }));
    return {
      status: "blocked_missing_credentials",
      errorReference: "GITHUB_TOKEN is required for repository inspection.",
      sanitizedError: "GitHub credentials are missing.",
    };
  }

  const repoPath = `/${repoSlug}`;
  const repoRes = await fetchGithubJson(`/repos${repoPath}`, token);
  console.log(JSON.stringify({
    event: "engineering-executor.github.request",
    repoSlug,
    path: `/repos${repoPath}`,
    status: repoRes.status,
  }));
  if (!repoRes.ok) {
    if (repoRes.status === 404) {
      return {
        status: "blocked_repo_not_connected",
        errorReference: `Repository ${repoSlug} was not found on GitHub.`,
        sanitizedError: `GitHub repository not found (404).`,
      };
    }
    if (repoRes.status === 403) {
      return {
        status: "blocked_missing_credentials",
        errorReference: `GitHub access was blocked. Add or refresh GITHUB_TOKEN.`,
        sanitizedError: `GitHub returned 403 for repo metadata.`,
      };
    }
    return {
      status: "failed",
      errorReference: `GitHub repository lookup failed with status ${repoRes.status}.`,
      sanitizedError: `GitHub repo metadata fetch failed with status ${repoRes.status}.`,
    };
  }

  const repoJson = (await repoRes.json()) as Record<string, unknown>;
  const defaultBranch = String(repoJson.default_branch ?? "main");
  const topics = Array.isArray(repoJson.topics) ? (repoJson.topics as string[]) : [];

  const treeRes = await fetchGithubJson(
    `/repos${repoPath}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    token
  );
  console.log(JSON.stringify({
    event: "engineering-executor.github.request",
    repoSlug,
    path: `/repos${repoPath}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    status: treeRes.status,
  }));

  if (!treeRes.ok) {
    if (treeRes.status === 404) {
      return {
        status: "failed",
        errorReference: `Could not inspect repository tree for ${repoSlug}.`,
        sanitizedError: `GitHub repo tree fetch returned 404 for branch ${defaultBranch}.`,
      };
    }
    if (treeRes.status === 403) {
      return {
        status: "blocked_missing_credentials",
        errorReference: `GitHub repo tree access was blocked. Add or refresh GITHUB_TOKEN.`,
        sanitizedError: `GitHub repo tree fetch returned 403 for branch ${defaultBranch}.`,
      };
    }
    return {
      status: "failed",
      errorReference: `GitHub repo tree lookup failed with status ${treeRes.status}.`,
      sanitizedError: `GitHub repo tree fetch failed with status ${treeRes.status}.`,
    };
  }

  const treeJson = (await treeRes.json()) as { tree?: Array<{ path?: string; type?: string }> };
  const rawPaths = Array.isArray(treeJson.tree)
    ? treeJson.tree.map((item) => item.path ?? "").filter(Boolean)
    : [];
  const files = rawPaths.map(normalizeFilePath);

  const topLevelFiles = files.filter((path) => !path.includes("/")).slice(0, 40);
  const packageJsonPath = files.find((path) => path.toLowerCase() === "package.json");
  const buildCommands: string[] = [];
  let packageManager = "unknown";
  const contentFetches: Array<Promise<void>> = [];
  let readmePreview = "";

  if (files.some((path) => path === "pnpm-lock.yaml")) {
    packageManager = "pnpm";
  } else if (files.some((path) => path === "yarn.lock")) {
    packageManager = "yarn";
  } else if (files.some((path) => path === "package-lock.json")) {
    packageManager = "npm";
  } else if (files.some((path) => path === "bun.lockb")) {
    packageManager = "bun";
  }

  async function fetchJson(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetchGithubJson(`/repos${repoPath}/contents/${encodeURIComponent(path)}`, token);
      if (!res.ok) return null;
      const body = (await res.json()) as Record<string, unknown>;
      if (body.encoding === "base64" && typeof body.content === "string") {
        const decoded = Buffer.from(body.content.replace(/\n/g, ""), "base64").toString("utf-8");
        return JSON.parse(decoded) as Record<string, unknown>;
      }
      return null;
    } catch {
      return null;
    }
  }

  if (packageJsonPath) {
    contentFetches.push(
      (async () => {
        console.log(JSON.stringify({
          event: "engineering-executor.github.request",
          repoSlug,
          path: `/repos${repoPath}/contents/${encodeURIComponent(packageJsonPath)}`,
        }));
        const json = await fetchJson(packageJsonPath);
        if (!json) return;
        const scripts = json.scripts as Record<string, string> | undefined;
        if (scripts) {
          if (scripts.build) buildCommands.push(`npm run build`);
          if (scripts.dev) buildCommands.push(`npm run dev`);
          if (scripts.start) buildCommands.push(`npm start`);
          if (scripts.preview) buildCommands.push(`npm run preview`);
        }
      })()
    );
  }

  const readmePath = files.find((path) => /^readme(\.md|\.txt)?$/i.test(path));
  if (readmePath) {
    contentFetches.push(
      (async () => {
        console.log(JSON.stringify({
          event: "engineering-executor.github.request",
          repoSlug,
          path: `/repos${repoPath}/contents/${encodeURIComponent(readmePath)}`,
        }));
        const json = await fetchJson(readmePath);
        if (!json) return;
        const content = String(json.content ?? "");
        if (content) {
          readmePreview = content
            .slice(0, 1200)
            .replace(/#{1,6}\s+/g, "\n")
            .replace(/\n{3,}/g, "\n\n")
            .trim();
        }
      })()
    );
  }

  await Promise.all(contentFetches);

  const appRoutes = files
    .filter((path) =>
      /(^|\/)(app|src\/app|pages|src\/pages)\//.test(path) && /\.(ts|tsx|js|jsx)$/.test(path)
    )
    .filter((path) => /(?:route\.(ts|js)|page\.(tsx|ts|jsx|js)|index\.(tsx|ts|jsx|js))$/.test(path))
    .slice(0, 40);

  const featureFolders = [
    ...new Set(
      files
        .filter((path) => /(^|\/)features?\//.test(path) || /(^|\/)modules?\//.test(path))
        .map((path) => path.split("/")[0])
    )
  ].slice(0, 20);

  const watchCandidates = files.filter((path) => /watch|watches|watcher/i.test(path));
  const likelyFilesForWatches = watchCandidates.length
    ? watchCandidates.slice(0, 20)
    : [
        "src/app/watches/route.ts",
        "src/app/watches/page.tsx",
        "src/lib/watch.ts",
        "src/features/watches/",
        "package.json",
        "README.md",
      ];

  return {
    status: "ok" as const,
    result: {
      title: String(repoJson.full_name ?? repoSlug),
      repoHtmlUrl: String(repoJson.html_url ?? `https://github.com/${repoSlug}`),
      description: String(repoJson.description ?? ""),
      defaultBranch,
      visibility: String(repoJson.visibility ?? "public"),
      license: typeof repoJson.license === "object" && repoJson.license ? String((repoJson.license as Record<string, unknown>).spdx_id ?? "") : "unknown",
      language: String(repoJson.language ?? "unknown"),
      stars: Number(repoJson.stargazers_count ?? 0),
      forks: Number(repoJson.forks_count ?? 0),
      openIssues: Number(repoJson.open_issues_count ?? 0),
      topics,
      packageManager,
      buildCommands: [...new Set(buildCommands)],
      appRoutes,
      featureFolders,
      likelyFilesForWatches,
      topLevelFiles,
      readmePreview,
    },
  };
}

export async function inspectEngineeringTask(taskId: string): Promise<EngineeringTaskView> {
  const task = await prisma.engineeringTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Engineering task ${taskId} not found.`);

  const result = await inspectRepository(task.repositorySlug);

  if (result.status !== "ok") {
    const blockedStatus =
      result.status === "blocked_missing_credentials"
        ? "blocked_missing_credentials"
        : result.status === "blocked_repo_not_connected"
        ? "blocked_repo_not_connected"
        : "failed";

    return await updateEngineeringTaskStatus(taskId, {
      status: blockedStatus,
      resultSummary: null,
      errorReference: result.errorReference ?? null,
      sanitizedError: result.sanitizedError ?? null,
    });
  }

  const metadata = result.result!;
  const summaryLines = [
    `Repository: ${metadata.title}`,
    `Description: ${metadata.description || "(none)"}`,
    `Visibility: ${metadata.visibility}`,
    `Language: ${metadata.language}`,
    `Stars: ${metadata.stars} | Forks: ${metadata.forks} | Open issues: ${metadata.openIssues}`,
    `Default branch: ${metadata.defaultBranch}`,
    `Package manager: ${metadata.packageManager}`,
    `Build commands: ${metadata.buildCommands.length ? metadata.buildCommands.join(", ") : "not detected"}`,
    `Top-level files: ${metadata.topLevelFiles.slice(0, 10).join(", ")}`,
    `App routes: ${metadata.appRoutes.length ? metadata.appRoutes.slice(0, 10).join(", ") : "none detected"}`,
    `Feature folders: ${metadata.featureFolders.length ? metadata.featureFolders.join(", ") : "none detected"}`,
    `Likely /watches files: ${metadata.likelyFilesForWatches.slice(0, 10).join(", ")}`,
  ];

  const resultSummary = summaryLines.join("\n");

  return await updateEngineeringTaskStatus(taskId, {
    status: "completed",
    resultSummary,
    errorReference: null,
    sanitizedError: null,
  });
}

export async function getEngineeringTask(taskId: string): Promise<EngineeringTaskView | null> {
  const row = await prisma.engineeringTask.findUnique({ where: { id: taskId } });
  return row ? toView(row) : null;
}
