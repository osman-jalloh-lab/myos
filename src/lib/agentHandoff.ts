// Agent-to-agent handoff library.
// Iris detects emails in the email-watcher cron; this module routes each
// action-needed email to the right downstream agent:
//
//   I-9 / workplace compliance  →  Themis  →  grounded draft (M-274 knowledge)
//   Recruiter / job follow-up   →  Athena  →  tracker update + draft reply
//
// Every handoff creates a draft_email ApprovalAction visible on the dashboard.
// Nothing sends automatically — Osman reviews the draft and copy-pastes to Gmail.
//
// Data-class rules (CLAUDE.md rule 4):
//   - I-9 / workplace content = PRIVATE → Groq only.
//   - Recruiter replies = PERSONAL → normal model router.
import { createApproval, type ApprovalActionView } from "@/lib/approvals";
import { callModel } from "@/lib/modelRouter";
import { retrieveWorkKnowledge, hasWorkKnowledge } from "@/lib/workKnowledge";
import { classifyJobEmail, extractAppFromEmail, upsertApplication } from "@/lib/appTracker";
import { logHandoff } from "@/agents/hermes";

// ── Email route classification ─────────────────────────────────────────────────

export type EmailRoute = "i9_compliance" | "recruiter" | "job_application" | "general";

const I9_KEYWORDS = [
  "form i-9", " i-9 ", "i-9.", "i-9,", "(i-9)", "i9 ", "i9.",
  "employment eligibility verification",
  "uscis", "e-verify", "everify",
  "reverification", "re-verification",
  "section 2", "section 3", "section 1",
  "ead ", "employment authorization document",
  "work authorization", "document expires", "authorization expires",
  "i-9 compliance", "i9 compliance",
  "employment verification form",
];

const RECRUITER_KEYWORDS = [
  "recruiter", "talent acquisition", "hiring manager",
  "would like to schedule", "let's schedule", "like to set up",
  "phone screen", "phone call", "video interview", "interview request",
  "next steps", "next round", "moving forward",
  "we were impressed", "your background caught",
  "we'd like to connect", "position at", "opportunity at", "role at",
  "your resume", "your profile", "your candidacy",
  "following up on your application", "regarding your application",
  "still interested in", "are you still interested",
];

const JOB_CONFIRM_KEYWORDS = [
  "thank you for applying",
  "application received",
  "we received your application",
  "we've received your application",
  "your application has been submitted",
  "application has been received",
];

export function classifyEmailRoute(
  subject: string,
  snippet: string,
  from: string,
  body?: string,
): EmailRoute {
  const haystack = `${subject} ${snippet} ${from} ${body ?? ""}`.toLowerCase();
  if (I9_KEYWORDS.some((kw) => haystack.includes(kw))) return "i9_compliance";
  if (RECRUITER_KEYWORDS.some((kw) => haystack.includes(kw))) return "recruiter";
  if (JOB_CONFIRM_KEYWORDS.some((kw) => haystack.includes(kw))) return "job_application";
  return "general";
}

// Second-pass follow-up drafting for messages already classified action_needed.
// It queues the next durable object Osman can approve: a calendar event for
// schedule/date mail, or a Task for work that is not tied to a specific slot.
export type EmailFollowUpKind = "event" | "task" | "none";

export interface EmailFollowUpClassification {
  kind: EmailFollowUpKind;
  confidence: "high" | "medium" | "low";
  reason: string;
  title: string;
  start?: string;
  end?: string;
  dueAt?: string;
  priority: "low" | "medium" | "high";
}

export interface EmailFollowUpResult {
  classification: EmailFollowUpClassification;
  action: ApprovalActionView | null;
}

const EVENT_KEYWORDS = [
  "interview", "meeting", "phone screen", "video interview", "call", "appointment",
  "calendar invite", "scheduled for", "confirmed for", "reschedule", "schedule",
  "availability", "deadline", "due date", "due by", "starts at", "ends at",
  "zoom", "google meet", "teams meeting", "onsite", "on-site",
];

const TASK_KEYWORDS = [
  "please respond", "please reply", "reply", "respond", "follow up", "following up",
  "action required", "complete", "submit", "review", "send", "provide", "upload",
  "confirm", "still interested", "next steps", "fill out", "sign", "approve",
];

