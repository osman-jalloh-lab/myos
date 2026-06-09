// Hermes Execution Layer — planner
// LLM-first intent detection using Groq (fast, cheap).
// Falls back to regex rules if the LLM call fails or times out.
// No new DB tables, no new API keys — uses existing callModel() + GROQ_API_KEY.

import type { ExecutionRequest, ExecutionPlan, ExecutionStep } from "./types";
import { hasTool } from "./tool-registry";

// ── tool catalog (shown to the LLM) ──────────────────────────────────────────

const TOOL_CATALOG = `
Tools available in Parawi/MyOS:
- github_repo_review: Inspect any GitHub repo. Trigger: GitHub URL, "what is this repo", "inspect", "scan repo", "look at this project"
- email_triage: Check/triage inbox for action-needed emails. Trigger: "check my email", "inbox", "any emails", "recruiter emails", "unread", "follow-ups"
- email_draft: Draft an email (held for approval, never auto-sent). Trigger: "draft a reply", "write an email", "compose", "respond to"
- task_create: Create a task, reminder, or to-do. Trigger: "remind me", "create a task", "add a task", "todo", "follow up", "don't let me forget"
- resume_builder: Generate or tailor a resume for a specific role. Trigger: "resume", "CV", "tailor my resume", "resume for [role]"
- job_search: Search for job openings. Trigger: "find jobs", "job openings", "search for [role] jobs", "what jobs are available", "roles in [city/field]"
- morning_brief: Get the day's brief — schedule, tasks, priorities. Trigger: "brief me", "what's my day", "morning brief", "what's on today", "what should I focus on"
- income_opportunities: F-1-safe income ideas — freelance, passive income, campus jobs. Trigger: "income", "make money", "side hustle", "gigs", "F-1 jobs", "earn as a student"
- email_schedule: Check or manage calendar events. Trigger: "my schedule", "what's today", "calendar", "meetings", "what's coming up"
- chat: Everything else — questions, advice, general conversation.
`.trim();

const PLANNER_SYSTEM = `You are the intent classifier for Parawi/MyOS, a personal AI operating system.

Given a user message, return ONLY a valid JSON object — no explanation, no markdown, just JSON.

${TOOL_CATALOG}

JSON format:
{
  "intent": "<one of the tool keys above>",
  "confidence": <0.0 to 1.0>,
  "extractedUrl": "<GitHub URL if present, else null>",
  "reasoning": "<one short line>"
}`;

// ── LLM-based planner ─────────────────────────────────────────────────────────

async function planWithLLM(message: string): Promise<{
  intent: string;
  confidence: number;
  extractedUrl: string | null;
} | null> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.1-8b-instant",
        messages: [
          { role: "system", content: PLANNER_SYSTEM },
          { role: "user", content: message },
        ],
        temperature: 0.1,
        max_tokens: 120,
      }),
      signal: AbortSignal.timeout(4000), // 4s max — never block the user
    });

    if (!res.ok) return null;

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";

    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(cleaned) as {
      intent?: string;
      confidence?: number;
      extractedUrl?: string | null;
    };

    if (!parsed.intent) return null;

    return {
      intent: parsed.intent,
      confidence: parsed.confidence ?? 0.8,
      extractedUrl: parsed.extractedUrl ?? null,
    };
  } catch {
    // LLM timeout or parse error — fall through to regex
    return null;
  }
}

// ── regex fallback (original rules) ──────────────────────────────────────────

function extractGitHubUrl(text: string): string | undefined {
  const match = text.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/);
  return match?.[0];
}

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(text));
}

function planWithRegex(msg: string): { intent: string; extractedUrl: string | null } {
  const lc = msg.toLowerCase();

  if (matchesAny(lc, [/github\.com/, /\binspect\b.*\brepo\b/, /\breview\b.*\brepo\b/, /\bwhat.*(is|in)\b.*\brepo\b/, /\bgithub\s+repo\b/]))
    return { intent: "github_repo_review", extractedUrl: extractGitHubUrl(msg) ?? null };

  if (matchesAny(lc, [/\bcheck\s+(my\s+)?email\b/, /\btriage\b/, /\binbox\b/, /\bany\s+(new\s+)?(email|messages)\b/, /\brecruiter\s+email\b/, /\bunread\b/]))
    return { intent: "email_triage", extractedUrl: null };

  if (matchesAny(lc, [/\bdraft\s+a\s+reply\b/, /\bwrite\s+a\s+reply\b/, /\bcompose\b.*\bemail\b/, /\bdraft\b.*\bemail\b/, /\brespond\s+to\s+this\s+email\b/]))
    return { intent: "email_draft", extractedUrl: null };

  if (matchesAny(lc, [/\bcreate\s+a\s+task\b/, /\badd\s+(a\s+)?task\b/, /\bremind\s+me\s+to\b/, /\bset\s+a\s+reminder\b/, /^todo\b/, /\bfollow\s+up\b/]))
    return { intent: "task_create", extractedUrl: null };

  if (matchesAny(lc, [/\b(build|generate|create|write|tailor)\b.*\bresume\b/, /\b(cv|curriculum\s+vitae)\b/]))
    return { intent: "resume_builder", extractedUrl: null };

  if (matchesAny(lc, [/\bfind\s+jobs\b/, /\bjob\s+openings\b/, /\bsearch\b.*\bjobs\b/, /\broles\s+in\b/, /\bjob\s+listings\b/]))
    return { intent: "job_search", extractedUrl: null };

  if (matchesAny(lc, [/\bincome\b/, /\bmake\s+money\b/, /\bside\s+hustle\b/, /\bgigs?\b/, /\bf-1\s+jobs\b/, /\bearn\b.*\bstudent\b/]))
    return { intent: "income_opportunities", extractedUrl: null };

  if (matchesAny(lc, [/\bbrief\s+me\b/, /\bmorning\s+brief\b/, /\bwhat'?s\s+my\s+day\b/, /\bwhat'?s\s+today\b/, /\bmy\s+schedule\b/, /\bwhat\s+should\s+i\s+focus\b/]))
    return { intent: "morning_brief", extractedUrl: null };

  return { intent: "chat", extractedUrl: null };
}

