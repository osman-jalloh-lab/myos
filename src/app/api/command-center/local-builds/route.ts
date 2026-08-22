import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { withCanonicalBuilderStage } from "@/lib/builder-lifecycle";
import {
  generateLocalStarterApp,
  getCodexCliStatus,
  getLocalBuilderRootInfo,
  isServerlessRuntime,
  type LocalBuildProject,
  type LocalBuildProjectResponse,
  openLocalProjectFolder,
  prepareLocalBuildProject,
  queueLocalBuilderWorkerTask,
  rebuildLocalStarterApp,
  runLocalCodexExecutor,
  runLocalBuilderQa,
  serializeLocalBuildProject,
  startLocalDevServer,
  stopLocalDevServer,
} from "@/lib/local-builder";
import { redactInternalDetails } from "@/lib/hermes-execution/response-formatter";
import { getCodexCliReadiness, getHermesAgentReadiness, getLocalWorkerLiveness, workerOfflineNotice } from "@/lib/worker-watch";

// Build-shaped actions default to Codex CLI when it is ready on the worker.
// Hermes Agent is the eligible fallback.
// The local_worker executor is deterministic worker/template execution for
// prepare, preview, and QA work.
const CODER_ACTIONS = new Set(["generate", "rebuild", "build", "npmBuild", "runCodex"]);
const SUPPORTED_LOCAL_BUILD_ACTIONS = new Set(["prepare", "generate", "rebuild", "build", "npmBuild", "runCodex", "open", "startDev", "stopDev", "runQa"]);

function projectView(project: LocalBuildProject): LocalBuildProjectResponse & { route: null; taskCounts: { done: number; total: number } } {
  return {
    ...withCanonicalBuilderStage(serializeLocalBuildProject(project)),
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

function queuedResponse(project: ReturnType<typeof projectView>, action: string, notices: Array<string | null> = []) {
  const answer = [
    `Local Builder ${action} queued for ${project.projectName}.`,
    `Folder: ${project.localFolderPath}`,
    `Status: ${project.status}`,
    `Worker task: ${project.taskId}`,
    "Vercel/serverless did not touch the local filesystem or start local processes.",
    ...notices,
  ].filter(Boolean).join("\n");
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

  const body = (await req.json().catch(() => null)) as { action?: string; message?: string; projectId?: string; executor?: "codex_cli" | "local_worker" | "hermes_agent" } | null;
  const message = body?.message?.trim();
  const action = body?.action ?? "prepare";
  const projectId = body?.projectId;

  if (!SUPPORTED_LOCAL_BUILD_ACTIONS.has(action)) return NextResponse.json({ error: "Unsupported local builder action." }, { status: 400 });
  if (action !== "prepare" && !projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  // Codex CLI is the primary coder and Hermes Nous is its fallback. An explicit
  // `executor` in the request always wins. Either way
  // the response says which executor was actually assigned — never a silent swap.
  let selectedExecutor: "codex_cli" | "hermes_agent" | "local_worker";
  let executorNote: string | null = null;
  if (body?.executor === "codex_cli" || body?.executor === "hermes_agent" || body?.executor === "local_worker") {
    selectedExecutor = body.executor;
    executorNote = `Executor: ${selectedExecutor === "hermes_agent" ? "Hermes Nous" : selectedExecutor === "codex_cli" ? "Codex CLI" : "Local worker (deterministic worker/template execution)"} — explicitly requested.`;
  } else if (CODER_ACTIONS.has(action)) {
    const codex = await getCodexCliReadiness().catch(() => ({ ready: false, reason: "readiness check failed" }));
    const readiness = await getHermesAgentReadiness().catch(() => ({ ready: false, reason: "readiness check failed" }));
    if (codex.ready) {
      selectedExecutor = "codex_cli";
      executorNote = "Executor: Codex CLI (primary, reported available by the local worker). Hermes Agent is the eligible fallback.";
    } else if (readiness.ready) {
      selectedExecutor = "hermes_agent";
      executorNote = "Executor: Hermes Agent (fallback because Codex CLI is unavailable).";
    } else {
      selectedExecutor = "local_worker";
      executorNote = `Executor: Local worker (deterministic worker/template execution) — Codex CLI and Hermes Agent unavailable: ${readiness.reason}.`;
    }
  } else {
    selectedExecutor = "local_worker";
  }

  if (isServerlessRuntime() || selectedExecutor === "hermes_agent" || selectedExecutor === "codex_cli") {
    let queued: LocalBuildProject | null;
    try {
      queued = await queueLocalBuilderWorkerTask(session.user.id, action, message ?? "", projectId, selectedExecutor);
    } catch (error) {
      return NextResponse.json({ error: redactInternalDetails(error instanceof Error ? error.message : String(error)) }, { status: 409 });
    }
    if (!queued) {
      return NextResponse.json(
        { error: "Not a local build request. Try: Build a website called MyProject" },
        { status: 400 }
      );
    }
    // Tell Osman explicitly when the queued task has no live worker to run it,
    // instead of replying as if the build is in motion.
    const liveness = await getLocalWorkerLiveness().catch(() => null);
    const notice = liveness ? workerOfflineNotice(liveness) : null;
    return queuedResponse(projectView(queued), action, [executorNote, notice]);
  }

  if (action === "generate") {
    if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
    let project: LocalBuildProject;
    try {
      project = await generateLocalStarterApp(session.user.id, projectId!, message);
    } catch (error) {
      return NextResponse.json({ error: redactInternalDetails(error instanceof Error ? error.message : String(error)) }, { status: 409 });
    }
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
    let project: LocalBuildProject;
    try {
      project = await rebuildLocalStarterApp(session.user.id, projectId!);
    } catch (error) {
      return NextResponse.json({ error: redactInternalDetails(error instanceof Error ? error.message : String(error)) }, { status: 409 });
    }
    return responseFor(projectView(project), "rebuild", project.status === "Build Failed");
  }

  if (action === "runQa") {
    const project = await runLocalBuilderQa(session.user.id, projectId!);
    return responseFor(projectView(project), "runQa");
  }

  if (action === "runCodex") {
    const improvementPrompt = message || "Improve this local app so it feels complete, polished, interactive, and ready to pass the Builder QA checklist.";
    let project: LocalBuildProject;
    try {
      project = await runLocalCodexExecutor(session.user.id, projectId!, improvementPrompt);
    } catch (error) {
      return NextResponse.json({ error: redactInternalDetails(error instanceof Error ? error.message : String(error)) }, { status: 409 });
    }
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
      "Ready for Generate app and QA.",
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
