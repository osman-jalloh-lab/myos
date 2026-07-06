export type ToolProfile =
  | "research"
  | "build"
  | "qa"
  | "visual_review"
  | "noop";

export type Stage =
  | "stage_1_research"
  | "stage_2_build"
  | "stage_3_qa"
  | "complete"
  | "failed"
  | "repairing";

export type ResearchOutputs = {
  researchBriefPath: string | null;
  assetProvenancePath: string | null;
  designBriefMarkdown: string | null;
};

export type BuildOutputs = {
  buildStatus: "passed" | "failed";
  buildLog: string | null;
  buildError: string | null;
};

export type ArtifactQaCheck = {
  key: string;
  label: string;
  status: "passed" | "failed" | "skipped";
  detail: string;
};

export type VisualQaOutputs = {
  browserQaPassed: boolean;
  visualQaStatus: "visual_qa_passed" | "visual_qa_failed" | "visual_qa_needs_review" | null;
  desktopScreenshotPath: string | null;
  mobileScreenshotPath: string | null;
  consoleErrors: string[];
  checks: ArtifactQaCheck[];
  repairPassesUsed: number;
  previewUrl: string | null;
};

export type BuildArtifacts = {
  projectId: string;
  stage: Stage;
  research: ResearchOutputs;
  build: BuildOutputs;
  visualQa: VisualQaOutputs;
  assetProvenancePath: string | null;
  researchBriefPath: string | null;
  desktopScreenshotPath: string | null;
  mobileScreenshotPath: string | null;
};

export const TOOL_PROFILES: Record<ToolProfile, string[]> = {
  research: ["terminal", "file", "browser", "vision", "web_search"],
  build: ["terminal", "file"],
  qa: ["terminal", "file", "vision"],
  visual_review: ["terminal", "file", "vision"],
  noop: [],
};

export function assertProfile(tool: string, profile: ToolProfile): void {
  const allowed = TOOL_PROFILES[profile];
  if (!allowed.includes(tool)) {
    throw new Error(`Tool '${tool}' is not allowed in ${profile}. Allowed: ${allowed.join(", ")}`);
  }
}

export function researchOutputDir(projectRoot: string): string {
  return `${projectRoot}/artifacts/research`;
}

export function qaOutputDir(projectRoot: string): string {
  return `${projectRoot}/artifacts/qa`;
}

export function defaultRepairPassCap(): number {
  return 2;
}

export function resolveResearchToolProfile(): { stage: Stage; tools: string[]; profile: ToolProfile } {
  return {
    stage: "stage_1_research",
    profile: "research",
    tools: TOOL_PROFILES.research,
  };
}

export function resolveBuildToolProfile(): { stage: Stage; tools: string[]; profile: ToolProfile } {
  return {
    stage: "stage_2_build",
    profile: "build",
    tools: TOOL_PROFILES.build,
  };
}

export function resolveQaToolProfile(): { stage: Stage; tools: string[]; profile: ToolProfile } {
  return {
    stage: "stage_3_qa",
    profile: "qa",
    tools: TOOL_PROFILES.qa,
  };
}

export function resolveVisualReviewProfile(): { stage: Stage; tools: string[]; profile: ToolProfile } {
  return {
    stage: "stage_3_qa",
    profile: "visual_review",
    tools: TOOL_PROFILES.visual_review,
  };
}

export function resolveProfileForAction(action?: string | null, executionProfile?: string | null): { stage: Stage; tools: string[]; profile: ToolProfile } {
  const normalizedAction = typeof action === "string" ? action.trim().toLowerCase() : "";
  const explicitProfile =
    typeof executionProfile === "string" && executionProfile.trim().length > 0
      ? executionProfile.trim().toLowerCase()
      : null;

  if (explicitProfile && explicitProfile in TOOL_PROFILES) {
    const profile = explicitProfile as ToolProfile;
    if (profile === "research") return resolveResearchToolProfile();
    if (profile === "qa") return resolveQaToolProfile();
    if (profile === "visual_review") return resolveVisualReviewProfile();
    if (profile === "build") return resolveBuildToolProfile();
  }

  if (["research", "asset research", "web research", "inspiration"].includes(normalizedAction)) {
    return resolveResearchToolProfile();
  }
  if (["generate", "fix", "rebuild", "build", "prepare"].includes(normalizedAction)) {
    return resolveBuildToolProfile();
  }
  if (["browserqa", "runqa", "local qa", "browser qa", "screenshot review"].includes(normalizedAction)) {
    return resolveQaToolProfile();
  }

  return resolveBuildToolProfile();
}

