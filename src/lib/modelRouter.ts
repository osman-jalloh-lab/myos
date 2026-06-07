// Model router. Default provider Groq (Lean). Logs every call to ModelUsage.
// PRIVATE data (email/I-9/finance) -> Groq on Vercel, or home Ollama via OLLAMA_BASE_URL tunnel.
export type DataClass = "PUBLIC" | "PERSONAL" | "PRIVATE" | "SECRET";
export type Provider = "groq" | "openai" | "anthropic" | "ollama";

export function pickProvider(taskType: string, dataClass: DataClass): Provider {
  if (dataClass === "SECRET") throw new Error("SECRET data must never reach an LLM");
  if (taskType === "code" || taskType === "long-doc") return "anthropic";
  if (dataClass === "PRIVATE") return process.env.OLLAMA_BASE_URL ? "ollama" : "groq";
  return (process.env.MODEL_ROUTER_DEFAULT_PROVIDER as Provider) || "groq";
}
// TODO: implement skill-match against ./skills, call provider, log ModelUsage.

// Provider fallback order. If a provider errors or hits a credit/quota limit,
// try the next one. The app must never go down because one provider is exhausted.
export const PROVIDER_FALLBACK: Provider[] = ["groq", "openai", "anthropic", "ollama"];