const MONTH_PATTERN = "\\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?\\s+\\d{1,2}(?:,\\s*\\d{4})?";
const NUMERIC_DATE_PATTERN = "\\b\\d{1,2}[/-]\\d{1,2}(?:[/-]\\d{2,4})?";
const WEEKDAY_PATTERN = "\\b(?:mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)\\b";
const TIME_PATTERN = "\\b\\d{1,2}(?::\\d{2})?\\s*(?:am|pm|a\\.m\\.|p\\.m\\.)\\b|\\b\\d{1,2}:\\d{2}\\b";

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripReplyPrefix(subject: string): string {
  return subject.replace(/^\s*(re|fw|fwd):\s*/i, "").trim() || "(no subject)";
}

function senderName(from: string): string {
  const display = from.includes("<") ? from.split("<")[0].trim().replace(/^"|"$/g, "") : "";
  return display || from.split("@")[0].replace(/[._-]+/g, " ").trim() || from;
}

function findFirstMatch(text: string, patterns: string[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(new RegExp(pattern, "i"));
    if (match?.[0]) return compactWhitespace(match[0]);
  }
  return undefined;
}

function inferDateText(text: string): string | undefined {
  return findFirstMatch(text, [
    `${MONTH_PATTERN}(?:\\s+(?:at|@)\\s+${TIME_PATTERN})?`,
    `${WEEKDAY_PATTERN}(?:,?\\s+${MONTH_PATTERN})?(?:\\s+(?:at|@)\\s+${TIME_PATTERN})?`,
    `${NUMERIC_DATE_PATTERN}(?:\\s+(?:at|@)\\s+${TIME_PATTERN})?`,
    `\\b(?:today|tomorrow)\\b(?:\\s+(?:at|@)\\s+${TIME_PATTERN})?`,
    TIME_PATTERN,
  ]);
}

