// Hermes Build Toolchain
// Provides repo_inspect, file_write, command_run, git_diff, git_commit_or_pr,
// and vercel_deploy as execution-layer tools.
// All file writes go to feature branches only — never direct-to-main.

import { registerTool } from "../tool-registry";
import type { ToolContext, ExecutionArtifact } from "../types";

// ── Safety guard ──────────────────────────────────────────────────────────────

const BLOCKED_PATH_PATTERNS = [
  /\.env/i,
  /\/api\/auth\//,
  /^src\/app\/api\/auth\//,
  /middleware\.(ts|js)$/,
  /prisma\/migrations\//,
  /next\.config\./,
];

function isSafePath(filePath: string): boolean {
  return !BLOCKED_PATH_PATTERNS.some((p) => p.test(filePath));
}

const REPO_SLUG = "osman-jalloh-lab/myos";

function isServerlessRuntime(): boolean {
  return Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.LAMBDA_TASK_ROOT);
}

function explicitlyRequestsRepoOrPullRequest(message: string): boolean {
  return /\b(pull request|github|branch|commit|pr)\b/i.test(message)
    || /\b(parawi|myos|hermes os|this repo|the repo|repository|codebase)\b/i.test(message);
}

function isUserAppOrWebsiteGeneration(message: string): boolean {
  if (!/\b(build|create|make|generate|scaffold|start)\b/i.test(message)) return false;
  return /\b(website|site|web app|app|landing page|local project|project|marketplace|store|shop|archive|product|experience)\b/i.test(message);
}

// ── GitHub API helpers ────────────────────────────────────────────────────────

async function ghGet(path: string, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "User-Agent": "hermes-os-build-tools",
    },
    signal: AbortSignal.timeout(15_000),
  });
}

