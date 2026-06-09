import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { approvalCounts, listApprovals } from "@/lib/approvals";
import { listTasks } from "@/lib/tasks";
import { plutusReport } from "@/agents/plutus";
import CommandCenterClient from "./CommandCenterClient";

export const dynamic = "force-dynamic";

export default async function CommandCenterPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/api/auth/signin");

  const userId = session.user.id;
  const userName = session.user.name?.split(" ")[0] ?? "Osman";

  const [apprActions, apprCounts, tasks, finReport] = await Promise.all([
    listApprovals(userId, "pending"),
    approvalCounts(userId),
    listTasks(userId, { status: "open" }),
    plutusReport(userId).catch(() => null),
  ]);

  return (
    <CommandCenterClient
      userName={userName}
      pendingApprovals={apprActions}
      approvalCounts={apprCounts}
      tasks={tasks}
      finIncome={finReport?.finance.income ?? 0}
      finExpenses={finReport?.finance.expenses ?? 0}
    />
  );
}
