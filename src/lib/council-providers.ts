import { MODEL_PROVIDER_REGISTRY, selectedProviderModel, type ProviderFamily, type ProviderRegistryEntry } from "./model-provider-registry";

export type CouncilChatMode = "council" | "provider";

export type CouncilProviderResponse = {
  family: ProviderFamily;
  provider: string;
  roleLabel: string;
  model: string;
  status: "answered" | "skipped" | "failed";
  text: string;
  safeError: string | null;
  latencyMs: number;
};

const PROVIDER_TIMEOUT_MS = 30_000;
const OLLAMA_TIMEOUT_MS = 120_000;

function safeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "Unknown provider error");
  return message
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)=([^\s,;]+)/gi, "$1=[redacted]")
    .slice(0, 300);
}

function cleanCredential(value: string | undefined): string {
  return (value ?? "").replace(/[\uFEFF\u200B-\u200D]/g, "").trim();
}

function envConfigured(entry: ProviderRegistryEntry): boolean {
  if (entry.family === "ollama") {
    const baseUrl = process.env.OLLAMA_BASE_URL?.trim();
    const isHostedRuntime = Boolean(process.env.VERCEL || process.env.VERCEL_ENV);
    return Boolean((baseUrl || !isHostedRuntime) && selectedProviderModel(entry));
  }
  return entry.env.every((name) => Boolean(cleanCredential(process.env[name])));
}

function councilSystemPrompt(entry: ProviderRegistryEntry): string {
  return [
    `You are the ${entry.roleLabel} on Osman's Hermes OS Council of Agents.`,
    "Answer as one reviewer, not as the whole council.",
    "Be concise, concrete, and willing to disagree with other reviewers.",
    "Return practical advice, risks, and your strongest recommendation.",
    "Hermes OS invariant: whole-Council mode is never cost-routed. Every configured Council provider must be asked every time.",
    "Cost-conscious routing applies only to ordinary background routing, never as a substitute for Council debate.",
    "Advisory only: do not claim you changed files, executed actions, or wrote durable memory.",
    "If you recommend a memory write, phrase it as an ApprovalAction proposal for Osman to approve first.",
    "Include a short 'Recommendation:' line and a short 'Dissent / concern:' line.",
  ].join(" ");
}

async function postJson(url: string, init: RequestInit, timeoutMs = PROVIDER_TIMEOUT_MS): Promise<unknown> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}.`);
  return response.json();
}

async function callOpenAI(entry: ProviderRegistryEntry, message: string): Promise<string> {
  const data = await postJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cleanCredential(process.env.OPENAI_API_KEY)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: selectedProviderModel(entry),
      messages: [
        { role: "system", content: councilSystemPrompt(entry) },
        { role: "user", content: message },
      ],
      temperature: 0.35,
      max_tokens: 650,
    }),
  });
  const parsed = data as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content?.trim() || "";
}

async function callAnthropic(entry: ProviderRegistryEntry, message: string): Promise<string> {
  const data = await postJson("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": cleanCredential(process.env.ANTHROPIC_API_KEY),
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: selectedProviderModel(entry),
      max_tokens: 650,
      system: councilSystemPrompt(entry),
      messages: [{ role: "user", content: message }],
    }),
  });
  const parsed = data as { content?: { type: string; text?: string }[] };
  return (parsed.content ?? []).filter((item) => item.type === "text").map((item) => item.text ?? "").join("").trim();
}

async function callDeepSeek(entry: ProviderRegistryEntry, message: string): Promise<string> {
  const baseUrl = (process.env.DEEPSEEK_BASE_URL?.trim() || "https://api.deepseek.com").replace(/\/$/, "");
  const data = await postJson(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cleanCredential(process.env.DEEPSEEK_API_KEY)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: selectedProviderModel(entry),
      messages: [
        { role: "system", content: councilSystemPrompt(entry) },
        { role: "user", content: message },
      ],
      temperature: 0.35,
      max_tokens: 650,
    }),
  });
  const parsed = data as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content?.trim() || "";
}

async function callGemini(entry: ProviderRegistryEntry, message: string): Promise<string> {
  const model = encodeURIComponent(selectedProviderModel(entry));
  const data = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(cleanCredential(process.env.GEMINI_API_KEY))}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: councilSystemPrompt(entry) }] },
      contents: [{ role: "user", parts: [{ text: message }] }],
      generationConfig: { temperature: 0.35, maxOutputTokens: 650 },
    }),
  });
  const parsed = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  return parsed.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("").trim() || "";
}

async function callOllama(entry: ProviderRegistryEntry, message: string): Promise<string> {
  const baseUrl = (process.env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434").replace(/\/$/, "");
  const data = await postJson(`${baseUrl}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: selectedProviderModel(entry),
      messages: [
        { role: "system", content: councilSystemPrompt(entry) },
        { role: "user", content: message },
      ],
      options: { num_predict: 180, temperature: 0.25 },
      stream: false,
    }),
  }, OLLAMA_TIMEOUT_MS);
  const parsed = data as { message?: { content?: string; thinking?: string } };
  return parsed.message?.content?.trim() || parsed.message?.thinking?.trim() || "";
}

