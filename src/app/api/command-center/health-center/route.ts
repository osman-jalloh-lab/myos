import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { apiProviderSeverity, createHealthLog, getApiProviderHealth, getHealthCenterSnapshot, logHealthSnapshot } from "@/lib/health-center";
import { GET as runJobScout } from "@/app/api/cron/job-scout/route";
import { GET as runEmailScout } from "@/app/api/cron/email-watcher/route";
import { GET as runSkillScout } from "@/app/api/cron/skills-scout/route";

type HealthAction =
  | "refreshHealth"
  | "checkAllConnections"
  | "runJobScout"
  | "runEmailScout"
  | "runSkillScout"
  | "testApiKeys";

function cronRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` },
  });
}

async function runCronAction(action: HealthAction): Promise<{ ok: boolean; message: string }> {
  if (!process.env.CRON_SECRET) {
    return { ok: false, message: "CRON_SECRET is not configured; scout action was not run." };
  }

  const started = Date.now();
  const response =
    action === "runJobScout" ? await runJobScout(cronRequest("/api/cron/job-scout")) :
    action === "runEmailScout" ? await runEmailScout(cronRequest("/api/cron/email-watcher")) :
    action === "runSkillScout" ? await runSkillScout(cronRequest("/api/cron/skills-scout")) :
    null;

  if (!response) return { ok: false, message: "Unsupported health action." };
  const body = await response.text().catch(() => "");
  const runtime = Date.now() - started;
  return {
    ok: response.ok,
    message: `${action} returned ${response.status} in ${runtime}ms${body ? `: ${body.slice(0, 500)}` : ""}`,
  };
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json(await getHealthCenterSnapshot(session.user.id));
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as { action?: HealthAction } | null;
  const action = body?.action ?? "refreshHealth";

  if (action === "checkAllConnections" || action === "refreshHealth") {
    const snapshot = await getHealthCenterSnapshot(session.user.id);
    if (action === "checkAllConnections") {
      for (const account of snapshot.accounts) {
        await createHealthLog(
          account.name,
          account.connected && !account.lastError ? "healthy" : account.reconnectRequired ? "failure" : "warning",
          account.lastError ?? `${account.name} connection checked.`
        );
      }
    } else {
      await logHealthSnapshot(snapshot);
    }
    return NextResponse.json(await getHealthCenterSnapshot(session.user.id));
  }

  if (["runJobScout", "runEmailScout", "runSkillScout"].includes(action)) {
    const result = await runCronAction(action);
    await createHealthLog(action, result.ok ? "healthy" : "failure", result.message);
    return NextResponse.json({
      ...(await getHealthCenterSnapshot(session.user.id)),
      actionResult: result,
    }, { status: result.ok ? 200 : 500 });
  }

  if (action === "testApiKeys") {
    const runs = await import("@/lib/db").then(({ prisma }) => prisma.agentRun.findMany({ orderBy: { createdAt: "desc" }, take: 250 }));
    const apiProviders = await getApiProviderHealth(session.user.id, runs, true);
    await createHealthLog(
      "api-providers",
      apiProviders.some((provider) => apiProviderSeverity(provider) === "failure") ? "failure" : apiProviders.some((provider) => apiProviderSeverity(provider) === "warning") ? "warning" : "healthy",
      apiProviders.map((provider) => `${provider.provider}: ${provider.status}`).join(" | ")
    );
    return NextResponse.json({
      ...(await getHealthCenterSnapshot(session.user.id)),
      apiProviders,
      actionResult: {
        ok: true,
        message: "API key tests completed. Restart npm run dev after local .env.local changes; redeploy after Vercel env changes.",
      },
    });
  }

  return NextResponse.json({ error: "Unsupported health action" }, { status: 400 });
}
