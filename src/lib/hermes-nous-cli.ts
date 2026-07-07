export function sanitizeHermesOutput(value: string): string {
  return value
    .replace(/^.*Using API key:.*$/gim, "[Hermes credential configured]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*\S+/gi, "$1=[redacted]");
}

export function parseHermesChatOutput(output: string): { reply: string; sessionId: string | null } {
  const safe = sanitizeHermesOutput(output).trim();
  const sessionMatch = safe.match(/(?:^|\n)session_id:\s*([^\s\r\n]+)/i);
  const withoutSession = safe
    .replace(/(?:^|\n)session_id:\s*[^\s\r\n]+/gi, "")
    .replace(/(?:^|\n).*Resumed session .*$/gim, "")
    .trim();
  return {
    reply: withoutSession || "Hermes Nous completed without a text reply.",
    sessionId: sessionMatch?.[1]?.trim() || null,
  };
}
