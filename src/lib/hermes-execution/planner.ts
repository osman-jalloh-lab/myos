// Hermes Execution Layer — planner
// Rule-based intent detection. No LLM required.
// TODO: Add model-based JSON planning for multi-step ambiguous requests.

import type { ExecutionRequest, ExecutionPlan, ExecutionStep } from "./types";
import { hasTool } from "./tool-registry";

// ── intent matchers ───────────────────────────────────────────────────────────

function extractGitHubUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/);
  return match?.[0];
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

// ── tool priority helper ──────────────────────────────────────────────────────
// Returns the best available tool name in priority order: MCP → internal → fallback.

function bestTool(...candidates: string[]): string {
  return candidates.find((name) => hasTool(name)) ?? candidates[candidates.length - 1];
}

// ── planner ───────────────────────────────────────────────────────────────────

export function plan(req: ExecutionRequest): ExecutionPlan {
  const msg = req.message;
  const lc = msg.toLowerCase();

  // ── GitHub repo inspection ──────────────────────────────────────────────────

  const isGitHubRequest = matchesAny(lc, [
    /github\.com/,
    /\brepo\b.*\binspect\b/,
    /\binspect\b.*\brepo\b/,
    /\blook at this repo\b/,
    /\btell me what this repo is\b/,
    /\bwhat is this repo\b/,
    /\bwhat('?s| is) in this repo\b/,
    /\bcheck this repo\b/,
    /\bscan this repo\b/,
    /\breview this repo\b/,
    /\bgithub repo\b/,
  ]);

  if (isGitHubRequest) {
    const repoUrl = extractGitHubUrl(msg);
    const tool = bestTool("mcp.github.inspectRepo", "internal.github.inspectRepo");
    const step: ExecutionStep = {
      id: "step_1",
      tool,
      input: { message: msg, ...(repoUrl ? { repoUrl } : {}) },
      risk: "read",
      requiresApproval: false,
    };
    return {
      intent: "github_repo_review",
      confidence: 0.95,
      steps: [step],
      reasoningSummary: `Detected GitHub repo URL or repo inspection keywords. Using ${tool}.`,
    };
  }

  // ── email triage ─────────────────────────────────────────────────────────────

  const isEmailTriage = matchesAny(lc, [
    /\bcheck my email\b/,
    /\bcheck email\b/,
    /\btriage\b.*\b(inbox|email)\b/,
    /\b(inbox|email)\b.*\btriage\b/,
    /\bmy inbox\b/,
    /\bjob follow.?up\b/,
    /\bfollowing up\b/,
    /\brecruiter email\b/,
    /\bunread email\b/,
    /\bcheck.*inbox\b/,
    /\bany (email|messages)\b/,
    /\bstill interested\b/,
    /\binterview.*email\b/,
    /\bwhat'?s in my (inbox|email)\b/,
  ]);

  if (isEmailTriage) {
    const searchTool = bestTool("mcp.gmail.search", "internal.email.search", "internal.email.placeholderSearch");
    const steps: ExecutionStep[] = [
      {
        id: "step_1",
        tool: searchTool,
        input: { query: "newer_than:7d", message: msg },
        risk: "read",
        requiresApproval: false,
      },
      {
        id: "step_2",
        tool: "internal.email.classifyImportant",
        input: { fromPreviousStep: "step_1" },
        risk: "read",
        requiresApproval: false,
        dependsOn: ["step_1"],
      },
    ];
    return {
      intent: "email_triage",
      confidence: 0.9,
      steps,
      reasoningSummary: `Email triage requested. Using ${searchTool} then classifying for importance.`,
    };
  }

  // ── email draft ──────────────────────────────────────────────────────────────

  const isEmailDraft = matchesAny(lc, [
    /\bdraft a reply\b/,
    /\bwrite a reply\b/,
    /\brespond to this email\b/,
    /\bdraft.*email\b/,
    /\bwrite.*email\b/,
    /\bcompose.*email\b/,
    /\breply to\b/,
    /\bsend an email\b/,
    /\bemail.*reply\b/,
  ]);

  if (isEmailDraft) {
    const draftTool = bestTool("mcp.gmail.createDraft", "internal.email.createDraft");
    const step: ExecutionStep = {
      id: "step_1",
      tool: draftTool,
      input: { message: msg },
      risk: "external_write",
      requiresApproval: true,
    };
    return {
      intent: "email_draft",
      confidence: 0.92,
      steps: [step],
      reasoningSummary: "Email draft requested. Requires approval before creation. Will never auto-send.",
    };
  }

  // ── task creation ─────────────────────────────────────────────────────────────

  const isTaskCreate = matchesAny(lc, [
    /\bcreate a task\b/,
    /\bmake a task\b/,
    /\badd a task\b/,
    /\badd task\b/,
    /\bremind me (to|about)\b/,
    /\bfollow up with\b/,
    /\bfollow.?up.*reminder\b/,
    /\btodo[:·]\s/,
    /^todo\b/,
    /\bset a reminder\b/,
    /\btrack this\b/,
  ]);

  if (isTaskCreate) {
    const step: ExecutionStep = {
      id: "step_1",
      tool: "internal.tasks.create",
      input: { message: msg },
      risk: "internal_write",
      requiresApproval: false,
    };
    return {
      intent: "task_create",
      confidence: 0.93,
      steps: [step],
      reasoningSummary: "Task creation requested. Uses existing Hermes OS task system.",
    };
  }

  // ── resume building ──────────────────────────────────────────────────────────

  const isResumeRequest = matchesAny(lc, [
    /\bbuild (me )?a resume\b/,
    /\bgenerate (me )?a resume\b/,
    /\bcreate (me )?a resume\b/,
    /\btailor my resume\b/,
    /\bwrite (me )?a resume\b/,
    /\bresume for\b/,
    /\bresume.*job description\b/,
    /\bjob description.*resume\b/,
    /\b(cv|curriculum vitae)\b/,
  ]);

  if (isResumeRequest) {
    const step: ExecutionStep = {
      id: "step_1",
      tool: "internal.resume.generate",
      input: { message: msg },
      risk: "internal_write",
      requiresApproval: false,
    };
    return {
      intent: "resume_builder",
      confidence: 0.9,
      steps: [step],
      reasoningSummary: "Resume generation requested. Returns a draft text artifact.",
    };
  }

  // ── general fallback ─────────────────────────────────────────────────────────

  return {
    intent: "chat",
    confidence: 0.5,
    steps: [
      {
        id: "step_1",
        tool: "internal.chat.respond",
        input: { message: msg },
        risk: "read",
        requiresApproval: false,
      },
    ],
    reasoningSummary: "No specific execution intent detected. Falling back to chat response.",
  };
}
