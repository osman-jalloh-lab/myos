const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i;
const DISALLOWED_FILE_PATTERNS = [
  /(^|\/)\.env(\.|$|\/)?/i,
  /(^|\/)(node_modules|dist|build|coverage|\.next)(\/|$)/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|\/)(secret|secrets|token|tokens)(\/|$)/i,
  /\.min\.(js|css)$/i,
  /(^|\/)(package-lock|yarn\.lock|pnpm-lock)\.yaml?$/i,
];
const EXECUTABLE_FILE_PATTERNS = /\.(mjs|cjs|js|ts|tsx|sh|ps1|bat|cmd|py|rb|go|rs)$/i;

export type ExternalSkillSourceInput = {
  repository: string;
  filePath: string;
  commitSha: string;
  trustLevel: "trusted" | "reviewed" | "untrusted";
  fileInventory: string[];
  requiredDependencies?: string[];
  requiredCredentials?: string[];
  permissionScope?: string;
  guidanceOnly?: boolean;
};

export type ExternalSkillSafetyResult = {
  allowed: boolean;
  guidanceOnly: boolean;
  requiresAdapterTask: boolean;
  reasons: string[];
};

export type SkillArmingInput = {
  guidanceOnly: boolean;
  toolExists: boolean;
  adapterValidationPassed: boolean;
  typecheckPassed: boolean;
  testsPassed: boolean;
  securityReviewPassed: boolean;
  approvalAccepted: boolean;
};

function hasDisallowedFile(path: string): boolean {
  return DISALLOWED_FILE_PATTERNS.some((pattern) => pattern.test(path.replace(/\\/g, "/")));
}

function isExecutablePath(path: string): boolean {
  return EXECUTABLE_FILE_PATTERNS.test(path);
}

export function evaluateExternalSkillSource(source: ExternalSkillSourceInput): ExternalSkillSafetyResult {
  const reasons: string[] = [];
  if (!COMMIT_SHA_PATTERN.test(source.commitSha)) reasons.push("External skill source must be pinned to an exact commit SHA.");
  if (hasDisallowedFile(source.filePath) || source.fileInventory.some(hasDisallowedFile)) {
    reasons.push("External skill source includes a disallowed file, secret-shaped file, dependency folder, build output, lockfile, or minified artifact.");
  }
  const executableFiles = [source.filePath, ...source.fileInventory].filter(isExecutablePath);
  const untrustedExecutable = source.trustLevel === "untrusted" && executableFiles.length > 0;
  if (untrustedExecutable) reasons.push("Executable files from untrusted sources must become adapter implementation tasks, not direct imports.");
  return {
    allowed: reasons.length === 0,
    guidanceOnly: source.guidanceOnly ?? true,
    requiresAdapterTask: untrustedExecutable,
    reasons,
  };
}

export function canArmSkillVersion(input: SkillArmingInput): { allowed: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (input.guidanceOnly) reasons.push("Guidance-only skills cannot invoke tools.");
  if (!input.toolExists) reasons.push("Required execution tool is not registered.");
  if (!input.adapterValidationPassed) reasons.push("Adapter validation has not passed.");
  if (!input.typecheckPassed) reasons.push("TypeScript validation has not passed.");
  if (!input.testsPassed) reasons.push("Skill evaluations or tests have not passed.");
  if (!input.securityReviewPassed) reasons.push("Security review has not passed.");
  if (!input.approvalAccepted) reasons.push("Executable arming requires accepted approval.");
  return { allowed: reasons.length === 0, reasons };
}
