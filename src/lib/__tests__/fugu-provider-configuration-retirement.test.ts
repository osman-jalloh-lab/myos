import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repositoryFile = (...segments: string[]) => readFileSync(path.join(process.cwd(), ...segments), "utf8");

describe("Fugu provider configuration retirement", () => {
  it("does not document active Fugu or Sakana environment variables", () => {
    const environmentExample = repositoryFile(".env.example");
    expect(environmentExample).not.toMatch(/SAKANA_API_KEY|FUGU_DESIGN_/);
  });

  it("deletes the provider implementation and keeps Builder free of its imports", () => {
    const builder = repositoryFile("src", "lib", "local-builder.ts");
    expect(existsSync(path.join(process.cwd(), "src", "lib", "fugu-design-critic.ts"))).toBe(false);
    expect(builder).not.toMatch(/import\s*\{[^;]*?from\s*["']@\/lib\/fugu-design-critic["']/);
  });

  it("does not register the retired provider in health, worker, or setup memory", () => {
    const activeConfigurationSources = [
      repositoryFile("src", "lib", "health-center.ts"),
      repositoryFile("src", "lib", "context-persistence.ts"),
      repositoryFile("scripts", "hermes-local-worker.ts"),
      repositoryFile("src", "lib", "auto-memory.ts"),
    ].join("\n");

    expect(activeConfigurationSources).not.toMatch(/SAKANA_API_KEY|Sakana \/ Fugu|Fugu Critic/);
  });
});
