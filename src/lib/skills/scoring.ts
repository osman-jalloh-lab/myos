import type { SkillEvaluationPrompt, SkillOutputContract } from "./types";

export type ScorableSkill = {
  id: string;
  name: string;
  description: string;
  ownerAgents: string[];
  tags: string[];
  triggerExamples: string[];
  requiredCapabilities: string[];
  validationStatus: "valid" | "missing_metadata" | "invalid";
  purpose?: string;
  whenToUse?: string[];
  whenNotToUse?: string[];
  strongSignals?: string[];
  weakSignals?: string[];
  negativeSignals?: string[];
  requiredContext?: string[];
  missingContextQuestions?: string[];
  outputContract?: SkillOutputContract;
  positiveExamples?: string[];
  negativeExamples?: string[];
  evaluationPrompts?: SkillEvaluationPrompt[];
  problemSolved?: string;
};

export type SkillScoreResult = {
  score: number;
  reason: string;
  matchedSignals: string[];
  negativeMatches: string[];
  missingContextQuestions: string[];
  specificity: number;
};

export const MIN_CONFIDENCE = 35;

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "you", "your", "are", "from", "into",
  "about", "what", "when", "where", "should", "could", "would", "need", "help", "please",
  "make", "does", "have", "has", "will", "just", "give", "tell", "show", "using", "can",
  "its", "it's", "how", "why", "who", "them", "they", "their", "our", "out", "got",
]);

const DOMAIN_ALIASES: Record<string, string[]> = {
  "i9-hr-compliance-specialist": [
    "i-9", "i9", "form i-9", "e-verify", "everify", "employment eligibility",
    "m-274", "section 1", "section 2", "section 3", "reverification", "remote document review",
    "tentative nonconfirmation", "tnc", "i-797", "i-94", "foreign passport", "ead",
    "permanent resident card", "employee choice of documents",
  ],
  "student-work-authorization-guard": [
    "f-1", "f1", "cpt", "opt", "stem opt", "student work authorization", "student employment",
    "sponsorship", "internship timing", "international office", "on-campus work", "off-campus work",
  ],
  "job-application-ops": [
    "job application", "resume", "cover letter", "ats", "interview", "recruiter",
    "application tracker", "fit score", "apply", "skip", "full-time", "internship",
  ],
  "grc-risk-role-screener": [
    "grc", "risk management", "soc 2", "soc2", "nist csf", "nist 800-53", "rmf",
    "iso 27001", "controls testing", "audit evidence", "compliance analyst", "security analyst",
  ],
  "it-help-desk-trainer": [
    "help desk", "service desk", "ticket", "troubleshoot", "technical support", "active directory",
    "vpn", "mfa", "windows login", "printer", "escalation", "tier 1", "tier 2",
  ],
  "writing-humanizer": [
    "rewrite", "humanize", "tone", "sound natural", "less robotic", "draft", "polish",
    "professional email", "text message", "my voice", "warmer", "direct",
  ],
  "personal-context-anchor": [
    "personal context", "my background", "my preferences", "remembered context", "my voice",
    "osman", "my certifications", "security+", "cysa+", "school planning", "career planning",
  ],
  "build-orchestrator": [
    "build", "implement", "fix", "upgrade", "code", "repo", "repository", "route", "api",
    "component", "provider setup", "model council", "run tests", "run build", "commit",
    "push", "deploy", "debug", "bug", "skills page", "wire this up", "add endpoint",
    "change the ui", "edit the app", "dashboard", "dashboard ui", "fix dashboard",
    "fix ui", "i-9 dashboard", "pull request", "typecheck", "lint",
  ],
  "local-worker-status": [
    "local worker", "local agent", "worker offline", "local agent not working",
    "agent not functioning", "ollama not reachable", "jobs stuck", "queue not processing",
    "why didn't it build", "why did this not route to the local worker", "worker heartbeat",
    "last heartbeat", "worker not claiming", "local execution loop", "nothing is building"
  ],
  "build-validation-runner": [
    "run tests", "run build", "run typecheck", "run lint", "prisma generate",
    "deployment readiness", "vercel status", "safe to push", "safe to deploy",
    "check vercel deployment", "vercel deployment", "deployment status",
    "check deployment", "verify validation", "validation after changes",
    "typecheck", "lint", "validate", "validation", "pipeline"
  ],
  "project-starter": [
    "start a project", "create a marketplace", "build a landing page", "design a system",
    "start from scratch", "scaffold this", "new project", "mvp", "architecture",
    "phases", "build an app", "make a website", "i want to build", "build a local task app",
    "cheapest stack", "one-page project"
  ],
  "repo-change-planner": [
    "plan the files", "files to inspect first", "expected edits", "rollback plan",
    "validation commands", "user approval checkpoint", "plan changes", "approval checkpoint",
    "inspect files", "before editing", "change plan"
  ],
};

