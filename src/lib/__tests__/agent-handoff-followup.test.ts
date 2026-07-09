import { describe, expect, it } from "vitest";
import { classifyEmailFollowUp } from "../agentHandoff";

describe("email follow-up classification", () => {
  it("classifies schedule-related action mail as an event draft", () => {
    const result = classifyEmailFollowUp(
      "Interview confirmed",
      "Your video interview is scheduled for July 15 at 2:00 PM.",
      "Recruiter <recruiter@example.com>",
    );

    expect(result.kind).toBe("event");
    expect(result.reason).toContain("Schedule signal");
    expect(result.title).toBe("Interview confirmed");
  });

  it("classifies non-scheduled action mail as a task draft", () => {
    const result = classifyEmailFollowUp(
      "Action required: submit documents",
      "Please upload your signed form and respond once complete.",
      "HR <hr@example.com>",
    );

    expect(result.kind).toBe("task");
    expect(result.title).toBe("Follow up: Action required: submit documents");
    expect(result.priority).toBe("high");
  });

  it("keeps update requests as task drafts even if the email mentions a past meeting", () => {
    const result = classifyEmailFollowUp(
      "Comment Added to HR Request",
      "Thank you all for meeting about this again today. Please still update the application questions.",
      "Ticket System <tickets@example.com>",
    );

    expect(result.kind).toBe("task");
    expect(result.reason).toContain("update");
  });

  it("treats dated orientation mail as an event draft", () => {
    const result = classifyEmailFollowUp(
      "Staff/Faculty Orientation Participants for July 16, 2026",
      "The Staff Orientation on Thursday July 16, 2026 will be held at HLC 2.2429.",
      "HR <hr@example.com>",
    );

    expect(result.kind).toBe("event");
    expect(result.reason).toContain("orientation");
  });
});
