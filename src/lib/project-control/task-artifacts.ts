import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { redactExecutionText } from "@/lib/execution-runs";

export type ProjectTaskArtifactType =
  | "research_report"
  | "design_review"
  | "code_diff"
  | "commit"
  | "build_result"
  | "test_result"
  | "deployment"
  | "communication_draft"
  | "skill_candidate"
  | "skill_adapter"
  | "capability_resolution"
  | "completion_report";

export type AgentProducedArtifact = {
  type: ProjectTaskArtifactType;
  title: string;
  summary?: string;
  content?: string;
  safeLocation?: string;
  metadata?: Record<string, unknown>;
};

export type AcceptanceEvidence = {
  type: string;
  summary: string;
  artifactTitle?: string;
  passed?: boolean;
};

export type TaskArtifactContext = {
  id: string;
  type: string;
  title: string;
  summary: string | null;
  safeLocation: string | null;
  createdAt: string;
};

function hashArtifact(input: Pick<AgentProducedArtifact, "type" | "title" | "summary" | "content" | "safeLocation">): string {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function safeMetadata(value: Record<string, unknown> | undefined): string | null {
  if (!value) return null;
  return redactExecutionText(value, 4000);
}

export async function persistTaskArtifacts(params: {
  userId: string;
  projectId: string;
  projectTaskId: string;
  executionRunId: string;
  wakeupId: string;
  agentKey: string;
  artifacts: AgentProducedArtifact[];
}) {
  const rows = [];
  for (const artifact of params.artifacts) {
    const content = artifact.content ? redactExecutionText(artifact.content, 8000) : null;
    const summary = artifact.summary ? redactExecutionText(artifact.summary, 1200) : null;
    const row = await prisma.projectTaskArtifact.create({
      data: {
        projectId: params.projectId,
        projectTaskId: params.projectTaskId,
        executionRunId: params.executionRunId,
        wakeupId: params.wakeupId,
        agentKey: params.agentKey,
        artifactType: artifact.type,
        title: redactExecutionText(artifact.title, 240),
        summary,
        content,
        safeLocation: artifact.safeLocation ? redactExecutionText(artifact.safeLocation, 500) : null,
        contentHash: hashArtifact({ ...artifact, content: content ?? undefined, summary: summary ?? undefined }),
        source: "agent_runtime",
        metadata: safeMetadata(artifact.metadata),
      },
    });
    rows.push(row);
  }
  return rows;
}

export async function listTaskArtifactContext(projectId: string): Promise<TaskArtifactContext[]> {
  const rows = await prisma.projectTaskArtifact.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  return rows.map((row) => ({
    id: row.id,
    type: row.artifactType,
    title: row.title,
    summary: row.summary,
    safeLocation: row.safeLocation,
    createdAt: row.createdAt.toISOString(),
  }));
}