const SPECIFIC_SKILLS = new Set([
  "i9-hr-compliance-specialist",
  "student-work-authorization-guard",
  "grc-risk-role-screener",
  "it-help-desk-trainer",
  "build-orchestrator",
  "local-worker-status",
  "project-starter",
  "repo-change-planner",
  "build-validation-runner",
]);

const BROAD_SUPPORT_SKILLS = new Set([
  "personal-context-anchor",
  "writing-humanizer",
  "job-application-ops",
]);

export function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9+#-]+/g, " ").replace(/\s+/g, " ").trim();
}

export function tokens(value: string): string[] {
  return normalize(value)
    .split(" ")
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
    .slice(0, 120);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function includesPhrase(haystack: string, phrase: string): boolean {
  const needle = normalize(phrase);
  if (needle.length <= 2) return false;
  if (haystack.includes(needle)) return true;
  const phraseWords = tokens(phrase);
  if (phraseWords.length <= 1) return false;
  const hayWords = new Set(tokens(haystack));
  return phraseWords.every((word) => hayWords.has(word));
}

function phraseHits(text: string, phrases: string[] | undefined, max = 6): string[] {
  return unique((phrases ?? []).filter((phrase) => includesPhrase(text, phrase))).slice(0, max);
}

function exampleHits(messageWords: string[], examples: string[] | undefined, max = 4): string[] {
  return unique((examples ?? []).filter((example) => {
    const exampleWords = tokens(example);
    if (exampleWords.length === 0) return false;
    const overlap = exampleWords.filter((word) => messageWords.includes(word)).length;
    const needed = Math.min(3, Math.max(1, Math.ceil(exampleWords.length * 0.38)));
    return overlap >= needed;
  })).slice(0, max);
}

function metadataWordHits(messageWords: string[], skill: ScorableSkill): string[] {
  const metadata = normalize([
    skill.name,
    skill.description,
    skill.purpose,
    skill.problemSolved,
    ...skill.tags,
    ...skill.requiredCapabilities,
  ].filter(Boolean).join(" "));
  return unique(messageWords.filter((word) => metadata.includes(word))).slice(0, 8);
}

function agentMatches(skill: ScorableSkill, agentName: string | null): { matches: boolean; exact: boolean } {
  if (!agentName) return { matches: false, exact: false };
  const agent = agentName.toLowerCase();
  const exact = skill.ownerAgents.some((owner) => owner.toLowerCase() === agent);
  return {
    exact,
    matches: exact || skill.ownerAgents.some((owner) => owner.toLowerCase() === "hermes"),
  };
}

function inferOutputIntents(text: string): string[] {
  const intents: string[] = [];
  if (/rewrite|humanize|less robotic|sound natural|tone|polish|tighten|soften/.test(text)) intents.push("rewrite");
  if (/draft|email|reply|message|text|follow[- ]?up|outreach/.test(text)) intents.push("draft");
  if (/score|fit|apply|maybe|skip|screen|evaluate|listing|role/.test(text)) intents.push("fit score");
  if (/ticket|note|escalation|customer|troubleshoot|steps taken/.test(text)) intents.push("ticket note");
  if (/checklist|next step|what should i do|deadline|timeline/.test(text)) intents.push("checklist");
  return intents;
}

function outputIntentHits(text: string, contract: SkillOutputContract | undefined): string[] {
  if (!contract) return [];
  const intents = inferOutputIntents(text);
  const contractText = normalize([contract.format, contract.tone, ...contract.mustInclude, ...contract.mustAvoid].filter(Boolean).join(" "));
  return intents.filter((intent) => includesPhrase(contractText, intent));
}

function ambiguousRequest(message: string, messageWords: string[], scoreBeforePenalty: number): boolean {
  const text = normalize(message);
  if (messageWords.length <= 4 && scoreBeforePenalty < 70) return true;
  if (/\b(this|it|that)\b/.test(text) && message.length < 140 && !/["':\n]/.test(message)) return true;
  return false;
}

export function isLocalWorkerDiagnosticRequest(message: string): boolean {
  const text = normalize(message);
  return /worker offline|local agent not functioning|local agent not working|local agent.*not functioning|local agent.*not working|agent not functioning|agent not working|ollama|jobs stuck|queue not processing|worker heartbeat|last heartbeat|worker not claiming|worker.*not.*claiming|local execution loop|nothing is building/.test(text)
    || /local worker.*(status|health|heartbeat|online|offline|stale|busy|reachable|not working|not functioning)|is the local worker/.test(text)
    || /why (didn t|did not).*(build|route)|why.*not route.*local worker|not route.*local worker/.test(text);
}

export function isBuildLikeRequest(message: string): boolean {
  const text = normalize(message);
  if (isLocalWorkerDiagnosticRequest(message)) return true;
  return /\b(build|implement|upgrade|code|repo|repository|route|api|component|deploy|debug|typecheck|lint)\b/.test(text)
    || /\b(run|npm)\s+(tests?|test|build|lint|typecheck|tsc)\b/.test(text)
    || /\b(commit|push)\b/.test(text)
    || /\bprovider setup|model council|local worker|add endpoint|wire this up|change the ui|edit the app|pull request\b/.test(text)
    || /\bfix\b.*\b(bug|page|route|api|component|dashboard|ui|app|build|test|tests|code|repo|skills)\b/.test(text)
    || /\b(add|create|make|write)\b.*\b(feature|route|endpoint|api|component|page|ui|app|skills|provider|model council)\b/.test(text);
}

export function taskTypeFor(message: string): string {
  const text = normalize(message);
  if (/\b(i-?9|form i 9|e-verify|everify|employment eligibility|m-274|section 2|section 3|reverification|tnc)\b/.test(text) && !/\b(build|implement|fix|page|ui|dashboard|api|component|app)\b/.test(text)) return "hr_compliance";
  if (/\b(f-?1|cpt|opt|stem opt|sponsorship|student work authorization|international office|on-campus|off-campus)\b/.test(text)) return "student_work_authorization";
  if (/help desk|service desk|ticket|troubleshoot|active directory|vpn|mfa|printer|windows login|cannot log in|can t log in|can't log in|login issue|tier 1|tier 2/.test(text)) return "it_support";
  if (/\bgrc\b|soc 2|soc2|nist|rmf|iso 27001|controls testing|audit evidence|risk management|compliance analyst/.test(text)) return "grc_role_screen";
  if (/resume|cover letter|interview|job application|ats|recruiter|internship|full-time|role|apply/.test(text)) return "career";
  if (/rewrite|humanize|tone|less robotic|sound natural|text message|email|reply|draft/.test(text)) return "communications";
  if (/calendar|meeting|schedule|deadline|appointment/.test(text)) return "scheduling";
  if (isLocalWorkerDiagnosticRequest(message)) return "local_worker_diagnostics";
  if (/check vercel|vercel deployment|deployment status|deploy status|latest deployment|production deployment|is (it|this) deployed|did (it|this) deploy|deployed yet/i.test(text)) return "deployment_status";
  if (/run tests|run build|run typecheck|run lint|prisma generate|safe to deploy|safe to push|deployment readiness|validate/i.test(text)) return "build_validation";
  if (/\b(plan the files|files to inspect first|rollback plan|validation commands|approval checkpoint|plan code changes|what files should i inspect|files should i inspect)\b/i.test(text)
    || /\b(plan|outline|map)\b.*\b(files|edits|changes|api route changes|route changes|rollback|validation commands)\b/i.test(text)) return "repo_change";
  if (/start a project|build a landing page|create a marketplace|design a system|scaffold this|mvp plan|architecture|start a new .* project|new .* project|i want to build (a|an) .* (app|website|project)|build (a|an) .* (app|website|project) from scratch|cheapest stack|what stack/i.test(text)) return "project_start";
  if (isBuildLikeRequest(message) || /build|app|site|frontend|component|feature/i.test(text)) return "build";
  return "general";
}

export function inferAgent(message: string, explicitAgent?: string | null): string | null {
  if (explicitAgent) return explicitAgent;
  const type = taskTypeFor(message);
  if (type === "hr_compliance") return "themis";
  if (type === "student_work_authorization" || type === "grc_role_screen" || type === "career") return "athena";
  if (type === "it_support") return "sophos";
  if (type === "communications") return "iris";
  if (type === "scheduling") return "kairos";
  if (type === "local_worker_diagnostics") return "argus";
  if (type === "build_validation") return "argus";
  if (type === "deployment_status") return "argus";
  if (type === "repo_change") return "prometheus";
  if (type === "project_start") return "prometheus";
  if (type === "build") return "prometheus";
  return "hermes";
}

export function scoreRegisteredSkill(skill: ScorableSkill, message: string, agentName: string | null): SkillScoreResult {
  const text = normalize(message);
  const words = tokens(message);
  const reasons: string[] = [];
  const matchedSignals: string[] = [];
  const negativeMatches: string[] = [];
  let score = 0;
  let specificity = 0;

  const agent = agentMatches(skill, agentName);
  if (agent.matches) {
    score += agent.exact ? 15 : 7;
    reasons.push(agent.exact ? `owned by ${agentName}` : "available to Hermes");
  } else if (agentName && !skill.ownerAgents.includes("hermes")) {
    score -= 5;
  }

  const aliasHits = phraseHits(text, DOMAIN_ALIASES[skill.id], 5);
  if (aliasHits.length) {
    score += aliasHits.length * 24;
    specificity += aliasHits.length * 4;
    matchedSignals.push(...aliasHits);
    reasons.push(`matched domain terms: ${aliasHits.join(", ")}`);
  }

  const strongHits = phraseHits(text, skill.strongSignals, 6);
  if (strongHits.length) {
    score += strongHits.length * 24;
    specificity += strongHits.length * 5;
    matchedSignals.push(...strongHits);
    reasons.push(`matched strong signals: ${strongHits.join(", ")}`);
  }

  const whenUseHits = phraseHits(text, skill.whenToUse, 4);
  if (whenUseHits.length) {
    score += whenUseHits.length * 14;
    specificity += whenUseHits.length * 2;
    matchedSignals.push(...whenUseHits);
    reasons.push("matched when-to-use guidance");
  }

  const positiveHits = exampleHits(words, skill.positiveExamples ?? skill.triggerExamples, 4);
  if (positiveHits.length) {
    score += positiveHits.length * 24;
    matchedSignals.push(...positiveHits);
    reasons.push("matched positive examples");
  }

  const weakHits = phraseHits(text, skill.weakSignals, 4);
  if (weakHits.length) {
    score += weakHits.length * 7;
    matchedSignals.push(...weakHits);
    reasons.push(`matched weak signals: ${weakHits.join(", ")}`);
  }

  const tagHits = phraseHits(text, skill.tags, 4);
  if (tagHits.length) {
    score += tagHits.length * 8;
    matchedSignals.push(...tagHits);
    reasons.push(`matched tags: ${tagHits.join(", ")}`);
  }

  const capabilityHits = phraseHits(text, skill.requiredCapabilities, 3);
  if (capabilityHits.length) {
    score += capabilityHits.length * 10;
    specificity += capabilityHits.length * 2;
    matchedSignals.push(...capabilityHits);
    reasons.push(`matched capabilities: ${capabilityHits.join(", ")}`);
  }

  const outputHits = outputIntentHits(text, skill.outputContract);
  if (outputHits.length) {
    score += Math.min(16, outputHits.length * 8);
    matchedSignals.push(...outputHits);
    reasons.push(`matched output intent: ${outputHits.join(", ")}`);
  }

  const metadataHits = metadataWordHits(words, skill);
  if (metadataHits.length) {
    score += Math.min(24, metadataHits.length * 4);
    reasons.push(`matched metadata words: ${metadataHits.slice(0, 5).join(", ")}`);
  }

  const notUseHits = phraseHits(text, skill.whenNotToUse, 4);
  const negativeHits = phraseHits(text, skill.negativeSignals, 5);
  const negativeExampleHits = exampleHits(words, skill.negativeExamples, 3);
  if (notUseHits.length || negativeHits.length || negativeExampleHits.length) {
    const allNegative = unique([...notUseHits, ...negativeHits, ...negativeExampleHits]).slice(0, 8);
    negativeMatches.push(...allNegative);
    score -= notUseHits.length * 16 + negativeHits.length * 18 + negativeExampleHits.length * 10;
    reasons.push(`negative signals: ${allNegative.join(", ")}`);
  }

  if (SPECIFIC_SKILLS.has(skill.id) && (aliasHits.length || strongHits.length)) {
    score += 15;
    specificity += 6;
    reasons.push("specific skill boost");
  }

  if (BROAD_SUPPORT_SKILLS.has(skill.id) && !aliasHits.length && strongHits.length <= 1 && /(i-?9|e-verify|grc|soc 2|nist|cpt|opt|f-?1|vpn|active directory|ticket|local worker|local agent|provider setup|model council|run tests|run build)/i.test(message)) {
    score -= 8;
    reasons.push("more specific skill likely applies");
  }

  if (ambiguousRequest(message, words, score)) {
    score -= 4;
    reasons.push("request is missing context");
  }

  if (!matchedSignals.length && metadataHits.length <= 1) {
    score -= 8;
    reasons.push("low overlap with skill purpose");
  }

  if (skill.validationStatus === "missing_metadata") score -= 8;
  if (skill.validationStatus === "invalid") score -= 30;

  const bounded = Math.max(0, Math.min(100, Math.round(score)));
  const missingContextQuestions = bounded >= MIN_CONFIDENCE && ambiguousRequest(message, words, score)
    ? (skill.missingContextQuestions ?? []).slice(0, 3)
    : [];

  return {
    score: bounded,
    reason: reasons.length ? reasons.join("; ") : "No deterministic v2 metadata match above the routing threshold.",
    matchedSignals: unique(matchedSignals).slice(0, 10),
    negativeMatches: unique(negativeMatches).slice(0, 10),
    missingContextQuestions,
    specificity,
  };
}
