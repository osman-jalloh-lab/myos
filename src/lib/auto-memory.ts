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

  const explicit = text.match(/^(?:remember|remember that|note that|log this|capture this|keep in mind)\s+(.{8,240})$/i)?.[1];
  if (explicit) facts.add(cleanFact(explicit));

  const preference = text.match(/\b(?:i prefer|my preference is|from now on)\b.{4,220}/i)?.[0];
  if (preference) facts.add(cleanFact(preference));

  if (/\bSAKANA_API_KEY\b|\bsakana\b/i.test(text) && /\b(vercel|local\.?env|\.env\.local|environment|env)\b/i.test(text)) {
    const hasLocal = /\b(local\.?env|\.env\.local|local env|environment)\b/i.test(text);
    const hasVercel = /\bvercel\b/i.test(text);
    facts.add(`Sakana API key is configured${hasLocal ? " in local environment" : ""}${hasLocal && hasVercel ? " and" : ""}${hasVercel ? " in Vercel" : ""}`);
  }

  if (/\b(forgot|forgetting|doesn'?t remember|keeps forgetting|memory)\b/i.test(text) && /\b(agent|agents|Hermes|system)\b/i.test(text)) {
    facts.add("User expects durable memory to be shared across Hermes and all specialist agents");
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

export async function autoCaptureUserMemory(userId: string, message: string, source = "auto-memory:user-stated"): Promise<string[]> {
  const facts = extractUserMemoryFacts(message);
  const saved: string[] = [];
  for (const fact of facts) {
    if (await rememberUserFact(userId, fact, source).catch(() => false)) saved.push(fact);
  }
  return saved;
}
