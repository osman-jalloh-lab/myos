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
});
