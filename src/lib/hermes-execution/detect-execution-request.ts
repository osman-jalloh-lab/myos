// Hermes Execution Layer — isExecutionRequest
// Determines whether a chat message should be routed through the execution layer
// instead of (or in addition to) the standard Hermes routeMessage() path.
// Called before routeMessage(); if returns false, normal chat flow continues.

const EXECUTION_PATTERNS = [
  // GitHub
  /https?:\/\/(?:www\.)?github\.com\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+/,
  /\b(inspect|review|scan|check|look at)\s+(this\s+)?repo\b/i,
  /\bgithub\s+repo\b/i,
  /\bwhat('?s| is) (in\s+)?this\s+repo\b/i,

  // Email triage
  /\bcheck\s+(my\s+)?email\b/i,
  /\btriage\s+(my\s+)?(inbox|email)\b/i,
  /\bwhat'?s\s+in\s+my\s+inbox\b/i,
  /\bany\s+(new\s+)?(email|messages)\b/i,
  /\bcheck\s+(my\s+)?inbox\b/i,
  /\bjob\s+follow.?up\s+email\b/i,
  /\brecruiter\s+email\b/i,

  // Email draft
  /\bdraft\s+a\s+reply\b/i,
  /\bwrite\s+a\s+reply\b/i,
  /\bcompose\s+(an?\s+)?email\b/i,
  /\bdraft\s+(an?\s+)?email\b/i,
  /\brespond\s+to\s+this\s+email\b/i,

  // Task creation
  /\bcreate\s+a\s+task\b/i,
  /\badd\s+(a\s+)?task\b/i,
  /\bremind\s+me\s+to\b/i,
  /\bset\s+a\s+reminder\b/i,
  /^todo\b/i,

  // Resume
  /\b(build|generate|create|write)\s+(me\s+)?a\s+resume\b/i,
  /\btailor\s+my\s+resume\b/i,
  /\b(cv|curriculum\s+vitae)\b/i,
];

/**
 * Returns true if this message should be handled by the execution layer.
 * The execution layer is only active when HERMES_EXECUTION_ENABLED=true.
 */
export function isExecutionRequest(message: string): boolean {
  if (!message?.trim()) return false;
  return EXECUTION_PATTERNS.some((p) => p.test(message));
}

/**
 * Convenience guard that checks both the feature flag and pattern match.
 * Use this in route handlers so the flag is the single on/off switch.
 */
export function shouldUseExecutionLayer(message: string): boolean {
  if (process.env.HERMES_EXECUTION_ENABLED !== "true") return false;
  return isExecutionRequest(message);
}
