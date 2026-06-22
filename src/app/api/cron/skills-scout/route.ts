// Vercel Cron: skills-scout. Schedule: every Monday 13:30 UTC (vercel.json).
// Sophos's weekly run: checks for new Claude Code skills, scores them for relevance,
// scouts release notes and GitHub repos, and synthesizes a digest.
// Proactively pings Telegram whenever high-relevance new skills are found —
// without waiting for Osman to ask. Explains why each skill was selected.
import { prisma } from "@/lib/db";
import {
  releaseWatch,
  repoScoutTool,
  videoDigestTool,
  skillBrief,
  checkSkillsRepo,
  SCOUT_TOPICS,
} from "@/agents/sophos";
import { scoreNewSkills } from "@/lib/sophos";
import { sendTelegramMessage } from "@/lib/telegram";

export const runtime = "nodejs";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  const userId = users[0]?.id;
  if (!userId) return Response.json({ ok: false, error: "no users" });

  const ownerChatId = process.env.TELEGRAM_OWNER_CHAT_ID;

  const [releaseNotes, repoResults, videoResults, newSkillsResult] = await Promise.all([
    releaseWatch().catch(() => null),
    Promise.allSettled(SCOUT_TOPICS.map((q) => repoScoutTool(q))),
    Promise.allSettled(SCOUT_TOPICS.map((q) => videoDigestTool(q))),
    checkSkillsRepo(userId).catch(() => null),
  ]);

  const repos = repoResults.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).slice(0, 8);
  const videos = videoResults.flatMap((r) => (r.status === "fulfilled" ? r.value : [])).slice(0, 6);

  // Score new skills for relevance to Hermes OS
  const highRelevanceSkills = newSkillsResult?.newSkills.length
    ? await scoreNewSkills(newSkillsResult.newSkills)
    : [];

  // Proactive Telegram ping for high-relevance skills — does not wait for weekly digest
  if (ownerChatId && highRelevanceSkills.length > 0) {
    const lines: string[] = [
      `Sophos: ${highRelevanceSkills.length} new Claude Code skill${highRelevanceSkills.length > 1 ? "s" : ""} relevant to Hermes OS.\n`,
    ];

    for (const skill of highRelevanceSkills.slice(0, 6)) {
      lines.push(`<b>${skill.name}</b>`);
      lines.push(`  Why: ${skill.reasons.join(", ")}`);
      lines.push(`  Install: <code>npx skills add affaan-m/everything-claude-code/${skill.name}</code>`);
      lines.push("");
    }

    if (newSkillsResult && newSkillsResult.newSkills.length > highRelevanceSkills.length) {
      const lowRelevance = newSkillsResult.newSkills.filter(
        (s) => !highRelevanceSkills.find((h) => h.name === s)
      );
      lines.push(`${lowRelevance.length} other new skills (lower relevance): ${lowRelevance.slice(0, 5).join(", ")}`);
    }

    await sendTelegramMessage(ownerChatId, lines.join("\n"), undefined, "HTML").catch(() => {});

    // Save a memory record so Hermes can answer "what skills should I install?"
    for (const skill of highRelevanceSkills.slice(0, 6)) {
      await prisma.memory.create({
        data: {
          userId,
          fact: `sophos:recommend-install::${skill.name}::reasons:${skill.reasons.join(",")}::command:npx skills add affaan-m/everything-claude-code/${skill.name}`,
          source: "sophos",
        },
      }).catch(() => {});
    }
  }

  // Weekly digest (covers everything — new skills summary + release notes + repos)
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

  const firstBrief = briefs.find(
    (b): b is PromiseFulfilledResult<Awaited<ReturnType<typeof skillBrief>>> =>
      b.status === "fulfilled"
  );

  // Send the full digest if there are findings AND we did not already flood Telegram
  // with the high-relevance ping above (avoid double-message on the same run)
  if (ownerChatId && firstBrief?.value.hasFindings && highRelevanceSkills.length === 0) {
    await sendTelegramMessage(
      ownerChatId,
      `Sophos weekly digest:\n\n${firstBrief.value.text}`
    ).catch(() => {});
  }

  return Response.json({
    ok: true,
    job: "skills-scout",
    releaseNotes: Boolean(releaseNotes),
    repos: repos.length,
    videos: videos.length,
    newSkillsTotal: newSkillsResult?.totalInRepo ?? 0,
    newSkillsFound: newSkillsResult?.newSkills ?? [],
    highRelevance: highRelevanceSkills.map((s) => ({ name: s.name, score: s.score, reasons: s.reasons })),
    briefed: briefs.filter((b) => b.status === "fulfilled").length,
  });
}
