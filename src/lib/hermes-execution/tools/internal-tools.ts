// Hermes Execution Layer — internal tools
// All tools here wrap EXISTING MyOS functions — no new data layer, no new DB tables.
// Registered into the tool registry at startup by ensureRegistryInitialized().

import { registerTool } from "../tool-registry";
import type { ToolContext, ExecutionArtifact } from "../types";
import { registerBuildTools } from "./build-tools";

const GITHUB_URL_PREFIX = "https://github.com/";
const GITHUB_REPO_SEGMENT_RE = /^[a-zA-Z0-9_.-]+$/;

export function sanitizeGitHubRepoInput(input: string): string {
  return input.replace(/[\uFEFF\u200B-\u200D]/g, "").trim();
}

export function sanitizeGitHubHeaderValue(input: string): string {
  return input.replace(/[\uFEFF\u200B-\u200D]/g, "").trim();
}

function getGitHubRepoPath(input: string): { repoPath?: string; error?: string } {
  const sanitized = sanitizeGitHubRepoInput(input);
  const urlCandidate = sanitized.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.;]+$/, "");

  if (!urlCandidate) {
    return {
      error: "I could not find a GitHub URL in your message. Include a full URL like https://github.com/owner/repo",
    };
  }

  if (!urlCandidate.startsWith(GITHUB_URL_PREFIX)) {
    return {
      error: "Invalid GitHub URL. Use a full repo URL that starts with https://github.com/owner/repo",
    };
  }

  let url: URL;
  try {
    url = new URL(urlCandidate);
  } catch {
    return {
      error: "Invalid GitHub URL. Use a full repo URL like https://github.com/owner/repo",
    };
  }

  if (url.origin !== "https://github.com") {
    return {
      error: "Invalid GitHub URL. Use a full repo URL that starts with https://github.com/owner/repo",
    };
  }

  const [owner, repoWithSuffix] = url.pathname.split("/").filter(Boolean);
  const repo = repoWithSuffix?.replace(/\.git$/, "");

  if (!owner || !repo || !GITHUB_REPO_SEGMENT_RE.test(owner) || !GITHUB_REPO_SEGMENT_RE.test(repo)) {
    return {
      error: "Invalid GitHub repo URL. Use https://github.com/owner/repo with a valid owner and repository name.",
    };
  }

  return { repoPath: `${owner}/${repo}` };
}

function projectNameFrom(input: Record<string, unknown>): string {
  const explicit = String(input.projectName ?? "").trim();
  if (explicit) return explicit.slice(0, 80);

  const message = String(input.message ?? "").trim();
  const match = message.match(/\b(?:build|create|make|start|plan|design)\s+(?:a\s+|an\s+|the\s+)?(.{3,70}?)(?:\s+(?:for|with|that|using|in)\b|[.!?\n]|$)/i);
  return (match?.[1]?.trim() || "Hermes Project").slice(0, 80);
}

