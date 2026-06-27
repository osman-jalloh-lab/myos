export type BuildFailureCategory = "filesystem" | "local_worker" | "hermes_agent" | "github" | "vercel" | "build" | "qa" | "unknown";

export type BuildFailureDiagnostic = {
  category: BuildFailureCategory;
  label: string;
  exactError: string;
  repositoryAccessTested: boolean;
};

const UNKNOWN = "Build stopped for an unknown reason. View technical logs.";

const RULES: Array<{ category: Exclude<BuildFailureCategory, "unknown">; label: string; pattern: RegExp }> = [
  { category: "filesystem", label: "Filesystem", pattern: /\b(?:ENOENT|EACCES|EPERM)\b|permission denied|access is denied|unsafe .*path|root folder is missing|cannot (?:read|write|create) (?:file|folder|directory)|not a directory/i },
  { category: "local_worker", label: "Local Worker", pattern: /local worker (?:is )?(?:offline|stale|unavailable)|worker api fetch failed|worker lease|heartbeat.*(?:failed|expired)|stale executing task|worker stopped/i },
  { category: "hermes_agent", label: "Hermes Agent", pattern: /Hermes Agent (?:is )?(?:not installed|unavailable|not ready)|hermes auth|hermes model|wrong framework|Hermes Agent safety check|hermes.*(?:timed out|failed)/i },
  { category: "github", label: "GitHub", pattern: /GitHub (?:repository lookup|repo metadata fetch|repo tree fetch|API request|authentication) failed|git (?:clone|fetch|ls-remote).*failed|repository access test failed.*GitHub/i },
  { category: "vercel", label: "Vercel", pattern: /Vercel (?:API request|deployment|authentication).*failed|deployment failed.*Vercel/i },
  { category: "build", label: "Build", pattern: /npm (?:install|run build) failed|next build.*failed|build failed|compilation failed|typescript.*error|Module not found|command timed out.*(?:npm|build)/i },
  { category: "qa", label: "QA", pattern: /Browser QA.*failed|Playwright.*failed|QA (?:checklist )?failed|horizontal overflow detected|console\/page error/i },
];

export function diagnoseBuildFailure(candidates: Array<string | null | undefined>): BuildFailureDiagnostic {
  const lines = candidates
    .flatMap((candidate) => String(candidate ?? "").split(/\r?\n/))
    .map((line) => line.trim())
    .filter(Boolean);
  const repositoryAccessTested = lines.some((line) => /GitHub (?:repository lookup|repo metadata fetch|repo tree fetch|API request|authentication) failed|git (?:clone|fetch|ls-remote)|repository access test/i.test(line));

  for (const rule of RULES) {
    const matching = lines.find((line) => rule.pattern.test(line));
    if (!matching) continue;
    return { category: rule.category, label: rule.label, exactError: matching.slice(0, 1000), repositoryAccessTested };
  }
  return { category: "unknown", label: "Unknown", exactError: UNKNOWN, repositoryAccessTested };
}