// ── tool priority helper ──────────────────────────────────────────────────────

function bestTool(...candidates: string[]): string {
  return candidates.find((name) => hasTool(name)) ?? candidates[candidates.length - 1];
}

// ── intent → ExecutionPlan ────────────────────────────────────────────────────

function buildPlan(
  intent: string,
  confidence: number,
  msg: string,
  repoUrl: string | null,
  source: string
): ExecutionPlan {
  switch (intent) {

    case "github_repo_review": {
      const tool = bestTool("mcp.github.inspectRepo", "internal.github.inspectRepo");
      return {
        intent,
        confidence,
        steps: [{
          id: "step_1",
          tool,
          input: { message: msg, ...(repoUrl ? { repoUrl } : {}) },
          risk: "read",
          requiresApproval: false,
        }],
        reasoningSummary: `GitHub repo inspection via ${tool}.`,
      };
    }

    case "email_triage": {
      const searchTool = bestTool("mcp.gmail.search", "internal.email.search", "internal.email.placeholderSearch");
      return {
        intent,
        confidence,
        steps: [
          { id: "step_1", tool: searchTool, input: { query: "newer_than:7d", message: msg }, risk: "read", requiresApproval: false },
          { id: "step_2", tool: "internal.email.classifyImportant", input: { fromPreviousStep: "step_1" }, risk: "read", requiresApproval: false, dependsOn: ["step_1"] },
        ],
        reasoningSummary: `Email triage via ${searchTool} then classification.`,
      };
    }

    case "email_draft": {
      const draftTool = bestTool("mcp.gmail.createDraft", "internal.email.createDraft");
      return {
        intent,
        confidence,
        steps: [{ id: "step_1", tool: draftTool, input: { message: msg }, risk: "external_write", requiresApproval: true }],
        reasoningSummary: "Email draft queued for approval.",
      };
    }

    case "task_create":
      return {
        intent,
        confidence,
        steps: [{ id: "step_1", tool: "internal.tasks.create", input: { message: msg }, risk: "internal_write", requiresApproval: false }],
        reasoningSummary: "Task creation via existing task system.",
      };

    case "resume_builder":
      return {
        intent,
        confidence,
        steps: [{ id: "step_1", tool: "internal.resume.generate", input: { message: msg }, risk: "internal_write", requiresApproval: false }],
        reasoningSummary: "Resume draft generation.",
      };

    case "job_search":
      return {
        intent,
        confidence,
        steps: [{ id: "step_1", tool: "internal.chat.respond", input: { message: msg, _intent: "job_search" }, risk: "read", requiresApproval: false }],
        reasoningSummary: "Job search routed through Hermes → Athena.",
      };

    case "income_opportunities":
      return {
        intent,
        confidence,
        steps: [{ id: "step_1", tool: "internal.chat.respond", input: { message: msg, _intent: "income_opportunities" }, risk: "read", requiresApproval: false }],
        reasoningSummary: "Income brief routed through Tyche.",
      };

    case "morning_brief":
    case "email_schedule":
      return {
        intent,
        confidence,
        steps: [{ id: "step_1", tool: "internal.chat.respond", input: { message: msg, _intent: intent }, risk: "read", requiresApproval: false }],
        reasoningSummary: `${intent} routed through Hermes.`,
      };

    default:
      return {
        intent: "chat",
        confidence: 0.5,
        steps: [{ id: "step_1", tool: "internal.chat.respond", input: { message: msg }, risk: "read", requiresApproval: false }],
        reasoningSummary: "No specific execution intent — falling back to chat.",
      };
  }
}

// ── main export ───────────────────────────────────────────────────────────────

export async function plan(req: ExecutionRequest): Promise<ExecutionPlan> {
  const msg = req.message;

  // 1. Try LLM-based planning first (fast Groq call, 4s timeout)
  const llmResult = await planWithLLM(msg);

  if (llmResult && llmResult.confidence >= 0.6) {
    console.log(`[hermes-planner] LLM intent=${llmResult.intent} confidence=${llmResult.confidence}`);
    return buildPlan(llmResult.intent, llmResult.confidence, msg, llmResult.extractedUrl, req.source);
  }

  // 2. Fall back to regex rules
  const regexResult = planWithRegex(msg);
  console.log(`[hermes-planner] regex intent=${regexResult.intent} (LLM ${llmResult ? `low-confidence:${llmResult.confidence}` : "failed"})`);
  return buildPlan(regexResult.intent, 0.75, msg, regexResult.extractedUrl, req.source);
}
