import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  executeRaw: vi.fn(async () => undefined),
  queryRaw: vi.fn(async () => []),
  memoryFindMany: vi.fn(),
}));

vi.mock("next/server", () => ({
  after: mocks.after,
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
  it("redacts sensitive memory before prompt injection and defers retrieval logging", async () => {
    const afterCallbacks: Array<() => Promise<void> | void> = [];
    mocks.after.mockClear();
    mocks.after.mockImplementation((callback: () => Promise<void> | void) => {
      afterCallbacks.push(callback);
    });
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
    expect(mocks.executeRaw.mock.calls.some((call: unknown[]) => String(call[0]).includes("INSERT INTO MemoryRetrievalLog"))).toBe(false);
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();
    const insertCall = mocks.executeRaw.mock.calls.find((call: unknown[]) =>
      String(call[0]).includes("INSERT INTO MemoryRetrievalLog")
    ) as unknown[] | undefined;
    expect(insertCall).toBeTruthy();
    expect(insertCall?.[2]).toBe("user_1");
    expect(insertCall?.[3]).toBe("run_1");
    expect(insertCall?.[4]).toBe("hermes");
    expect(insertCall?.[5]).toBe("test");
    expect(JSON.parse(String(insertCall?.[7]))[0]).toMatchObject({
      id: "memory_1",
      fact: "TOKEN is configured for the internal verifier",
    });

    mocks.executeRaw.mockClear();
    afterCallbacks.length = 0;
    await retrieveMemoryForPrompt({
      userId: "user_1",
      message: "internal verifier token",
      agentName: "hermes",
      taskType: "test",
      runId: "run_2",
    });
    expect(mocks.executeRaw.mock.calls.some((call: unknown[]) => /CREATE TABLE|CREATE INDEX/.test(String(call[0])))).toBe(false);
    expect(mocks.executeRaw.mock.calls.some((call: unknown[]) => String(call[0]).includes("INSERT INTO MemoryRetrievalLog"))).toBe(false);
  });

  it("sanitizes credential-shaped facts", () => {
    expect(sanitizeMemoryForPrompt("api key is sk-test-secret-value").text).toBe("api key is configured");
  });
});
