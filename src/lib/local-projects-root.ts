import path from "node:path";

// The ONE definition of where local projects live on the build machine.
// Override via HERMES_LOCAL_PROJECTS_ROOT (.env.local, mirrored in .env.example).
// local-builder.ts and scripts/hermes-local-worker.ts both import from here —
// never redeclare this path anywhere else. Dependency-free on purpose so the
// worker script can import it before its env/DB setup runs.
export const DEFAULT_LOCAL_PROJECTS_ROOT = "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject";

export function isWindowsAbsolute(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || /^\\\\/.test(value);
}

export function resolveLocalPath(value: string): string {
  if (isWindowsAbsolute(value)) return path.win32.normalize(value);
  return path.resolve(value);
}

/** Synchronous resolver: env override first, then the canonical default. */
export function resolveLocalProjectsRoot(): string {
  const fromEnv = process.env.HERMES_LOCAL_PROJECTS_ROOT?.trim();
  return resolveLocalPath(fromEnv || DEFAULT_LOCAL_PROJECTS_ROOT);
}
