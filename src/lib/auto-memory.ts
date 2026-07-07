import { prisma } from "@/lib/db";

const SECRET_VALUE_RE = /(api[_\s-]?key|token|secret|password|credential)\s*(?:is|=|:)\s*["']?[A-Za-z0-9_\-./+=]{8,}["']?/gi;

function cleanFact(value: string): string {
  return value
    .replace(SECRET_VALUE_RE, (_match, label: string) => `${String(label).replace(/\s+/g, " ")} is configured`)
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, "")
    .trim()
    .replace(/[.!?]+$/, "");
}

function canonicalFact(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function extractUserMemoryFacts(message: string): string[] {
  const text = message.trim();
  const facts = new Set<string>();

  const explicit = text.match(/^(?:remember that|remember|note that|log this|capture this|keep in mind)\s+(.{8,240})$/i)?.[1];
  if (explicit) facts.add(cleanFact(explicit));

  const preference = text.match(/\b(?:i prefer|my preference is|from now on)\b.{4,220}/i)?.[0];
  if (preference) facts.add(cleanFact(preference));

  if (/\bSAKANA_API_KEY\b|\bsakana\b/i.test(text) && /\b(vercel|local\.?env|\.env\.local|environment|env)\b/i.test(text)) {
    const hasLocal = /\b(local\.?env|\.env\.local|local env|environment)\b/i.test(text);
    const hasVercel = /\bvercel\b/i.test(text);
    facts.add(`Sakana API key is configured${hasLocal ? " in local environment" : ""}${hasLocal && hasVercel ? " and" : ""}${hasVercel ? " in Vercel" : ""}`);
  }

  for (const match of text.matchAll(/\b(?:i added|i configured|i connected|i installed|i updated)\s+(.{8,180})/gi)) {
    if (!/\bit\b/i.test(match[1])) facts.add(cleanFact(match[0]));
  }

  return Array.from(facts)
    .map(cleanFact)
    .filter((fact) => fact.length >= 8 && fact.length <= 260);
}

export async function rememberUserFact(userId: string, fact: string, source = "auto-memory:user-stated"): Promise<boolean> {
  const cleaned = cleanFact(fact);
  if (!cleaned) return false;
  const canonical = canonicalFact(cleaned);
  const existing = await prisma.memory.findMany({
    where: { userId, approvedAt: { not: null } },
    select: { id: true, fact: true },
    take: 300,
  });
  if (existing.some((memory) => canonicalFact(memory.fact) === canonical)) return false;

  await prisma.memory.create({
    data: {
      userId,
      fact: cleaned,
      source,
      approvedAt: new Date(),
    },
  });
  return true;
}

// ── LLM fact extraction ───────────────────────────────────────────────────────
// The magic-phrase patterns above only catch exact templates ("remember that",
// "i prefer"). Anything Osman says in plain English used to be captured
// nowhere — the root cause of "if I talk to it, it forgets automatically".
// Messages that miss the fast-path patterns go through a cheap Groq
// classification asking "is there a durable fact here?". Facts STATED by the
// user auto-save directly (same proven rememberUserFact write path); the
// approval queue stays only for Mnemosyne's INFERRED facts and deletions.

function worthClassifying(message: string): boolean {
  const text = message.trim();
  if (text.length < 20 || text.length > 2000) return false;
  // Skip bare commands/acknowledgements — no durable content to mine.
  if (/^(yes|no|ok|okay|thanks|thank you|sure|go ahead|approve|reject|status|help)\b/i.test(text) && text.length < 40) return false;
  return true;
}

async function extractFactsWithLlm(userId: string, message: string): Promise<string[]> {
  const { callModel } = await import("@/lib/modelRouter");
  const result = await callModel({
    userId,
    taskType: "memory-extraction",
    dataClass: "PERSONAL",
    systemPrompt: [
      "You extract durable memory facts from a user's chat message to their personal assistant.",
      "A durable fact is something worth remembering across sessions: who the user is, their preferences,",
      "their projects and goals, decisions they announce, tools/accounts they use, deadlines, constraints.",
      "NOT durable: questions, one-off task requests (\"build me X\", \"draft a reply\"), small talk,",
      "anything already ephemeral, and never secrets/API keys/passwords.",
      "Reply with ONLY a JSON array of strings (each a standalone third-person fact, max 200 chars,",
      'starting with "User" or a proper noun). Reply [] if there is nothing durable.',
    ].join("\n"),
    userPrompt: message.slice(0, 2000),
  });
  const jsonText = result.text.trim().match(/\[[\s\S]*\]/)?.[0];
  if (!jsonText) return [];
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is string => typeof item === "string")
      .map(cleanFact)
      .filter((fact) => fact.length >= 8 && fact.length <= 260)
      .slice(0, 5);
  } catch {
    return [];
  }
}

export async function autoCaptureUserMemory(userId: string, message: string, source = "auto-memory:user-stated"): Promise<string[]> {
  const facts = extractUserMemoryFacts(message);
  const saved: string[] = [];
  for (const fact of facts) {
    if (await rememberUserFact(userId, fact, source)) saved.push(fact);
  }
  // LLM pass only when the fast-path patterns found nothing, so explicit
  // "remember that ..." stays instant and cheap.
  if (saved.length === 0 && facts.length === 0 && worthClassifying(message)) {
    const llmFacts = await extractFactsWithLlm(userId, message);
    for (const fact of llmFacts) {
      if (await rememberUserFact(userId, fact, "auto-memory:llm-extracted")) saved.push(fact);
    }
  }
  return saved;
}

export async function logAutoMemoryFailure(userId: string, message: string, error: unknown): Promise<void> {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(JSON.stringify({
    event: "auto_memory_capture_failed",
    userId,
    messagePreview: message.slice(0, 160),
    error: detail.slice(0, 500),
  }));
  await prisma.agentRun.create({
    data: {
      agentName: "mnemosyne",
      inputSummary: `auto_memory_capture user=${userId} message=${message.slice(0, 160)}`,
      outputSummary: detail.slice(0, 1000),
      modelProvider: "auto-memory",
      status: "failed",
    },
  }).catch(() => undefined);
}

/** Chat-reply tag so Osman gets instant feedback that a fact landed. */
export function rememberedTag(saved: string[]): string | null {
  if (!saved.length) return null;
  return `📌 Remembered: ${saved.join(" · ")}`;
}
