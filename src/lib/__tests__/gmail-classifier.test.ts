import { describe, expect, it } from "vitest";
import { classify, type EmailMessage } from "../gmail";

function message(overrides: Partial<EmailMessage>): EmailMessage {
  return {
    id: "msg_1",
    threadId: "thread_1",
    subject: "Hello",
    from: "Taylor Person <taylor@example.com>",
    snippet: "",
    receivedAt: new Date().toISOString(),
    labels: ["UNREAD"],
    isUnread: true,
    isImportant: false,
    isBulk: false,
    authenticationResults: "",
    accountEmail: "osman@example.com",
    accountLabel: "main",
    ...overrides,
  };
}

describe("gmail classify", () => {
  it("demotes financial scam mail with authentication failures even without bulk headers", () => {
    const result = classify(message({
      subject: "Pre-approved loan offer for you",
      from: "Funding Team <offers@fresh-funding.example>",
      snippet: "Urgent loan approval available today with quick wire transfer options.",
      authenticationResults: "mx.google.com; spf=fail smtp.mailfrom=fresh-funding.example; dkim=none; dmarc=fail",
    }));

    expect(result).toBe("promotion");
  });

  it("still treats an unread human sender as action-needed", () => {
    const result = classify(message({
      subject: "Can we meet tomorrow?",
      from: "Alex Morgan <alex.morgan@example.com>",
      snippet: "Can you reply with a time that works?",
      authenticationResults: "mx.google.com; spf=pass; dkim=pass; dmarc=pass",
    }));

    expect(result).toBe("action_needed");
  });

  it("demotes one-way Workday-style service mail when the sender is not in the correspondent graph", () => {
    const result = classify(message({
      subject: "Action required: review your Workday notification",
      from: "Workday <notifications@myworkday.com>",
      snippet: "You have a new task waiting in Workday.",
      labels: ["UNREAD", "IMPORTANT", "CATEGORY_PERSONAL"],
      isImportant: true,
    }), { correspondents: new Set() });

    expect(result).toBe("notification");
  });

  it("promotes unread mail from a real correspondent even without Gmail importance", () => {
    const result = classify(message({
      subject: "Can you send the notes?",
      from: "Jordan Lee <jordan.lee@example.com>",
      snippet: "Please send those notes when you can.",
      labels: ["UNREAD"],
      isImportant: false,
    }), { correspondents: new Set(["jordan.lee@example.com"]) });

    expect(result).toBe("action_needed");
  });
});
