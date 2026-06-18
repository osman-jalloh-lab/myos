// Vercel Cron: github-scout. Schedule defined in vercel.json (weekly, UTC).
// Runs Athena's read-only github-scout tool against a fixed set of search terms
// aligned with Osman's GRC/security direction, and logs the run for the
// dashboard. PUBLIC data, no auth, no writes — pure signal surfacing.
import { prisma } from "@/lib/db";
import { githubScout } from "@/agents/athena";

const SCOUT_QUERIES = ["GRC compliance security tooling", "security audit automation"];

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const results = await Promise.allSettled(
    SCOUT_QUERIES.map(async (query) => ({ query, repos: await githubScout(query) }))
  );

  const found = results
    .filter((r): r is PromiseFulfilledResult<{ query: string; repos: Awaited<ReturnType<typeof githubScout>> }> => r.status === "fulfilled")
    .map((r) => r.value);

  const summary = found
    .map((f) => `"${f.query}": ${f.repos.map((r) => r.fullName).join(", ") || "(no results)"}`)
    .join(" · ");

  await prisma.agentRun.create({
    data: {
      agentName: "athena",
      inputSummary: `github-scout queries: ${SCOUT_QUERIES.join(" | ")}`,
      outputSummary: summary.slice(0, 2000),
      status: "completed",
    },
  });

  return Response.json({ ok: true, job: "github-scout", found });
}
