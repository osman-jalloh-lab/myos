import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { createTask, listTasks, assignTask } from "@/lib/tasks";
import { isTaskAssignableAgent, normalizeAgentKey } from "@/lib/agent-roster";

/**
 * GET  /api/tasks?agent=<name>&status=<status>  — list tasks, optionally scoped
 * POST /api/tasks                                — create a task, optionally
 *                                                   assigning it to an agent
 *
 * This is the "CEO layer" surface: Osman assigns work to an agent from the UI
 * (or types it in chat — see the assignment branch in Hermes.routeMessage()).
 * Either way it lands in the same Task table, same audit trail (AgentRun rows
 * via assignTask/delegateTask), nothing bypasses the agents' existing tools.
 */
export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(req.url);
  const agent = url.searchParams.get("agent") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const tasks = await listTasks(session.user.id, { agent, status });
  return NextResponse.json({ tasks });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const body = (await req.json().catch(() => null)) as
    | { title?: string; description?: string; assignedAgent?: string; priority?: string }
    | null;
  if (!body?.title?.trim()) {
    return NextResponse.json({ error: "title is required" }, { status: 400 });
  }
  const agent = body.assignedAgent?.trim().toLowerCase();
  if (agent && !isTaskAssignableAgent(agent)) {
    return NextResponse.json({ error: `unknown agent "${agent}"` }, { status: 400 });
  }
  const assignedAgent = agent ? normalizeAgentKey(agent) : null;

  const task = await createTask(session.user.id, {
    title: body.title.trim(),
    description: body.description?.trim() || undefined,
    priority: body.priority?.trim() || undefined,
    source: "dashboard",
  });
  if (!assignedAgent) return NextResponse.json({ task });

  const assigned = await assignTask(session.user.id, task.id, assignedAgent);
  return NextResponse.json({ task: assigned });
}
