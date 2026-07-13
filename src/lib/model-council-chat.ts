import { prisma } from "@/lib/db";
import { createExecutionQueueTask } from "@/lib/execution-queue";
import { councilProviderEntries, formatCouncilResponse, getProviderOffice, runCouncilProvider, type CouncilChatMode } from "@/lib/council-providers";
import type { CouncilProviderResponse } from "@/lib/council-providers";
import type { ProviderFamily } from "@/lib/model-provider-registry";
import type { ChatMessageView } from "@/lib/chat";
import type { RouteResult } from "@/agents/hermes";
import type { DataClass } from "@/lib/modelRouter";

export const COUNCIL_TARGET = "model_council";
export const councilProviderTarget = (family: ProviderFamily) => `council_${family}`;

const DIRECT_COUNCIL_FAMILIES = new Set<ProviderFamily>(["openai", "anthropic", "deepseek", "gemini", "ollama", "groq"]);
const DOMESTIC_PRIVATE_FAMILIES = new Set<ProviderFamily>(["groq", "ollama"]);

export const COUNCIL_PRIVATE_REFUSAL = "The Council can't review private data (I-9, finance, email content). Ask a specific domestic office (Groq/Ollama) or handle it in the normal private-data flow.";

// TODO: Replace this Council-only stopgap with one shared content classifier used by modelRouter and every model entry point.
export function classifyCouncilMessage(message: string): DataClass {
  const text = message.trim();
  if (/\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|password)\s*[:=]\s*\S+/i.test(text)) return "SECRET";
  const privatePatterns = [
    /\b\d{3}-\d{2}-\d{4}\b/, // SSN
    /\b\d{2}-\d{7}\b/, // EIN
    /\b(?:i-?9|e-?verify|employment authorization|work authorization|alien registration|a-number)\b/i,
    /\b(?:bank account|routing number|checking account|savings account|credit card|debit card|account number|tax return|pay stub|payroll)\b/i,
    /(?:^|\n)\s*from:\s*.+(?:\n|\r\n?)\s*(?:to|sent|date):\s*.+(?:\n|\r\n?)\s*subject:/i,
    /\b(?:email body|pasted email|inbox message|gmail message)\b/i,
  ];
  if (privatePatterns.some((pattern) => pattern.test(text))) return "PRIVATE";
  return "PUBLIC";
}

function assertCouncilPrivacy(message: string, mode: CouncilChatMode, providerFamily?: ProviderFamily): void {
  const dataClass = classifyCouncilMessage(message);
  if (dataClass !== "PRIVATE" && dataClass !== "SECRET") return;
  if (mode === "provider" && providerFamily && DOMESTIC_PRIVATE_FAMILIES.has(providerFamily)) return;
  throw new Error(COUNCIL_PRIVATE_REFUSAL);
}

function toView(row: {
  id: string;
  role: string;
  content: string;
  channel: string;
  targetAgent: string | null;
  createdAt: Date;
}): ChatMessageView {
  return {
    id: row.id,
    role: row.role === "assistant" ? "assistant" : "user",
    content: row.content,
    channel: row.channel === "telegram" ? "telegram" : "dashboard",
    targetAgent: row.targetAgent,
    createdAt: row.createdAt.toISOString(),
  };
}

export function councilTargets(): string[] {
  return [COUNCIL_TARGET, ...councilProviderEntries().map((entry) => councilProviderTarget(entry.family))];
}

export function providerFamilyFromCouncilTarget(target: string): ProviderFamily | null {
  const match = target.match(/^council_(openai|anthropic|deepseek|gemini|ollama|groq)$/);
  return match ? match[1] as ProviderFamily : null;
}

export function isCouncilProviderTarget(target: string | null | undefined): boolean {
  return Boolean(target && providerFamilyFromCouncilTarget(target));
}

