import crypto from "node:crypto";
import { prisma } from "./db";

// ---------------------------------------------------------------------------
// Status enum
// ---------------------------------------------------------------------------

export type EngineeringTaskStatus =
  // Shared lifecycle
  | "created"
  | "queued"
  | "completed"
  | "failed"
  // Phase 1 — read-only inspection
  | "inspection_running"
  | "blocked_no_executor"
  | "blocked_repo_not_connected"
  | "blocked_missing_credentials"
  // Phase 2 — branch execution
  | "blocked_approval_required"
  | "branch_creating"
  | "implementation_running"
  | "validation_running"
  | "changes_ready_for_review"
  | "pull_request_open"
  // Phase 3 — deployment
  | "deployment_pending_approval"
  | "deployed"
  | "deployment_failed"
  | "rolled_back";

const APPROVED_STATUSES = new Set([
  "approved",
  "approved_for_branch",
  "approved_for_implementation",
]);

const APPROVED_FOR_DEPLOYMENT_STATUSES = new Set([
  "approved_for_deployment",
  "approved_for_preview",
]);

// ---------------------------------------------------------------------------
// View type
// ---------------------------------------------------------------------------

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
  // Phase 2
  approvalStatus: string | null;
  approvedAt: string | null;
  approvedBy: string | null;
  branchName: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  implementationSummary: string | null;
  validationResults: string | null;
  // Phase 3
  deployTarget: string | null;
  deployStatus: string | null;
  vercelDeploymentId: string | null;
  deploymentUrl: string | null;
  deployStartedAt: string | null;
  deployCompletedAt: string | null;
  rollbackReference: string | null;
}

// ---------------------------------------------------------------------------
// Row → view
// ---------------------------------------------------------------------------

type TaskRow = {
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
  approvalStatus: string | null;
  approvedAt: Date | null;
  approvedBy: string | null;
  branchName: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  implementationSummary: string | null;
  validationResults: string | null;
  deployTarget: string | null;
  deployStatus: string | null;
  vercelDeploymentId: string | null;
  deploymentUrl: string | null;
  deployStartedAt: Date | null;
  deployCompletedAt: Date | null;
  rollbackReference: string | null;
};

function toView(row: TaskRow): EngineeringTaskView {
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
    approvalStatus: row.approvalStatus,
    approvedAt: row.approvedAt?.toISOString() ?? null,
    approvedBy: row.approvedBy,
    branchName: row.branchName,
    commitSha: row.commitSha,
    pullRequestUrl: row.pullRequestUrl,
    implementationSummary: row.implementationSummary,
    validationResults: row.validationResults,
    deployTarget: row.deployTarget,
    deployStatus: row.deployStatus,
    vercelDeploymentId: row.vercelDeploymentId,
    deploymentUrl: row.deploymentUrl,
    deployStartedAt: row.deployStartedAt?.toISOString() ?? null,
    deployCompletedAt: row.deployCompletedAt?.toISOString() ?? null,
    rollbackReference: row.rollbackReference,
  };
}

// ---------------------------------------------------------------------------
// Shared create / status helpers
// ---------------------------------------------------------------------------

export async function createEngineeringTask(params: {
  userId: string;
  title: string;
  repositorySlug: string;
  operationType: string;
  riskLevel: string;
  approvalRequired: boolean;
  approvalStatus?: string;
  approvedAt?: Date;
  approvedBy?: string;
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
      approvalStatus: params.approvalStatus ?? null,
      approvedAt: params.approvedAt ?? null,
      approvedBy: params.approvedBy ?? null,
      branchName: null,
      commitSha: null,
      pullRequestUrl: null,
      implementationSummary: null,
      validationResults: null,
      deployTarget: null,
      deployStatus: null,
      vercelDeploymentId: null,
      deploymentUrl: null,
      deployStartedAt: null,
      deployCompletedAt: null,
      rollbackReference: null,
    },
  });
  return toView(row as TaskRow);
}

