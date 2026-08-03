import type { RestrictedPlanningRunner } from "../planning-provider";

const SECRET_KEYS = /(?:KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)/i;
export function hermesPlanningEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ["SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "TEMP", "TMP", "LANG", "LC_ALL", "HERMES_HOME"];
  return Object.fromEntries(allowed.flatMap((key) => env[key] && !SECRET_KEYS.test(key) ? [[key, env[key] as string]] : []));
}
export function redactPlanningRunnerError(value: unknown): string {
  return String(value ?? "Hermes planning runner unavailable.")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[redacted-path]")
    .replace(/\/Users\/[^\s"']+/g, "[redacted-path]")
    .replace(/(?:Bearer\s+)?(?:sk|pk|ghp|xoxb)-[A-Za-z0-9._-]+/gi, "[redacted-secret]")
    .slice(0, 240);
}
/**
 * Deliberately unavailable until Nous exposes a verified fixed no-tools mode.
 * This fulfils the runner interface without falling back to chat/oneshot modes,
 * both of which the process-boundary audit classified as unsafe for planning.
 */
export class HardenedHermesPlanningRunner implements RestrictedPlanningRunner {
  async run(_prompt: string, _timeoutMs: number): Promise<{ status: "unavailable" }> {
    return { status: "unavailable" };
  }
}
