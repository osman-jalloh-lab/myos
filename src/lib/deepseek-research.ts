import { getCouncilProvider, runCouncilProvider, type CouncilProviderResponse } from "@/lib/council-providers";
import { classifyCouncilMessage } from "@/lib/data-class-classifier";

export const DEEPSEEK_PRIVATE_REFUSAL = "DeepSeek can't receive PRIVATE or SECRET data. Use the domestic Groq/Ollama path for I-9, finance, email content, credentials, or other sensitive material.";
export const DEEPSEEK_RESEARCH_SYSTEM_PROMPT = [
  "You are a read-only research and drafting assistant.",
  "Use only public, non-sensitive material explicitly provided in the user prompt.",
  "Do not claim to read files, use private memory, execute changes, or write durable state.",
  "You may draft research, skills, plans, outlines, and code snippets for later review.",
].join(" ");

export type DeepSeekResearchResult = {
  answer: string;
  providerResult: CouncilProviderResponse;
};

export async function runDeepSeekResearch(message: string): Promise<DeepSeekResearchResult> {
  const trimmed = message.trim();
  if (!trimmed) throw new Error("message is required");

  const dataClass = classifyCouncilMessage(trimmed);
  if (dataClass === "PRIVATE" || dataClass === "SECRET") {
    throw new Error(DEEPSEEK_PRIVATE_REFUSAL);
  }

  const provider = getCouncilProvider("deepseek");
  if (!provider) throw new Error("DeepSeek is not registered as a Council provider.");

  const providerResult = await runCouncilProvider(provider, trimmed, {
    systemPrompt: DEEPSEEK_RESEARCH_SYSTEM_PROMPT,
  });
  if (providerResult.status !== "answered") {
    throw new Error(`DeepSeek did not answer: ${providerResult.safeError ?? providerResult.status}`);
  }

  return { answer: providerResult.text, providerResult };
}