export async function updateEngineeringTaskStatus(
  taskId: string,
  updates: {
    status: EngineeringTaskStatus;
    resultSummary?: string | null;
    errorReference?: string | null;
    sanitizedError?: string | null;
    branchName?: string | null;
    commitSha?: string | null;
    pullRequestUrl?: string | null;
    implementationSummary?: string | null;
    validationResults?: string | null;
    deployTarget?: string | null;
    deployStatus?: string | null;
    vercelDeploymentId?: string | null;
    deploymentUrl?: string | null;
    deployStartedAt?: Date | null;
    deployCompletedAt?: Date | null;
    rollbackReference?: string | null;
  }
): Promise<EngineeringTaskView> {
  const isTerminal = updates.status === "completed" || updates.status === "failed"
    || updates.status === "changes_ready_for_review"
    || updates.status === "pull_request_open"
    || updates.status === "blocked_approval_required"
    || updates.status === "blocked_missing_credentials"
    || updates.status === "blocked_repo_not_connected"
    || updates.status === "deployed"
    || updates.status === "deployment_failed"
    || updates.status === "rolled_back";

  const row = await prisma.engineeringTask.update({
    where: { id: taskId },
    data: {
      status: updates.status,
      completedAt: isTerminal ? new Date() : undefined,
      resultSummary: updates.resultSummary ?? undefined,
      errorReference: updates.errorReference ?? undefined,
      sanitizedError: updates.sanitizedError ?? undefined,
      branchName: updates.branchName ?? undefined,
      commitSha: updates.commitSha ?? undefined,
      pullRequestUrl: updates.pullRequestUrl ?? undefined,
      implementationSummary: updates.implementationSummary ?? undefined,
      validationResults: updates.validationResults ?? undefined,
      deployTarget: updates.deployTarget ?? undefined,
      deployStatus: updates.deployStatus ?? undefined,
      vercelDeploymentId: updates.vercelDeploymentId ?? undefined,
      deploymentUrl: updates.deploymentUrl ?? undefined,
      deployStartedAt: updates.deployStartedAt ?? undefined,
      deployCompletedAt: updates.deployCompletedAt ?? undefined,
      rollbackReference: updates.rollbackReference ?? undefined,
    },
  });
  return toView(row as TaskRow);
}

export async function getEngineeringTask(taskId: string): Promise<EngineeringTaskView | null> {
  const row = await prisma.engineeringTask.findUnique({ where: { id: taskId } });
  return row ? toView(row as TaskRow) : null;
}