export const browserQaPolicy = Object.freeze({
  allowedHostRegex: /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/i,
  allowedPaths: ["/"],
  blockedScheme: ["file:", "chrome:", "about:"],
  maxAutoRepairPasses: 2,
  screenDir: (projectRoot: string) => `${projectRoot}/artifacts/qa`,
});

export const researchPolicy = Object.freeze({
  allowedTools: TOOL_PROFILES.research,
  requirePersonalCookiesDisabled: true,
  forbiddenTargets: [
    "gmail.com",
    "mail.google.com",
    "calendar.google.com",
    "accounts.google.com",
    ".edu",
    ".gov",
    "bank",
    "login",
    "oauth",
    "pay",
    "social.",
  ],
  maxExternalAssets: 20,
});

export const buildPolicy = Object.freeze({
  allowedTools: TOOL_PROFILES.build,
  maxTools: 2,
  minTools: 2,
  prohibitedActions: [
    "edit .env.local",
    "modify credentials",
    "push to main",
    "merge without approval",
    "deploy production",
    "modify production database",
  ],
});

export function browserQaPassed(checks: ArtifactQaCheck[]): boolean {
  return !checks.some((check) => check.status === "failed");
}

export function isLocalPreviewHost(hostname: string | URL | { hostname?: string }): boolean {
  const resolved =
    typeof hostname === "string" ? new URL(hostname).hostname : (hostname as { hostname?: string }).hostname ?? "";
  return browserQaPolicy.allowedHostRegex.test(resolved);
}

export function normalizeBrowserPolicyHost(browserHost: string | URL): string {
  const resolved = typeof browserHost === "string" ? new URL(browserHost) : browserHost;
  if (!isLocalPreviewHost(resolved)) {
    throw new Error(`Browser QA policy rejected non-localhost origin: ${resolved}`);
  }
  return resolved.host;
}

export function buildPolicyToolCompliance(tool: string, profile: ToolProfile): boolean {
  return TOOL_PROFILES[profile].includes(tool);
}

export function validateStageTransition(current: Stage, next: Stage): void {
  if (current === "complete" || current === "failed") {
    if (next !== current) throw new Error(`Cannot transition from ${current} without restart.`);
  }
  if (next === "stage_3_qa" && current !== "stage_2_build") {
    throw new Error(`Builder QA requires completed build stage. Current: ${current}`);
  }
}

export function validateArtifactPathing(path: string, stage: "research" | "qa"): void {
  if (stage === "research") {
    if (!/DESIGN_RESEARCH\.md$/.test(path)) {
      throw new Error("Research stage artifacts must end with DESIGN_RESEARCH.md.");
    }
  }
  if (stage === "qa") {
    const parsed = JSON.parse(path) as Partial<BuildArtifacts>;
    if (!parsed.desktopScreenshotPath && !parsed.mobileScreenshotPath) {
      throw new Error("QA artifacts require desktopScreenshotPath and mobileScreenshotPath.");
    }
  }
}

export function summarizeToolProfile(profile: ToolProfile): string {
  return `${profile}: ${TOOL_PROFILES[profile].join(" + ")}`;
}

export function isResearchProfle(profile: ToolProfile): boolean {
  return profile === "research";
}

export function isBuildProfile(profile: ToolProfile): boolean {
  return profile === "build";
}

export function isQaProfile(profile: ToolProfile): boolean {
  return profile === "qa" || profile === "visual_review";
}
