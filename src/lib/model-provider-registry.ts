export type ProviderFamily = "openai" | "anthropic" | "deepseek" | "gemini" | "ollama" | "groq";

export type ProviderRole =
  | "engineering"
  | "architecture"
  | "challenger"
  | "multimodal_strategy"
  | "local_reviewer"
  | "fallback";

export type ProviderEnvironment = "Local" | "Vercel" | "Both";

export type ProviderRegistryEntry = {
  family: ProviderFamily;
  provider: string;
  role: ProviderRole;
  roleLabel: string;
  env: string[];
  modelEnv?: string;
  defaultModel?: string;
  baseUrlEnv?: string;
  environment: ProviderEnvironment;
  council: boolean;
  testable: boolean;
  routePreview: string;
};

export const MODEL_PROVIDER_REGISTRY: ProviderRegistryEntry[] = [
  {
    family: "openai",
    provider: "OpenAI / ChatGPT / Codex",
    role: "engineering",
    roleLabel: "Engineering Reviewer",
    env: ["OPENAI_API_KEY"],
    modelEnv: "OPENAI_MODEL",
    defaultModel: "gpt-4o-mini",
    environment: "Both",
    council: true,
    testable: true,
    routePreview: "Code plans, repository review, implementation checks.",
  },
  {
    family: "anthropic",
    provider: "Anthropic / Claude",
    role: "architecture",
    roleLabel: "Architecture Reviewer",
    env: ["ANTHROPIC_API_KEY"],
    modelEnv: "ANTHROPIC_MODEL",
    defaultModel: "claude-haiku-4-5-20251001",
    environment: "Both",
    council: true,
    testable: true,
    routePreview: "Architecture, tradeoffs, long-form reasoning.",
  },
  {
    family: "deepseek",
    provider: "DeepSeek",
    role: "challenger",
    roleLabel: "Independent Challenger",
    env: ["DEEPSEEK_API_KEY"],
    modelEnv: "DEEPSEEK_MODEL",
    baseUrlEnv: "DEEPSEEK_BASE_URL",
    defaultModel: "deepseek-chat",
    environment: "Both",
    council: true,
    testable: true,
    routePreview: "Independent challenge, alternative reasoning, and dissent in whole-Council debates.",
  },
  {
    family: "gemini",
    provider: "Google Gemini",
    role: "multimodal_strategy",
    roleLabel: "Strategy / Multimodal Reviewer",
    env: ["GEMINI_API_KEY"],
    modelEnv: "GEMINI_MODEL",
    defaultModel: "gemini-1.5-flash",
    environment: "Both",
    council: false,
    testable: false,
    routePreview: "Deferred future reviewer for PDFs, screenshots, visual context, and long documents.",
  },
  {
    family: "ollama",
    provider: "Ollama / Qwen",
    role: "local_reviewer",
    roleLabel: "Local Private Reviewer",
    env: ["OLLAMA_BASE_URL", "OLLAMA_MODEL", "OLLAMA_MODEL_FAMILY"],
    modelEnv: "OLLAMA_MODEL",
    baseUrlEnv: "OLLAMA_BASE_URL",
    defaultModel: "qwen3:4b",
    environment: "Local",
    council: true,
    testable: false,
    routePreview: "Simple, low-cost, private local review through the worker.",
  },
  {
    family: "groq",
    provider: "Groq",
    role: "fallback",
    roleLabel: "Existing Low-Cost Fallback",
    env: ["GROQ_API_KEY"],
    defaultModel: "llama-3.1-8b-instant",
    environment: "Both",
    council: false,
    testable: false,
    routePreview: "Preserved existing fallback behavior only.",
  },
];

export function providerComponent(provider: string): string {
  return provider.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function selectedProviderModel(entry: ProviderRegistryEntry): string {
  if (!entry.modelEnv) return entry.defaultModel ?? "default";
  return process.env[entry.modelEnv]?.trim() || entry.defaultModel || "not selected";
}