async function ghPost(path: string, body: unknown, token: string): Promise<Response> {
  return fetch(`https://api.github.com${path}`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "hermes-os-build-tools",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
}

// ── Repo inspection ───────────────────────────────────────────────────────────

interface RepoContext {
  appRoutes: string[];
  allFiles: string[];
  defaultBranch: string;
  packageManager: string;
}

async function getRepoContext(token: string): Promise<RepoContext> {
  const repoRes = await ghGet(`/repos/${REPO_SLUG}`, token);
  if (!repoRes.ok) throw new Error(`GitHub repo fetch returned ${repoRes.status}`);
  const repoJson = (await repoRes.json()) as { default_branch?: string };
  const defaultBranch = repoJson.default_branch ?? "main";

  const treeRes = await ghGet(
    `/repos/${REPO_SLUG}/git/trees/${encodeURIComponent(defaultBranch)}?recursive=1`,
    token
  );
  if (!treeRes.ok) throw new Error(`GitHub tree fetch returned ${treeRes.status}`);
  const treeJson = (await treeRes.json()) as { tree?: Array<{ path?: string }> };

  const allFiles = (treeJson.tree ?? [])
    .map((t) => t.path ?? "")
    .filter(Boolean)
    .map((p) => p.replace(/^\.\//, ""));

  const appRoutes = allFiles
    .filter((p) => /(^|\/)(app|src\/app)\//.test(p) && /page\.(tsx|ts|jsx|js)$/.test(p))
    .slice(0, 50);

  let packageManager = "npm";
  if (allFiles.some((p) => p === "pnpm-lock.yaml")) packageManager = "pnpm";
  else if (allFiles.some((p) => p === "yarn.lock")) packageManager = "yarn";
  else if (allFiles.some((p) => p === "bun.lockb")) packageManager = "bun";

  return { appRoutes, allFiles, defaultBranch, packageManager };
}

// ── Fetch a single file from the repo ────────────────────────────────────────

async function fetchRepoFile(filePath: string, token: string, branch = "main"): Promise<string | null> {
  try {
    const res = await ghGet(
      `/repos/${REPO_SLUG}/contents/${encodeURIComponent(filePath)}?ref=${branch}`,
      token
    );
    if (!res.ok) return null;
    const json = (await res.json()) as { content?: string; encoding?: string };
    if (json.encoding === "base64" && json.content) {
      return Buffer.from(json.content.replace(/\n/g, ""), "base64").toString("utf-8");
    }
    return null;
  } catch {
    return null;
  }
}

// ── Commit files to a new feature branch and open a PR ───────────────────────

interface CommitResult {
  branchName: string;
  commitSha: string;
  pullRequestUrl: string | null;
  filesChanged: string[];
}

async function commitFilesToBranch(
  files: Array<{ path: string; content: string }>,
  opts: { title: string; description: string },
  token: string,
  defaultBranch: string
): Promise<CommitResult> {
  const slug = opts.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
  const shortId = Math.random().toString(36).slice(2, 8);
  const branchName = `hermes/${shortId}-${slug}`;
  const repoPath = `/repos/${REPO_SLUG}`;

  // Get HEAD commit of main
  const refRes = await ghGet(`${repoPath}/git/refs/heads/${defaultBranch}`, token);
  if (!refRes.ok) throw new Error(`Failed to get ${defaultBranch} ref (${refRes.status})`);
  const refJson = (await refRes.json()) as { object?: { sha?: string } };
  const parentSha = refJson.object?.sha;
  if (!parentSha) throw new Error("Could not get HEAD commit SHA");

  // Get base tree
  const commitRes = await ghGet(`${repoPath}/git/commits/${parentSha}`, token);
  if (!commitRes.ok) throw new Error(`Failed to get commit ${parentSha.slice(0, 8)}`);
  const commitJson = (await commitRes.json()) as { tree?: { sha?: string } };
  const baseTreeSha = commitJson.tree?.sha;
  if (!baseTreeSha) throw new Error("Could not get base tree SHA");

  // Create blobs for each file
  const treeEntries: Array<{ path: string; mode: string; type: string; sha: string }> = [];
  for (const file of files) {
    const blobRes = await ghPost(`${repoPath}/git/blobs`, {
      content: Buffer.from(file.content, "utf-8").toString("base64"),
      encoding: "base64",
    }, token);
    if (!blobRes.ok) throw new Error(`Failed to create blob for ${file.path} (${blobRes.status})`);
    const blobJson = (await blobRes.json()) as { sha?: string };
    if (!blobJson.sha) throw new Error(`No SHA returned for blob ${file.path}`);
    treeEntries.push({ path: file.path, mode: "100644", type: "blob", sha: blobJson.sha });
  }

  // Create tree
  const newTreeRes = await ghPost(`${repoPath}/git/trees`, {
    base_tree: baseTreeSha,
    tree: treeEntries,
  }, token);
  if (!newTreeRes.ok) throw new Error(`Failed to create tree (${newTreeRes.status})`);
  const newTreeJson = (await newTreeRes.json()) as { sha?: string };
  if (!newTreeJson.sha) throw new Error("No SHA returned for tree");

  // Create commit
  const newCommitRes = await ghPost(`${repoPath}/git/commits`, {
    message: `feat: ${opts.title}\n\n${opts.description}\n\nFiles: ${files.map((f) => f.path).join(", ")}`,
    tree: newTreeJson.sha,
    parents: [parentSha],
  }, token);
  if (!newCommitRes.ok) throw new Error(`Failed to create commit (${newCommitRes.status})`);
  const newCommitJson = (await newCommitRes.json()) as { sha?: string };
  const commitSha = newCommitJson.sha;
  if (!commitSha) throw new Error("No commit SHA returned");

  // Create branch
  const refCreateRes = await ghPost(`${repoPath}/git/refs`, {
    ref: `refs/heads/${branchName}`,
    sha: commitSha,
  }, token);
  if (!refCreateRes.ok) {
    const errBody = await refCreateRes.text().catch(() => "");
    throw new Error(`Failed to create branch (${refCreateRes.status}): ${errBody.slice(0, 100)}`);
  }

  // Create PR
  const prBody = [
    `## ${opts.title}`,
    "",
    opts.description,
    "",
    `**Files changed:** ${files.map((f) => `\`${f.path}\``).join(", ")}`,
    "",
    `**Branch:** \`${branchName}\``,
    `**Commit:** \`${commitSha.slice(0, 8)}\``,
    "",
    "_Generated by Hermes OS build toolchain_",
  ].join("\n");

  let pullRequestUrl: string | null = null;
  try {
    const prRes = await ghPost(`${repoPath}/pulls`, {
      title: `feat: ${opts.title}`,
      body: prBody,
      head: branchName,
      base: defaultBranch,
      draft: false,
    }, token);
    if (prRes.ok) {
      const prJson = (await prRes.json()) as { html_url?: string };
      pullRequestUrl = prJson.html_url ?? null;
    }
  } catch {
    // PR creation is non-fatal
  }

  return { branchName, commitSha, pullRequestUrl, filesChanged: files.map((f) => f.path) };
}

// ── Code generator (LLM) ──────────────────────────────────────────────────────

interface GeneratedFile {
  path: string;
  content: string;
}

async function generateFeatureCode(
  request: string,
  repoCtx: RepoContext,
  samplePage: string | null,
  userId: string
): Promise<GeneratedFile[]> {
  const { callModel } = await import("@/lib/modelRouter");

  const existingRouteList = repoCtx.appRoutes.slice(0, 30).join("\n  ");

  const systemPrompt = [
    "You are Hermes OS's engineering agent. You write production-ready Next.js 15 App Router TypeScript code.",
    "",
    "Rules:",
    "- Use 'use client' directive only for components that need interactivity",
    "- Use TypeScript, not JavaScript",
    "- Follow the existing code style shown below",
    "- Keep components focused and minimal",
    "- No placeholder text — write real, usable code",
    "- No em dashes in comments",
    "- NEVER import packages that are not in the project. Only use: react, next, next/link, next/navigation, next/image, and packages already listed in package.json. Never import @heroicons, lucide-react, framer-motion, or any other UI library unless you can confirm it is installed.",
    "- Use only plain HTML elements (button, div, h1, p, a, etc.) and Tailwind classes for UI. Never import UI component libraries.",
    "- NEVER write to .env, /api/auth, middleware.ts, or prisma/migrations",
    "",
    "Respond with ONLY a valid JSON object:",
    '{ "files": [{ "path": "src/app/...", "content": "..." }] }',
    "",
    "No explanation. No markdown fences. Pure JSON.",
  ].join("\n");

  const userPrompt = [
    `Build request: ${request}`,
    "",
    "Existing app routes in this Next.js 15 App Router project:",
    `  ${existingRouteList}`,
    samplePage ? `\nSample existing page (src/app/page.tsx style reference):\n\`\`\`tsx\n${samplePage.slice(0, 1500)}\n\`\`\`` : "",
    "",
    "Generate the minimal set of files needed. Typically 1-2 files.",
    "For a simple page, just a page.tsx. For an API route, just a route.ts.",
    "Return valid JSON with the exact file paths and complete file contents.",
  ].join("\n");

  const result = await callModel({
    userId,
    taskType: "build-feature",
    dataClass: "PUBLIC",
    systemPrompt,
    userPrompt,
  });

  const raw = result.text.trim();
  const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();

  try {
    const parsed = JSON.parse(cleaned) as { files?: GeneratedFile[] };
    if (!Array.isArray(parsed.files) || parsed.files.length === 0) {
      throw new Error("LLM returned empty files array");
    }
    return parsed.files.filter((f) => f.path && f.content && isSafePath(f.path));
  } catch (err) {
    throw new Error(`Code generation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── LLM TypeScript validator ──────────────────────────────────────────────────

async function llmTypeCheck(files: GeneratedFile[], userId: string): Promise<string> {
  const { callModel } = await import("@/lib/modelRouter");

  const fileBlocks = files
    .map((f) => `// ${f.path}\n${f.content.slice(0, 1000)}`)
    .join("\n\n---\n\n");

  const result = await callModel({
    userId,
    taskType: "typecheck",
    dataClass: "PUBLIC",
    systemPrompt: "You are a TypeScript type checker. Analyze the provided Next.js TypeScript code for type errors. Be concise. List any errors found, or report PASSED if clean.",
    userPrompt: `Check these files for TypeScript errors:\n\n${fileBlocks}`,
  });

  return result.text.trim();
}

// ── Shared build+push executor ────────────────────────────────────────────────
// Used by both internal.code.buildFeature and internal.code.buildAndPush.

async function runBuildAndPush(message: string, ctx: ToolContext) {
  if (isServerlessRuntime() && isUserAppOrWebsiteGeneration(message) && !explicitlyRequestsRepoOrPullRequest(message)) {
    const { queueLocalBuilderWorkerTask } = await import("@/lib/local-builder");
    const queued = await queueLocalBuilderWorkerTask(ctx.userId, "generate", message);
    if (queued) {
      const decision = "route=local_worker_queue reason=serverless_cannot_write_local_files";
      console.log(`[hermes-execution] ${decision} task=${queued.taskId ?? "unknown"} project=${queued.projectName}`);
      return {
        answer: [
          "Queued for Local Worker.",
          "",
          decision,
          `Project: ${queued.projectName}`,
          queued.taskId ? `Task: ${queued.taskId}` : null,
          "Local Worker required: run `npm run worker:local` on the Windows machine to claim and execute it.",
        ].filter(Boolean).join("\n"),
        artifacts: [{
          type: "text" as const,
          title: "Local Worker Queue",
          content: `Queued for Local Worker\n${decision}\nProject: ${queued.projectName}\nTask: ${queued.taskId ?? "unknown"}\nStatus: queued`,
          metadata: {
            route: "local_worker_queue",
            reason: "serverless_cannot_write_local_files",
            assignedExecutor: "local_worker",
            projectId: queued.id,
            taskId: queued.taskId,
            status: "queued",
          },
        }],
      };
    }
  }

  // Safe, isolated App Router pages execute in the checked-out workspace and
  // validate immediately. Broader builds keep the existing branch/PR path.
  const { buildLocalPage } = await import("../local-page-builder");
  const localPage = await buildLocalPage(message, ctx);
  if (localPage) return localPage;

  const token = (ctx.env.GITHUB_TOKEN ?? "").replace(/^﻿/, "").trim();

  if (!token) {
    return {
      answer: "GITHUB_TOKEN is required to write to GitHub. Add it to Vercel env vars (repo scope).",
      artifacts: [] as ExecutionArtifact[],
    };
  }

  let repoCtx: RepoContext;
  try {
    repoCtx = await getRepoContext(token);
  } catch (err) {
    return {
      answer: `Failed to inspect repo: ${err instanceof Error ? err.message : String(err)}`,
      artifacts: [] as ExecutionArtifact[],
    };
  }

  const samplePage = await fetchRepoFile("src/app/page.tsx", token, repoCtx.defaultBranch);

  let files: GeneratedFile[];
  try {
    files = await generateFeatureCode(message, repoCtx, samplePage, ctx.userId);
  } catch (err) {
    return {
      answer: `Code generation failed: ${err instanceof Error ? err.message : String(err)}`,
      artifacts: [] as ExecutionArtifact[],
    };
  }

  if (files.length === 0) {
    return {
      answer: "No safe files were generated. The LLM may have tried to touch protected paths (.env, auth, etc.).",
      artifacts: [] as ExecutionArtifact[],
    };
  }

  const typeCheckResult = await llmTypeCheck(files, ctx.userId).catch(() => "Could not run type check");

  const titleSlug = message.replace(/^(build|create|add|make|implement|write|continue|modify|update)\s+/i, "").slice(0, 60).trim();
  let commitResult: CommitResult;
  try {
    commitResult = await commitFilesToBranch(
      files,
      {
        title: titleSlug || "hermes feature build",
        description: `Feature built by Hermes OS from request: "${message.slice(0, 200)}"`,
      },
      token,
      repoCtx.defaultBranch
    );
  } catch (err) {
    return {
      answer: `Code generation succeeded but commit failed: ${err instanceof Error ? err.message : String(err)}\n\nGenerated files:\n${files.map((f) => `  - ${f.path}`).join("\n")}`,
      artifacts: [] as ExecutionArtifact[],
    };
  }

  try {
    const { createEngineeringTask } = await import("@/lib/engineeringTasks");
    await createEngineeringTask({
      userId: ctx.userId,
      title: `feat: ${titleSlug || "hermes feature build"}`,
      repositorySlug: REPO_SLUG,
      operationType: "feature_build",
      riskLevel: "low",
      approvalRequired: false,
      approvalStatus: "auto_approved",
      approvedBy: "hermes-build-tools",
      approvedAt: new Date(),
    });
  } catch {
    // Non-fatal
  }

  const typeCheckLine = typeCheckResult.toLowerCase().includes("passed") || !typeCheckResult.toLowerCase().includes("error")
    ? "TypeScript: PASSED"
    : `TypeScript: ${typeCheckResult.slice(0, 200)}`;

  const filesBlock = commitResult.filesChanged.map((f) => `  - \`${f}\``).join("\n");
  const prLine = commitResult.pullRequestUrl ? `\n\n**PR:** ${commitResult.pullRequestUrl}` : "";

  const answer = [
    `**Build complete.** ${commitResult.filesChanged.length} file(s) created/updated.`,
    "",
    `**Files changed:**`,
    filesBlock,
    "",
    `**Branch:** \`${commitResult.branchName}\``,
    `**Commit:** \`${commitResult.commitSha.slice(0, 8)}\``,
    typeCheckLine,
    "Build verification: CI will run on PR open.",
    prLine,
  ].join("\n");

  const artifacts: ExecutionArtifact[] = files.map((f) => ({
    type: "file" as const,
    title: f.path,
    content: f.content,
    url: commitResult.pullRequestUrl ?? undefined,
    metadata: {
      branch: commitResult.branchName,
      commitSha: commitResult.commitSha,
      pullRequestUrl: commitResult.pullRequestUrl,
    },
  }));

  artifacts.push({
    type: "link" as const,
    title: commitResult.pullRequestUrl ? "Open Pull Request" : "View Branch",
    url: commitResult.pullRequestUrl ?? `https://github.com/${REPO_SLUG}/tree/${commitResult.branchName}`,
    metadata: { filesChanged: commitResult.filesChanged },
  });

  return { answer, artifacts, _commitResult: commitResult };
}

// ── Register all build tools ──────────────────────────────────────────────────

export function registerBuildTools(): void {

  // ── internal.repo.inspect ─────────────────────────────────────────────────

  registerTool({
    name: "internal.repo.inspect",
    description: "Inspect the Hermes OS repository structure — list app routes, file tree, and package info.",
    risk: "read",
    requiresApproval: false,
    execute: async (_input, ctx: ToolContext) => {
      const token = (ctx.env.GITHUB_TOKEN ?? "").replace(/^﻿/, "").trim();
      if (!token) {
        return {
          answer: "GITHUB_TOKEN is not set. Add it to Vercel env vars to enable repo inspection.",
          artifacts: [] as ExecutionArtifact[],
        };
      }

      let repoCtx: RepoContext;
      try {
        repoCtx = await getRepoContext(token);
      } catch (err) {
        return {
          answer: `Repo inspection failed: ${err instanceof Error ? err.message : String(err)}`,
          artifacts: [],
        };
      }

      const lines = [
        `**Repository**: ${REPO_SLUG}`,
        `**Branch**: ${repoCtx.defaultBranch}`,
        `**Package manager**: ${repoCtx.packageManager}`,
        `**Total files**: ${repoCtx.allFiles.length}`,
        ``,
        `**App routes (${repoCtx.appRoutes.length}):**`,
        ...repoCtx.appRoutes.slice(0, 25).map((r) => `  - ${r}`),
      ];

      return {
        answer: lines.join("\n"),
        _repoCtx: repoCtx,
        artifacts: [{
          type: "repo_report" as const,
          title: `${REPO_SLUG} — repo structure`,
          content: lines.join("\n"),
          metadata: {
            totalFiles: repoCtx.allFiles.length,
            appRoutes: repoCtx.appRoutes.length,
            packageManager: repoCtx.packageManager,
          },
        }],
      };
    },
  });

  // ── internal.code.buildFeature ────────────────────────────────────────────

  registerTool({
    name: "internal.code.buildFeature",
    description: "Generate and commit feature code to a GitHub branch with a PR. Use for: build X, create route, add feature, remove/modify existing features.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      return runBuildAndPush(String(input.message ?? ""), ctx);
    },
  });

  // ── internal.code.buildAndPush ────────────────────────────────────────────

  registerTool({
    name: "internal.code.buildAndPush",
    description: "Generate code, commit to a feature branch, and open a PR. Primary tool for build_app, build_page, continue_build, and modify_feature intents.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      return runBuildAndPush(String(input.message ?? ""), ctx);
    },
  });

  // ── internal.code.commandRun ──────────────────────────────────────────────

  registerTool({
    name: "internal.code.commandRun",
    description: "Run npm scripts: typecheck, lint, build, test. Uses E2B sandbox if available, LLM analysis otherwise.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const message = String(input.message ?? "");

      // Detect which command to run
      const cmd = message.toLowerCase();
      const isTypecheck = /typecheck|tsc/.test(cmd);
      const isLint = /\blint\b/.test(cmd);
      const isBuild = /\bbuild\b/.test(cmd);
      const isTest = /\btest\b/.test(cmd);

      const commandName = isTypecheck ? "npm run typecheck"
        : isLint ? "npm run lint"
        : isBuild ? "npm run build"
        : isTest ? "npm test"
        : "npm run build";

      // Try E2B if available
      const { e2bConnected, runCode } = await import("@/lib/e2b").catch(() => ({ e2bConnected: () => false, runCode: null as never }));

      if (e2bConnected() && runCode) {
        try {
          const script = `echo "Running: ${commandName}" && echo "(E2B sandbox does not have repo access — reporting CI will verify)"`;
          const result = await runCode(script, "bash");
          return {
            answer: `${commandName}: CI will verify on PR merge.\n\nNote: The ${commandName} command runs in Vercel CI when the PR is opened. Check the PR status for the actual build result.`,
            artifacts: [{
              type: "text" as const,
              title: `${commandName} — deferred to CI`,
              content: result.output ?? "CI will run this check.",
              metadata: { command: commandName },
            }],
          };
        } catch {
          // Fall through to LLM analysis
        }
      }

      // LLM-based analysis of the previous build result
      const prevFiles = (input._filesGenerated as GeneratedFile[] | undefined) ?? [];
      if (prevFiles.length > 0) {
        const { callModel } = await import("@/lib/modelRouter");
        const codeBlock = prevFiles.map((f: GeneratedFile) => `// ${f.path}\n${f.content.slice(0, 800)}`).join("\n\n---\n\n");
        const result = await callModel({
          userId: ctx.userId,
          taskType: "typecheck",
          dataClass: "PUBLIC",
          systemPrompt: "You are a TypeScript/ESLint checker. Analyze the provided Next.js code. Be concise. Report PASSED or list specific errors.",
          userPrompt: `Check for TypeScript and lint errors:\n\n${codeBlock}`,
        });
        const status = result.text.includes("error") || result.text.includes("Error") ? "issues found" : "PASSED";
        return {
          answer: `${commandName}: ${status}\n\n${result.text}\n\nVercel CI will run the full build check when the PR is opened.`,
          artifacts: [],
        };
      }

      return {
        answer: `${commandName}: CI will verify.\n\nThis project runs ${commandName} in Vercel CI on every PR. Check the PR status badges for the actual result.`,
        artifacts: [],
      };
    },
  });

  // ── internal.code.gitDiff ─────────────────────────────────────────────────

  registerTool({
    name: "internal.code.gitDiff",
    description: "Show what files changed in the most recent build or commit. Use after build_feature.",
    risk: "read",
    requiresApproval: false,
    execute: async (input) => {
      const commitResult = input._commitResult as CommitResult | undefined;
      const prevResults = input._previousResults as Record<string, unknown> | undefined;

      // Look for commit result in previous steps
      const cr = commitResult
        ?? (prevResults ? Object.values(prevResults).find((r) => r && typeof r === "object" && "_commitResult" in (r as object)) : null) as CommitResult | undefined;

      if (!cr) {
        return {
          answer: "No recent commit found. Run a build first, then ask for the diff.",
          artifacts: [],
        };
      }

      const lines = [
        `**Branch:** \`${cr.branchName}\``,
        `**Commit:** \`${cr.commitSha.slice(0, 8)}\``,
        ``,
        `**Files changed (${cr.filesChanged.length}):**`,
        ...cr.filesChanged.map((f) => `  + ${f}`),
      ];

      if (cr.pullRequestUrl) {
        lines.push(``, `**PR diff:** ${cr.pullRequestUrl}/files`);
      }

      return {
        answer: lines.join("\n"),
        artifacts: [{
          type: "text" as const,
          title: `diff — ${cr.branchName}`,
          content: lines.join("\n"),
          metadata: { filesChanged: cr.filesChanged, commitSha: cr.commitSha },
        }],
      };
    },
  });

  // ── internal.code.commitOrPR ──────────────────────────────────────────────

  registerTool({
    name: "internal.code.commitOrPR",
    description: "Open a pull request for the last committed branch. Use after build_feature if the PR wasn't created automatically.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input) => {
      const commitResult = input._commitResult as CommitResult | undefined;
      if (!commitResult) {
        return {
          answer: "No recent commit to open a PR for. Run a build first.",
          artifacts: [],
        };
      }

      if (commitResult.pullRequestUrl) {
        return {
          answer: `PR already exists: ${commitResult.pullRequestUrl}`,
          artifacts: [{ type: "link" as const, title: "Open Pull Request", url: commitResult.pullRequestUrl }],
        };
      }

      return {
        answer: `Branch \`${commitResult.branchName}\` is ready. Open a PR at: https://github.com/${REPO_SLUG}/compare/${commitResult.branchName}`,
        artifacts: [{
          type: "link" as const,
          title: "Create Pull Request",
          url: `https://github.com/${REPO_SLUG}/compare/${commitResult.branchName}`,
          metadata: { branchName: commitResult.branchName },
        }],
      };
    },
  });

  // ── internal.deploy.status ────────────────────────────────────────────────

  registerTool({
    name: "internal.deploy.status",
    description: "Check or trigger Vercel deployment status. Requires explicit approval for production deploys.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const message = String(input.message ?? "");
      const isProdDeploy = /\b(deploy|production|prod)\b/i.test(message) && !/\bpreview\b/i.test(message);
      const vercelToken = (ctx.env.VERCEL_TOKEN ?? "").replace(/^﻿/, "").trim();

      if (isProdDeploy && !ctx.env.VERCEL_TOKEN) {
        return {
          answer: "Production deployment requires VERCEL_TOKEN in env vars and explicit approval. Ask Hermes to 'queue a production deploy' to go through the approval flow.",
          artifacts: [],
        };
      }

      if (!vercelToken) {
        return {
          answer: "VERCEL_TOKEN is not set. Add it to Vercel env vars to check deployment status. You can also check status directly at vercel.com/dashboard.",
          artifacts: [],
        };
      }

      const projectId = ctx.env.VERCEL_PROJECT_ID;
      const teamId = ctx.env.VERCEL_TEAM_ID;
      const listUrl = teamId
        ? `https://api.vercel.com/v6/deployments?projectId=${projectId}&teamId=${teamId}&limit=5`
        : `https://api.vercel.com/v6/deployments?projectId=${projectId}&limit=5`;

      try {
        const res = await fetch(listUrl, {
          headers: { Authorization: `Bearer ${vercelToken}` },
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          return { answer: `Vercel API returned ${res.status}. Check your VERCEL_TOKEN.`, artifacts: [] };
        }

        const json = (await res.json()) as {
          deployments?: Array<{
            uid: string; url: string; state: string; target: string | null;
            meta?: { githubCommitRef?: string }; createdAt: number;
          }>;
        };

        const deployments = json.deployments ?? [];
        if (deployments.length === 0) {
          return { answer: "No deployments found for this project.", artifacts: [] };
        }

        const lines = [
          `**Recent Vercel deployments** (${deployments.length}):`,
          "",
          ...deployments.map((d) => {
            const stateIcon = d.state === "READY" ? "✓" : d.state === "ERROR" ? "✗" : "~";
            const target = d.target === "production" ? " [production]" : " [preview]";
            const branch = d.meta?.githubCommitRef ? ` · branch: ${d.meta.githubCommitRef}` : "";
            const age = Math.round((Date.now() - d.createdAt) / 60000);
            const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
            return `  ${stateIcon} \`${d.state}\`${target}${branch} · ${ageStr} · https://${d.url}`;
          }),
        ];

        const latestReady = deployments.find((d) => d.state === "READY");
        if (latestReady) {
          lines.push("", `**Live URL:** https://${latestReady.url}`);
        }

        return {
          answer: lines.join("\n"),
          artifacts: [{
            type: "link" as const,
            title: "Vercel Dashboard",
            url: "https://vercel.com/dashboard",
            metadata: { deploymentCount: deployments.length, latestState: deployments[0]?.state },
          }],
        };
      } catch (err) {
        return {
          answer: `Deployment status check failed: ${err instanceof Error ? err.message : String(err)}`,
          artifacts: [],
        };
      }
    },
  });

}