function routeForProject(projectName: string): string {
  const slug = projectName
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
  return `/${slug || "hermes-project"}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function findProjectId(value: unknown): string | null {
  const record = asRecord(value);
  if (!record) return null;
  if (typeof record.projectId === "string") return record.projectId;
  const project = asRecord(record.project);
  if (typeof project?.id === "string") return project.id;
  const result = asRecord(record.result);
  if (typeof result?.projectId === "string") return result.projectId;
  const resultProject = asRecord(result?.project);
  if (typeof resultProject?.id === "string") return resultProject.id;
  for (const nested of Object.values(record)) {
    const found = findProjectId(nested);
    if (found) return found;
  }
  return null;
}

function defaultProjectPlan(message: string): Array<{ title: string; assignedAgent: string; description: string }> {
  const prompt = message.trim() || "Start the project and prepare the first build handoff.";
  return [
    {
      title: "Clarify project scope",
      assignedAgent: "project-starter",
      description: `Confirm goal, target users, core features, and constraints. Source: ${prompt.slice(0, 240)}`,
    },
    {
      title: "Draft architecture and data model",
      assignedAgent: "project-starter",
      description: "Turn the idea into routes, data model, integrations, and acceptance criteria.",
    },
    {
      title: "Prepare approved build handoff",
      assignedAgent: "build-orchestrator",
      description: "Queue implementation only after the owner approves the project plan.",
    },
  ];
}

// ── internal.chat.respond ─────────────────────────────────────────────────────

export function registerInternalTools(): void {

  registerTool({
    name: "internal.chat.respond",
    description: "Fallback response when no execution tool matched the request.",
    risk: "read",
    requiresApproval: false,
    execute: async (input) => {
      const msg = String(input.message ?? "");
      return {
        answer: `I received your message but routed it through chat instead of a specific tool.\n\nExecution tools I can invoke:\n  • "Build [feature name]" → generate + commit + PR real code\n  • "Create the /[route] route" → create a new Next.js page\n  • "Run build / run typecheck" → check the build\n  • "Deploy" → check Vercel deployment status\n  • "Inspect the repo" → read the file structure\n  • "Inspect https://github.com/owner/repo" → GitHub repo report\n  • "Check my email for job follow-ups" → email triage\n  • "Create a task to ..." → task creation\n  • "Build me a resume for [role]" → resume draft\n\nYour message: "${msg.slice(0, 200)}"`,
        artifacts: [] as ExecutionArtifact[],
      };
    },
  });

  // ── internal.github.inspectRepo ─────────────────────────────────────────────

  registerTool({
    name: "internal.github.inspectRepo",
    description: "Inspect a GitHub repo — fetch metadata and README via public API.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const message = String(input.message ?? "");
      const urlArg = input.repoUrl as string | undefined;

      const { repoPath, error } = getGitHubRepoPath(urlArg || message);
      if (!repoPath) {
        return {
          answer: error,
          artifacts: [],
        };
      }

      const token = ctx.env.GITHUB_TOKEN ? sanitizeGitHubHeaderValue(ctx.env.GITHUB_TOKEN) : "";
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "hermes-os-execution",
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;

      // Fetch repo metadata
      const metaRes = await fetch(`https://api.github.com/repos/${repoPath}`, { headers });
      if (!metaRes.ok) {
        const status = metaRes.status;
        if (status === 404) return { answer: `Repository "${repoPath}" was not found on GitHub (404).`, artifacts: [] };
        if (status === 403) return { answer: `GitHub rate-limited this request (403). Set GITHUB_TOKEN in env to increase rate limits.`, artifacts: [] };
        return { answer: `GitHub API returned ${status} for "${repoPath}".`, artifacts: [] };
      }

      const meta = (await metaRes.json()) as {
        full_name: string;
        description: string | null;
        language: string | null;
        default_branch: string;
        stargazers_count: number;
        forks_count: number;
        open_issues_count: number;
        topics?: string[];
        html_url: string;
        homepage?: string | null;
        license?: { spdx_id: string } | null;
        created_at: string;
        updated_at: string;
        size: number;
        visibility: string;
      };

      // Fetch README (best-effort)
      let readmePreview = "";
      try {
        const readmeRes = await fetch(`https://api.github.com/repos/${repoPath}/readme`, { headers });
        if (readmeRes.ok) {
          const readmeData = (await readmeRes.json()) as { content?: string; encoding?: string };
          if (readmeData.encoding === "base64" && readmeData.content) {
            const decoded = Buffer.from(readmeData.content.replace(/\n/g, ""), "base64").toString("utf-8");
            readmePreview = decoded.slice(0, 1200).replace(/#{1,6}\s+/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
          }
        }
      } catch {
        // README fetch is best-effort
      }

      const lines = [
        `**${meta.full_name}** (${meta.visibility})`,
        meta.description ? `${meta.description}` : "No description.",
        `Language: ${meta.language ?? "not specified"} | Stars: ${meta.stargazers_count} | Forks: ${meta.forks_count} | Open issues: ${meta.open_issues_count}`,
        `Default branch: ${meta.default_branch}`,
        meta.topics?.length ? `Topics: ${meta.topics.join(", ")}` : "",
        meta.license ? `License: ${meta.license.spdx_id}` : "",
        meta.homepage ? `Homepage: ${meta.homepage}` : "",
        `Last updated: ${new Date(meta.updated_at).toLocaleDateString()}`,
        readmePreview ? `\nREADME preview:\n${readmePreview.slice(0, 800)}` : "",
      ].filter(Boolean).join("\n");

      return {
        answer: lines,
        artifacts: [
          {
            type: "repo_report" as const,
            title: meta.full_name,
            url: meta.html_url,
            content: lines,
            metadata: {
              language: meta.language,
              stars: meta.stargazers_count,
              defaultBranch: meta.default_branch,
              topics: meta.topics,
            },
          },
        ],
      };
    },
  });

  // ── internal.tasks.create ────────────────────────────────────────────────────
  // Wraps existing lib/tasks.ts:createTask() — no new DB table.

  registerTool({
    name: "internal.skillScout.inspectRepo",
    description: "Inspect a GitHub repo for Parawi-relevant skills, tools, and patterns, then queue approval requests before any import.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const { runSkillScout } = await import("@/lib/skill-scout/github");
      const message = String(input.message ?? "");
      const repoUrl = String(input.repoUrl ?? message);
      const result = await runSkillScout(ctx.userId, repoUrl);

      const lines = [
        `Skill Scout inspected ${result.repo.fullName}.`,
        result.repo.description ? result.repo.description : "No repository description.",
        `Tree items inspected: ${result.inspected.treeItems}. Scripts run: no. Files imported: no.`,
        `Approval requests queued: ${result.approvals.length}.`,
        "",
        "Top recommendations:",
        ...result.candidates.slice(0, 5).map((candidate, index) =>
          `${index + 1}. ${candidate.name} (${candidate.category}) - ${candidate.recommendedAction} - benefit ${candidate.scores.benefit}/10, risk ${candidate.scores.risk}/10, effort ${candidate.scores.effort}/10, priority ${candidate.scores.priority}\n   ${candidate.whyItHelpsParawi}\n   Source: ${candidate.sourcePath}`
        ),
        "",
        "Nothing has been imported. Approve a Skill Scout request before adapting any files.",
      ];

      return {
        answer: lines.join("\n"),
        artifacts: [
          {
            type: "repo_report" as const,
            title: `Skill Scout - ${result.repo.fullName}`,
            url: result.repoUrl,
            content: lines.join("\n"),
            metadata: {
              candidateCount: result.candidates.length,
              approvalCount: result.approvals.length,
              scriptsRun: false,
              filesImported: false,
            },
          },
        ],
        result,
      };
    },
  });

  registerTool({
    name: "internal.tasks.create",
    description: "Create a task using the existing Hermes OS task system.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const { createTask } = await import("@/lib/tasks");

      const message = String(input.message ?? "");

      // Parse title from the message — strip trigger words, take first 100 chars
      const titleRaw = message
        .replace(/^(create a task|make a task|add task|add a task|todo|remind me to|follow up with|follow-up with)\s*/i, "")
        .replace(/\s*(tomorrow|today|this week|next week|by [a-z]+day).*$/i, "")
        .trim();
      const title = titleRaw.slice(0, 100) || message.slice(0, 100);

      // Extract due date hint (very simple)
      const dueTomorrow = /tomorrow/i.test(message);
      const dueAt = dueTomorrow ? new Date(Date.now() + 86_400_000) : undefined;

      const task = await createTask(ctx.userId, {
        title,
        description: message.length > title.length ? message : undefined,
        dueAt,
        source: "execution-layer",
      });

      return {
        answer: `Task created: "${task.title}"${dueAt ? ` (due ${dueAt.toLocaleDateString()})` : ""}.`,
        artifacts: [
          {
            type: "task" as const,
            title: task.title,
            id: task.id,
            content: task.description ?? undefined,
            metadata: { status: task.status, priority: task.priority, dueAt: task.dueAt },
          },
        ],
      };
    },
  });

  // ── internal.resume.generate ─────────────────────────────────────────────────

  registerTool({
    name: "internal.projects.create",
    description: "Create or reopen a Project row and mark it as the active execution project.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const { ensureBuildProject, updateProjectStatus, createProjectTask } = await import("@/lib/memory-context");
      const message = String(input.message ?? "");
      const projectName = projectNameFrom(input);
      const route = String(input.route ?? routeForProject(projectName));
      const project = await ensureBuildProject(ctx.sessionId ?? `execution:${ctx.userId}`, ctx.userId, route, message || projectName);
      await updateProjectStatus(project.id, "planning");
      const task = await createProjectTask(project.id, ctx.userId, "Clarify project scope", {
        assignedAgent: "project-starter",
        description: message || `Start ${projectName}.`,
        nextStep: "Confirm goal, users, features, routes, data model, risks, and first build step.",
      });

      return {
        answer: `Project created: ${project.projectName} (${project.id.slice(0, 8)}). I added the intake task and kept the project in planning.`,
        project: { ...project, status: "planning" },
        projectId: project.id,
        artifacts: [
          {
            type: "task" as const,
            title: task.title,
            id: task.id,
            content: task.description ?? undefined,
            metadata: { projectId: project.id, status: task.status, assignedAgent: task.assignedAgent },
          },
        ],
      };
    },
  });

  registerTool({
    name: "internal.projects.plan",
    description: "Create ProjectTask rows for a project starter plan.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const { createProjectTasksFromPlan, updateProjectStatus } = await import("@/lib/memory-context");
      const projectId = findProjectId(input) ?? findProjectId(ctx.previousResults);
      if (!projectId) {
        return {
          answer: "No project id was available to plan against. Create the project first, then run the project planner.",
          artifacts: [],
        };
      }

      const message = String(input.message ?? "");
      const rawSteps = Array.isArray(input.steps) ? input.steps : [];
      const steps = rawSteps.length
        ? rawSteps.map((step) => {
            const record = asRecord(step);
            return {
              title: String(record?.title ?? step).slice(0, 120),
              assignedAgent: String(record?.assignedAgent ?? "project-starter"),
              description: String(record?.description ?? message ?? "").slice(0, 500),
            };
          })
        : defaultProjectPlan(message);

      const tasks = await createProjectTasksFromPlan(projectId, ctx.userId, steps);
      await updateProjectStatus(projectId, "planned");

      return {
        answer: `Project plan saved with ${tasks.length} new task${tasks.length === 1 ? "" : "s"}. Status is planned; implementation still needs approval.`,
        projectId,
        planSteps: steps,
        artifacts: tasks.map((task) => ({
          type: "task" as const,
          title: task.title,
          id: task.id,
          content: task.description ?? undefined,
          metadata: { projectId, status: task.status, assignedAgent: task.assignedAgent },
        })),
      };
    },
  });

  registerTool({
    name: "internal.projects.requestHandoff",
    description: "Queue an approved project build handoff without executing it automatically.",
    risk: "external_write",
    requiresApproval: true,
    execute: async (input, ctx: ToolContext) => {
      const { createApproval } = await import("@/lib/approvals");
      const projectId = findProjectId(input) ?? findProjectId(ctx.previousResults);
      const message = String(input.message ?? "");
      const planSteps = asRecord(input)?.planSteps ?? asRecord(ctx.previousResults)?.planSteps;
      const approval = await createApproval(ctx.userId, "engineering_plan", {
        projectId,
        projectName: String(input.projectName ?? "Hermes Project"),
        message,
        planSteps: Array.isArray(planSteps) ? planSteps : defaultProjectPlan(message),
        source: "project-starter",
        handoffTarget: "build-orchestrator",
      });

      return {
        answer: `Project handoff is queued for approval (id: ${approval.id.slice(0, 8)}). No implementation handoff has run yet.`,
        projectId,
        artifacts: [
          {
            type: "task" as const,
            title: "Project handoff pending approval",
            id: approval.id,
            content: message,
            metadata: { approvalId: approval.id, projectId, actionType: "engineering_plan", status: "pending" },
          },
        ],
      };
    },
  });

  registerTool({
    name: "internal.resume.generate",
    description: "Generate a resume draft from the user's profile and a target role.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const { callModel } = await import("@/lib/modelRouter");
      const { OSMAN_CONTEXT } = await import("@/agents/souls/osman");

      const message = String(input.message ?? "");

      const roleMatch = message.match(/(?:for|as an?|targeting)\s+([^.]+?)(?:\s+role|\s+position|$)/i)
        ?? message.match(/resume\s+(?:for\s+)?([^.]+)/i);
      const role = roleMatch?.[1]?.trim() ?? "the target role";

      const result = await callModel({
        userId: ctx.userId,
        taskType: "resume-generate",
        dataClass: "PERSONAL",
        systemPrompt: `You are Athena, Hermes OS's career agent. Generate a clean, ATS-optimized resume draft for the role requested. Use ONLY facts from the profile below. No em dashes. One page. Security+ and CySA+ near the top. No CPT mention. No Sierra Leone mention.\n\n${OSMAN_CONTEXT}`,
        userPrompt: `Generate a resume draft for: ${role}\n\nFormat it as clean plain text with sections: Summary, Skills, Experience, Education, Certifications. ATS-optimized. Under 600 words.`,
      });

      return {
        answer: `Resume draft for "${role}" generated. Review it, then ask Athena to refine or ATS-score it against a specific job description.`,
        artifacts: [
          {
            type: "text" as const,
            title: `Resume draft — ${role}`,
            content: result.text,
            metadata: { role, generatedAt: new Date().toISOString() },
          },
        ],
      };
    },
  });

  // ── internal.email.search ─────────────────────────────────────────────────────
  // Wraps existing lib/gmail.ts:fetchInboxMessages() — real Gmail via OAuth.

  registerTool({
    name: "internal.email.search",
    description: "Fetch inbox messages using existing Gmail OAuth integration.",
    risk: "read",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      let messages;
      try {
        const { fetchInboxMessages } = await import("@/lib/gmail");
        messages = await fetchInboxMessages(ctx.userId, 20);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("token") || msg.includes("auth") || msg.includes("OAuth")) {
          return {
            answer: "Gmail is not connected or your Google account token has expired. Go to Settings → Linked Accounts to reconnect your Google account.",
            artifacts: [],
            _emails: [],
          };
        }
        return {
          answer: `Email fetch failed: ${msg}. Make sure a Google account is linked in Settings.`,
          artifacts: [],
          _emails: [],
        };
      }

      return {
        answer: `Fetched ${messages.length} inbox message(s).`,
        _emails: messages,
        artifacts: [],
      };
    },
  });

  // ── internal.email.classifyImportant ─────────────────────────────────────────

  registerTool({
    name: "internal.email.classifyImportant",
    description: "Classify fetched emails for importance — find action-needed messages.",
    risk: "read",
    requiresApproval: false,
    execute: async (input) => {
      const fromPrev = input.fromPreviousStep as string | undefined;
      const emails = (input._emails ?? (fromPrev ? [] : [])) as {
        subject?: string;
        from?: string;
        snippet?: string;
        isUnread?: boolean;
        isImportant?: boolean;
        receivedAt?: string;
      }[];

      if (!emails.length) {
        return {
          answer: "No email data was provided to classify. Run email search first.",
          artifacts: [],
        };
      }

      const ACTION_PHRASES = [
        "still interested", "are you available", "interview", "next steps",
        "position", "offer", "deadline", "action required", "please respond",
        "following up", "follow up", "recruiter", "opportunity", "application",
        "schedule", "availability", "onsite", "on-site", "virtual", "zoom",
      ];

      const needsAction = emails.filter((m) => {
        const text = `${m.subject ?? ""} ${m.snippet ?? ""} ${m.from ?? ""}`.toLowerCase();
        return ACTION_PHRASES.some((phrase) => text.includes(phrase));
      });

      const unread = emails.filter((m) => m.isUnread);

      const lines = [
        `${emails.length} emails fetched. ${unread.length} unread. ${needsAction.length} need action.`,
      ];

      if (needsAction.length) {
        lines.push("\nNeeds action:");
        for (const m of needsAction.slice(0, 6)) {
          lines.push(`  • ${m.subject ?? "(no subject)"} — from ${m.from ?? "unknown"}`);
        }
      } else {
        lines.push("Nothing in the inbox requires immediate action.");
      }

      return {
        answer: lines.join("\n"),
        artifacts: needsAction.length ? [
          {
            type: "text" as const,
            title: `${needsAction.length} action-needed email(s)`,
            content: needsAction.map((m) => `${m.subject} | ${m.from} | ${m.snippet ?? ""}`).join("\n"),
            metadata: { count: needsAction.length, unread: unread.length },
          },
        ] : [],
      };
    },
  });

  // ── internal.email.placeholderSearch ─────────────────────────────────────────
  // Only used if internal.email.search is not registered (shouldn't happen normally).

  registerTool({
    name: "internal.email.placeholderSearch",
    description: "Placeholder — real email search not yet connected.",
    risk: "read",
    requiresApproval: false,
    execute: async () => ({
      answer: "Email execution is not connected. The Gmail OAuth integration needs a linked Google account. Go to Settings → Linked Accounts to connect your Google account, then retry.",
      artifacts: [],
    }),
  });

  // ── internal.email.createDraft ────────────────────────────────────────────────
  // Requires approval — NEVER auto-sends.

  registerTool({
    name: "internal.email.createDraft",
    description: "Queue an email draft for approval. Never sends automatically.",
    risk: "external_write",
    requiresApproval: true,
    execute: async (input, ctx: ToolContext) => {
      // Use existing approval system from lib/approvals.ts
      const { createApproval } = await import("@/lib/approvals");

      const message = String(input.message ?? "");
      const approval = await createApproval(ctx.userId, "draft_email", { message, source: "execution-layer" });

      return {
        answer: `I've queued a draft email for your approval (id: ${approval.id.slice(0, 8)}). Review it in the Approvals panel before anything is created.`,
        artifacts: [
          {
            type: "email_draft" as const,
            title: "Email draft — pending approval",
            id: approval.id,
            content: message,
            metadata: { approvalId: approval.id, status: "pending" },
          },
        ],
      };
    },
  });

  // ── internal.jobs.updateFromEmail ────────────────────────────────────────────
  // Scans Gmail for application-status emails, then queues add_job or
  // update_job_status approvals. Nothing writes without Osman's approval.

  registerTool({
    name: "internal.jobs.updateFromEmail",
    description: "Scan inbox for job application emails and queue tracker updates for approval.",
    risk: "read",
    requiresApproval: false,
    execute: async (_input, ctx: ToolContext) => {
      const { fetchInboxMessages } = await import("@/lib/gmail");
      const { createApproval } = await import("@/lib/approvals");
      const { prisma } = await import("@/lib/db");

      let messages: Awaited<ReturnType<typeof fetchInboxMessages>>;
      try {
        messages = await fetchInboxMessages(ctx.userId, 40);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          answer: `Gmail not accessible: ${msg}. Make sure a Google account is linked in Settings.`,
          artifacts: [],
        };
      }

      // Status signals ranked by specificity (most specific first)
      const SIGNALS: { patterns: RegExp[]; status: string; label: string }[] = [
        { patterns: [/pleased to offer|job offer|offer letter|extend.*offer|formally offer/i], status: "offer", label: "offer" },
        { patterns: [/schedule.*interview|interview.*schedule|like to (invite|speak|chat)|phone (screen|call)|video interview|on.?site|next round/i], status: "interview", label: "interview" },
        { patterns: [/regret to inform|not.*moving forward|position.*filled|unsuccessful|decided to (move|go) with|not.*selected|no longer.*considering/i], status: "rejected", label: "rejected" },
        { patterns: [/received your application|we('ve| have) received|application.*submitted|thank.*applying|application.*received|application.*confirmation/i], status: "applied", label: "received confirmation" },
      ];

      // Extract company/role from subject line — best effort
      function parseSubject(subject: string): { company: string; role: string } {
        const companyMatch = subject.match(/(?:at|from|with|@)\s+([A-Z][A-Za-z0-9& ,.-]{1,40})/);
        const roleMatch = subject.match(/(?:for|re:|regarding)\s+(.{5,60}?)(?:\s+(?:at|position|role|job)|$)/i);
        return {
          company: companyMatch?.[1]?.trim() ?? "Unknown Company",
          role: roleMatch?.[1]?.trim() ?? subject.slice(0, 60),
        };
      }

      // Fetch existing job listings for match-against
      const existingJobs = await prisma.jobListing.findMany({
        where: { userId: ctx.userId },
        select: { id: true, company: true, title: true, status: true },
      });

      function findExistingJob(company: string) {
        const lc = company.toLowerCase();
        return existingJobs.find((j) =>
          j.company.toLowerCase().includes(lc) || lc.includes(j.company.toLowerCase())
        );
      }

      // Job-board digests and alert blasts are not application-status emails.
      // "Osman: 30+ new jobs", "jobs for you", "your job alert" etc. must never
      // become tracker entries — they caused the recurring junk add_job approval.
      const DIGEST_RE = /\d+\+?\s*new\s*jobs|job\s*alert|jobs?\s*for\s*you|recommended\s*(jobs|for)|daily\s*digest|weekly\s*digest|hiring\s*now|apply\s*now\b.*\bmore\b/i;

      const queued: string[] = [];
      const seen = new Set<string>(); // deduplicate by company+status

      for (const msg of messages) {
        const text = `${msg.subject ?? ""} ${msg.snippet ?? ""}`;
        if (DIGEST_RE.test(msg.subject ?? "")) continue; // alert blast, not a status update
        for (const signal of SIGNALS) {
          if (!signal.patterns.some((p) => p.test(text))) continue;

          const { company, role } = parseSubject(msg.subject ?? "");
          // A status signal with no identifiable company is noise — queueing
          // "Unknown Company" rows just clutters the approval queue.
          if (company === "Unknown Company") break;
          const key = `${company.toLowerCase()}:${signal.status}`;
          if (seen.has(key)) break;
          seen.add(key);

          const existing = findExistingJob(company);

          if (existing) {
            if (existing.status === signal.status) break; // already up to date
            await createApproval(ctx.userId, "update_job_status", {
              jobListingId: existing.id,
              status: signal.status,
              reason: `Email signal: "${(msg.subject ?? "").slice(0, 80)}"`,
            });
            queued.push(`Update "${existing.title}" at ${existing.company} → ${signal.status}`);
          } else {
            await createApproval(ctx.userId, "add_job", {
              title: role,
              company,
              status: signal.status,
              notes: `Discovered via email: ${(msg.subject ?? "").slice(0, 120)}`,
            });
            queued.push(`Add "${role}" at ${company} (${signal.label})`);
          }
          break; // one signal per email is enough
        }
      }

      if (!queued.length) {
        return {
          answer: `Scanned ${messages.length} emails. No new application-status signals found. I looked for confirmations, interview invites, offers, and rejections.`,
          artifacts: [],
        };
      }

      return {
        answer: `Scanned ${messages.length} emails and queued ${queued.length} update${queued.length !== 1 ? "s" : ""} for your approval:\n\n${queued.map((q) => `  • ${q}`).join("\n")}\n\nReview and approve them in the Approvals panel.`,
        artifacts: [
          {
            type: "text" as const,
            title: `${queued.length} job tracker update(s) queued`,
            content: queued.join("\n"),
            metadata: { count: queued.length, scanned: messages.length },
          },
        ],
      };
    },
  });

  // ── internal.code.execute ────────────────────────────────────────────────────
  // Runs code in an E2B cloud sandbox. Safe — isolated container, killed after run.
  // Used by Prometheus to turn ideas into working prototypes / data transforms.

  registerTool({
    name: "internal.code.execute",
    description: "Execute Python, JavaScript, or bash code in an isolated E2B cloud sandbox. Use to prototype ideas, run calculations, transform data, or build small scripts.",
    risk: "read",
    requiresApproval: false,
    execute: async (input) => {
      const { runCode, e2bConnected } = await import("@/lib/e2b");

      if (!e2bConnected()) {
        return {
          answer: "E2B code execution is not connected. Add E2B_API_KEY to Vercel env vars (get a free key at e2b.dev — 100 hours/month on the free tier).",
          artifacts: [],
        };
      }

      const message = String(input.message ?? "");
      const codeArg = input.code as string | undefined;
      const langArg = (input.language as string | undefined) ?? "python";
      const language = (["python", "javascript", "bash"].includes(langArg) ? langArg : "python") as "python" | "javascript" | "bash";

      // If no code block was provided, extract from message fences or use message as code
      const fenceMatch = message.match(/```(?:python|javascript|js|bash|sh)?\s*\n([\s\S]+?)```/);
      const code = codeArg ?? fenceMatch?.[1]?.trim() ?? message.trim();

      if (!code) {
        return {
          answer: "No code to execute. Provide a code block or describe what you want to run.",
          artifacts: [],
        };
      }

      let result;
      try {
        result = await runCode(code, language);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          answer: `Execution failed: ${msg}`,
          artifacts: [],
        };
      }

      const outputText = result.output || "(no output)";
      const errorText = result.error ? `\n\nError: ${result.error}` : "";

      return {
        answer: `Code executed (${language}):\n\`\`\`\n${outputText.slice(0, 2000)}${errorText}\n\`\`\``,
        artifacts: [
          {
            type: "text" as const,
            title: `Code execution result (${language})`,
            content: outputText + errorText,
            metadata: { language, hasError: !!result.error, outputLength: outputText.length },
          },
        ],
      };
    },
  });

  // ── internal.code.buildAndPush ───────────────────────────────────────────────
  // Runs code in E2B, captures files written to /home/user/output/, then pushes
  // them to osman-jalloh-lab/prometheus-builds on GitHub.
  // Requires both E2B_API_KEY and GITHUB_TOKEN.

  registerTool({
    name: "internal.code.buildAndPush",
    description: "Build an application in E2B sandbox, capture output files, and push them to GitHub. Use when Prometheus builds something worth keeping — a script, a tool, a prototype.",
    risk: "external_write",
    requiresApproval: false,
    execute: async (input) => {
      const { runCodeAndCapture, e2bConnected } = await import("@/lib/e2b");
      const { pushToGitHub, githubConnected } = await import("@/lib/github-push");

      if (!e2bConnected()) {
        return {
          answer: "E2B code execution is not connected. Add E2B_API_KEY to Vercel env vars.",
          artifacts: [],
        };
      }
      if (!githubConnected()) {
        return {
          answer: "GitHub persistence is not connected. Add GITHUB_TOKEN to Vercel env vars (needs repo scope — github.com/settings/tokens).",
          artifacts: [],
        };
      }

      const message = String(input.message ?? "");
      const codeArg = input.code as string | undefined;
      const langArg = (input.language as string | undefined) ?? "python";
      const language = (["python", "javascript", "bash"].includes(langArg) ? langArg : "python") as "python" | "javascript" | "bash";
      const projectName = (input.projectName as string | undefined) ?? `build-${new Date().toISOString().slice(0, 10)}`;

      const fenceMatch = message.match(/```(?:python|javascript|js|bash|sh)?\s*\n([\s\S]+?)```/);
      const code = codeArg ?? fenceMatch?.[1]?.trim() ?? message.trim();

      if (!code) {
        return { answer: "No code to execute. Provide a code block.", artifacts: [] };
      }

      let result;
      try {
        result = await runCodeAndCapture(code, language);
      } catch (err) {
        return { answer: `Build failed: ${err instanceof Error ? err.message : String(err)}`, artifacts: [] };
      }

      if (!result.files?.length) {
        // Nothing in /output — fall back to saving the code itself
        result.files = [{ path: `main.${language === "javascript" ? "js" : language === "bash" ? "sh" : "py"}`, content: code }];
      }

      let pushResult;
      try {
        pushResult = await pushToGitHub(result.files, {
          folder: projectName,
          commitMessage: `feat: ${projectName} — built by Prometheus`,
        });
      } catch (err) {
        return {
          answer: `Code ran OK but GitHub push failed: ${err instanceof Error ? err.message : String(err)}\n\nOutput:\n${result.output.slice(0, 1000)}`,
          artifacts: [],
        };
      }

      const outputText = result.output || "(no output)";
      const errorText = result.error ? `\n\nError: ${result.error}` : "";

      const liveUrl = pushResult.pagesUrl
        ? `\n\n**Live site (ready in ~1 min):** ${pushResult.pagesUrl}`
        : "";
      const repoLine = `\n\n**Repo:** ${pushResult.repoUrl}`;
      const filesLine = `\n**Files:** ${pushResult.files.join(", ")}`;

      return {
        answer: `Built and pushed to GitHub.${liveUrl}${repoLine}${filesLine}\n\n**Output:**\n\`\`\`\n${outputText.slice(0, 1500)}${errorText}\n\`\`\``,
        artifacts: [
          {
            type: "text" as const,
            title: `${projectName} — pushed to GitHub`,
            content: outputText + errorText,
            metadata: {
              repoUrl: pushResult.repoUrl,
              pagesUrl: pushResult.pagesUrl ?? undefined,
              files: pushResult.files,
              language,
              projectName,
            },
          },
        ],
      };
    },
  });

  // ── internal.approval.create ─────────────────────────────────────────────────

  registerTool({
    name: "internal.capabilities.answer",
    description: "Answer whether Hermes can do a requested action using the live tool registry and worker status.",
    risk: "read",
    requiresApproval: false,
    execute: async (input) => {
      const { answerCapabilityQuestion, getCapabilitySnapshot } = await import("@/lib/hermes-execution/capabilities");
      const message = String(input.message ?? "");
      const snapshot = await getCapabilitySnapshot();
      const result = answerCapabilityQuestion(message, snapshot);
      return {
        answer: result.answer,
        result,
        artifacts: [
          {
            type: "text" as const,
            title: `Capability answer - ${result.shape}`,
            content: result.answer,
            metadata: {
              shape: result.shape,
              matchedTools: result.matchedTools,
              workerStatus: result.workerStatus,
              buildExecutor: snapshot.buildExecution.executor,
            },
          },
        ],
      };
    },
  });

  registerTool({
    name: "internal.approval.create",
    description: "Queue any action into the existing Hermes OS approval system.",
    risk: "internal_write",
    requiresApproval: false,
    execute: async (input, ctx: ToolContext) => {
      const { createApproval } = await import("@/lib/approvals");

      const actionType = String(input.actionType ?? "draft_email") as Parameters<typeof createApproval>[1];
      const payload = input.payload ?? { message: input.message };

      const approval = await createApproval(ctx.userId, actionType, payload);
      return {
        answer: `Action queued for your approval (id: ${approval.id.slice(0, 8)}). You can approve or reject it from the Approvals panel.`,
        artifacts: [
          {
            type: "task" as const,
            title: `Pending approval — ${actionType}`,
            id: approval.id,
            metadata: { approvalId: approval.id, actionType, status: "pending" },
          },
        ],
      };
    },
  });

  // Register build tools (repo_inspect, file_write, command_run, git_diff, git_commit_or_pr, vercel_deploy)
  registerBuildTools();

}
