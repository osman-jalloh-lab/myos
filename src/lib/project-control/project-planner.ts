import crypto from "node:crypto";
import { getCapabilitySnapshot } from "@/lib/hermes-execution/capabilities";
import { getRegisteredSkills } from "@/lib/skills/registry";

export type CapabilityRequirement = {
  name: string;
  type: "skill" | "tool" | "runtime" | "credential" | "agent";
  required?: boolean;
  ownerAgent?: string;
};

export type CouncilOption = {
  id: string;
  label: string;
  description: string;
};

export type ReviewerNote = {
  reviewer: string;
  position: string;
  dissent?: string;
};

export type CouncilDecision = {
  id: string;
  title: string;
  summary: string;
  selectedDirection: string;
  rationale: string;
  requirements: string[];
  outOfScope: string[];
  deliverables: string[];
  requiredCapabilities: CapabilityRequirement[];
  recommendedAgents: string[];
  risks: string[];
  needsUserChoice: boolean;
  options: CouncilOption[];
  reviewerNotes: ReviewerNote[];
  revision: number;
};

export type PlannedProjectTask = {
  title: string;
  description?: string;
  assignedAgent?: string;
  responsibleAgent?: string;
  priority?: "low" | "medium" | "high";
  acceptanceCriteria?: string;
  requiredCapabilities?: CapabilityRequirement[];
  outputContract?: string;
  dependsOn?: string[];
};

export type ProposedProjectPlan = {
  title: string;
  summary: string;
  requestFingerprint: string;
  requiredCapabilities: CapabilityRequirement[];
  tasks: PlannedProjectTask[];
  needsCouncil: boolean;
  needsUserChoice: boolean;
};

export type CapabilityResolutionState =
  | "available"
  | "available_but_weak"
  | "missing_skill"
  | "missing_tool"
  | "missing_runtime"
  | "missing_credential";

export type CapabilityResolution = CapabilityRequirement & {
  state: CapabilityResolutionState;
  reason: string;
  matchingSkillId?: string;
};

export function requestFingerprint(request: string): string {
  return crypto.createHash("sha256").update(request.trim().toLowerCase()).digest("hex");
}

export function shouldUseCouncil(request: string): boolean {
  const text = request.toLowerCase();
  if (/\b(debate|council|multiple opinions|argue|compare directions)\b/.test(text)) return true;
  if (/\b(platform|operating system|multi-agent|marketplace|payments|medical|legal|finance|compliance)\b/.test(text)) return true;
  return /\b(ambiguous|high risk|expensive|architecture|multi-domain|enterprise)\b/.test(text);
}

