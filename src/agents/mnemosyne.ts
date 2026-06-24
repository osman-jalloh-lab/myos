// Mnemosyne — memory
// Owns ONLY these tools (this is what enforces no-overlap): "memory.read","memory-suggest","context-cards","stale-cleanup","onboarding-memory"
// CAN: suggest memory, surface context, retain onboarding
// CANNOT: save/delete memory without approval — every write below queues a
// save_memory or delete_memory ApprovalAction; nothing reaches the Memory
// table until Osman clicks Approve (see @/lib/approvals SCOPE_BLOCKED).

import {
  memoryRead,
  memorySuggest,
  onboardingMemory,
  contextCards,
  staleCleanup,
  type MemoryView,
  type ContextCard,
  type StaleCandidate,
} from "@/lib/memory";

export const mnemosyne = {
  name: "Mnemosyne",
  domain: "memory",
  tools: ["memory.read", "memory-suggest", "context-cards", "stale-cleanup", "onboarding-memory"] as const,
};

export async function readMemory(userId: string): Promise<MemoryView[]> {
  return memoryRead(userId);
}

export async function suggestMemory(userId: string, fact: string, source?: string) {
  return memorySuggest(userId, fact, source);
}

export async function getContextCards(userId: string, query: string, max?: number): Promise<ContextCard[]> {
  return contextCards(userId, query, max);
}

export async function runStaleCleanup(userId: string): Promise<StaleCandidate[]> {
  return staleCleanup(userId);
}

export async function proposeOnboarding(userId: string, fact: string, place: string) {
  return onboardingMemory(userId, fact, place);
}
