import { describe, expect, it } from "vitest";

import { chatContextTaskType, isHermesCapabilityQuestion, splitRoutedHermesMessage } from "@/agents/hermes";

describe("Hermes chat context relevance", () => {
  it("does not treat conversational capability questions as a daily brief", () => {
    expect(chatContextTaskType("Hello Hermes. Briefly tell me what you can help me with today.")).toBeNull();
  });

  it("keeps explicit daily brief requests routed to Argus context", () => {
    expect(chatContextTaskType("today")).toBe("chat-brief");
    expect(chatContextTaskType("Give me my morning brief")).toBe("chat-brief");
  });

  it("separates skill and memory guidance from the user's intent text", () => {
    expect(splitRoutedHermesMessage([
      "CONFIRMED MEMORY",
      "- Active project status is queued.",
      "",
      "USER MESSAGE",
      "Hello Hermes. What can you help me with?",
    ].join("\n"))).toEqual({
      userMessage: "Hello Hermes. What can you help me with?",
      routingContext: "CONFIRMED MEMORY\n- Active project status is queued.",
    });
  });

  it("recognizes a direct capability question without consulting unrelated state", () => {
    expect(isHermesCapabilityQuestion("Hello Hermes. What can you help me with?")).toBe(true);
    expect(isHermesCapabilityQuestion("What is the status of my project?")).toBe(false);
  });
});
