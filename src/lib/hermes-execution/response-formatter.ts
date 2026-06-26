import type { ExecutionResponse } from "./types";

function stripStackLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !/^\s*at\s+/.test(line) && !/webpack-internal|node_modules|\.next[\\/]/i.test(line))
    .join("\n");
}

export function redactInternalDetails(text: string): string {
  return stripStackLines(text)
    .replace(/\binternal\.[a-zA-Z0-9_.-]+/g, "the internal tool")
    .replace(/\b[a-zA-Z0-9_-]{8}-[a-zA-Z0-9_-]{4}-[a-zA-Z0-9_-]{4}-[a-zA-Z0-9_-]{4}-[a-zA-Z0-9_-]{12}\b/g, "the task")
    .replace(/[A-Z]:\\[^\n`"]+/g, "the local project folder")
    .replace(/\/(?:Users|home|var|tmp)\/[^\n`"]+/g, "the local project folder")
    .replace(/\{[\s\S]{0,1200}\}/g, (match) => match.includes('"') || match.includes(":") ? "the internal result" : match)
    .replace(/\s+\n/g, "\n")
    .trim();
}

export function userSafeFailureMessage(message: string): string {
  const cleaned = redactInternalDetails(message);
  if (/ByteString|65279|BOM|zero-width/i.test(cleaned)) {
    return "I could not complete that request because the input contained a hidden character. I can retry it with the cleaned value.";
  }
  if (/not registered|not available yet/i.test(cleaned)) {
    return "I could not complete that request because the needed capability is not connected yet.";
  }
  if (/rate[- ]?limited/i.test(cleaned)) {
    return "GitHub rate-limited the request. Try again later or add a clean GitHub token.";
  }
  if (/unauthorized|forbidden|401|403/i.test(cleaned)) {
    return "I could not access the required service with the current credentials.";
  }
  if (/not found|404/i.test(cleaned)) {
    return "I could not find the requested resource.";
  }
  return cleaned || "I could not complete that request. Check Mission Control for technical details.";
}

export function formatExecutionResponseForUser(response: ExecutionResponse): ExecutionResponse {
  return {
    ...response,
    answer: response.status === "failed" || response.status === "blocked"
      ? userSafeFailureMessage(response.answer)
      : redactInternalDetails(response.answer),
    toolCalls: response.toolCalls.map((call) => ({
      id: call.id,
      tool: "internal",
      status: call.status,
      startedAt: call.startedAt,
      completedAt: call.completedAt,
      error: call.error ? userSafeFailureMessage(call.error) : undefined,
    })),
    artifacts: response.artifacts.map((artifact) => ({
      ...artifact,
      id: artifact.id ? "artifact" : undefined,
      content: artifact.content ? redactInternalDetails(artifact.content) : undefined,
      metadata: undefined,
    })),
    plan: response.plan ? {
      ...response.plan,
      steps: response.plan.steps.map((step) => ({
        ...step,
        tool: "internal",
        input: {},
      })),
    } : undefined,
  };
}
