import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionContextState } from "@/lib/context-persistence";

let state: SessionContextState;

vi.mock("@/lib/memory-context", () => ({
  readSessionContextState: vi.fn(async () => state),
  writeSessionContextState: vi.fn(async (_chatId: string, _userId: string, next: SessionContextState) => {
    state = next;
  }),
}));

import { handleBuildIntake } from "@/lib/build-intake";

function emptyState(): SessionContextState {
  return {
    activeIntent: null,
    rememberedEntities: {},
    toolHealth: [],
    recentFailures: [],
  };
}

beforeEach(() => {
  state = emptyState();
});

describe("handleBuildIntake", () => {
  it("asks build requirements one at a time before returning a build prompt", async () => {
    await expect(handleBuildIntake("chat_1", "user_1", "Build me a watch marketplace")).resolves.toMatchObject({
      action: "ask",
      answer: "Who is the audience for this build?",
    });

    await expect(handleBuildIntake("chat_1", "user_1", "Collectors")).resolves.toMatchObject({
      action: "ask",
      answer: "Should it be ecommerce checkout, inquiry/concierge, or showcase only?",
    });

    await expect(handleBuildIntake("chat_1", "user_1", "Inquiry and concierge")).resolves.toMatchObject({
      action: "ask",
      answer: "What style or brand feel should it have?",
    });

    await expect(handleBuildIntake("chat_1", "user_1", "Modern luxury")).resolves.toMatchObject({
      action: "ask",
      answer: "What must-have features should I include, and is there anything I should avoid?",
    });

    const ready = await handleBuildIntake("chat_1", "user_1", "Filters, saved watches, avoid copied brand assets");
    expect(ready.action).toBe("ready");
    expect(ready).toMatchObject({
      message: expect.stringContaining("Builder intake answers:"),
    });
    if (ready.action === "ready") {
      expect(ready.message).toContain("Audience: Collectors");
      expect(ready.message).toContain("Mode: Inquiry and concierge");
      expect(ready.message).toContain("Style: Modern luxury");
    }
  });
});
