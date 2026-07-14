export type WorkRequestClass =
  | "conversation"
  | "information"
  | "small_action"
  | "project"
  | "council_project"
  | "capability_question";

export type ConversationContext = {
  activeProjectId?: string | null;
  latestPlanId?: string | null;
};

export type RepoContext = {
  repository?: string | null;
  activeProjectId?: string | null;
};

export type WorkRequestClassification = {
  class: WorkRequestClass;
  confidence: number;
  reason: string;
  isNewProject: boolean;
  isExistingProjectChange: boolean;
  requiresCouncil: boolean;
  estimatedScope: "tiny" | "small" | "medium" | "large";
  detectedProjectId?: string;
  detectedRepository?: string;
};

const SOCIAL_PATTERNS = [
  /^(hi|hey|hello|yo|good morning|good afternoon|good evening)\b/i,
  /^(thanks|thank you|cool|nice|awesome|ok|okay|sounds good)\b/i,
  /^(how are you|what did you do today)\b/i,
];

const INFO_PATTERNS = [
  /^(explain|describe|define|tell me about|help me understand)\b/i,
  /^(what|why|how|who|when|where|is|are|can|could|should)\b(?!.*\b(build|create|add|change|fix|run|deploy|implement)\b)/i,
];

const CAPABILITY_PATTERNS = [
  /\b(can you|are you able to|do you have|what can you)\b.*\b(build|deploy|run|access|use|connect|capability|skill|tool)\b/i,
  /\b(worker|runtime|tools?|skills?|capabilities|setup)\b.*\b(status|available|ready|connected)\b/i,
];

const CONTINUATION_PATTERNS = [
  /^(go ahead|approve|approved|continue|use option (one|two|three|1|2|3)|make it|deploy it|fix what qa found)\b/i,
  /^(change|add|make|remove|fix)\b.*\b(it|that|this)\b/i,
];

const SMALL_ACTION_PATTERNS = [
  /^run\s+(typecheck|tsc|lint|test|build|checks?)\b/i,
  /\b(check deployment status|preview url|is it deployed)\b/i,
  /\b(change|fix|edit|update|remove|hide)\b.*\b(button|copy|typo|heading|color|label|text|contact page|section)\b/i,
  /\b(add|update)\b.*\b(class|style|margin|padding|copy)\b/i,
];

const PROJECT_PATTERNS = [
  /\b(build|create|make|scaffold|implement|add)\b.*\b(website|web app|app|marketplace|dashboard|portal|platform|control plane|multiple pages|complete|full)\b/i,
  /\b(new|complete|full)\b.*\b(project|site|app|dashboard|feature|section)\b/i,
  /\b(build me|create a|create an|build a|build an)\b/i,
];

const COUNCIL_PATTERNS = [
  /\b(council|debate|compare directions|multiple options|architectural directions)\b/i,
  /\b(authentication|auth|schema|database|infrastructure|deployment|production|payments|legal|medical|compliance|multi-domain|enterprise)\b/i,
  /\b(major|large|high-risk|expensive|architecture|rewrite|migration)\b/i,
];

function scopeFor(message: string): WorkRequestClassification["estimatedScope"] {
  const text = message.toLowerCase().replace(/\bdo not\b[^.]{0,160}\b(?:deploy|production data)\b/g, "");
  if (COUNCIL_PATTERNS.some((pattern) => pattern.test(text))) return "large";
  if (/\b(complete|full|marketplace|platform|dashboard|website|web app|multiple pages)\b/.test(text)) return "medium";
  if (SMALL_ACTION_PATTERNS.some((pattern) => pattern.test(text))) return "small";
  return "tiny";
}

