// Model router. Default provider Groq (Lean). Logs every call to ModelUsage.
// PRIVATE data (email/I-9/finance) -> Groq on Vercel, or home Ollama via OLLAMA_BASE_URL tunnel.
// Chat tasks (PERSONAL) -> Claude Haiku when ANTHROPIC_API_KEY is set (better reasoning).
import { prisma } from "./db";

export type DataClass = "PUBLIC" | "PERSONAL" | "PRIVATE" | "SECRET";
export type Provider = "groq" | "openai" | "anthropic" | "ollama";

export function pickProvider(taskType: string, dataClass: DataClass): Provider {
  if (dataClass === "SECRET") throw new Error("SECRET data must never reach an LLM");
  if (taskType === "code" || taskType === "long-doc") return "anthropic";
  // PRIVATE data (email, finance, I-9) stays on Groq per CLAUDE.md rule 4
  if (dataClass === "PRIVATE") return process.env.OLLAMA_BASE_URL ? "ollama" : "groq";
  // Job-related tasks go to OpenAI (GPT-4o-mini is strong at job matching)
  if (process.env.OPENAI_API_KEY && (taskType === "chat-jobs" || taskType === "job-scout" || taskType.startsWith("chat-agent-athena"))) {
    return "openai";
  }
  // All other chat and brief tasks get Claude Haiku/Sonnet when the key is available
  if (process.env.ANTHROPIC_API_KEY && (taskType.startsWith("chat-") || taskType === "daily-brief")) {
    return "anthropic";
  }
  return (process.env.MODEL_ROUTER_DEFAULT_PROVIDER as Provider) || "groq";
}

// Provider fallback order. If a provider errors or hits a credit/quota limit,
// try the next one. The app must never go down because one provider is exhausted.
export const PROVIDER_FALLBACK: Provider[] = ["groq", "openai", "anthropic", "ollama"];

// Lean Mode default — small, fast, cheap. Good enough for structured-signal synthesis.
const GROQ_MODEL = "llama-3.1-8b-instant";

// Claude models: Haiku for fast chat, Sonnet for synthesis/briefs.
const ANTHROPIC_CHAT_MODEL = "claude-haiku-4-5-20251001";
const ANTHROPIC_SYNTHESIS_MODEL = "claude-sonnet-4-6";

// OpenAI model for job matching — GPT-4o-mini is strong at structured reasoning.
const OPENAI_CHAT_MODEL = "gpt-4o-mini";

const HOSTED_PROVIDER_TIMEOUT_MS = 30_000;
const OLLAMA_TIMEOUT_MS = 60_000;
const MEMORY_EXTRACTION_TIMEOUT_MS = 5_000;

// Rough list pricing per 1M tokens (not billing-accurate; update if pricing changes).
const GROQ_COST_PER_MILLION = { input: 0.05, output: 0.08 };
const ANTHROPIC_COST_PER_MILLION = {
  haiku: { input: 0.80, output: 4.00 },
  sonnet: { input: 3.00, output: 15.00 },
};
const OPENAI_COST_PER_MILLION = { input: 0.15, output: 0.60 }; // gpt-4o-mini

interface ProviderResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

function providerTimeoutSignal(provider: Provider, taskType?: string): AbortSignal {
  if (taskType === "memory-extraction") return AbortSignal.timeout(MEMORY_EXTRACTION_TIMEOUT_MS);
  return AbortSignal.timeout(provider === "ollama" ? OLLAMA_TIMEOUT_MS : HOSTED_PROVIDER_TIMEOUT_MS);
}

async function callGroq(system: string, user: string, taskType?: string): Promise<ProviderResponse> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY is not set");

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_tokens: 400,
    }),
    signal: providerTimeoutSignal("groq", taskType),
  });

  if (!res.ok) {
    throw new Error(`Groq API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? "",
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

// Ollama chat endpoint — only reachable if Osman has wired a home Ollama
// through a Cloudflare Tunnel and set OLLAMA_BASE_URL (CLAUDE.md rule 4).
// No token usage is reported, so cost stays unestimated (estimateCost returns
// undefined for non-Groq providers, which is correct here too).
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "llama3.1";

async function callOllama(system: string, user: string, taskType?: string): Promise<ProviderResponse> {
  const baseUrl = process.env.OLLAMA_BASE_URL;
  if (!baseUrl) throw new Error("OLLAMA_BASE_URL is not set");

  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      stream: false,
    }),
    signal: providerTimeoutSignal("ollama", taskType),
  });

  if (!res.ok) {
    throw new Error(`Ollama API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  return { text: data.message?.content?.trim() ?? "" };
}

async function callOpenAI(system: string, user: string, taskType?: string): Promise<ProviderResponse> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_CHAT_MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0.4,
      max_tokens: 500,
    }),
    signal: providerTimeoutSignal("openai", taskType),
  });

  if (!res.ok) {
    throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  return {
    text: data.choices?.[0]?.message?.content?.trim() ?? "",
    inputTokens: data.usage?.prompt_tokens,
    outputTokens: data.usage?.completion_tokens,
  };
}

