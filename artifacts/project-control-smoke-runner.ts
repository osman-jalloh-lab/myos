import { prisma } from "../src/lib/db";
import { handleProjectControlChat } from "../src/lib/project-control/chat-workflow";
import { dispatchQueuedWakeups, finishWakeup } from "../src/lib/project-control/wakeup-dispatcher";
import { decomposeAcceptedPlan } from "../src/lib/project-control/project-manager";
import { executeClaimedWakeup } from "../src/lib/project-control/wakeup-executor";

const REQUEST = 'Build a simple page at `/project-control-smoke`. Heading "Project Control Smoke Test"; three status cards (Planning, Building, Complete); 60% progress bar; link back to `/command-center`; responsive. Do not commit, push, deploy, send messages, or access production data.';
const userId = "smoke-user-local-only";

function out(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

async function snapshot(projectId: string) {
  const [project, plans, decompositions, tasks, dependencies, wakeups, runs, artifacts] = await Promise.all([
    prisma.project.findUnique({ where: { id: projectId } }),
    prisma.projectPlan.findMany({ where: { projectId }, orderBy: { revision: "asc" } }),
    prisma.projectPlanDecomposition.findMany({ where: { projectId } }),
    prisma.projectTask.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    prisma.projectTaskDependency.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
    prisma.agentWakeup.findMany({ where: { projectId }, orderBy: { requestedAt: "asc" } }),
    prisma.executionRun.findMany({ where: { projectId }, orderBy: { startedAt: "asc" } }),
    prisma.projectTaskArtifact.findMany({ where: { projectId }, orderBy: { createdAt: "asc" } }),
  ]);
  return { project, plans, decompositions, tasks, dependencies, wakeups, runs, artifacts };
}

async function main() {
  process.env.HERMES_PROJECT_WORKSPACE = process.cwd();
  await prisma.user.create({ data: { id: userId, primaryEmail: "smoke-local@example.invalid", name: "Local Smoke" } });
  out("EXACT REQUEST", REQUEST);
  const proposed = await handleProjectControlChat({ userId, message: REQUEST });
  out("PROPOSED RESPONSE", proposed);
  if (!proposed.projectId || !proposed.planId) throw new Error("Project workflow did not return project and plan IDs.");
  const projectId = proposed.projectId;
  const planId = proposed.planId;
  const beforeApproval = await snapshot(projectId);
  out("BEFORE APPROVAL", beforeApproval);

  const approvalMessage = `project-control:approve-plan:${projectId}:${planId}`;
  const approved = await handleProjectControlChat({ userId, message: approvalMessage });
  out("APPROVAL RESPONSE", approved);
  out("AFTER APPROVAL PASS 1", await snapshot(projectId));

  for (let pass = 1; pass <= 10; pass++) {
    const result = await dispatchQueuedWakeups({ userId, projectId, limit: 6 });
    out(`DISPATCH PASS ${pass}`, result);
    if (result.checked === 0) break;
  }
  const completed = await snapshot(projectId);
  out("COMPLETED SNAPSHOT", completed);

  const finalReport = await handleProjectControlChat({ userId, message: `project-control:dispatch:${projectId}:${planId}` });
  out("HERMES FINAL USER REPORT", finalReport.answer);

  const countsBefore = {
    decomposition: completed.decompositions.length,
    tasks: completed.tasks.length,
    dependencies: completed.dependencies.length,
    wakeups: completed.wakeups.length,
    artifacts: completed.artifacts.length,
  };
  const secondApproval = await handleProjectControlChat({ userId, message: approvalMessage });
  const directDecomposition = await decomposeAcceptedPlan({ userId, projectId, planId });
  const redispatch = await dispatchQueuedWakeups({ userId, projectId, limit: 20 });
  const firstWakeup = completed.wakeups[0];
  if (firstWakeup) await finishWakeup(firstWakeup.id, { replay: true, originalCompletionPreserved: true });
  const prometheusWakeup = completed.wakeups.find((item) => item.agentKey === "prometheus");
  const retry = prometheusWakeup ? await executeClaimedWakeup(prometheusWakeup.id) : null;
  const afterReplay = await snapshot(projectId);
  const countsAfter = {
    decomposition: afterReplay.decompositions.length,
    tasks: afterReplay.tasks.length,
    dependencies: afterReplay.dependencies.length,
    wakeups: afterReplay.wakeups.length,
    artifacts: afterReplay.artifacts.length,
  };
  out("IDEMPOTENCY EVIDENCE", { countsBefore, countsAfter, secondApproval, directDecompositionId: directDecomposition.id, redispatch, retry, zeroDuplicateCounts: JSON.stringify(countsBefore) === JSON.stringify(countsAfter) });
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