function projectIdFromMessage(message: string): string | undefined {
  return message.match(/\b(?:project|projectId)[:#\s]+([a-z0-9_-]{8,})\b/i)?.[1];
}

function repositoryFromMessage(message: string): string | undefined {
  return message.match(/https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/)?.[0];
}

export async function classifyWorkRequest(input: {
  message: string;
  targetAgent?: string | null;
  conversationContext?: ConversationContext;
  repoContext?: RepoContext | null;
}): Promise<WorkRequestClassification> {
  const message = input.message.trim();
  const detectedProjectId = projectIdFromMessage(message) ?? input.conversationContext?.activeProjectId ?? input.repoContext?.activeProjectId ?? undefined;
  const detectedRepository = repositoryFromMessage(message) ?? input.repoContext?.repository ?? undefined;

  if (!message) {
    return { class: "conversation", confidence: 1, reason: "Empty chat message.", isNewProject: false, isExistingProjectChange: false, requiresCouncil: false, estimatedScope: "tiny", detectedProjectId, detectedRepository };
  }
  if (input.targetAgent) {
    return { class: "conversation", confidence: 0.92, reason: "Private agent office messages remain conversational.", isNewProject: false, isExistingProjectChange: false, requiresCouncil: false, estimatedScope: "tiny", detectedProjectId, detectedRepository };
  }
  if (SOCIAL_PATTERNS.some((pattern) => pattern.test(message))) {
    return { class: "conversation", confidence: 0.98, reason: "Greeting or social message.", isNewProject: false, isExistingProjectChange: false, requiresCouncil: false, estimatedScope: "tiny", detectedProjectId, detectedRepository };
  }
  if (CAPABILITY_PATTERNS.some((pattern) => pattern.test(message))) {
    return { class: "capability_question", confidence: 0.88, reason: "Capability/status question.", isNewProject: false, isExistingProjectChange: false, requiresCouncil: false, estimatedScope: "tiny", detectedProjectId, detectedRepository };
  }
  if (INFO_PATTERNS.some((pattern) => pattern.test(message))) {
    return { class: "information", confidence: 0.9, reason: "Informational request.", isNewProject: false, isExistingProjectChange: false, requiresCouncil: false, estimatedScope: "tiny", detectedProjectId, detectedRepository };
  }

  const isContinuation = Boolean(detectedProjectId) && CONTINUATION_PATTERNS.some((pattern) => pattern.test(message));
  const isSmall = SMALL_ACTION_PATTERNS.some((pattern) => pattern.test(message));
  const isProject = PROJECT_PATTERNS.some((pattern) => pattern.test(message));
  const riskText = message.replace(/\bdo not\b[^.]{0,160}\b(?:deploy|production data)\b/gi, "");
  const requiresCouncil = COUNCIL_PATTERNS.some((pattern) => pattern.test(riskText));
  const estimatedScope = scopeFor(message);

  if (isContinuation || (detectedProjectId && isSmall)) {
    return {
      class: "small_action",
      confidence: 0.84,
      reason: "Follow-up or bounded change against an active project.",
      isNewProject: false,
      isExistingProjectChange: true,
      requiresCouncil: false,
      estimatedScope: isSmall ? "small" : "tiny",
      detectedProjectId,
      detectedRepository,
    };
  }
  if (requiresCouncil && isProject) {
    return { class: "council_project", confidence: 0.88, reason: "Project-sized work with Council-triggering risk or ambiguity.", isNewProject: true, isExistingProjectChange: false, requiresCouncil: true, estimatedScope: "large", detectedProjectId, detectedRepository };
  }
  if (isProject && estimatedScope !== "small") {
    return { class: "project", confidence: 0.86, reason: "Project-sized build request.", isNewProject: !detectedProjectId, isExistingProjectChange: Boolean(detectedProjectId), requiresCouncil: false, estimatedScope, detectedProjectId, detectedRepository };
  }
  if (isSmall) {
    return { class: "small_action", confidence: 0.87, reason: "Small bounded action.", isNewProject: false, isExistingProjectChange: Boolean(detectedProjectId), requiresCouncil: false, estimatedScope: "small", detectedProjectId, detectedRepository };
  }

  return { class: "conversation", confidence: 0.55, reason: "No deterministic project or action trigger matched.", isNewProject: false, isExistingProjectChange: false, requiresCouncil: false, estimatedScope: "tiny", detectedProjectId, detectedRepository };
}
