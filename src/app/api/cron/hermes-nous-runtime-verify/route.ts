import { prisma } from "@/lib/db";
import { cronGuard } from "@/lib/cron-auth";
import { getHealthCenterSnapshot } from "@/lib/health-center";

export async function GET(req: Request) {
  const denied = cronGuard(req);
  if (denied) return denied;

  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

  const snapshot = await getHealthCenterSnapshot(user.id);
  const runtime = snapshot.hermesNousRuntime;
  const serialized = JSON.stringify(runtime);
  const leaksRawUserPath = /Users[\\/]+osman|OneDrive[\\/]+Desktop|AppData[\\/]+Local/i.test(serialized);
  const leaksCredential = /(TOKEN|SECRET|PASSWORD|CREDENTIAL)\s*[:=]\s*(?!\[redacted\])/i.test(serialized);
  const workerExecutor = snapshot.executors.find((executor) => executor.name === "Local Worker");
  const hermesExecutor = snapshot.executors.find((executor) => executor.name === "Hermes Agent");

  return Response.json({
    ok: Boolean(runtime)
      && !leaksRawUserPath
      && !leaksCredential
      && runtime.installed === Boolean(hermesExecutor?.capabilities?.some((capability) => /Hermes Agent|Version|Executable/i.test(capability)))
      && typeof runtime.diagnostic === "string",
    runtime,
    workerExecutor,
    hermesExecutor,
    safety: {
      leaksRawUserPath,
      leaksCredential,
      copyDiagnosticIsSafe: !leaksRawUserPath && !leaksCredential,
    },
    checkedAt: new Date().toISOString(),
  });
}