async function callGroq(entry: ProviderRegistryEntry, message: string): Promise<string> {
  const data = await postJson("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cleanCredential(process.env.GROQ_API_KEY)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: selectedProviderModel(entry),
      messages: [
        { role: "system", content: councilSystemPrompt(entry) },
        { role: "user", content: message },
      ],
      temperature: 0.35,
      max_tokens: 650,
    }),
  });
  const parsed = data as { choices?: { message?: { content?: string } }[] };
  return parsed.choices?.[0]?.message?.content?.trim() || "";
}

async function callProvider(entry: ProviderRegistryEntry, message: string): Promise<string> {
  if (entry.family === "openai") return callOpenAI(entry, message);
  if (entry.family === "anthropic") return callAnthropic(entry, message);
  if (entry.family === "deepseek") return callDeepSeek(entry, message);
  if (entry.family === "gemini") return callGemini(entry, message);
  if (entry.family === "ollama") return callOllama(entry, message);
  if (entry.family === "groq") return callGroq(entry, message);
  throw new Error(`${entry.provider} is not a Council participant.`);
}

export function councilProviderEntries(): ProviderRegistryEntry[] {
  return MODEL_PROVIDER_REGISTRY.filter((entry) => entry.council);
}

export function getCouncilProvider(family: ProviderFamily): ProviderRegistryEntry | null {
  return councilProviderEntries().find((entry) => entry.family === family) ?? null;
}

export function getProviderOffice(family: ProviderFamily): ProviderRegistryEntry | null {
  return MODEL_PROVIDER_REGISTRY.find((entry) => entry.family === family) ?? null;
}

export async function runCouncilProvider(entry: ProviderRegistryEntry, message: string): Promise<CouncilProviderResponse> {
  const started = Date.now();
  if (!envConfigured(entry)) {
    return {
      family: entry.family,
      provider: entry.provider,
      roleLabel: entry.roleLabel,
      model: selectedProviderModel(entry),
      status: "skipped",
      text: "",
      safeError: "Provider is not configured in the local worker environment.",
      latencyMs: 0,
    };
  }
  try {
    const text = await callProvider(entry, message);
    return {
      family: entry.family,
      provider: entry.provider,
      roleLabel: entry.roleLabel,
      model: selectedProviderModel(entry),
      status: text ? "answered" : "failed",
      text,
      safeError: text ? null : "Provider returned an empty response.",
      latencyMs: Date.now() - started,
    };
  } catch (error) {
    return {
      family: entry.family,
      provider: entry.provider,
      roleLabel: entry.roleLabel,
      model: selectedProviderModel(entry),
      status: "failed",
      text: "",
      safeError: safeProviderError(error),
      latencyMs: Date.now() - started,
    };
  }
}

export function formatCouncilResponse(mode: CouncilChatMode, responses: CouncilProviderResponse[]): string {
  const answered = responses.filter((response) => response.status === "answered");
  const unavailable = responses.filter((response) => response.status !== "answered");
  if (mode === "provider") {
    const response = responses[0];
    if (!response) return "No provider response was recorded.";
    if (response.status !== "answered") return `${response.provider} did not answer: ${response.safeError ?? response.status}`;
    return `## ${response.roleLabel}\n${response.text}`;
  }

  const sections = answered.map((response) => [
    `## ${response.roleLabel} (${response.provider})`,
    response.text,
  ].join("\n")).join("\n\n");
  const dissent = answered.length > 1
    ? "## Agreement / Dissent\nCompare the reviewer notes above: any contradiction or tradeoff is intentional Council signal, not a routing failure."
    : "## Agreement / Dissent\nOnly one configured Council member answered, so no real dissent could be measured.";
  const skipped = unavailable.length
    ? `\n\n## Unavailable\n${unavailable.map((response) => `- ${response.provider}: ${response.safeError ?? response.status}`).join("\n")}`
    : "";
  return `${sections || "No configured Council member answered."}\n\n${dissent}${skipped}`;
}
