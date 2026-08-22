import { access, realpath } from "node:fs/promises";
import path from "node:path";

/** Provider-neutral boundary for disposable Builder execution environments. */
export type BuilderSandboxCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  output: string;
  command: string;
  exitCode: number | null;
};

export type BuilderSandboxRunSpec = { executable: string; args: string[]; displayCommand: string };

export type BuilderSandboxRuntime = {
  availability(): Promise<{ available: boolean; reason: string | null }>;
  execute(input: BuilderSandboxExecutionInput): Promise<BuilderSandboxCommandResult>;
  stopPreview(input: BuilderSandboxPreviewInput): Promise<void>;
};

export type BuilderSandboxExecutionInput = {
  folder: string;
  projectId: string;
  runId: string;
  command: string[];
  timeoutMs?: number;
  detached?: boolean;
  hostPort?: number;
};

export type BuilderSandboxPreviewInput = Pick<BuilderSandboxExecutionInput, "folder" | "projectId">;

export class BuilderRuntimeUnavailableError extends Error {
  constructor(message: string) {
    super(`builder_runtime_unavailable: ${message}`);
    this.name = "BuilderRuntimeUnavailableError";
  }
}

export type BuilderSandboxProcessRunner = (
  executable: string,
  args: string[],
  cwd: string,
  options: { timeoutMs?: number; displayCommand: string; env?: NodeJS.ProcessEnv }
) => Promise<BuilderSandboxCommandResult>;

const NODE_IMAGE = "node:22-bookworm-slim";
export const BUILDER_SANDBOX_MAX_COMMAND_TIMEOUT_MS = 15 * 60_000;

function token(value: string): string {
  return (value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "project").slice(0, 48);
}

export function createBuilderDockerRunSpec(params: {
  dockerExecutable: string;
  folder: string;
  projectId: string;
  runId: string;
  command: string[];
  detached?: boolean;
  hostPort?: number;
}): BuilderSandboxRunSpec {
  const name = `builder-${params.detached ? "preview" : "job"}-${token(params.projectId)}-${token(params.runId)}`;
  const args = [
    "run", ...(params.detached ? ["-d"] : ["--rm"]), "--name", name,
    "--label", "hermes.builder.owner=local-builder",
    "--label", `hermes.builder.project-id=${params.projectId}`,
    "--label", `hermes.builder.kind=${params.detached ? "preview" : "job"}`,
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "node",
    "--memory", "2g", "--cpus", "2", "--pids-limit", "256",
    "--mount", `type=bind,src=${params.folder},dst=/workspace`, "--workdir", "/workspace",
    ...(params.hostPort ? ["-p", `127.0.0.1:${params.hostPort}:3000`] : []),
    NODE_IMAGE, ...params.command,
  ];
  return { executable: params.dockerExecutable, args, displayCommand: [params.dockerExecutable, ...args].join(" ") };
}

export async function discoverBuilderDockerExecutable(candidatesOverride?: string[]): Promise<string> {
  const candidates = candidatesOverride ?? [
    process.env.BUILDER_DOCKER_PATH,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs", "DockerDesktop", "resources", "bin", "docker.exe"),
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe"),
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch { /* try approved next location */ }
  }
  throw new BuilderRuntimeUnavailableError("Docker Desktop CLI was not found at an approved executable path.");
}

/**
 * Docker is the local default. The small interface above is deliberately the only
 * provider contract, leaving a future E2B/Daytona implementation no access to
 * Builder state beyond an approved workspace and this explicit command request.
 */
export function createDockerBuilderSandboxRuntime(options: {
  getApprovedProjectsRoot: () => Promise<string>;
  discoverExecutable?: () => Promise<string>;
  run: BuilderSandboxProcessRunner;
  environment?: (dockerExecutable: string) => NodeJS.ProcessEnv;
}): BuilderSandboxRuntime {
  const discover = options.discoverExecutable ?? (() => discoverBuilderDockerExecutable());
  const environment = options.environment ?? ((dockerExecutable) => ({ ...process.env, PATH: `${path.dirname(dockerExecutable)}${path.delimiter}${process.env.PATH ?? ""}` }));

  async function approvedFolder(folder: string): Promise<string> {
    const root = await realpath(path.resolve(await options.getApprovedProjectsRoot())).catch(() => "");
    const resolved = await realpath(path.resolve(folder)).catch(() => "");
    const rootPrefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
    if (!root || !resolved || resolved === root || !resolved.startsWith(rootPrefix)) {
      throw new BuilderRuntimeUnavailableError("Refusing sandbox execution outside an approved generated project directory.");
    }
    return resolved;
  }

  return {
    async availability() {
      try {
        const executable = await discover();
        const result = await options.run(executable, ["version", "--format", "{{.Server.Version}}"], process.cwd(), { timeoutMs: 15_000, displayCommand: "docker version --format <server-version>", env: environment(executable) });
        return result.ok && result.stdout.trim() ? { available: true, reason: null } : { available: false, reason: "Docker Engine is unavailable." };
      } catch (error) {
        return { available: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },
    async execute(input) {
      const folder = await approvedFolder(input.folder);
      const executable = await discover();
      const probe = await this.availability();
      if (!probe.available) throw new BuilderRuntimeUnavailableError(probe.reason ?? "Docker Engine is unavailable.");
      const spec = createBuilderDockerRunSpec({ dockerExecutable: executable, folder, projectId: input.projectId, runId: input.runId, command: input.command, detached: input.detached, hostPort: input.hostPort });
      const timeoutMs = Math.min(Math.max(input.timeoutMs ?? BUILDER_SANDBOX_MAX_COMMAND_TIMEOUT_MS, 1), BUILDER_SANDBOX_MAX_COMMAND_TIMEOUT_MS);
      return options.run(spec.executable, spec.args, folder, { timeoutMs, displayCommand: spec.displayCommand, env: environment(executable) });
    },
    async stopPreview(input) {
      const folder = await approvedFolder(input.folder);
      const executable = await discover();
      const env = environment(executable);
      const list = await options.run(executable, ["ps", "-aq", "--filter", "label=hermes.builder.owner=local-builder", "--filter", `label=hermes.builder.project-id=${input.projectId}`, "--filter", "label=hermes.builder.kind=preview"], folder, { timeoutMs: 30_000, displayCommand: "docker ps -aq --filter builder-project-preview", env });
      if (!list.ok) throw new BuilderRuntimeUnavailableError("Docker Engine is unavailable while locating the prior Builder preview.");
      const ids = list.stdout.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (ids.length) {
        const removed = await options.run(executable, ["rm", "-f", ...ids], folder, { timeoutMs: 30_000, displayCommand: "docker rm -f <prior-builder-preview>", env });
        if (!removed.ok) throw new Error(`Unable to remove the prior Builder preview. ${removed.output}`);
      }
    },
  };
}
