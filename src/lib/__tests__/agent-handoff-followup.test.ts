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
});