function parseDueAt(text: string): string | undefined {
  const dateText = inferDateText(text);
  if (!dateText) return undefined;
  const parsed = new Date(dateText);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function eventWindowFromText(text: string): { start?: string; end?: string } {
  const dateText = inferDateText(text);
  if (!dateText) return {};
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return { start: dateText };
  const end = new Date(parsed.getTime() + 60 * 60 * 1000);
  return { start: parsed.toISOString(), end: end.toISOString() };
}

export function classifyEmailFollowUp(
  subject: string,
  snippet: string,
  from: string,
  body?: string,
): EmailFollowUpClassification {
  void from;
  const titleSubject = stripReplyPrefix(subject);
  const haystack = compactWhitespace(`${subject} ${snippet} ${body ?? ""}`);
  const lower = haystack.toLowerCase();
  const eventHits = EVENT_KEYWORDS.filter((kw) => lower.includes(kw));
  const taskHits = TASK_KEYWORDS.filter((kw) => lower.includes(kw));
  const hasDate = Boolean(inferDateText(haystack));

  if (eventHits.length > 0 && (hasDate || eventHits.some((kw) => kw.includes("interview") || kw.includes("meeting") || kw.includes("appointment") || kw.includes("deadline")))) {
    const window = eventWindowFromText(haystack);
    return {
      kind: "event",
      confidence: window.start ? "high" : "medium",
      reason: `Schedule signal: ${eventHits.slice(0, 3).join(", ")}${hasDate ? "; date/time detected" : ""}.`,
      title: titleSubject,
      start: window.start,
      end: window.end,
      priority: "high",
    };
  }

  if (taskHits.length > 0) {
    return {
      kind: "task",
      confidence: taskHits.length > 1 ? "high" : "medium",
      reason: `Task signal: ${taskHits.slice(0, 3).join(", ")}.`,
      title: `Follow up: ${titleSubject}`,
      dueAt: parseDueAt(haystack),
      priority: lower.includes("urgent") || lower.includes("deadline") || lower.includes("action required") ? "high" : "medium",
    };
  }

  return {
    kind: "none",
    confidence: "low",
    reason: "Action-needed email did not contain a clear schedule or task signal.",
    title: titleSubject,
    priority: "medium",
  };
}

export async function routeActionEmailFollowUp(
  userId: string,
  email: {
    id: string;
    threadId?: string;
    accountEmail?: string;
    accountLabel?: string;
    from: string;
    subject: string;
    snippet: string;
    receivedAt?: string;
    body?: string;
  },
): Promise<EmailFollowUpResult> {
  const emailBody = email.body || email.snippet;
  const classification = classifyEmailFollowUp(email.subject, email.snippet, email.from, emailBody);
  const sourceRef = `gmail:${email.accountEmail ?? "unknown"}:${email.id}`;
  const basePayload = {
    source: "gmail",
    sourceRef,
    gmailMessageId: email.id,
    gmailThreadId: email.threadId,
    accountEmail: email.accountEmail,
    accountLabel: email.accountLabel,
    emailFrom: email.from,
    emailSubject: email.subject,
    emailSnippet: email.snippet.slice(0, 500),
    receivedAt: email.receivedAt,
    reason: classification.reason,
    instruction:
      "Iris drafted this from an action-needed email. Review and approve before anything durable is created.",
  };

  if (classification.kind === "event") {
    const title = classification.title || `Meeting with ${senderName(email.from)}`;
    const action = await createApproval(userId, "create_event", {
      ...basePayload,
      agentKey: "kairos",
      title,
      summary: title,
      start: classification.start,
      end: classification.end,
      description: [
        `Drafted from Gmail message ${email.id}.`,
        `From: ${email.from}`,
        `Subject: ${email.subject}`,
        "",
        emailBody.slice(0, 1200),
      ].join("\n"),
      location: undefined,
    });

    await logHandoff({
      agentName: "kairos",
      inputSummary: `[email-followup] schedule email=${email.id} from=${email.from.slice(0, 60)}`,
      outputSummary: `create_event queued (${action.id.slice(0, 8)}). ${classification.reason}`,
      modelProvider: "internal",
    });
    return { classification, action };
  }

  if (classification.kind === "task") {
    const action = await createApproval(userId, "create_task", {
      ...basePayload,
      agentKey: "hermes",
      title: classification.title,
      description: [
        `Action-needed email from ${email.from}.`,
        `Subject: ${email.subject}`,
        `Reason: ${classification.reason}`,
        "",
        emailBody.slice(0, 1200),
      ].join("\n"),
      dueAt: classification.dueAt,
      priority: classification.priority,
      assignedAgent: null,
      delegatedBy: "iris",
    });

    await logHandoff({
      agentName: "iris",
      inputSummary: `[email-followup] task email=${email.id} from=${email.from.slice(0, 60)}`,
      outputSummary: `create_task queued (${action.id.slice(0, 8)}). ${classification.reason}`,
      modelProvider: "internal",
    });
    return { classification, action };
  }

  return { classification, action: null };
}

// ── Themis handoff ─────────────────────────────────────────────────────────────
// I-9 / workplace compliance email → Themis generates a grounded draft reply
// using M-274 Handbook knowledge → stored as draft_email ApprovalAction.

const THEMIS_DRAFT_SYSTEM = `You are Themis, the workplace knowledge and I-9 compliance agent inside Hermes OS.

An employee or HR contact has sent Osman Jalloh (who works in client services / HR support at ACC) an email about I-9 or employment eligibility.

Your job: Draft a clear, professional, procedurally-correct reply grounded ONLY in the M-274 knowledge context provided. If the answer is not in the context, say exactly which section is missing rather than guessing.

Hard rules:
- No em dashes.
- Never repeat, store, or include SSNs, alien registration numbers, or document numbers from the email.
- Sign off: Osman Jalloh | ACC Client Services (unless context indicates otherwise).
- Under 200 words.
- State procedure, not legal advice. If the question crosses into legal advice territory, add one sentence: "Please consult an immigration attorney for specific legal guidance."
- Draft FROM osman.jalloh@g.austincc.edu.
- Cite your source heading when the context covers the question (e.g., "Per M-274 Section 5.0, EAD Auto-Extensions...").`;

export interface ThemisHandoffResult {
  action: ApprovalActionView;
  modelProvider: string;
}

export async function routeToThemis(
  userId: string,
  email: { id: string; from: string; subject: string; snippet: string; body?: string },
): Promise<ThemisHandoffResult> {
  const emailBody = email.body || email.snippet;
  const searchQuery = `${email.subject} ${emailBody.slice(0, 500)}`;
  const knowledgeContext = hasWorkKnowledge() ? retrieveWorkKnowledge(searchQuery) : "";

  const userPrompt = `M-274 knowledge context:
${knowledgeContext || "(No work knowledge loaded — answer will be general.)"}

---

Email received:
From: ${email.from}
Subject: ${email.subject}
Body:
${emailBody.slice(0, 3000)}

---

Draft a professional reply to this I-9 / employment eligibility email. Ground every statement in the knowledge context above. If the context does not cover the question, name the missing section.`;

  const result = await callModel({
    userId,
    taskType: "themis-draft-reply",
    dataClass: "PRIVATE",
    systemPrompt: THEMIS_DRAFT_SYSTEM,
    userPrompt,
  });

  const sourcesUsed = (knowledgeContext.match(/\[([^\]]+)\]/g) ?? []).slice(0, 5);

  const action = await createApproval(userId, "draft_email", {
    agentKey: "themis",
    emailFrom: email.from,
    emailSubject: email.subject,
    emailBody: emailBody.slice(0, 2000),
    draft: result.text,
    knowledgeSources: sourcesUsed,
    instruction:
      "Themis drafted this reply grounded in the M-274 Handbook. Review it, then copy-paste into Gmail and send from osman.jalloh@g.austincc.edu.",
    generatedAt: new Date().toISOString(),
  });

  await logHandoff({
    agentName: "themis",
    inputSummary: `[email-watcher] I-9 email from ${email.from.slice(0, 60)}: ${email.subject.slice(0, 80)}`,
    outputSummary: `draft_email queued (${action.id.slice(0, 8)}). Sources: ${sourcesUsed.join(", ").slice(0, 200) || "none"}`,
    modelProvider: result.provider,
  });

  return { action, modelProvider: result.provider };
}

