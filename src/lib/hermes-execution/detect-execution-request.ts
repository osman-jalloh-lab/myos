// Hermes Execution Layer — isExecutionRequest
// Fast pre-filter: catches action-style messages and routes them to the LLM planner.
// The LLM planner does the precise classification — this just decides whether to
// even try. Keep it broad so the LLM gets a chance on anything action-oriented.

// Patterns that strongly suggest a conversational question (skip execution layer)
const CONVERSATIONAL_PATTERNS = [
  /^(what|why|how|who|when|where|is|are|can|could|would|should|do|does|did)\s+(?!you\s+(?:create|make|find|check|build|draft|generate|write|inspect|remind|add|scan|search|show|run|get|fetch|triage))/i,
  /^(explain|tell me about|describe|define|help me understand)\b/i,
  /^(hi|hey|hello|good morning|good afternoon|good evening|thanks|thank you|ok|okay|cool|great|nice|awesome|sounds good)\b/i,
];

// Patterns that strongly suggest an action request (always try execution layer)
const ACTION_PATTERNS = [
  // Explicit action verbs at the start
  /^(check|find|search|create|make|add|build|generate|write|draft|inspect|remind|scan|show|run|get|fetch|triage|compose|review|tailor|give me|pull up|look up|look at|implement|scaffold|deploy|continue|remove|delete|refactor|rewrite|update|edit|modify)\b/i,
  // Build/feature triggers (these are always execution-layer)
  /\b(build|create|add)\s+(the\s+)?\/\S+\s+(route|page|endpoint)\b/i,
  /\bcontinue\s+the\s+\S+\s+build\b/i,
  /build\s+(chrono|watch|market|archive|website|app|site|feature|page|dashboard)\b/i,
  /\b(remove|strip|hide|enable|disable)\s+(pricing|header|footer|nav|sidebar)\b/i,
  // Run command triggers
  /^run\s+(build|test|lint|typecheck|tsc|check)\b/i,
  /\bnpm\s+run\b/i,
  // Deploy triggers
  /\b(deploy|deployment\s+status|is\s+it\s+(live|deployed))\b/i,
  // Tool-specific triggers
  /github\.com\//i,
  // Job tracker sync phrases
  /\b(update|sync|check|scan).*(job\s+tracker|application|tracker)/i,
  /\b(job\s+tracker|application\s+status).*(email|inbox|update)/i,
  // brief/schedule/calendar/today are handled better by the normal chat path (CONTEXT_MATCHERS)
  /\b(inbox|email|resume|cv|task|reminder|todo|to-do|job|jobs|income)\b/i,
  // Natural delegation phrases
  /\b(i want you to|can you|please|go ahead and)\s+(check|find|create|make|draft|generate|build|write|inspect|scan|search|show|get|fetch|pull|look|run|deploy)\b/i,
  // "use X" patterns
  /\buse\s+(claude|groq|gpt|local|ollama)\b/i,
];

export function isExecutionRequest(message: string): boolean {
  if (!message?.trim()) return false;
  const trimmed = message.trim();

  // Skip very short messages (likely greetings or confirmations)
  if (trimmed.length < 6) return false;

  // If it matches a conversational opener, skip
  if (CONVERSATIONAL_PATTERNS.some((p) => p.test(trimmed))) return false;

  // If it matches an action pattern, route through execution layer
  return ACTION_PATTERNS.some((p) => p.test(trimmed));
}

export function shouldUseExecutionLayer(message: string): boolean {
  return isExecutionRequest(message);
}
