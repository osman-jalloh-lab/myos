import { mkdir, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  BUILDER_SANDBOX_MAX_COMMAND_TIMEOUT_MS,
  BuilderRuntimeUnavailableError,
  createBuilderDockerRunSpec,
  createDockerBuilderSandboxRuntime,
  type BuilderSandboxCommandResult,
  type BuilderSandboxProcessRunner,
} from "../builder-sandbox-runtime";

const root = path.join(os.tmpdir(), `hermes-builder-sandbox-${process.pid}`);
const project = path.join(root, "project-a");
const siblingOutsideRoot = path.join(os.tmpdir(), `hermes-builder-sibling-${process.pid}`);
type Call = { executable: string; args: string[]; cwd: string; timeoutMs?: number };

function result(overrides: Partial<BuilderSandboxCommandResult> = {}): BuilderSandboxCommandResult {
  return { ok: true, stdout: "ok", stderr: "", output: "ok", command: "docker", exitCode: 0, ...overrides };
}

function harness(overrides: { discoverExecutable?: () => Promise<string>; run?: BuilderSandboxProcessRunner } = {}) {
  const calls: Call[] = [];
  const run: BuilderSandboxProcessRunner = overrides.run ?? (async (executable, args, cwd, options) => {
    calls.push({ executable, args, cwd, timeoutMs: options.timeoutMs });
    if (args[0] === "version") return result({ stdout: "24.0.0", output: "24.0.0" });
    if (args[0] === "ps") return result({ stdout: "owned-preview\n", output: "owned-preview\n" });
    return result();
  });
  return {
    calls,
    runtime: createDockerBuilderSandboxRuntime({
      getApprovedProjectsRoot: async () => root,
      discoverExecutable: overrides.discoverExecutable ?? (async () => "C:/approved/docker.exe"),
      run,
    }),
  };
}

beforeAll(async () => {
  await mkdir(project, { recursive: true });
  await mkdir(siblingOutsideRoot, { recursive: true });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(siblingOutsideRoot, { recursive: true, force: true });
});

