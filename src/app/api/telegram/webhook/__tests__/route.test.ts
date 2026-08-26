import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Telegram webhook contract tests ─────────────────────────────────────────
// Covers: shared clean-response contract, durable update_id/callback
// idempotency, voice transcription routing, and plan-only intent. Every
// downstream collaborator is mocked — this exercises only the webhook's own
// control flow (auth, dedupe, dispatch), not Hermes routing internals.

const DIAGNOSTIC_PATTERNS = [/Skills used:/i, /confidence/i, /Normal agent\/model path used/i];

vi.mock("@/lib/db", () => ({
  prisma: { user: { findFirst: vi.fn() } },
}));

vi.mock("@/lib/chat", () => ({ sendMessage: vi.fn() }));

vi.mock("@/lib/memory-context", () => ({
  buildContextBlock: vi.fn().mockResolvedValue(""),
  updateSessionAfterResponse: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/telegram", async () => {
  const actual = await vi.importActual<typeof import("@/lib/telegram")>("@/lib/telegram");
  return {
    ...actual,
    sendTelegramMessage: vi.fn().mockResolvedValue(undefined),
    sendChatAction: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    getTelegramFilePath: vi.fn(),
    downloadTelegramFile: vi.fn(),
  };
});

vi.mock("@/lib/voice-service", () => ({ transcribeAudioBuffer: vi.fn() }));

vi.mock("@/lib/agent-roster", () => ({ COMMAND_AGENT_PREFIXES: [] }));

vi.mock("@/lib/orchestration/telegram-planner", () => ({
  createTelegramPlanPreview: vi.fn(),
  formatTelegramPlanPreview: vi.fn().mockReturnValue("PLAN PREVIEW TEXT"),
  telegramPlanButtons: vi.fn().mockReturnValue(undefined),
  telegramPlanButtonsForApproval: vi.fn().mockReturnValue([[{ text: "✅ Approve Plan", callback_data: "approve appr_1" }]]),
}));

vi.mock("@/lib/approvals", () => ({
  getApproval: vi.fn(),
  markApprovalAwaitingRevision: vi.fn().mockResolvedValue(undefined),
  findApprovalAwaitingRevision: vi.fn().mockResolvedValue(null),
  supersedeApproval: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/model-council-chat", () => ({ sendCouncilMessage: vi.fn() }));

vi.mock("@/lib/telegram-idempotency", () => ({
  claimTelegramUpdate: vi.fn().mockResolvedValue({ outcome: "claimed" }),
  completeTelegramUpdate: vi.fn().mockResolvedValue(undefined),
  failTelegramUpdate: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@/lib/db";
import { sendMessage } from "@/lib/chat";
import { sendTelegramMessage, answerCallbackQuery, getTelegramFilePath, downloadTelegramFile } from "@/lib/telegram";
import { transcribeAudioBuffer } from "@/lib/voice-service";
import { createTelegramPlanPreview } from "@/lib/orchestration/telegram-planner";
import { getApproval, markApprovalAwaitingRevision, findApprovalAwaitingRevision, supersedeApproval } from "@/lib/approvals";
import { sendCouncilMessage } from "@/lib/model-council-chat";
import { claimTelegramUpdate } from "@/lib/telegram-idempotency";
import { POST } from "../route";

const SECRET = "test-secret";
const OWNER_CHAT_ID = "555";
const MOCK_USER = { id: "user_1", createdAt: new Date() };

function req(body: unknown, secret = SECRET) {
  return new Request("https://example.com/api/telegram/webhook", {
    method: "POST",
    headers: { "x-telegram-bot-api-secret-token": secret, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.TELEGRAM_WEBHOOK_SECRET = SECRET;
  process.env.TELEGRAM_OWNER_CHAT_ID = OWNER_CHAT_ID;
  vi.mocked(prisma.user.findFirst).mockResolvedValue(MOCK_USER as never);
  // clearAllMocks() clears call history but not a prior test's mockResolvedValue
  // override — restore defaults so earlier tests' overrides don't leak forward.
  vi.mocked(claimTelegramUpdate).mockResolvedValue({ outcome: "claimed" });
  vi.mocked(findApprovalAwaitingRevision).mockResolvedValue(null);
});

describe("auth", () => {
  it("rejects a request with the wrong secret", async () => {
    const res = await POST(req({ update_id: 1 }, "wrong-secret"));
    expect(res.status).toBe(401);
  });

  it("silently ignores updates not from the owner", async () => {
    const res = await POST(req({ update_id: 1, message: { chat: { id: 1 }, from: { id: 999 }, text: "hi" } }));
    expect(res.status).toBe(200);
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("response cleanliness — 'Hi' regression (production version-skew bug)", () => {
  it("passes the shared Hermes reply through untouched, with no diagnostic noise added by the webhook", async () => {
    vi.mocked(sendMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: { content: "Hey Osman — what's up?" } as never,
      route: { reply: "Hey Osman — what's up?" },
    });

    await POST(req({ update_id: 100, message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "Hi" } }));

    expect(sendMessage).toHaveBeenCalledWith(MOCK_USER.id, "Hi", "telegram", null, undefined);
    const [, sentText] = vi.mocked(sendTelegramMessage).mock.calls[0];
    expect(sentText).toBe("Hey Osman — what's up?");
    for (const pattern of DIAGNOSTIC_PATTERNS) expect(sentText).not.toMatch(pattern);
  });

  it("does not filter an explicit diagnostic/approval question — passes it straight through to the shared router", async () => {
    vi.mocked(sendMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: { content: "You have 2 pending approvals: ..." } as never,
      route: { reply: "You have 2 pending approvals: ..." },
    });

    await POST(req({ update_id: 101, message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "What approvals are waiting?" } }));

    expect(sendMessage).toHaveBeenCalledWith(MOCK_USER.id, "What approvals are waiting?", "telegram", null, undefined);
  });
});

describe("durable update_id idempotency", () => {
  it("skips re-processing a duplicate text update — no second Hermes call", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({ outcome: "duplicate", status: "completed", resultNote: "text: routed" });

    await POST(req({ update_id: 200, message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "Hi" } }));

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("acks a duplicate callback (double-tapped Approve Plan) without creating a second approval action", async () => {
    vi.mocked(claimTelegramUpdate).mockResolvedValue({ outcome: "duplicate", status: "processing", resultNote: null });

    await POST(req({
      update_id: 201,
      callback_query: { id: "cbq_1", from: { id: Number(OWNER_CHAT_ID) }, message: { chat: { id: Number(OWNER_CHAT_ID) }, message_id: 1 }, data: "approve appr_1" },
    }));

    expect(answerCallbackQuery).toHaveBeenCalledWith("cbq_1", "Already handled.");
    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("voice messages", () => {
  it("transcribes a valid voice message and routes the transcript through the shared Hermes path", async () => {
    vi.mocked(getTelegramFilePath).mockResolvedValue({ filePath: "voice/file_1.oga", fileSize: 12_000 });
    vi.mocked(downloadTelegramFile).mockResolvedValue({ buffer: new ArrayBuffer(8), mimeType: "audio/ogg" });
    vi.mocked(transcribeAudioBuffer).mockResolvedValue("what are you working on");
    vi.mocked(sendMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: { content: "Working on the Telegram remote command milestone." } as never,
      route: { reply: "Working on the Telegram remote command milestone." },
    });

    await POST(req({
      update_id: 300,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, voice: { file_id: "f1", file_unique_id: "u1", duration: 3 } },
    }));

    expect(getTelegramFilePath).toHaveBeenCalledWith("f1");
    expect(transcribeAudioBuffer).toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(MOCK_USER.id, "what are you working on", "telegram", null, undefined);
  });

  it("sends a graceful failure message when the file is oversized/unsupported and never calls Hermes", async () => {
    vi.mocked(getTelegramFilePath).mockResolvedValue({ filePath: "voice/file_2.oga", fileSize: 99_000_000 });
    vi.mocked(downloadTelegramFile).mockRejectedValue(new Error("Voice file too large (99000000 bytes, max 20971520)."));

    await POST(req({
      update_id: 301,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, voice: { file_id: "f2", file_unique_id: "u2", duration: 300 } },
    }));

    expect(sendMessage).not.toHaveBeenCalled();
    const sentMessages = vi.mocked(sendTelegramMessage).mock.calls.map((call) => call[1]);
    expect(sentMessages.some((text) => text.includes("couldn't process that voice message"))).toBe(true);
  });
});

describe("plan-only intent", () => {
  it("routes /plan through the read-only preview branch, not the executing chat router", async () => {
    vi.mocked(createTelegramPlanPreview).mockResolvedValue({ accepted: true, approvalId: "appr_2" } as never);

    await POST(req({
      update_id: 400,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "/plan a simple construction-company website" },
    }));

    expect(createTelegramPlanPreview).toHaveBeenCalledWith(MOCK_USER.id, String(Number(OWNER_CHAT_ID)), "a simple construction-company website", 400);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("recognizes clear natural-language plan-only intent without the /plan prefix", async () => {
    vi.mocked(createTelegramPlanPreview).mockResolvedValue({ accepted: true, approvalId: "appr_3" } as never);

    await POST(req({
      update_id: 401,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "Plan a simple one-page website for a local construction company. Do not build it yet." },
    }));

    expect(createTelegramPlanPreview).toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("'Build me a one-page website' is NOT treated as pre-approved execution — it goes through the normal controlled chat/approval path, not a silent build", async () => {
    vi.mocked(sendMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: { content: "I'll need to plan this first — want me to sketch an approach?" } as never,
      route: { reply: "I'll need to plan this first — want me to sketch an approach?" },
    });

    await POST(req({
      update_id: 403,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "Build me a one-page website." },
    }));

    // Not the read-only plan-preview branch (no "do not build it yet" signal)...
    expect(createTelegramPlanPreview).not.toHaveBeenCalled();
    // ...but also not silently executed by the webhook — it's handed to the
    // same controlled chat router as everything else, which owns the
    // approval-required decision for build work.
    expect(sendMessage).toHaveBeenCalledWith(MOCK_USER.id, "Build me a one-page website.", "telegram", null, undefined);
  });

  it("does not treat an ordinary 'plan my day' message as plan-only intent", async () => {
    vi.mocked(sendMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: { content: "Here's your day..." } as never,
      route: { reply: "Here's your day..." },
    });

    await POST(req({
      update_id: 402,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "plan my day" },
    }));

    expect(createTelegramPlanPreview).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalled();
  });
});

describe("plan approval callbacks", () => {
  it("Ask Council pulls the pending plan's objective and asks Council, without executing anything", async () => {
    vi.mocked(getApproval).mockResolvedValue({
      id: "appr_1",
      actionType: "engineering_plan",
      payload: { objective: "build a landing page" },
      status: "pending",
      createdAt: "",
      resolvedAt: null,
    } as never);
    vi.mocked(sendCouncilMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: {} as never,
      route: { reply: "" },
      target: "council",
      providerResults: [],
      councilResult: {
        selection: { domain: "software", specialists: [], providerFamilies: [], reason: "" },
        synthesis: { stage: "awaiting_user_decision", positions: [{ participant: "Prometheus", position: "Looks feasible.", status: "answered" }], disagreement: "none", confidence: "high", risks: [], recommendation: "Proceed.", needsUserDecision: false },
      },
    } as never);

    await POST(req({
      update_id: 500,
      callback_query: { id: "cbq_2", from: { id: Number(OWNER_CHAT_ID) }, message: { chat: { id: Number(OWNER_CHAT_ID) }, message_id: 2 }, data: "plan_council appr_1" },
    }));

    expect(sendCouncilMessage).toHaveBeenCalledWith({ userId: MOCK_USER.id, message: "build a landing page", mode: "council" });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("Revise flags the plan awaiting revision and asks what to change — no execution, original stays pending (not yet superseded)", async () => {
    vi.mocked(getApproval).mockResolvedValue({
      id: "appr_1",
      actionType: "engineering_plan",
      payload: { objective: "build a landing page" },
      status: "pending",
      createdAt: "",
      resolvedAt: null,
    } as never);

    await POST(req({
      update_id: 501,
      callback_query: { id: "cbq_3", from: { id: Number(OWNER_CHAT_ID) }, message: { chat: { id: Number(OWNER_CHAT_ID) }, message_id: 3 }, data: "plan_revise appr_1" },
    }));

    expect(markApprovalAwaitingRevision).toHaveBeenCalledWith(MOCK_USER.id, "appr_1");
    expect(supersedeApproval).not.toHaveBeenCalled(); // not yet — only once the revision text actually arrives
    expect(sendMessage).not.toHaveBeenCalled();
    const sentMessages = vi.mocked(sendTelegramMessage).mock.calls.map((call) => call[1]);
    expect(sentMessages.some((text) => text.includes("What would you like to change"))).toBe(true);
  });

  it("the user's next free-text message after Revise supersedes the original plan and creates an updated proposal (not routed through normal chat)", async () => {
    vi.mocked(findApprovalAwaitingRevision).mockResolvedValue({
      id: "appr_1",
      actionType: "engineering_plan",
      payload: { objective: "build a landing page" },
      status: "pending",
      createdAt: "",
      resolvedAt: null,
    } as never);
    vi.mocked(createTelegramPlanPreview).mockResolvedValue({ accepted: true, approvalId: "appr_5" } as never);

    await POST(req({
      update_id: 503,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "make it two pages instead of one" },
    }));

    expect(supersedeApproval).toHaveBeenCalledWith(MOCK_USER.id, "appr_1");
    expect(createTelegramPlanPreview).toHaveBeenCalledWith(
      MOCK_USER.id,
      String(Number(OWNER_CHAT_ID)),
      expect.stringContaining("make it two pages instead of one"),
      503
    );
    expect(sendMessage).not.toHaveBeenCalled(); // not treated as an ordinary chat message
  });

  it("a slash command while awaiting a revision is NOT hijacked as the revision reply", async () => {
    vi.mocked(findApprovalAwaitingRevision).mockResolvedValue({
      id: "appr_1",
      actionType: "engineering_plan",
      payload: { objective: "build a landing page" },
      status: "pending",
      createdAt: "",
      resolvedAt: null,
    } as never);
    vi.mocked(sendMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: { content: "Here's your day..." } as never,
      route: { reply: "Here's your day..." },
    });

    await POST(req({
      update_id: 504,
      message: { chat: { id: Number(OWNER_CHAT_ID) }, from: { id: Number(OWNER_CHAT_ID) }, text: "/brief" },
    }));

    expect(supersedeApproval).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalled();
  });

  it("Approve Plan falls through to the existing generic approve/reject verb path", async () => {
    vi.mocked(sendMessage).mockResolvedValue({
      userMessage: {} as never,
      reply: { content: "Plan approved. Implementation delegated." } as never,
      route: { reply: "Plan approved. Implementation delegated." },
    });

    await POST(req({
      update_id: 502,
      callback_query: { id: "cbq_4", from: { id: Number(OWNER_CHAT_ID) }, message: { chat: { id: Number(OWNER_CHAT_ID) }, message_id: 4 }, data: "approve appr_1" },
    }));

    expect(sendMessage).toHaveBeenCalledWith(MOCK_USER.id, "approve appr_1", "telegram", null, undefined);
  });
});
