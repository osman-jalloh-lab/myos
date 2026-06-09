// Model router. Default provider Groq (Lean). Logs every call to ModelUsage.
// PRIVATE data (email/I-9/finance) -> Groq on Vercel, or home Ollama via OLLAMA_BASE_URL tunnel.
import { prisma } from "./db";

export type DataClass = "PUBLIC" | "PERSONAL" | "PRIVATE" | "SECRET";
export type Provider = "groq" | "openai" | "anthropic" | "ollama";

export function pickProvider(taskType: string, dataClass: DataClass): Provider {
  if (dataClass === "SECRET") throw new Error("SECRET data must never reach an LLM");
  if (taskType === "code" || taskType === "long-doc") return "anthropic";
  if (dataClass === "PRIVATE") return process.env.OLLAMA_BASE_URL ? "ollama" : "groq";
  return (process.env.MODEL_ROUTER_DEFAULT_PROVIDER as Provider) || "groq";
}

// Provider fallback order. If a provider errors or hits a credit/quota limit,
// try the next one. The app must never go down because one provider is exhausted.
export const PROVIDER_FALLBACK: Provider[] = ["groq", "openai", "anthropic", "ollama"];

// Lean Mode default — small, fast, cheap. Good enough for structured-signal synthesis.
const GROQ_MODEL = "llama-3.1-8b-instant";

// Rough Groq list pricing per 1M tokens — only used to populate model_usage.est_cost_usd
// for the cost panel. Not billing-accurate; update if Groq's pricing changes.
const GROQ_COST_PER_MILLION = { input: 0.05, output: 0.08 };

interface ProviderResponse {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

async function callGroq(system: string, user: string): Promise<ProviderResponse> {
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

async function callOllama(system: string, user: string): Promise<ProviderResponse> {
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
  });

  if (!res.ok) {
    throw new Error(`Ollama API ${res.status}: ${await res.text()}`);
  }

  const data = (await res.json()) as { message?: { content?: string } };
  return { text: data.message?.content?.trim() ?? "" };
}

function estimateCost(provider: Provider, inputTokens = 0, outputTokens = 0): number | undefined {
  if (provider === "groq") {
    return (
      (inputTokens / 1_000_000) * GROQ_COST_PER_MILLION.input +
      (outputTokens / 1_000_000) * GROQ_COST_PER_MILLION.output
    );
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

async function runProvider(provider: Provider, system: string, user: string): Promise<ProviderResponse> {
  if (provider === "groq") return callGroq(system, user);
  if (provider === "ollama") return callOllama(system, user);
  // openai/anthropic have no implementation yet — fail loudly rather than
  // silently sending data somewhere unexpected.
  throw new Error(`Provider "${provider}" is not yet implemented in the model router`);
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
      estCostUsd: estimateCost(provider, response.inputTokens, response.outputTokens),
    },
  });
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
    const response = await runProvider(provider, params.systemPrompt, params.userPrompt);
    await logUsage(params, provider, response);
    return { text: response.text, provider };
  } catch (err) {
    const ollamaConfigured = Boolean(process.env.OLLAMA_BASE_URL);
    if (provider === "ollama" || !ollamaConfigured) throw err;

    const response = await callOllama(params.systemPrompt, params.userPrompt);
    await logUsage(params, "ollama", response);
    return { text: response.text, provider: "ollama" };
  }
}