describe("Builder sandbox runtime conformance", () => {
  describe("availability and fail-closed execution", () => {
    it("reports Docker Engine availability truthfully", async () => {
      expect(await harness().runtime.availability()).toEqual({ available: true, reason: null });
    });

    it("reports unavailable probes and never falls back to host execution", async () => {
      const calls: Call[] = [];
      const { runtime } = harness({ run: async (executable, args, cwd, options) => {
        calls.push({ executable, args, cwd, timeoutMs: options.timeoutMs });
        return result({ ok: false, stdout: "", stderr: "daemon unavailable", output: "daemon unavailable", exitCode: 1 });
      } });
      expect(await runtime.availability()).toEqual({ available: false, reason: "Docker Engine is unavailable." });
      await expect(runtime.execute({ folder: project, projectId: "project-a", runId: "blocked", command: ["npm", "test"] })).rejects.toBeInstanceOf(BuilderRuntimeUnavailableError);
      expect(calls.every((call) => call.executable === "C:/approved/docker.exe")).toBe(true);
      expect(calls.some((call) => call.args[0] === "run")).toBe(false);
    });

    it("reports executable discovery failures as unavailable", async () => {
      const { runtime } = harness({ discoverExecutable: async () => { throw new Error("Docker CLI missing"); } });
      expect(await runtime.availability()).toEqual({ available: false, reason: "Docker CLI missing" });
    });
  });

  describe("workspace scope", () => {
    it("executes only in the canonical approved generated-project directory", async () => {
      const { runtime, calls } = harness();
      await runtime.execute({ folder: project, projectId: "project-a", runId: "run-1", command: ["npm", "run", "build"] });
      const execution = calls.at(-1);
      expect(execution?.cwd).toBe(await realpath(project));
      expect(execution?.args).toEqual(expect.arrayContaining(["run", "--rm", "node:22-bookworm-slim", "npm", "run", "build"]));
    });

    it.each([
      ["approved projects root", root],
      ["parent directory", path.dirname(root)],
      ["sibling project outside the root", siblingOutsideRoot],
      ["path traversal escape", path.join(project, "..", "..")],
      ["absolute escape", path.parse(root).root],
      ["nonexistent project", path.join(root, "missing-project")],
    ])("rejects %s", async (_label, folder) => {
      const { runtime } = harness();
      await expect(runtime.execute({ folder, projectId: "project-a", runId: "escape", command: ["npm", "run", "build"] })).rejects.toBeInstanceOf(BuilderRuntimeUnavailableError);
    });
  });

  describe("container security", () => {
    it("uses exactly one confined mount and the finished Builder hardening", () => {
      const spec = createBuilderDockerRunSpec({ dockerExecutable: "C:/approved/docker.exe", folder: "C:/projects/a", projectId: "a", runId: "run", command: ["npm", "run", "build"] });
      expect(spec.args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "node", "--memory", "2g", "--cpus", "2", "--pids-limit", "256", "--mount", "type=bind,src=C:/projects/a,dst=/workspace", "--workdir", "/workspace"]));
      expect(spec.args.filter((value) => value === "--mount")).toHaveLength(1);
      expect(spec.args).not.toContain("--privileged");
      expect(spec.args).not.toContain("--network");
      expect(spec.args.join(" ")).not.toMatch(/docker\.sock|\.ssh|credentials|users[/\\]osman|my os/i);
    });
  });

  describe("execution", () => {
    it("returns command failures and exit codes unchanged", async () => {
      const { runtime } = harness({ run: async (_executable, args) => args[0] === "version"
        ? result({ stdout: "24.0.0", output: "24.0.0" })
        : result({ ok: false, stdout: "", stderr: "build failed", output: "build failed", exitCode: 7 }) });
      await expect(runtime.execute({ folder: project, projectId: "project-a", runId: "failed", command: ["npm", "run", "build"] })).resolves.toMatchObject({ ok: false, exitCode: 7, stderr: "build failed" });
    });

    it("bounds execution timeouts and invokes the command only through Docker", async () => {
      const { runtime, calls } = harness();
      await runtime.execute({ folder: project, projectId: "project-a", runId: "bounded", command: ["npm", "test"], timeoutMs: Number.MAX_SAFE_INTEGER });
      const execution = calls.at(-1);
      expect(execution?.timeoutMs).toBe(BUILDER_SANDBOX_MAX_COMMAND_TIMEOUT_MS);
      expect(execution?.executable).toBe("C:/approved/docker.exe");
      expect(execution?.args.slice(-3)).toEqual(["node:22-bookworm-slim", "npm", "test"]);
    });
  });

  describe("preview lifecycle", () => {
    it("publishes an allocated port only on localhost from a Docker preview", () => {
      const spec = createBuilderDockerRunSpec({ dockerExecutable: "docker", folder: "C:/projects/a", projectId: "a", runId: "preview", command: ["npm", "run", "start"], detached: true, hostPort: 43127 });
      expect(spec.args).toEqual(expect.arrayContaining(["run", "-d", "-p", "127.0.0.1:43127:3000", "node:22-bookworm-slim"]));
      expect(spec.args).toEqual(expect.arrayContaining(["--label", "hermes.builder.owner=local-builder", "--label", "hermes.builder.project-id=a", "--label", "hermes.builder.kind=preview"]));
    });

    it("stops only containers selected by all Builder ownership labels", async () => {
      const { runtime, calls } = harness();
      await runtime.stopPreview({ folder: project, projectId: "project-a" });
      const list = calls.find((call) => call.args[0] === "ps");
      const remove = calls.find((call) => call.args[0] === "rm");
      expect(list?.args).toEqual(["ps", "-aq", "--filter", "label=hermes.builder.owner=local-builder", "--filter", "label=hermes.builder.project-id=project-a", "--filter", "label=hermes.builder.kind=preview"]);
      expect(remove?.args).toEqual(["rm", "-f", "owned-preview"]);
      expect(remove?.args).not.toContain("unrelated-container");
    });

    it("does not issue a remove command when no owned preview exists", async () => {
      const calls: Call[] = [];
      const { runtime } = harness({ run: async (executable, args, cwd, options) => {
        calls.push({ executable, args, cwd, timeoutMs: options.timeoutMs });
        return result({ stdout: "", output: "" });
      } });
      await runtime.stopPreview({ folder: project, projectId: "project-a" });
      expect(calls.some((call) => call.args[0] === "rm")).toBe(false);
    });
  });

  describe("project durability", () => {
    it("keeps the canonical project mount stable while container identity is disposable", async () => {
      const { runtime, calls } = harness();
      await runtime.execute({ folder: project, projectId: "project-a", runId: "container-one", command: ["npm", "run", "build"] });
      await runtime.execute({ folder: project, projectId: "project-a", runId: "container-two", command: ["npm", "run", "build"] });
      const executions = calls.filter((call) => call.args[0] === "run");
      const names = executions.map((call) => call.args[call.args.indexOf("--name") + 1]);
      const mounts = executions.map((call) => call.args[call.args.indexOf("--mount") + 1]);
      expect(names).toEqual(["builder-job-project-a-container-one", "builder-job-project-a-container-two"]);
      expect(new Set(mounts)).toEqual(new Set([`type=bind,src=${await realpath(project)},dst=/workspace`]));
      expect(executions.every((call) => call.cwd === path.resolve(project))).toBe(true);
    });
  });
});