async function callAnthropic(system: string, user: string, taskType?: string): Promise<ProviderResponse> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set");

  // Synthesis tasks get Sonnet; everything else gets Haiku (fast + cheap).
  const isSynthesis = taskType === "daily-brief" || taskType === "chat-multi-agent";
  const model = isSynthesis ? ANTHROPIC_SYNTHESIS_MODEL : ANTHROPIC_CHAT_MODEL;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: isSynthesis ? 800 : 500,
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: providerTimeoutSignal("anthropic", taskType),
  });

  if (!res.ok) {
    throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as {
    content?: { type: string; text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const text = (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("")
    .trim();

  return {
    text,
    inputTokens: data.usage?.input_tokens,
    outputTokens: data.usage?.output_tokens,
  };
}

function estimateCost(provider: Provider, inputTokens = 0, outputTokens = 0, taskType?: string): number | undefined {
  if (provider === "groq") {
    return (inputTokens / 1_000_000) * GROQ_COST_PER_MILLION.input + (outputTokens / 1_000_000) * GROQ_COST_PER_MILLION.output;
  }
  if (provider === "openai") {
    return (inputTokens / 1_000_000) * OPENAI_COST_PER_MILLION.input + (outputTokens / 1_000_000) * OPENAI_COST_PER_MILLION.output;
  }
  if (provider === "anthropic") {
    const isSynthesis = taskType === "daily-brief" || taskType === "chat-multi-agent";
    const rates = isSynthesis ? ANTHROPIC_COST_PER_MILLION.sonnet : ANTHROPIC_COST_PER_MILLION.haiku;
    return (inputTokens / 1_000_000) * rates.input + (outputTokens / 1_000_000) * rates.output;
  }
  return undefined;
}

export interface ModelCallParams {
  userId?: string;
  taskType: string;
  dataClass: DataClass;
  systemPrompt: string;
  userPrompt: string;
  /** Explicit provider override — set when the user says "use claude", "use local", etc. */
  providerOverride?: Provider;
}

export interface ModelCallResult {
  text: string;
  provider: Provider;
}

async function runProvider(provider: Provider, system: string, user: string, taskType?: string): Promise<ProviderResponse> {
  if (provider === "groq") return callGroq(system, user, taskType);
  if (provider === "ollama") return callOllama(system, user, taskType);
  if (provider === "openai") return callOpenAI(system, user, taskType);
  if (provider === "anthropic") return callAnthropic(system, user, taskType);
  throw new Error(`Unknown provider: ${provider}`);
}

async function logUsage(params: ModelCallParams, provider: Provider, response: ProviderResponse): Promise<void> {
  await prisma.modelUsage.create({
    data: {
      userId: params.userId,
      provider,
      taskType: params.taskType,
      dataClass: params.dataClass,
      inputTokens: response.inputTokens,
      outputTokens: response.outputTokens,
      estCostUsd: estimateCost(provider, response.inputTokens, response.outputTokens, params.taskType),
    },
  });
}

/**
 * Streaming variant of callModel — yields text delta chunks as they arrive.
 * Only Groq (OpenAI-compatible SSE) and Anthropic support streaming today.
 * Falls back to yielding the full response as a single chunk for other providers.
 *
 * Usage:
 *   for await (const chunk of callModelStream(params)) { ... }
 */
export async function* callModelStream(params: ModelCallParams): AsyncGenerator<string, void, unknown> {
  const provider = params.providerOverride ?? pickProvider(params.taskType, params.dataClass);
  let fullText = "";

  if (provider === "groq") {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error("GROQ_API_KEY is not set");

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userPrompt },
        ],
        temperature: 0.4,
        max_tokens: 400,
        stream: true,
      }),
      signal: providerTimeoutSignal("groq", params.taskType),
    });

    if (!res.ok || !res.body) throw new Error(`Groq streaming API ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") break;
          try {
            const parsed = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const chunk = parsed.choices?.[0]?.delta?.content ?? "";
            if (chunk) { fullText += chunk; yield chunk; }
          } catch { /* skip malformed lines */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  } else {
    // Non-streaming providers — yield the full response as one chunk
    const response = await runProvider(provider, params.systemPrompt, params.userPrompt, params.taskType);
    fullText = response.text;
    yield response.text;
    await logUsage(params, provider, response);
    return;
  }

  await logUsage(params, provider, { text: fullText });
}

/**
 * Routes a call through the model router, then logs it to model_usage.
 * Resilience: if the picked provider fails (rate limit, outage, bad key) and
 * Osman has a home Ollama reachable via OLLAMA_BASE_URL, retry once on Ollama
 * before giving up — so a Groq blip doesn't take Hermes OS down. The actual
 * provider that served the response (not just the one picked) is what gets
 * logged to model_usage, so the cost panel stays honest about what ran where.
 */
export async function callModel(params: ModelCallParams): Promise<ModelCallResult> {
  const provider = params.providerOverride ?? pickProvider(params.taskType, params.dataClass);

  try {
    const response = await runProvider(provider, params.systemPrompt, params.userPrompt, params.taskType);
    await logUsage(params, provider, response);
    return { text: response.text, provider };
  } catch (err) {
    const ollamaConfigured = Boolean(process.env.OLLAMA_BASE_URL);
    if (provider === "ollama" || !ollamaConfigured) throw err;

    const response = await callOllama(params.systemPrompt, params.userPrompt, params.taskType);
    await logUsage(params, "ollama", response);
    return { text: response.text, provider: "ollama" };
  }
}
