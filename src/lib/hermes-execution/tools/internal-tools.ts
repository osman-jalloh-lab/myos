// Hermes Execution Layer — internal tools
// All tools here wrap EXISTING MyOS functions — no new data layer, no new DB tables.
// Registered into the tool registry at startup by ensureRegistryInitialized().

import { registerTool } from "../tool-registry";
import type { ToolContext, ExecutionArtifact } from "../types";

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
        answer: `I received your message but no specific execution tool matched it yet.\n\nCommands I can currently execute:\n  • "Inspect https://github.com/owner/repo" → GitHub repo report\n  • "Check my email for job follow-ups" → email triage\n  • "Create a task to ..." → task creation\n  • "Build me a resume for [role]" → resume draft\n  • "Draft a reply to that recruiter" → email draft (requires approval)\n\nYour message: "${msg.slice(0, 200)}"`,
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

      // Extract GitHub URL from message or explicit input
      const urlMatch = (urlArg || message).match(
        /https?:\/\/(?:www\.)?github\.com\/([a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+)/
      );
      if (!urlMatch) {
        return {
          answer: "I could not find a GitHub URL in your message. Include a full URL like https://github.com/owner/repo",
          artifacts: [],
        };
      }

      const repoPath = urlMatch[1].replace(/\.git$/, "");
      const token = ctx.env.GITHUB_TOKEN;
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

  // ── internal.approval.create ─────────────────────────────────────────────────

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

}
