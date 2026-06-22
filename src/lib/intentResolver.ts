/**
 * Intent Resolution Layer
 *
 * Runs before every LLM call. Loads structured context from the pre-built
 * chatContext block and resolves shorthand user messages to concrete intents
 * with a confidence score.
 *
 * Resolution priority (matches the spec):
 *   1. Active Project
 *   2. Active Tasks
 *   3. Pending Approvals
 *   4. Session Summary
 *   5. Recent Conversation
 *   6. Raw User Message
 *
 * Execute when confidence >= 80. Ask for clarification when < 80 AND the
 * message is ambiguous (not a clearly unrelated question).
 */

// ── Status vocabularies ──────────────────────────────────────────────────────

export const PROJECT_STATUSES = ["planning", "approved", "active", "blocked", "completed"] as const;
export const DEPLOYMENT_STATUSES = ["planned", "building", "deployed", "failed"] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

// ── Parsed context ───────────────────────────────────────────────────────────

export interface ParsedContextBlock {
  projectId: string | null;
  projectName: string | null;
  projectStatus: string | null;
  route: string | null;
  latestInstruction: string | null;
  tasks: Array<{ status: string; title: string }>;
  hasPendingApprovals: boolean;
  pendingApprovalCount: number;
  pendingApprovalSummaries: string[];
  sessionGoal: string | null;
  recentMessages: string[];
}

function emptyContext(): ParsedContextBlock {
  return {
    projectId: null, projectName: null, projectStatus: null,
    route: null, latestInstruction: null, tasks: [],
    hasPendingApprovals: false, pendingApprovalCount: 0,
    pendingApprovalSummaries: [], sessionGoal: null, recentMessages: [],
  };
}

/**
 * Parse the chatContext string produced by buildContextBlock() into structured
 * data the resolver can act on without additional DB round-trips.
 */
export function parseContextBlock(chatContext: string | undefined): ParsedContextBlock {
  if (!chatContext) return emptyContext();
  const lines = chatContext.split("\n");

  // PROJECT_ID: <id>
  const projectIdLine = lines.find((l) => l.startsWith("PROJECT_ID:"));
  const projectId = projectIdLine?.replace("PROJECT_ID:", "").trim() ?? null;

  // ACTIVE PROJECT: Name [status]
  const projectLine = lines.find((l) => l.startsWith("ACTIVE PROJECT:"));
  let projectName: string | null = null;
  let projectStatus: string | null = null;
  if (projectLine) {
    const m = projectLine.match(/^ACTIVE PROJECT:\s*(.+?)\s*\[([^\]]+)\]/);
    if (m) { projectName = m[1].trim(); projectStatus = m[2].trim(); }
  }

  // Route: /path
  const routeLine = lines.find((l) => l.startsWith("Route:"));
  const route = routeLine?.replace("Route:", "").trim() ?? null;

  // Last instruction: ...
  const instrLine = lines.find((l) => l.startsWith("Last instruction:"));
  const latestInstruction = instrLine?.replace("Last instruction:", "").trim() ?? null;

  // Tasks:
  //   - [status] title (next: ...)
  const tasks: Array<{ status: string; title: string }> = [];
  let inTasks = false;
  for (const line of lines) {
    if (line === "Tasks:") { inTasks = true; continue; }
    if (inTasks && line.match(/^\s+-\s+\[/)) {
      const m = line.match(/^\s+-\s+\[([^\]]+)\]\s+(.+)/);
      if (m) tasks.push({ status: m[1], title: m[2].split("(next:")[0].trim() });
    } else if (inTasks && !line.startsWith("  ")) {
      inTasks = false;
    }
  }

  // PENDING APPROVALS (N):
  //   - summary (id:xxx)
  const approvalHeader = lines.find((l) => /^PENDING APPROVALS \(\d+\):/.test(l));
  const pendingApprovalCount = approvalHeader
    ? parseInt(approvalHeader.match(/\((\d+)\)/)?.[1] ?? "0", 10)
    : 0;
  const hasPendingApprovals = pendingApprovalCount > 0;
  const pendingApprovalSummaries: string[] = [];
  if (hasPendingApprovals) {
    let inApprovals = false;
    for (const line of lines) {
      if (/^PENDING APPROVALS/.test(line)) { inApprovals = true; continue; }
      if (inApprovals && line.startsWith("  - ")) {
        pendingApprovalSummaries.push(line.replace("  - ", "").trim());
      } else if (inApprovals && line.trim() === "") {
        inApprovals = false;
      }
    }
  }

  // SESSION GOAL: ...
  const goalLine = lines.find((l) => l.startsWith("SESSION GOAL:"));
  const sessionGoal = goalLine?.replace("SESSION GOAL:", "").trim() ?? null;

  // RECENT CONVERSATION:
  //   [speaker]: message
  const recentMessages: string[] = [];
  let inRecent = false;
  for (const line of lines) {
    if (line === "RECENT CONVERSATION:") { inRecent = true; continue; }
    if (inRecent && /^\s+\[(osman|hermes)\]:/.test(line)) {
      recentMessages.push(line.trim());
    } else if (inRecent && line.trim() === "") {
      inRecent = false;
    }
  }

  return {
    projectId, projectName, projectStatus, route, latestInstruction,
    tasks, hasPendingApprovals, pendingApprovalCount, pendingApprovalSummaries,
    sessionGoal, recentMessages,
  };
}

