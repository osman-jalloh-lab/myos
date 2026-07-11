import { describe, expect, it } from "vitest";
import { apiProviderSeverity, buildHermesNousRuntimeHealth, cleanProviderCredential } from "../health-center";

describe("provider health safety", () => {
  it("removes whitespace, BOM, and zero-width characters from credentials", () => {
    expect(cleanProviderCredential(" \uFEFF\u200Btoken\u200C-value\u200D \n")).toBe("token-value");
  });

  it("does not treat configured but untested providers as failures", () => {
    expect(apiProviderSeverity({ provider: "Sakana / Fugu", status: "configured_untested" })).toBe("healthy");
  });

  it("treats missing providers as warnings, not failures", () => {
    expect(apiProviderSeverity({ provider: "Hunter.io", status: "missing" })).toBe("warning");
  });

  it("redacts Hermes Nous install path and diagnostic details", () => {
    const runtime = buildHermesNousRuntimeHealth({
      heartbeat: {
        workerId: "worker-1",
        machineName: "HP",
        status: "online",
        lastHeartbeat: new Date().toISOString(),
        rootPath: "C:\\Users\\osman\\OneDrive\\Desktop\\my os\\HermesProject",
        nodeVersion: "v22.0.0",
        npmVersion: "10.0.0",
        gitAvailable: 1,
        codexAvailable: 1,
        currentTask: null,
        lastError: null,
        workerApiTarget: "https://www.parawi.com",
        lastFetchError: null,
        hermesAgentAvailable: 1,
        hermesAgentPath: "C:\\Users\\osman\\AppData\\Local\\Programs\\Hermes\\hermes.exe",
        hermesAgentVersion: "1.2.3",
        hermesAgentAuthConfigured: 1,
        hermesAgentModelConfigured: 1,
        lastHermesAgentRun: "2026-07-09T10:00:00.000Z",
        lastHermesAgentError: "TOKEN=super-secret-value should be redacted",
        autoStartInstalled: 1,
      },
      codexAvailable: true,
      hermesAgentAvailable: true,
      hermesAgentAuthConfigured: true,
      hermesAgentModelConfigured: true,
    });

    expect(runtime.installPath).toBe("C:/.../hermes.exe");
    expect(runtime.diagnostic).toContain("Safe install path: C:/.../hermes.exe");
    expect(runtime.diagnostic).not.toContain("osman");
    expect(runtime.diagnostic).not.toContain("super-secret-value");
    expect(runtime.authState).toBe("configured");
    expect(runtime.codexFallbackAvailable).toBe(true);
  });
});
