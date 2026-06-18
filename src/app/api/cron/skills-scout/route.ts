// Vercel Cron: skills-scout. Schedule defined in vercel.json (weekly, UTC).
// Runs Sophos's three read-only scouting tools (release-watch, repo-scout,
// video-digest) over a fixed topic list aligned with Osman's GRC/security/AI
// direction, then synthesizes the findings into a digest via skill-brief.
// Pure read + synthesis — Sophos never installs or applies anything; the
// AgentRun row from skillBrief is the entire output, surfaced on the dashboard
// (and pingable to Telegram once Osman wants that wired in).
import { prisma } from "@/lib/db";
import { releaseWatch, repoScoutTool, videoDigestTool, skillBrief, SCOUT_TOPICS } from "@/agents/sophos";
import { sendTelegramMessage } from "@/lib/telegram";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const [releaseNotes, repoResults, videoResults] = await Promise.all([
    releaseWatch().catch(() => null),
    Promise.allSettled(SCOUT_TOPICS.map((q) => repoScoutTool(q))),
    Promise.allSettled(SCOUT_TOPICS.map((q) => videoDigestTool(q))),
  ]);

  const repos = repoResults.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).slice(0, 8);
  const videos = videoResults.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).slice(0, 6);

  const users = await prisma.user.findMany({ select: { id: true } });
  const briefs = await Promise.allSettled(
    users.map((u) => skillBrief(u.id, { releaseNotes, repos, videos }))
  );

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  if (ownerChatId) {
    const firstBrief = briefs.find((b): b is PromiseFulfilledResult<Awaited<ReturnType<typeof skillBrief>>> => b.status === "fulfilled");
    if (firstBrief?.value.hasFindings) {
      await sendTelegramMessage(ownerChatId, `Sophos weekly skill brief:\n\n${firstBrief.value.text}`).catch(() => {});
    }
  }

  return Response.json({
    ok: true,
    job: "skills-scout",
    releaseNotes: Boolean(releaseNotes),
    repos: repos.length,
    videos: videos.length,
    briefed: briefs.filter((b) => b.status === "fulfilled").length,
  });
}
