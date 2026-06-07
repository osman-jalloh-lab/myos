// Iris — email
// Owns ONLY these tools (this is what enforces no-overlap):
//   gmail.read | classify | triage | draft-reply
// CAN:  read & classify metadata across accounts, propose draft replies
// CANNOT: send/delete/label for real, touch calendar/finance/memory

import {
  fetchInboxMessages,
  classify,
  triage,
  draftReply,
  type EmailMessage,
  type EmailCategory,
  type TriageResult,
} from "@/lib/gmail";

export const iris = {
  name: "Iris",
  domain: "email",
  tools: ["gmail.read", "classify", "triage", "draft-reply"] as const,
};

// ── gmail.read ────────────────────────────────────────────────────────────────

export async function gmailRead(userId: string, maxPerAccount = 15): Promise<EmailMessage[]> {
  return fetchInboxMessages(userId, maxPerAccount);
}

// ── classify ──────────────────────────────────────────────────────────────────

export function classifyMessage(message: EmailMessage): EmailCategory {
  return classify(message);
}

// ── triage ────────────────────────────────────────────────────────────────────

export async function triageInbox(userId: string, maxPerAccount = 15): Promise<TriageResult> {
  return triage(userId, maxPerAccount);
}

// ── draft-reply ───────────────────────────────────────────────────────────────
// Writes a pending ApprovalAction (actionType: draft_email). Nothing reaches
// Gmail until a human approves it through the Phase 4 approval queue —
// Iris is not granted gmail.compose/gmail.send.

export async function draftReplyTo(
  userId: string,
  params: { messageId: string; threadId: string; to: string; subject: string; body: string }
) {
  return draftReply(userId, params);
}
