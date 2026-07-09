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
      answer: "What type of build should this become?",
      options: expect.arrayContaining([
        expect.objectContaining({ label: "Interactive web app" }),
      ]),
    });

    await expect(handleBuildIntake("chat_1", "user_1", "Interactive marketplace app")).resolves.toMatchObject({
      action: "ask",
      answer: "Who is the audience for this build?",
      options: expect.arrayContaining([
        expect.objectContaining({ label: "Customers" }),
      ]),
    });

    await expect(handleBuildIntake("chat_1", "user_1", "Collectors")).resolves.toMatchObject({
      action: "ask",
      answer: "What is the primary action or outcome this app should support?",
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
      expect(ready.message).toContain("Build type: Interactive marketplace app");
      expect(ready.message).toContain("Audience: Collectors");
      expect(ready.message).toContain("Primary outcome: Inquiry and concierge");
      expect(ready.message).toContain("Style: Modern luxury");
    }
  });
});