// ── Athena handoff ─────────────────────────────────────────────────────────────
// Recruiter or job-confirmation email → Athena updates/creates a TrackedApplication
// + drafts a professional acknowledgment reply → ApprovalAction.

const ATHENA_DRAFT_SYSTEM = `You are Athena, the career and writing agent inside Hermes OS.

A recruiter or hiring team has sent Osman Jalloh an email. Draft a concise, professional reply.

Writing rules (no exceptions):
- No em dashes. No "excited to apply." No "great fit." No "I am writing to."
- FROM osman.jalloh@g.austincc.edu.
- Under 150 words. No filler.
- Confident, warm, direct. Sound like Osman on a good day.
- If it is a scheduling request: express availability and ask them to send time options (do not commit to a specific slot).
- If it is a rejection: acknowledge gracefully and ask to be kept in mind for future roles.
- If it is a next-steps confirmation or "we received your application": confirm receipt, express readiness for next steps.
- If it is an "are you still interested" follow-up: confirm interest, briefly note current availability.`;

export interface AthenaHandoffResult {
  action: ApprovalActionView;
  isNewApp: boolean;
  modelProvider: string;
}

export async function routeToAthena(
  userId: string,
  email: { id: string; from: string; subject: string; snippet: string; body?: string },
): Promise<AthenaHandoffResult> {
  const emailBody = email.body || email.snippet;
  let isNewApp = false;

  // Try to update the job tracker — non-fatal if it fails
  try {
    const emailType = classifyJobEmail(email.subject, email.snippet, emailBody);
    void emailType; // used for context, not routing here
    const extracted = await extractAppFromEmail(userId, email.subject, email.from, email.snippet, emailBody);
    if (extracted?.companyName && extracted?.jobTitle) {
      const { isNew } = await upsertApplication(userId, {
        companyName: extracted.companyName,
        jobTitle: extracted.jobTitle,
        source: "Gmail",
        status: extracted.status ?? "Applied",
        contactName: extracted.contactName,
        contactEmail: email.from,
        emailSubject: email.subject,
        gmailMessageId: email.id,
        notes: emailBody.slice(0, 500),
        applicationDate: new Date(),
      });
      isNewApp = isNew;
    }
  } catch {
    // tracker update best-effort; continue with draft generation
  }

  const result = await callModel({
    userId,
    taskType: "athena-draft-reply",
    dataClass: "PERSONAL",
    systemPrompt: ATHENA_DRAFT_SYSTEM,
    userPrompt: `Email received:
From: ${email.from}
Subject: ${email.subject}
Body:
${emailBody.slice(0, 3000)}

Draft a professional reply from Osman Jalloh. Follow all writing rules strictly.`,
  });

  const action = await createApproval(userId, "draft_email", {
    agentKey: "athena",
    emailFrom: email.from,
    emailSubject: email.subject,
    emailBody: emailBody.slice(0, 2000),
    draft: result.text,
    trackerUpdated: isNewApp ? "new application logged" : "existing record updated",
    instruction:
      "Athena drafted this reply. Review it, then copy-paste into Gmail and send from osman.jalloh@g.austincc.edu.",
    generatedAt: new Date().toISOString(),
  });

  await logHandoff({
    agentName: "athena",
    inputSummary: `[email-watcher] Recruiter email from ${email.from.slice(0, 60)}: ${email.subject.slice(0, 80)}`,
    outputSummary: `draft_email queued (${action.id.slice(0, 8)}). Tracker: ${isNewApp ? "new record" : "updated existing"}.`,
    modelProvider: result.provider,
  });

  return { action, isNewApp, modelProvider: result.provider };
}
