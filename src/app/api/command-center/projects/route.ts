import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createClient } from "@libsql/client";

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

type DbRow = Record<string, unknown>;

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const userId = session.user.id;
  const db = getDb();

  const projectsRes = await db.execute({
    sql: `SELECT * FROM Project WHERE userId = ? ORDER BY updatedAt DESC LIMIT 20`,
    args: [userId],
  });

  const projects = await Promise.all(
    projectsRes.rows.map(async (r) => {
      const p = r as unknown as DbRow;
      const tasksRes = await db.execute({
        sql: `SELECT id, title, status, assignedAgent, nextStep FROM ProjectTask WHERE projectId = ? ORDER BY updatedAt DESC`,
        args: [p.id as string],
      });

      const taskCounts = { pending: 0, in_progress: 0, done: 0, total: 0 };
      const tasks = tasksRes.rows.map((t) => {
        const tr = t as unknown as DbRow;
        const status = tr.status as string;
        if (status === "pending") taskCounts.pending++;
        else if (status === "in_progress") taskCounts.in_progress++;
        else if (status === "done") taskCounts.done++;
        taskCounts.total++;
        return {
          id: tr.id as string,
          title: tr.title as string,
          status,
          assignedAgent: (tr.assignedAgent as string | null) ?? null,
          nextStep: (tr.nextStep as string | null) ?? null,
        };
      });

      const latestTask = tasks[0];

      return {
        id: p.id as string,
        projectName: p.projectName as string,
        description: (p.description as string | null) ?? null,
        route: (p.route as string | null) ?? null,
        localFolderPath: (p.localFolderPath as string | null) ?? null,
        buildLog: (p.localBuildLog as string | null) ?? null,
        buildError: (p.localBuildError as string | null) ?? null,
        localDevUrl: (p.localDevUrl as string | null) ?? null,
        localDevPid: (p.localDevPid as number | null) ?? null,
        status: (p.status as string) ?? "planning",
        latestInstruction: (p.latestInstruction as string | null) ?? null,
        currentTask: latestTask?.title ?? null,
        assignedAgent: (p.assignedAgent as string | null) ?? null,
        createdAt: p.createdAt as string,
        updatedAt: p.updatedAt as string,
        taskCounts,
        tasks,
      };
    })
  );

  return NextResponse.json({ projects });
}
