// Hermes Execution Layer — planner
// LLM-first intent detection using Groq (fast, cheap).
// Falls back to regex rules if the LLM call fails or times out.
// No new DB tables, no new API keys — uses existing callModel() + GROQ_API_KEY.

import type { ExecutionRequest, ExecutionPlan, ExecutionStep } from "./types";
import { hasTool } from "./tool-registry";

// ── tool catalog (shown to the LLM) ──────────────────────────────────────────

const TOOL_CATALOG = `
Tools available in Parawi/MyOS:
- build_app: Build or rebuild the entire app, site, or a major section. Trigger: "build the app", "build the site", "build hermes", "build myos", "rebuild the whole thing", "build the full app"
- build_page: Build or create a specific page or route. Trigger: "build a page", "build the /X page", "build a simple /X page", "create a /X route", "add a /X page", "make the /X page", "build a simple page called X"
- continue_build: Continue or resume an in-progress build. Trigger: "continue the build", "continue building", "resume the build", "keep building", "continue where you left off", "pick up the build"
- modify_feature: Modify, update, or refactor an existing feature or component. Trigger: "modify the X", "update the X feature", "change the X component", "edit the X page", "refactor X", "fix the X section", "remove X from the page"
- run_validation: Run typecheck, lint, tests, or full validation suite. Trigger: "run validation", "validate the build", "run all checks", "run typecheck and lint", "check everything", "run all tests"
- build_feature: Build, create, or implement any code feature (fallback for build intents not matched above). Trigger: "implement X", "build X feature", "add a button", "generate the X component", "write X code"
- repo_inspect: Inspect the Hermes OS repo structure. Trigger: "what's in the repo", "show me the file structure", "what routes exist", "inspect the codebase"
- run_command: Run a single build/typecheck/lint command. Trigger: "run build", "typecheck", "run lint", "npm run build", "check types", "run tests"
- deploy: Check or trigger Vercel deployment. Trigger: "deploy", "check deployment", "deployment status", "is it deployed", "preview URL"
- github_repo_review: Inspect any GitHub repo with Skill Scout. Trigger: GitHub URL, "what is this repo", "inspect", "scan repo", "look at this project"
- email_triage: Check/triage inbox for action-needed emails. Trigger: "check my email", "inbox", "any emails", "recruiter emails", "unread", "follow-ups"
- email_draft: Draft an email (held for approval, never auto-sent). Trigger: "draft a reply", "write an email", "compose", "respond to"
- task_create: Create a task, reminder, or to-do. Trigger: "remind me", "create a task", "add a task", "todo", "follow up", "don't let me forget"
- resume_builder: Generate or tailor a resume for a specific role. Trigger: "resume", "CV", "tailor my resume", "resume for [role]"
- job_search: Search for job openings. Trigger: "find jobs", "job openings", "search for [role] jobs", "what jobs are available", "roles in [city/field]"
- morning_brief: Get the day's brief — schedule, tasks, priorities. Trigger: "brief me", "what's my day", "morning brief", "what's on today", "what should I focus on"
- income_opportunities: F-1-safe income ideas — freelance, passive income, campus jobs. Trigger: "income", "make money", "side hustle", "gigs", "F-1 jobs", "earn as a student"
- email_schedule: Check or manage calendar events. Trigger: "my schedule", "what's today", "calendar", "meetings", "what's coming up"
- job_tracker_sync: Scan inbox for job application emails and update the job tracker. Trigger: "update my job tracker", "check email for job updates", "scan email for applications", "look at my email and update tracker", "received applications", "application status from email"
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

  // build_page — specific page/route creation (highest priority among build intents)
  if (matchesAny(lc, [
    /build\s+a?\s*simple\s+\/\S+\s*(page|route)?/,
    /build\s+(the\s+)?\/\S+\s*(page|route)/,
    /\b(create|add|make)\s+(a\s+)?(simple\s+)?\/\S+\s*(page|route)/,
    /\b(build|create|add|make)\s+(a|an|the)?\s*(simple\s+)?(new\s+)?(page|route)\b/,
  ]))
    return { intent: "build_page", extractedUrl: null };

  // build_app — full app or major section build
  if (matchesAny(lc, [
    /build\s+(the\s+)?(whole\s+)?(app|site|website|hermes|myos|full\s+app)\b/,
    /rebuild\s+(the\s+)?(app|site|website|everything|whole\s+thing)\b/,
    /build\s+hermes\b/,
  ]))
    return { intent: "build_app", extractedUrl: null };

  // continue_build — resume in-progress work
  if (matchesAny(lc, [
    /\bcontinue\s+(the\s+)?(build|building)\b/,
    /\bresume\s+(the\s+)?(build|building)\b/,
    /\bkeep\s+building\b/,
    /\bcontinue\s+where\s+you\s+left\s+off\b/,
    /\bpick\s+up\s+(the\s+)?build\b/,
  ]))
    return { intent: "continue_build", extractedUrl: null };

  // modify_feature — edit/update/refactor existing code
  if (matchesAny(lc, [
    /\b(modify|refactor|rewrite|update|edit)\s+(the\s+)?\S+\s*(feature|component|page|section|route)\b/,
    /\b(remove|delete|strip|hide|disable)\s+(the\s+)?(pricing|header|footer|nav|sidebar|section|component)\b/,
    /\bfix\s+the\s+\S+\s*(section|component|page)\b/,
  ]))
    return { intent: "modify_feature", extractedUrl: null };

  // run_validation — full validation suite
  if (matchesAny(lc, [
    /\brun\s+validation\b/,
    /\bvalidate\s+(the\s+)?build\b/,
    /\brun\s+all\s+(checks|tests)\b/,
    /\bcheck\s+everything\b/,
    /\brun\s+typecheck\s+and\s+lint\b/,
  ]))
    return { intent: "run_validation", extractedUrl: null };

  // Build feature — general fallback for remaining build patterns
  if (matchesAny(lc, [
    /\b(build|create|add|implement|write|make|generate)\b.*(page|route|feature|component|view|section|widget|button|form|modal|dashboard|endpoint|api|table|chart|list|card)/,
    /\b(create|add|build)\s+the\s+\/\S+\s+route\b/,
    /\bcontinue\s+the\s+\S+\s+build\b/,
    /build\s+(chrono|watch|market|archive|project|the\s+website|the\s+app|the\s+site)\b/,
    /\b(scaffold|prototype|wire up|set up|spin up)\s+(a|an|the)?\s+(page|route|feature|view|component)\b/,
  ]))
    return { intent: "build_feature", extractedUrl: null };

  // Run command
  if (matchesAny(lc, [/^run\s+(build|test|lint|typecheck|tsc|check)\b/, /\bnpm\s+run\b/, /\brun\s+npm\b/, /\btypecheck\b/, /\brun\s+lint\b/, /\brun\s+build\b/]))
    return { intent: "run_command", extractedUrl: null };

  // Deploy / deployment status
  if (matchesAny(lc, [/\bdeploy\b(?!\s+(to\s+)?github)/, /\bdeployment\s+status\b/, /\bpreview\s+url\b/, /\bis\s+it\s+(live|deployed)\b/]))
    return { intent: "deploy", extractedUrl: null };

  // Repo inspect
  if (matchesAny(lc, [/\binspect\s+(the\s+)?(repo|codebase|project)\b/, /\bwhat('s| is)\s+in\s+the\s+repo\b/, /\bshow\s+(me\s+)?the\s+file\s+structure\b/, /\bwhat\s+routes\s+exist\b/]))
    return { intent: "repo_inspect", extractedUrl: null };

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

  if (matchesAny(lc, [/update.*job\s+tracker/, /job\s+tracker.*update/, /check.*email.*job/, /email.*job.*update/, /scan.*email.*appli/, /application.*status.*email/, /email.*application.*status/, /received.*appli/, /look.*email.*tracker/]))
    return { intent: "job_tracker_sync", extractedUrl: null };

  if (matchesAny(lc, [/\bincome\b/, /\bmake\s+money\b/, /\bside\s+hustle\b/, /\bgigs?\b/, /\bf-1\s+jobs\b/, /\bearn\b.*\bstudent\b/]))
    return { intent: "income_opportunities", extractedUrl: null };

  if (matchesAny(lc, [/\bbrief\s+me\b/, /\bmorning\s+brief\b/, /\bwhat'?s\s+my\s+day\b/, /\bwhat'?s\s+today\b/, /\bmy\s+schedule\b/, /\bwhat\s+should\s+i\s+focus\b/]))
    return { intent: "morning_brief", extractedUrl: null };

  return { intent: "chat", extractedUrl: null };
}

function planWithCertainRegex(msg: string): { intent: string; extractedUrl: string | null; confidence: number } | null {
  const lc = msg.toLowerCase();
  const regexResult = planWithRegex(msg);

  if (["build_page", "build_app", "continue_build", "modify_feature", "build_feature"].includes(regexResult.intent)) {
    return { ...regexResult, confidence: 0.99 };
  }
  if (extractGitHubUrl(msg)) {
    return { intent: "github_repo_review", extractedUrl: extractGitHubUrl(msg) ?? null, confidence: 0.99 };
  }
  if (/\bnpm\s+run\s+\S+/.test(lc) || /^run\s+(build|test|lint|typecheck|tsc|check)\b/.test(lc)) {
    return { ...regexResult, confidence: 0.98 };
  }
  if (/\bremind\s+me\s+to\b/.test(lc)) {
    return { ...regexResult, confidence: 0.98 };
  }
  if (/\bdeploy\b(?!\s+(to\s+)?github)|\bdeployment\s+status\b|\bpreview\s+url\b|\bis\s+it\s+(live|deployed)\b/.test(lc)) {
    return { ...regexResult, confidence: 0.98 };
  }

  return null;
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

    case "build_page":
    case "build_app":
    case "continue_build":
      return {
        intent,
        confidence,
        steps: [{
          id: "step_1",
          tool: "internal.code.buildAndPush",
          input: { message: msg },
          risk: "internal_write",
          requiresApproval: false,
        }],
        reasoningSummary: "Generate, commit, and open PR via internal.code.buildAndPush.",
      };

    case "modify_feature":
      return {
        intent,
        confidence,
        steps: [{
          id: "step_1",
          tool: "internal.code.buildAndPush",
          input: { message: msg },
          risk: "internal_write",
          requiresApproval: false,
        }],
        reasoningSummary: "Modify existing feature — generate diff, commit, PR.",
      };

    case "run_validation":
      return {
        intent,
        confidence,
        steps: [
          {
            id: "step_1",
            tool: "internal.code.commandRun",
            input: { message: "run typecheck" },
            risk: "read",
            requiresApproval: false,
          },
          {
            id: "step_2",
            tool: "internal.code.commandRun",
            input: { message: "run lint", dependsOn: ["step_1"] },
            risk: "read",
            requiresApproval: false,
            dependsOn: ["step_1"],
          },
        ],
        reasoningSummary: "Run typecheck then lint as validation suite.",
      };

    case "build_feature":
      return {
        intent,
        confidence,
        steps: [{
          id: "step_1",
          tool: "internal.code.buildFeature",
          input: { message: msg },
          risk: "internal_write",
          requiresApproval: false,
        }],
        reasoningSummary: "Generate, commit, and PR a feature via GitHub API.",
      };

    case "repo_inspect":
      return {
        intent,
        confidence,
        steps: [{
          id: "step_1",
          tool: "internal.repo.inspect",
          input: { message: msg },
          risk: "read",
          requiresApproval: false,
        }],
        reasoningSummary: "Inspect Hermes OS repo structure via GitHub API.",
      };

    case "run_command":
      return {
        intent,
        confidence,
        steps: [{
          id: "step_1",
          tool: "internal.code.commandRun",
          input: { message: msg },
          risk: "read",
          requiresApproval: false,
        }],
        reasoningSummary: "Run build/typecheck/lint command.",
      };

    case "deploy":
      return {
        intent,
        confidence,
        steps: [{
          id: "step_1",
          tool: "internal.deploy.status",
          input: { message: msg },
          risk: "read",
          requiresApproval: false,
        }],
        reasoningSummary: "Check or trigger Vercel deployment.",
      };

    case "github_repo_review": {
      const tool = bestTool("internal.skillScout.inspectRepo", "mcp.github.inspectRepo", "internal.github.inspectRepo");
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
        reasoningSummary: `GitHub repo Skill Scout via ${tool}.`,
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

    case "job_tracker_sync":
      return {
        intent,
        confidence,
        steps: [{ id: "step_1", tool: "internal.jobs.updateFromEmail", input: { message: msg }, risk: "read", requiresApproval: false }],
        reasoningSummary: "Scan inbox for application-status emails, queue tracker updates for approval.",
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

  const deterministic = planWithCertainRegex(msg);
  if (deterministic) {
    return buildPlan(deterministic.intent, deterministic.confidence, msg, deterministic.extractedUrl, req.source);
  }

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