export function extractCapabilityRequirements(request: string): CapabilityRequirement[] {
  const text = request.toLowerCase();
  const requirements: CapabilityRequirement[] = [
    { name: "project-planning", type: "skill", ownerAgent: "project-manager", required: true },
  ];
  if (/\b(site|website|web app|landing page|dashboard|portal)\b/.test(text)) {
    requirements.push({ name: "local-build", type: "tool", ownerAgent: "prometheus", required: true });
    requirements.push({ name: "design-review", type: "skill", ownerAgent: "fugu", required: true });
    requirements.push({ name: "browser-qa", type: "tool", ownerAgent: "argus", required: true });
  }
  const deploymentProhibited = /\b(?:do not|don't|never|no)\s+(?:commit,?\s*push,?\s*)?(?:or\s+)?deploy\b/.test(text)
    || /\bdo not\b[^.]{0,100}\b(?:deploy|production data)\b/.test(text);
  if (!deploymentProhibited && /\b(deploy|production|domain|vercel)\b/.test(text)) {
    requirements.push({ name: "deployment", type: "tool", ownerAgent: "prometheus", required: true });
  }
  if (/\b(email|gmail|reply|inbox)\b/.test(text)) {
    requirements.push({ name: "gmail", type: "credential", ownerAgent: "iris", required: true });
  }
  return requirements;
}

export function createDeterministicProjectPlan(request: string, decision?: CouncilDecision | null): ProposedProjectPlan {
  const title = decision?.title ?? request.replace(/[.!?]+$/, "").slice(0, 90);
  const requiredCapabilities = decision?.requiredCapabilities?.length
    ? decision.requiredCapabilities
    : extractCapabilityRequirements(request);
  const isWebBuild = /\b(page|site|website|web app|landing page|dashboard|portal|route)\b/i.test(request);
  const baseTasks: PlannedProjectTask[] = [
    {
      title: "Confirm project direction",
      description: decision?.selectedDirection ?? request,
      assignedAgent: "project-manager",
      responsibleAgent: "project-manager",
      acceptanceCriteria: "Accepted plan exists with scope and deliverables.",
      outputContract: "ProjectPlan",
    },
    ...(!isWebBuild ? [{
      title: "Prepare implementation brief",
      description: "Translate the accepted plan into a build-ready brief with requirements, constraints, and acceptance checks.",
      assignedAgent: "sophos",
      responsibleAgent: "project-manager",
      acceptanceCriteria: "Research or product brief is attached to the project.",
      outputContract: "research_artifact",
      dependsOn: ["Confirm project direction"],
    } satisfies PlannedProjectTask] : []),
    {
      title: "Build first implementation",
      description: "Create the first working version using registered local build/runtime tools.",
      assignedAgent: "prometheus",
      responsibleAgent: "project-manager",
      acceptanceCriteria: isWebBuild
        ? `A page exists at ${request.match(/\/(?!command-center\b)[a-z0-9][a-z0-9-]*/i)?.[0] ?? "/project-control-demo"}; The page contains a visible heading; The page renders three project-status cards; The page contains a progress indicator; The page links back to Command Center.`
        : "Build output exists.",
      outputContract: "code_diff",
      requiredCapabilities,
      dependsOn: [isWebBuild ? "Confirm project direction" : "Prepare implementation brief"],
    },
    ...(isWebBuild ? [{
      title: "Review implementation design",
      description: "Review real implementation evidence for hierarchy, spacing, responsive behavior, consistency, accessibility, focus, contrast, and broken elements.",
      assignedAgent: "fugu",
      responsibleAgent: "project-manager",
      acceptanceCriteria: "Design review has no unresolved required findings.",
      outputContract: "design_review",
      dependsOn: ["Build first implementation"],
    } satisfies PlannedProjectTask] : []),
    {
      title: "Validate deliverable",
      description: "Run actual TypeScript, test, and production build commands before marking the project done.",
      assignedAgent: "argus",
      responsibleAgent: "project-manager",
      acceptanceCriteria: "TypeScript passes; Tests pass; Production build passes.",
      outputContract: "qa_result",
      dependsOn: [isWebBuild ? "Review implementation design" : "Build first implementation"],
    },
  ];
  return {
    title,
    summary: decision?.summary ?? `Project plan for: ${request}`,
    requestFingerprint: requestFingerprint(request),
    requiredCapabilities,
    tasks: baseTasks,
    needsCouncil: shouldUseCouncil(request),
    needsUserChoice: Boolean(decision?.needsUserChoice),
  };
}

export async function resolveCapabilities(userId: string, requirements: CapabilityRequirement[]): Promise<CapabilityResolution[]> {
  const [snapshot, skills] = await Promise.all([
    getCapabilitySnapshot().catch(() => null),
    getRegisteredSkills(userId).catch(() => []),
  ]);
  const skillText = skills.map((skill) => `${skill.id} ${skill.name} ${skill.description} ${skill.tags.join(" ")}`.toLowerCase());
  const toolNames = new Set(snapshot?.tools.map((tool) => tool.name.toLowerCase()) ?? []);
  const workerReady = snapshot?.worker.status === "online";

  return requirements.map((requirement) => {
    const name = requirement.name.toLowerCase();
    if (["project-planning", "local-build", "design-review", "browser-qa"].includes(name)) {
      return { ...requirement, state: "available", reason: "A built-in project-control runtime adapter provides this capability." };
    }
    if (requirement.type === "credential") {
      return { ...requirement, state: "missing_credential", reason: "Credential availability must be resolved by the setup/health workflow, not Skill Agency." };
    }
    if (requirement.type === "runtime") {
      return workerReady
        ? { ...requirement, state: "available", reason: "Required runtime is online." }
        : { ...requirement, state: "missing_runtime", reason: "Required runtime is offline or stale." };
    }
    if (requirement.type === "tool") {
      const exact = toolNames.has(name)
        || [...toolNames].some((tool) => tool.includes(name) || name.includes(tool))
        || (name.includes("local-build") && Boolean(snapshot?.buildExecution.available));
      return exact
        ? { ...requirement, state: "available", reason: "Registered execution tool is available." }
        : { ...requirement, state: "missing_tool", reason: "No matching registered execution tool was found." };
    }
    const index = skillText.findIndex((text) => text.includes(name.replace(/-/g, " ")));
    if (index >= 0) return { ...requirement, state: "available", reason: "Matching skill is registered.", matchingSkillId: skills[index]?.id };
    return { ...requirement, state: "missing_skill", reason: "No matching skill is registered." };
  });
}