// ── Intent types ─────────────────────────────────────────────────────────────

export type IntentType =
  | "approve"              // approve latest pending approval
  | "reject"               // reject latest pending approval
  | "resume"               // continue / check active project
  | "status"               // show task/deployment status
  | "instruction"          // apply instruction to active project
  | "subscribe_completion" // subscribe to done notification
  | "passthrough";         // no confident resolution — route to existing handlers

export interface ResolvedIntent {
  type: IntentType;
  confidence: number;       // 0–100
  projectId: string | null;
  projectName: string | null;
  instruction: string | null;        // for "instruction" type
  projectKeyword: string | null;     // for "continue X build" resolution
  clarificationQuestion: string | null;
  shouldAsk: boolean;       // true when confidence < 80 AND ambiguous
}

// ── Patterns ─────────────────────────────────────────────────────────────────

const APPROVE_RE =
  /^(approve|yes|confirmed?|go ahead|do it|looks good|ok|okay|sounds good|ship it|let'?s go|run it|yep|yup|affirmative|proceed)\.?!?$/i;

const REJECT_RE =
  /^(reject|cancel|no|nope|stop|don'?t|nevermind|never mind|scratch that|forget it|abort|nah|negative)\.?!?$/i;

// "continue", "continue watch build", "build it", "keep going", "next step"
const RESUME_RE =
  /^(continue|build it|keep going|next step|next|pick up|resume|go|move on|carry on)(?:\s+(.+?)(?:\s+(build|project|work))?)?\.?!?\??$/i;

const STATUS_RE =
  /\b(status|what'?s the status|where are we|what'?s left|progress|how'?s it going|is it (done|finished)|what'?s (done|complete|remaining|next)|any updates|what'?s (happening|going on))\b/i;

const SUBSCRIBE_RE =
  /\b(let me know|notify me|ping me|tell me|alert me|message me|update me)\s+when\s+(done|finished|complete|it'?s done|you'?re done|it completes)/i;

// Short imperative instructions that apply to the active project
const INSTRUCTION_VERB_RE =
  /^(remove|add|change|update|fix|make|set|show|hide|enable|disable|delete|move|rename|refactor|adjust|modify|edit|replace|include|exclude|implement|integrate|connect|style|design|deploy|test|rewrite|simplify|improve|clean|strip|drop|pull|switch|toggle|center|align|bold|wrap|limit|cap|filter|sort|paginate|animate|compress|cache|debounce|throttle)\b/i;

// Messages that are clearly about other domains — never intercept these
const OTHER_DOMAIN_RE =
  /\b(email|calendar|event|meeting|job|resume|finance|expense|income|budget|memory|brief|news|weather)\b/i;

// ── Resolver ─────────────────────────────────────────────────────────────────

function matchesProjectKeyword(keyword: string, projectName: string): boolean {
  const kws = keyword.toLowerCase().replace(/\s+(build|project|work|thing|app|site|page)$/i, "").split(/\s+/);
  const pws = projectName.toLowerCase().split(/\s+/);
  return kws.some((kw) => pws.some((pw) => pw.startsWith(kw) || kw.startsWith(pw)));
}

/**
 * Resolve the user's message to a typed intent with a confidence score.
 * Pure function — no DB calls. Takes the parsed context block.
 */
export function resolveIntent(text: string, ctx: ParsedContextBlock): ResolvedIntent {
  const t = text.trim();
  const hasProject = Boolean(ctx.projectId && ctx.projectName);
  const isOtherDomain = OTHER_DOMAIN_RE.test(t);

  // ── 1. Approve ─────────────────────────────────────────────────────────────
  if (APPROVE_RE.test(t)) {
    const confidence = ctx.hasPendingApprovals ? 100 : 70;
    return {
      type: "approve",
      confidence,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      instruction: null,
      projectKeyword: null,
      clarificationQuestion: confidence < 80
        ? "Approve what? There are no pending items right now."
        : null,
      shouldAsk: confidence < 80,
    };
  }

  // ── 2. Reject ──────────────────────────────────────────────────────────────
  if (REJECT_RE.test(t)) {
    const confidence = ctx.hasPendingApprovals ? 100 : 55;
    return {
      type: "reject",
      confidence,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      instruction: null,
      projectKeyword: null,
      clarificationQuestion: null,
      shouldAsk: false, // "no" with no pending just falls through gracefully
    };
  }

  // ── 3. Resume / Continue ──────────────────────────────────────────────────
  const resumeMatch = t.match(RESUME_RE);
  if (resumeMatch) {
    const keyword = resumeMatch[2]?.toLowerCase().trim() ?? null;

    if (!keyword) {
      // bare "continue", "build it", "keep going"
      const confidence = hasProject ? 92 : 35;
      return {
        type: "resume",
        confidence,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        instruction: null,
        projectKeyword: null,
        clarificationQuestion: confidence < 80 ? "Continue what? No active project right now." : null,
        shouldAsk: confidence < 80,
      };
    }

    // "continue [keyword]" — try to match against active project name
    if (hasProject && matchesProjectKeyword(keyword, ctx.projectName!)) {
      return {
        type: "resume",
        confidence: 95,
        projectId: ctx.projectId,
        projectName: ctx.projectName,
        instruction: null,
        projectKeyword: keyword,
        clarificationQuestion: null,
        shouldAsk: false,
      };
    }

    // keyword doesn't match active project — ask
    return {
      type: "resume",
      confidence: 50,
      projectId: null,
      projectName: null,
      instruction: null,
      projectKeyword: keyword,
      clarificationQuestion: hasProject
        ? `Did you mean continue working on "${ctx.projectName}"?`
        : `I don't have an active project matching "${keyword}". Which project?`,
      shouldAsk: true,
    };
  }

  // ── 4. Status ──────────────────────────────────────────────────────────────
  if (STATUS_RE.test(t)) {
    return {
      type: "status",
      confidence: hasProject ? 95 : 75,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      instruction: null,
      projectKeyword: null,
      clarificationQuestion: null,
      shouldAsk: false,
    };
  }

  // ── 5. Subscribe to completion ────────────────────────────────────────────
  if (SUBSCRIBE_RE.test(t)) {
    return {
      type: "subscribe_completion",
      confidence: 95,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      instruction: null,
      projectKeyword: null,
      clarificationQuestion: null,
      shouldAsk: false,
    };
  }

  // ── 6. Instruction (short imperative, active project, not other domain) ───
  if (hasProject && !isOtherDomain && INSTRUCTION_VERB_RE.test(t) && t.length <= 150) {
    return {
      type: "instruction",
      confidence: 85,
      projectId: ctx.projectId,
      projectName: ctx.projectName,
      instruction: t,
      projectKeyword: null,
      clarificationQuestion: null,
      shouldAsk: false,
    };
  }

  // ── 7. Passthrough ────────────────────────────────────────────────────────
  return {
    type: "passthrough",
    confidence: 50,
    projectId: ctx.projectId,
    projectName: ctx.projectName,
    instruction: null,
    projectKeyword: null,
    clarificationQuestion: null,
    shouldAsk: false,
  };
}
