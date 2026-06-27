import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  generateLocalStarterApp,
  getCodexCliStatus,
  getLocalBuilderRootInfo,
  isServerlessRuntime,
  type LocalBuildProject,
  openLocalProjectFolder,
  prepareLocalBuildProject,
  queueLocalBuilderWorkerTask,
  rebuildLocalStarterApp,
  runLocalCodexExecutor,
  runLocalFuguDesignReview,
  runLocalBuilderQa,
  startLocalDevServer,
  stopLocalDevServer,
} from "@/lib/local-builder";
import { redactInternalDetails } from "@/lib/hermes-execution/response-formatter";

function projectView(project: LocalBuildProject) {
  return {
    ...project,
    route: null,
    taskCounts: { done: project.status === "completed" ? 1 : 0, total: 1 },
  };
}

function responseFor(project: ReturnType<typeof projectView>, action: string, failed = false) {
  const answer = [
    `Local Builder ${action} ${failed ? "failed" : "completed"} for ${project.projectName}.`,
    `Folder: ${project.localFolderPath}`,
    project.localDevUrl ? `URL: ${project.localDevUrl}` : null,
    `Status: ${project.status}`,
    project.researchBrief ? "Athena brief: ready" : null,
    project.designReview ? `Fugu design review: ready${project.designScore ? ` (${project.designScore}/10)` : ""}` : null,
    project.polishReview ? "Fugu polish review: ready" : null,
    project.qaStatus ? `QA: ${project.qaStatus}` : null,
    project.buildError ? `First error: ${project.buildError}` : null,
  ].filter(Boolean).join("\n");
  return NextResponse.json({
    status: failed ? "failed" : "completed",
    answer: redactInternalDetails(answer),
    project,
    toolCalls: [
      {
        id: `local_build_${action}`,
        tool: "Local Builder",
        status: failed ? "failed" : "completed",
        error: project.buildError ? redactInternalDetails(project.buildError) : undefined,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
    artifacts: project.localDevUrl ? [{ type: "link", title: "Local preview", url: project.localDevUrl }] : [],
  }, { status: failed ? 500 : 200 });
}

function queuedResponse(project: ReturnType<typeof projectView>, action: string) {
  const answer = [
    `Local Builder ${action} queued for ${project.projectName}.`,
    `Folder: ${project.localFolderPath}`,
    `Status: ${project.status}`,
    `Worker task: ${project.taskId}`,
    "Vercel/serverless did not touch the local filesystem or start local processes.",
  ].join("\n");
  return NextResponse.json({
    status: "queued",
    answer: redactInternalDetails(answer),
    project,
    toolCalls: [
      {
        id: `local_build_${action}_queued`,
        tool: "Local Builder",
        status: "queued",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
    artifacts: [],
  });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const [root, codex] = await Promise.all([getLocalBuilderRootInfo(), getCodexCliStatus()]);
  return NextResponse.json({ root, codex });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { action?: string; message?: string; projectId?: string; executor?: "local_worker" | "hermes_agent" } | null;
  const message = body?.message?.trim();
  const action = body?.action ?? "prepare";
  const projectId = body?.projectId;

  if (action !== "prepare" && !projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  const selectedExecutor = body?.executor === "hermes_agent" ? "hermes_agent" : "local_worker";
  if (isServerlessRuntime() || selectedExecutor === "hermes_agent") {
    const queued = await queueLocalBuilderWorkerTask(session.user.id, action, message ?? "", projectId, selectedExecutor);
    if (!queued) {
      return NextResponse.json(
        { error: "Not a local build request. Try: Build a website called MyProject" },
        { status: 400 }
      );
    }
    return queuedResponse(projectView(queued), action);
  }

  if (action === "generate") {
    if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
    const project = await generateLocalStarterApp(session.user.id, projectId!, message);
    const failed = project.status === "Build Failed";
    const view = projectView(project);
    return NextResponse.json({
      status: failed ? "failed" : "completed",
      answer: redactInternalDetails([
        `Research-to-Build pipeline ${failed ? "failed" : "generated"} ${project.projectName}.`,
        `Folder: ${project.localFolderPath}`,
        `Status: ${project.status}`,
        `Current task: ${project.currentTask}`,
        project.researchBrief ? "Athena brief used: yes" : "Athena brief used: no",
        project.designReview ? "Fugu design review used: yes" : "Fugu design review used: no",
        project.polishReview ? "Fugu polish review: ready" : "Fugu polish review: pending",
        project.qaStatus ? `QA status: ${project.qaStatus}` : "QA status: pending",
        project.buildError ? `First error: ${project.buildError}` : "npm install and npm run build passed. QA checklist is required before completion.",
      ].join("\n")),
      project: view,
      toolCalls: [{ id: "local_build_generate", tool: "Local Builder", status: failed ? "failed" : "completed", error: project.buildError ? redactInternalDetails(project.buildError) : undefined, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
      artifacts: (project.files ?? []).map((file) => ({ type: "file", title: file, metadata: { projectId: project.id, localFolderPath: project.localFolderPath, status: project.status } })),
    }, { status: failed ? 500 : 200 });
  }

  if (action === "open") {
    const project = await openLocalProjectFolder(session.user.id, projectId!);
    return responseFor(projectView(project), "openFolder");
  }

  if (action === "startDev") {
    const project = await startLocalDevServer(session.user.id, projectId!);
    return responseFor(projectView(project), "startDevServer");
  }

  if (action === "stopDev") {
    const project = await stopLocalDevServer(session.user.id, projectId!);
    return responseFor(projectView(project), "stopDevServer");
  }

  if (action === "rebuild") {
    const project = await rebuildLocalStarterApp(session.user.id, projectId!);
    return responseFor(projectView(project), "rebuild", project.status === "Build Failed");
  }

  if (action === "fuguDesignReview") {
    const project = await runLocalFuguDesignReview(session.user.id, projectId!);
    return responseFor(projectView(project), "fuguDesignReview");
  }

  if (action === "runQa") {
    const project = await runLocalBuilderQa(session.user.id, projectId!);
    return responseFor(projectView(project), "runQa");
  }

  if (action === "runCodex") {
    const improvementPrompt = message || "Improve this local app so it feels complete, polished, interactive, and ready to pass the Builder QA checklist.";
    const project = await runLocalCodexExecutor(session.user.id, projectId!, improvementPrompt);
    return responseFor(projectView(project), "runCodex", project.status === "failed");
  }

  if (!message) {
    return NextResponse.json({ error: "message is required" }, { status: 400 });
  }

  const project = await prepareLocalBuildProject(session.user.id, message);
  if (!project) {
    return NextResponse.json(
      {
        error: "Not a local build request. Try: Build a website called MyProject",
      },
      { status: 400 }
    );
  }

  const view = projectView(project);

  return NextResponse.json({
    status: "completed",
    answer: redactInternalDetails([
      `Athena researched and Local Builder prepared ${project.projectName}.`,
      `Folder: ${project.localFolderPath}`,
      `Status: ${project.status}`,
      `Current task: ${project.currentTask}`,
      "",
      "Athena research brief is ready.",
      "Fugu design review is optional. Run Fugu Design Review when the app feels too basic.",
      "",
      "Ready for Generate app.",
    ].join("\n")),
    project: view,
    toolCalls: [
      {
        id: "local_build_prepare",
        tool: "Local Builder",
        status: "completed",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
    artifacts: [
      {
        type: "research_brief",
        title: `Athena research brief for ${project.projectName}`,
        content: project.researchBrief ?? undefined,
        metadata: {
          projectId: project.id,
          status: project.status,
        },
      },
      {
        type: "design_review",
        title: `Fugu design review for ${project.projectName}`,
        content: project.designReview ?? undefined,
        metadata: {
          projectId: project.id,
          status: project.status,
          designScore: project.designScore,
        },
      },
      {
        type: "task",
        title: project.currentTask,
        id: project.taskId,
        metadata: {
          projectId: project.id,
          localFolderPath: project.localFolderPath,
          status: project.status,
        },
      },
    ],
  });
}