export async function listCouncilMessages(userId: string, target: string, limit = 50): Promise<ChatMessageView[]> {
  if (!councilTargets().includes(target)) throw new Error("Unknown Council chat target.");
  const rows = await prisma.chatMessage.findMany({
    where: { userId, targetAgent: target },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return rows.map(toView).reverse();
}

export async function queueCouncilMessage(params: {
  userId: string;
  message: string;
  mode: CouncilChatMode;
  providerFamily?: ProviderFamily;
}): Promise<{ userMessage: ChatMessageView; taskId: string; target: string }> {
  const trimmed = params.message.trim();
  if (!trimmed) throw new Error("message is required");
  assertCouncilPrivacy(trimmed, params.mode, params.providerFamily);

  let target = COUNCIL_TARGET;
  let providerFamily: ProviderFamily | null = null;
  if (params.mode === "provider") {
    if (!params.providerFamily || !DIRECT_COUNCIL_FAMILIES.has(params.providerFamily)) throw new Error("A valid Council provider is required.");
    if (!getProviderOffice(params.providerFamily)) throw new Error("Council provider is not registered.");
    providerFamily = params.providerFamily;
    target = councilProviderTarget(params.providerFamily);
  }

  const userRow = await prisma.chatMessage.create({
    data: { userId: params.userId, role: "user", content: trimmed, channel: "dashboard", targetAgent: target },
  });
  const payload = JSON.stringify({
    type: "council_chat",
    mode: params.mode,
    providerFamily,
    target,
    message: trimmed,
    chatMessageId: userRow.id,
  });
  const task = await createExecutionQueueTask({
    userId: params.userId,
    title: params.mode === "council" ? `Council question: ${trimmed.slice(0, 80)}` : `${providerFamily} office: ${trimmed.slice(0, 80)}`,
    description: payload,
    priority: "high",
    assignedExecutor: "council_chat",
    initialLog: params.mode === "council"
      ? "Queued Council debate. Each configured Council provider must be called by the local worker."
      : `Queued direct ${providerFamily} office chat through the local worker.`,
  });

  return { userMessage: toView(userRow), taskId: task.id, target };
}

export async function sendCouncilMessage(params: {
  userId: string;
  message: string;
  mode: CouncilChatMode;
  providerFamily?: ProviderFamily;
}): Promise<{ userMessage: ChatMessageView; reply: ChatMessageView; route: RouteResult; target: string; providerResults: CouncilProviderResponse[] }> {
  const trimmed = params.message.trim();
  if (!trimmed) throw new Error("message is required");
  assertCouncilPrivacy(trimmed, params.mode, params.providerFamily);

  let target = COUNCIL_TARGET;
  let entries = councilProviderEntries();
  if (params.mode === "provider") {
    if (!params.providerFamily || !DIRECT_COUNCIL_FAMILIES.has(params.providerFamily)) throw new Error("A valid Council provider is required.");
    const entry = getProviderOffice(params.providerFamily);
    if (!entry) throw new Error("Council provider is not registered.");
    target = councilProviderTarget(params.providerFamily);
    entries = [entry];
  }

  const userRow = await prisma.chatMessage.create({
    data: { userId: params.userId, role: "user", content: trimmed, channel: "dashboard", targetAgent: target },
  });

  const responses = await Promise.all(entries.map((entry) => runCouncilProvider(entry, trimmed)));
  const replyText = formatCouncilResponse(params.mode, responses);
  const replyRow = await prisma.chatMessage.create({
    data: { userId: params.userId, role: "assistant", content: replyText, channel: "dashboard", targetAgent: target },
  });

  await prisma.agentRun.create({
    data: {
      agentName: params.mode === "council" ? "model_council" : target,
      inputSummary: trimmed.slice(0, 200),
      outputSummary: responses.map((response) => `${response.family}:${response.status}`).join(", ").slice(0, 500),
      modelProvider: params.mode === "council" ? "council-all-configured" : params.providerFamily,
      status: responses.some((response) => response.status === "answered") ? "completed" : "failed",
    },
  }).catch(() => undefined);

  return {
    userMessage: toView(userRow),
    reply: toView(replyRow),
    route: { reply: replyText },
    target,
    providerResults: responses,
  };
}
