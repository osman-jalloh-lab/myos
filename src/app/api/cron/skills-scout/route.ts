// Vercel Cron: skills-scout. Schedule: every Monday 13:30 UTC (vercel.json).
// Runs Sophos's scouting tools and synthesizes findings into a digest.
// Now tracks new Claude Code skills from affaan-m/everything-claude-code
// and always sends a Telegram ping when new skills are found.
import { prisma } from "@/lib/db";
import {
  releaseWatch,
  repoScoutTool,
  videoDigestTool,
  skillBrief,
  checkSkillsRepo,
  SCOUT_TOPICS,
} from "@/agents/sophos";
import { sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const userId = users[0]?.id;
  if (!userId) return Response.json({ ok: false, error: "no users" });

  const [releaseNotes, repoResults, videoResults, newSkillsResult] = await Promise.all([
    releaseWatch().catch(() => null),
    Promise.allSettled(SCOUT_TOPICS.map((q) => repoScoutTool(q))),
    Promise.allSettled(SCOUT_TOPICS.map((q) => videoDigestTool(q))),
    checkSkillsRepo(userId).catch(() => null),
  ]);

  const repos = repoResults.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).slice(0, 8);
  const videos = videoResults.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).slice(0, 6);

  const briefs = await Promise.allSettled(
    users.map((u) =>
      skillBrief(u.id, {
        releaseNotes,
        repos,
        videos,
        newSkills: newSkillsResult ?? undefined,
      })
    )
  );

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;
  const firstBrief = briefs.find(
    (b): b is PromiseFulfilledResult<Awaited<ReturnType<typeof skillBrief>>> =>
      b.status === "fulfilled"
  );

  if (ownerChatId && firstBrief) {
    const { hasFindings, text } = firstBrief.value;
    const hasNewSkills = (newSkillsResult?.newSkills.length ?? 0) > 0;

    // Always ping on new skills. Also ping for general findings.
    if (hasNewSkills || hasFindings) {
      const prefix = hasNewSkills
        ? `Sophos: ${newSkillsResult!.newSkills.length} new Claude Code skill(s) available.\n\n`
        : "Sophos weekly skill brief:\n\n";
      await sendTelegramMessage(ownerChatId, `${prefix}${text}`).catch(() => {});
    }
  }

  return Response.json({
    ok: true,
    job: "skills-scout",
    releaseNotes: Boolean(releaseNotes),
    repos: repos.length,
    videos: videos.length,
    newSkills: newSkillsResult?.newSkills ?? [],
    totalSkillsInRepo: newSkillsResult?.totalInRepo ?? 0,
    briefed: briefs.filter((b) => b.status === "fulfilled").length,
  });
}
