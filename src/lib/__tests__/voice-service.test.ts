import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createExecutionRun: vi.fn(),
  appendExecutionEvent: vi.fn(),
  getExecutionRun: vi.fn(),
}));

vi.mock("@/lib/execution-runs", () => mocks);

import { createVoiceSession, synthesizeHermesSpeech } from "@/lib/voice-service";

describe("Hermes voice provider boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.OPENAI_API_KEY = "server-only-test-key";
    mocks.createExecutionRun.mockResolvedValue({ id: "voice-run" });
    mocks.appendExecutionEvent.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.OPENAI_API_KEY;
  });

  it("creates a transcription-only ephemeral Realtime session without returning the server key", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ value: "temporary-client-secret", expires_at: 123 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const session = await createVoiceSession("owner");
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as { session: { type: string } };

    expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
    expect(body.session.type).toBe("transcription");
    expect(request.headers).toMatchObject({ Authorization: "Bearer server-only-test-key" });
    expect(session).toEqual({ clientSecret: "temporary-client-secret", expiresAt: 123, model: "gpt-realtime-mini", runId: "voice-run" });
    expect(JSON.stringify(session)).not.toContain("server-only-test-key");
  });

  it("keeps speech synthesis server-side and strips markup from spoken text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await synthesizeHermesSpeech("**Ready** <script>unsafe</script>");
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(request.body)) as { input: string };

    expect(url).toBe("https://api.openai.com/v1/audio/speech");
    expect(body.input).toBe("Ready unsafe");
  });
});
