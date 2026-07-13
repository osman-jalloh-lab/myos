import { describe, expect, it, vi } from "vitest";
import { assertLocalWorkerQueueAction, settleNonWorkerAction } from "../local-worker-action-policy";

function handlers() {
  return {
    complete: vi.fn(async () => undefined),
    fail: vi.fn(async () => undefined),
    trace: vi.fn(async () => undefined),
  };
}

describe("local worker action policy", () => {
  it.each(["fuguGate", "fuguDesignReview", "fuguGateOverride"])(
    "rejects server-only %s before the worker enqueue path",
    (action) => {
      expect(() => assertLocalWorkerQueueAction(action)).toThrow(`${action} is a server-only action`);
    }
  );

  it.each(["fuguGate", "fuguDesignReview", "fuguGateOverride"])(
    "completes stale server-only %s tasks without throwing or wedging",
    async (action) => {
      const hooks = handlers();

      await expect(settleNonWorkerAction(action, hooks)).resolves.toBe(true);
      expect(hooks.trace).toHaveBeenCalledWith(expect.stringContaining(`Skipped server-only action ${action}`), "info");
      expect(hooks.complete).toHaveBeenCalledWith(expect.stringContaining("handled server side"));
      expect(hooks.fail).not.toHaveBeenCalled();
    }
  );

  it("fails a genuinely unknown action with a named reason", async () => {
    const hooks = handlers();

    await expect(settleNonWorkerAction("mysteryAction", hooks)).resolves.toBe(true);
    expect(hooks.fail).toHaveBeenCalledWith("Worker received unknown action mysteryAction.");
    expect(hooks.trace).toHaveBeenCalledWith("Worker received unknown action mysteryAction.", "error");
    expect(hooks.complete).not.toHaveBeenCalled();
  });

  it("leaves real worker actions unchanged", async () => {
    const hooks = handlers();

    await expect(settleNonWorkerAction("generate", hooks)).resolves.toBe(false);
    expect(hooks.trace).not.toHaveBeenCalled();
    expect(hooks.complete).not.toHaveBeenCalled();
    expect(hooks.fail).not.toHaveBeenCalled();
  });
});
