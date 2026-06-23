import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import {
  generateLocalStarterApp,
  getLocalBuilderRootInfo,
  type LocalBuildProject,
  openLocalProjectFolder,
  prepareLocalBuildProject,
  rebuildLocalStarterApp,
  startLocalDevServer,
  stopLocalDevServer,
} from "@/lib/local-builder";

function projectView(project: LocalBuildProject) {
  return {
    ...project,
    route: null,
    taskCounts: { done: project.status === "Build Passed" || project.status === "Dev Server Running" ? 1 : 0, total: 1 },
  };
}

function responseFor(project: ReturnType<typeof projectView>, action: string, failed = false) {
  return NextResponse.json({
    status: failed ? "failed" : "completed",
    answer: [
      `Local Builder ${action} ${failed ? "failed" : "completed"} for ${project.projectName}.`,
      `Folder: ${project.localFolderPath}`,
      project.localDevUrl ? `URL: ${project.localDevUrl}` : null,
      `Status: ${project.status}`,
      project.buildError ? `First error: ${project.buildError}` : null,
    ].filter(Boolean).join("\n"),
    project,
    toolCalls: [
      {
        id: `local_build_${action}`,
        tool: `internal.localBuilder.${action}`,
        status: failed ? "failed" : "completed",
        error: project.buildError ?? undefined,
        result: project,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
    artifacts: project.localDevUrl ? [{ type: "link", title: "Local preview", url: project.localDevUrl }] : [],
  }, { status: failed ? 500 : 200 });
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({ root: await getLocalBuilderRootInfo() });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { action?: string; message?: string; projectId?: string } | null;
  const message = body?.message?.trim();
  const action = body?.action ?? "prepare";
  const projectId = body?.projectId;

  if (action !== "prepare" && !projectId) return NextResponse.json({ error: "projectId is required" }, { status: 400 });

  if (action === "generate") {
    if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });
    const project = await generateLocalStarterApp(session.user.id, projectId!, message);
    const failed = project.status === "Build Failed";
    const view = projectView(project);
    return NextResponse.json({
      status: failed ? "failed" : "completed",
      answer: [
        `Local Builder v2 ${failed ? "failed" : "generated"} ${project.projectName}.`,
        `Folder: ${project.localFolderPath}`,
        `Status: ${project.status}`,
        `Current task: ${project.currentTask}`,
        project.buildError ? `First error: ${project.buildError}` : "npm install and npm run build passed.",
      ].join("\n"),
      project: view,
      toolCalls: [{ id: "local_build_generate", tool: "internal.localBuilder.generateStarterApp", status: failed ? "failed" : "completed", error: project.buildError ?? undefined, result: project, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }],
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
    answer: [
      `Local Builder v1 prepared ${project.projectName}.`,
      `Folder: ${project.localFolderPath}`,
      `Status: ${project.status}`,
      `Current task: ${project.currentTask}`,
      "",
      "Ready for Generate app.",
    ].join("\n"),
    project: view,
    toolCalls: [
      {
        id: "local_build_prepare",
        tool: "internal.localBuilder.prepareProject",
        status: "completed",
        result: project,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    ],
    artifacts: [
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
