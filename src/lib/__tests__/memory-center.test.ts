import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  executeRaw: vi.fn(async () => undefined),
  queryRaw: vi.fn(async () => []),
  memoryFindMany: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  prisma: {
    $executeRawUnsafe: mocks.executeRaw,
    $queryRawUnsafe: mocks.queryRaw,
    memory: {
      findMany: mocks.memoryFindMany,
      updateMany: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
    approvalAction: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
    },
    agentRun: {
      findMany: vi.fn(async () => []),
    },
  },
}));

vi.mock("@/lib/memory", () => ({
  contextCards: vi.fn(async () => [
    {
      fact: "TOKEN is abcdefghijk123456 for the internal verifier",
      source: "memory-center:test",
      relevance: 3,
    },
  ]),
}));

import { retrieveMemoryForPrompt, sanitizeMemoryForPrompt } from "@/lib/memory-center";

describe("memory center", () => {
  it("redacts sensitive memory before prompt injection and logs retrieval", async () => {
    mocks.executeRaw.mockClear();
    mocks.queryRaw.mockResolvedValue([]);
    mocks.memoryFindMany.mockResolvedValue([
      {
        id: "memory_1",
        fact: "TOKEN is abcdefghijk123456 for the internal verifier",
        source: "memory-center:test",
      },
    ]);

    const result = await retrieveMemoryForPrompt({
      userId: "user_1",
      message: "internal verifier token",
      agentName: "hermes",
      taskType: "test",
      runId: "run_1",
    });

    expect(result.redactedCount).toBe(1);
    expect(result.confirmedFacts[0]).toMatchObject({
      id: "memory_1",
      fact: "TOKEN is configured for the internal verifier",
      source: "memory-center:test",
    });
    expect(mocks.executeRaw.mock.calls.some((call: unknown[]) => String(call[0]).includes("INSERT INTO MemoryRetrievalLog"))).toBe(true);
  });

  it("sanitizes credential-shaped facts", () => {
    expect(sanitizeMemoryForPrompt("api key is sk-test-secret-value").text).toBe("api key is configured");
  });
});