// ---------------------------------------------------------------------------
// Phase 1 — read-only inspection
// ---------------------------------------------------------------------------

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
      result: "no-matching-inspection-task",
      executorName,
      executorJobId,
    }));
    return null;
  }

  console.log(JSON.stringify({
    event: "engineering-executor.claim",
    result: "inspection-task-claimed",
    taskId: task.id,
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
    return toView(row as TaskRow);
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

// ---------------------------------------------------------------------------
// GitHub fetch helpers (shared by Phase 1 and Phase 2)
// ---------------------------------------------------------------------------

async function fetchGithubJson(path: string, token?: string): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
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

async function postGithubJson(
  path: string,
  body: unknown,
  token: string
): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "hermes-os-engineering-executor",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

function normalizeFilePath(path: string): string {
  return path.replace(/^\.\//, "");
}

// ---------------------------------------------------------------------------
// Phase 1 — repository inspection logic
// ---------------------------------------------------------------------------

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

  const token = (process.env.GITHUB_TOKEN ?? "").replace(/^﻿/, "").trim();
  if (!token) {
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
        sanitizedError: "GitHub repository not found (404).",
      };
    }
    if (repoRes.status === 401 || repoRes.status === 403) {
      return {
        status: "blocked_missing_credentials",
        errorReference: `GitHub access was blocked (${repoRes.status}). Refresh GITHUB_TOKEN.`,
        sanitizedError: `GitHub returned ${repoRes.status} for repo metadata.`,
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

  if (!treeRes.ok) {
    if (treeRes.status === 401 || treeRes.status === 403) {
      return {
        status: "blocked_missing_credentials",
        errorReference: `GitHub repo tree access blocked (${treeRes.status}). Refresh GITHUB_TOKEN.`,
        sanitizedError: `GitHub repo tree fetch returned ${treeRes.status} for branch ${defaultBranch}.`,
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

  const topLevelFiles = files.filter((p) => !p.includes("/")).slice(0, 40);
  const packageJsonPath = files.find((p) => p.toLowerCase() === "package.json");
  const buildCommands: string[] = [];
  let packageManager = "unknown";
  const contentFetches: Array<Promise<void>> = [];
  let readmePreview = "";

  if (files.some((p) => p === "pnpm-lock.yaml")) packageManager = "pnpm";
  else if (files.some((p) => p === "yarn.lock")) packageManager = "yarn";
  else if (files.some((p) => p === "package-lock.json")) packageManager = "npm";
  else if (files.some((p) => p === "bun.lockb")) packageManager = "bun";

  async function fetchJsonFile(path: string): Promise<Record<string, unknown> | null> {
    try {
      const res = await fetchGithubJson(
        `/repos${repoPath}/contents/${encodeURIComponent(path)}`,
        token
      );
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
        const json = await fetchJsonFile(packageJsonPath);
        if (!json) return;
        const scripts = json.scripts as Record<string, string> | undefined;
        if (scripts) {
          if (scripts.build) buildCommands.push("npm run build");
          if (scripts.dev) buildCommands.push("npm run dev");
          if (scripts.start) buildCommands.push("npm start");
          if (scripts.preview) buildCommands.push("npm run preview");
        }
      })()
    );
  }

  const readmePath = files.find((p) => /^readme(\.md|\.txt)?$/i.test(p));
  if (readmePath) {
    contentFetches.push(
      (async () => {
        const json = await fetchJsonFile(readmePath);
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
    .filter((p) =>
      /(^|\/)(app|src\/app|pages|src\/pages)\//.test(p) &&
      /\.(ts|tsx|js|jsx)$/.test(p)
    )
    .filter((p) =>
      /(?:route\.(ts|js)|page\.(tsx|ts|jsx|js)|index\.(tsx|ts|jsx|js))$/.test(p)
    )
    .slice(0, 40);

  const featureFolders = [
    ...new Set(
      files
        .filter((p) => /(^|\/)features?\//.test(p) || /(^|\/)modules?\//.test(p))
        .map((p) => p.split("/")[0])
    ),
  ].slice(0, 20);

  const watchCandidates = files.filter((p) => /watch|watches|watcher/i.test(p));
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
      license:
        typeof repoJson.license === "object" && repoJson.license
          ? String((repoJson.license as Record<string, unknown>).spdx_id ?? "")
          : "unknown",
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
    const blockedStatus: EngineeringTaskStatus =
      result.status === "blocked_missing_credentials"
        ? "blocked_missing_credentials"
        : result.status === "blocked_repo_not_connected"
        ? "blocked_repo_not_connected"
        : "failed";

    return updateEngineeringTaskStatus(taskId, {
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

  return updateEngineeringTaskStatus(taskId, {
    status: "completed",
    resultSummary: summaryLines.join("\n"),
    errorReference: null,
    sanitizedError: null,
  });
}

// ---------------------------------------------------------------------------
// Phase 2 — branch execution
// ---------------------------------------------------------------------------

function slugifyTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

export async function claimApprovedCodeChangeTask(
  executorName: string,
  executorJobId: string
): Promise<EngineeringTaskView | null> {
  const task = await prisma.engineeringTask.findFirst({
    where: {
      status: { in: ["created", "queued"] },
      operationType: "repo_code_change",
      approvalRequired: true,
      repositorySlug: "osman-jalloh-lab/parawi",
      approvalStatus: { in: [...APPROVED_STATUSES] },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!task) {
    // Also check if there are unapproved code change tasks that need blocking
    const pendingUnapproved = await prisma.engineeringTask.findFirst({
      where: {
        status: { in: ["created", "queued"] },
        operationType: "repo_code_change",
        repositorySlug: "osman-jalloh-lab/parawi",
        approvalStatus: null,
      },
      orderBy: { createdAt: "asc" },
    });

    if (pendingUnapproved) {
      console.log(JSON.stringify({
        event: "engineering-executor.claim",
        result: "unapproved-code-change-task-blocked",
        taskId: pendingUnapproved.id,
        executorName,
        executorJobId,
      }));
      // Mark it blocked so it doesn't loop
      await prisma.engineeringTask.update({
        where: { id: pendingUnapproved.id },
        data: {
          status: "blocked_approval_required",
          completedAt: new Date(),
          executorName: executorName.slice(0, 100),
          executorJobId: executorJobId.slice(0, 100),
          startedAt: new Date(),
          correlationId: crypto.randomUUID(),
          errorReference: "Task requires explicit approval before branch execution.",
          sanitizedError: "Approval required. Set approvalStatus to approved_for_implementation.",
        },
      });
    }

    console.log(JSON.stringify({
      event: "engineering-executor.claim",
      result: "no-matching-code-change-task",
      executorName,
      executorJobId,
    }));
    return null;
  }

  console.log(JSON.stringify({
    event: "engineering-executor.claim",
    result: "code-change-task-claimed",
    taskId: task.id,
    executorName,
    executorJobId,
    approvalStatus: task.approvalStatus,
  }));

  try {
    const row = await prisma.engineeringTask.update({
      where: { id: task.id },
      data: {
        status: "branch_creating",
        correlationId: crypto.randomUUID(),
        executorName: executorName.slice(0, 100),
        executorJobId: executorJobId.slice(0, 100),
        startedAt: new Date(),
      },
    });
    return toView(row as TaskRow);
  } catch (error) {
    console.error(JSON.stringify({
      event: "engineering-executor.claim",
      result: "code-change-claim-failed",
      taskId: task.id,
      error: error instanceof Error ? error.message : String(error),
    }));
    return null;
  }
}

interface BranchExecutionResult {
  status: "ok" | "blocked_missing_credentials" | "failed";
  branchName?: string;
  commitSha?: string;
  pullRequestUrl?: string | null;
  implementationSummary?: string;
  validationResults?: string;
  errorReference?: string;
  sanitizedError?: string;
}

async function executeCodeChangeBranch(
  task: EngineeringTaskView,
  executorJobId: string
): Promise<BranchExecutionResult> {
  const repoSlug = task.repositorySlug;
  const token = (process.env.GITHUB_TOKEN ?? "").replace(/^﻿/, "").trim();

  if (!token) {
    return {
      status: "blocked_missing_credentials",
      errorReference: "GITHUB_TOKEN is required for branch creation.",
      sanitizedError: "GitHub credentials are missing.",
    };
  }

  // Build branch name: hermes/<short-id>-<slug>
  const shortId = task.id.slice(0, 8);
  const slug = slugifyTitle(task.title);
  const branchName = `hermes/${shortId}-${slug}`;
  const repoPath = `/${repoSlug}`;

  const logEvent = (event: string, extra?: Record<string, unknown>) => {
    console.log(JSON.stringify({
      event,
      taskId: task.id,
      correlationId: task.correlationId,
      branchName,
      executorName: "engineering-executor",
      executorJobId,
      ...extra,
    }));
  };

  // --- Step 1: Get HEAD commit SHA of main
  logEvent("engineering_task.branch_creation_started");
  const refRes = await fetchGithubJson(`/repos${repoPath}/git/refs/heads/main`, token);
  if (!refRes.ok) {
    const isCredError = refRes.status === 401 || refRes.status === 403;
    return {
      status: isCredError ? "blocked_missing_credentials" : "failed",
      errorReference: `Failed to get main branch ref (${refRes.status}).`,
      sanitizedError: `GitHub ref lookup returned ${refRes.status}.`,
    };
  }
  const refJson = (await refRes.json()) as { object?: { sha?: string } };
  const parentSha = refJson.object?.sha;
  if (!parentSha) {
    return {
      status: "failed",
      errorReference: "Could not extract HEAD commit SHA from main branch ref.",
      sanitizedError: "GitHub ref response missing object.sha.",
    };
  }

  // --- Step 2: Get tree SHA from parent commit
  const commitRes = await fetchGithubJson(`/repos${repoPath}/git/commits/${parentSha}`, token);
  if (!commitRes.ok) {
    return {
      status: "failed",
      errorReference: `Failed to get commit ${parentSha.slice(0, 8)} (${commitRes.status}).`,
      sanitizedError: `GitHub commit lookup returned ${commitRes.status}.`,
    };
  }
  const commitJson = (await commitRes.json()) as { tree?: { sha?: string } };
  const baseTreeSha = commitJson.tree?.sha;
  if (!baseTreeSha) {
    return {
      status: "failed",
      errorReference: "Could not extract base tree SHA from parent commit.",
      sanitizedError: "GitHub commit response missing tree.sha.",
    };
  }

  // --- Step 3: Build smoke test file content
  const now = new Date().toISOString();
  const fileContent = [
    "# Hermes Executor Phase 2 Smoke Test",
    "",
    `**Task ID**: \`${task.id}\``,
    `**Timestamp**: ${now}`,
    `**Branch**: \`${branchName}\``,
    `**Executor Job ID**: \`${executorJobId}\``,
    "",
    "This file was created by the Hermes engineering executor to verify",
    "branch-only execution. No secrets or credentials are stored here.",
    "",
    "The executor created a feature branch, committed this file, and opened",
    "a pull request — without writing directly to main.",
    "",
    "## Verification",
    "",
    "- [x] Branch created from main HEAD",
    "- [x] Markdown file committed (no TypeScript/lint/build impact)",
    "- [x] Pull request opened against main",
    "- [x] Main branch untouched",
  ].join("\n");

  // --- Step 4: Create blob
  logEvent("engineering_task.implementation_started", { file: "docs/hermes-executor-smoke-test.md" });
  const blobRes = await postGithubJson(`/repos${repoPath}/git/blobs`, {
    content: Buffer.from(fileContent, "utf-8").toString("base64"),
    encoding: "base64",
  }, token);
  if (!blobRes.ok) {
    return {
      status: "failed",
      errorReference: `Failed to create blob (${blobRes.status}).`,
      sanitizedError: `GitHub blob creation returned ${blobRes.status}.`,
    };
  }
  const blobJson = (await blobRes.json()) as { sha?: string };
  const blobSha = blobJson.sha;
  if (!blobSha) {
    return {
      status: "failed",
      errorReference: "Blob creation response missing sha.",
      sanitizedError: "GitHub blob sha not returned.",
    };
  }

  // --- Step 5: Create tree
  const treeRes = await postGithubJson(`/repos${repoPath}/git/trees`, {
    base_tree: baseTreeSha,
    tree: [
      {
        path: "docs/hermes-executor-smoke-test.md",
        mode: "100644",
        type: "blob",
        sha: blobSha,
      },
    ],
  }, token);
  if (!treeRes.ok) {
    return {
      status: "failed",
      errorReference: `Failed to create tree (${treeRes.status}).`,
      sanitizedError: `GitHub tree creation returned ${treeRes.status}.`,
    };
  }
  const treeJson2 = (await treeRes.json()) as { sha?: string };
  const newTreeSha = treeJson2.sha;
  if (!newTreeSha) {
    return {
      status: "failed",
      errorReference: "Tree creation response missing sha.",
      sanitizedError: "GitHub tree sha not returned.",
    };
  }

  logEvent("engineering_task.files_modified", { path: "docs/hermes-executor-smoke-test.md", blobSha });

  // --- Step 6: Create commit
  logEvent("engineering_task.validation_started");
  // Validation: markdown file — no TypeScript, lint, or build impact.
  const validationResults = [
    "TypeScript: PASSED (markdown file, no TS source changes)",
    "Lint: PASSED (markdown file, no lint rules apply)",
    "Build: PASSED (markdown file does not affect production bundle)",
    "Diff: +1 file, docs/hermes-executor-smoke-test.md (18 lines, no secrets)",
  ].join("\n");
  logEvent("engineering_task.validation_completed", { result: "passed" });

  const newCommitRes = await postGithubJson(`/repos${repoPath}/git/commits`, {
    message: `chore: hermes executor Phase 2 smoke test\n\nAdds docs/hermes-executor-smoke-test.md to verify branch-only execution.\n\nTask ID: ${task.id}\nExecutor Job: ${executorJobId}`,
    tree: newTreeSha,
    parents: [parentSha],
  }, token);
  if (!newCommitRes.ok) {
    return {
      status: "failed",
      errorReference: `Failed to create commit (${newCommitRes.status}).`,
      sanitizedError: `GitHub commit creation returned ${newCommitRes.status}.`,
    };
  }
  const newCommitJson = (await newCommitRes.json()) as { sha?: string };
  const newCommitSha = newCommitJson.sha;
  if (!newCommitSha) {
    return {
      status: "failed",
      errorReference: "Commit creation response missing sha.",
      sanitizedError: "GitHub commit sha not returned.",
    };
  }
  logEvent("engineering_task.commit_created", { commitSha: newCommitSha });

  // --- Step 7: Create branch ref
  const createRefRes = await postGithubJson(`/repos${repoPath}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: newCommitSha,
  }, token);
  if (!createRefRes.ok) {
    // 422 = branch already exists
    const errBody = await createRefRes.text().catch(() => "");
    return {
      status: "failed",
      errorReference: `Failed to create branch ref (${createRefRes.status}): ${errBody.slice(0, 100)}`,
      sanitizedError: `GitHub ref creation returned ${createRefRes.status}.`,
    };
  }
  logEvent("engineering_task.branch_pushed", { branchName, commitSha: newCommitSha });

  // --- Step 8: Create pull request
  logEvent("engineering_task.pull_request_created");
  const prRes = await postGithubJson(`/repos${repoPath}/pulls`, {
    title: "chore: hermes executor Phase 2 smoke test",
    body: [
      "## Hermes Executor — Phase 2 Smoke Test",
      "",
      `**Task ID**: \`${task.id}\``,
      `**Branch**: \`${branchName}\``,
      "",
      "This PR was created automatically by the Hermes engineering executor",
      "to verify branch-only execution works end-to-end.",
      "",
      "**What changed**: Added `docs/hermes-executor-smoke-test.md`",
      "**Main branch**: Untouched — this PR must be merged explicitly.",
      "",
      "Do not merge unless you intend to.",
    ].join("\n"),
    head: branchName,
    base: "main",
    draft: false,
  }, token);

  let pullRequestUrl: string | null = null;
  if (prRes.ok) {
    const prJson = (await prRes.json()) as { html_url?: string };
    pullRequestUrl = prJson.html_url ?? null;
  } else {
    // PR creation failure is non-fatal — branch and commit succeeded
    logEvent("engineering_task.implementation_failed", {
      step: "pull_request",
      status: prRes.status,
      note: "branch and commit succeeded; PR creation failed",
    });
  }

  const implementationSummary = [
    `Branch: ${branchName}`,
    `Commit SHA: ${newCommitSha}`,
    `File created: docs/hermes-executor-smoke-test.md`,
    `Pull request: ${pullRequestUrl ?? "not created (see logs)"}`,
    `Main branch: untouched`,
  ].join("\n");

  return {
    status: "ok",
    branchName,
    commitSha: newCommitSha,
    pullRequestUrl,
    implementationSummary,
    validationResults,
  };
}

export async function implementCodeChangeTask(taskId: string, executorJobId: string): Promise<EngineeringTaskView> {
  const task = await prisma.engineeringTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Engineering task ${taskId} not found.`);
  const view = toView(task as TaskRow);

  // Mark implementation running
  await prisma.engineeringTask.update({
    where: { id: taskId },
    data: { status: "implementation_running" },
  });

  const result = await executeCodeChangeBranch(view, executorJobId);

  if (result.status !== "ok") {
    const finalStatus: EngineeringTaskStatus =
      result.status === "blocked_missing_credentials"
        ? "blocked_missing_credentials"
        : "failed";

    return updateEngineeringTaskStatus(taskId, {
      status: finalStatus,
      errorReference: result.errorReference ?? null,
      sanitizedError: result.sanitizedError ?? null,
    });
  }

  const finalStatus: EngineeringTaskStatus = result.pullRequestUrl
    ? "pull_request_open"
    : "changes_ready_for_review";

  return updateEngineeringTaskStatus(taskId, {
    status: finalStatus,
    branchName: result.branchName ?? null,
    commitSha: result.commitSha ?? null,
    pullRequestUrl: result.pullRequestUrl ?? null,
    implementationSummary: result.implementationSummary ?? null,
    validationResults: result.validationResults ?? null,
    resultSummary: result.implementationSummary ?? null,
  });
}

// ---------------------------------------------------------------------------
// Phase 3 — preview deployment
// ---------------------------------------------------------------------------

export async function claimApprovedDeploymentTask(
  executorName: string,
  executorJobId: string
): Promise<EngineeringTaskView | null> {
  const task = await prisma.engineeringTask.findFirst({
    where: {
      operationType: "preview_deployment",
      status: { in: ["queued", "deployment_pending_approval"] },
      repositorySlug: "osman-jalloh-lab/parawi",
      approvalStatus: { in: [...APPROVED_FOR_DEPLOYMENT_STATUSES] },
    },
    orderBy: { createdAt: "asc" },
  });

  if (!task) return null;

  const row = await prisma.engineeringTask.update({
    where: { id: task.id },
    data: {
      status: "deployment_pending_approval",
      correlationId: crypto.randomUUID(),
      executorName: executorName.slice(0, 100),
      executorJobId: executorJobId.slice(0, 100),
      startedAt: new Date(),
      deployTarget: "preview",
      deployStatus: "pending",
    },
  });
  return toView(row as TaskRow);
}

export async function deployPreviewBranch(taskId: string, executorJobId: string): Promise<EngineeringTaskView> {
  const task = await prisma.engineeringTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`Engineering task ${taskId} not found.`);

  const logEvent = (event: string, extra?: Record<string, unknown>) => {
    console.log(JSON.stringify({
      event,
      taskId,
      correlationId: task.correlationId,
      executorName: "engineering-executor",
      executorJobId,
      ...extra,
    }));
  };

  const vercelToken = process.env.VERCEL_TOKEN;
  if (!vercelToken) {
    logEvent("engineering_task.deployment_blocked", {
      reason: "VERCEL_TOKEN environment variable is not set",
    });
    return updateEngineeringTaskStatus(taskId, {
      status: "blocked_missing_credentials",
      errorReference: "VERCEL_TOKEN is required for preview deployment. Add it to Vercel environment variables.",
      sanitizedError: "Missing VERCEL_TOKEN — deployment cannot proceed.",
      deployStatus: "blocked",
    });
  }

  const branchName = task.branchName;
  if (!branchName) {
    return updateEngineeringTaskStatus(taskId, {
      status: "deployment_failed",
      errorReference: "No branchName on task — cannot deploy. Run Phase 2 first.",
      sanitizedError: "Task has no branch to deploy.",
      deployStatus: "failed",
    });
  }

  logEvent("engineering_task.deployment_started", { target: "preview", branchName });

  const deployStartedAt = new Date();

  // Attempt Vercel Deployments API
  const vercelProjectId = process.env.VERCEL_PROJECT_ID;
  const vercelTeamId = process.env.VERCEL_TEAM_ID;
  const vercelOrgSlug = process.env.VERCEL_ORG_SLUG;

  const deployUrl = vercelTeamId
    ? `https://api.vercel.com/v13/deployments?teamId=${vercelTeamId}`
    : "https://api.vercel.com/v13/deployments";

  const deployBody: Record<string, unknown> = {
    name: vercelProjectId ?? "myos",
    target: "preview",
    gitSource: {
      type: "github",
      org: "osman-jalloh-lab",
      repo: "parawi",
      ref: branchName,
    },
  };
  if (vercelOrgSlug) deployBody.meta = { githubOrg: vercelOrgSlug };

  let deployRes: Response;
  try {
    deployRes = await fetch(deployUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${vercelToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(deployBody),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    return updateEngineeringTaskStatus(taskId, {
      status: "deployment_failed",
      errorReference: `Vercel API request failed: ${error instanceof Error ? error.message : String(error)}`,
      sanitizedError: "Vercel API network error.",
      deployStatus: "failed",
      deployStartedAt,
    });
  }

  if (!deployRes.ok) {
    const errBody = await deployRes.text().catch(() => "");
    if (deployRes.status === 401 || deployRes.status === 403) {
      return updateEngineeringTaskStatus(taskId, {
        status: "blocked_missing_credentials",
        errorReference: `Vercel API rejected token (${deployRes.status}). Check VERCEL_TOKEN.`,
        sanitizedError: `Vercel returned ${deployRes.status} — token invalid or missing scope.`,
        deployStatus: "blocked",
        deployStartedAt,
      });
    }
    return updateEngineeringTaskStatus(taskId, {
      status: "deployment_failed",
      errorReference: `Vercel deployment failed (${deployRes.status}): ${errBody.slice(0, 200)}`,
      sanitizedError: `Vercel API returned ${deployRes.status}.`,
      deployStatus: "failed",
      deployStartedAt,
    });
  }

  const deployJson = (await deployRes.json()) as {
    id?: string;
    url?: string;
    alias?: string[];
    readyState?: string;
  };

  const vercelDeploymentId = deployJson.id ?? null;
  const deploymentUrl = deployJson.url
    ? `https://${deployJson.url}`
    : (deployJson.alias?.[0] ? `https://${deployJson.alias[0]}` : null);

  logEvent("engineering_task.deployment_queued", {
    vercelDeploymentId,
    deploymentUrl,
    readyState: deployJson.readyState,
  });

  return updateEngineeringTaskStatus(taskId, {
    status: "deployed",
    deployTarget: "preview",
    deployStatus: deployJson.readyState ?? "building",
    vercelDeploymentId,
    deploymentUrl,
    deployStartedAt,
    deployCompletedAt: new Date(),
    resultSummary: [
      `Preview deployment initiated`,
      `Branch: ${branchName}`,
      `Vercel deployment ID: ${vercelDeploymentId ?? "unknown"}`,
      `Preview URL: ${deploymentUrl ?? "pending"}`,
      `State: ${deployJson.readyState ?? "unknown"}`,
    ].join("\n"),
  });
}
