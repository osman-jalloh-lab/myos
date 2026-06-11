// Vercel Cron: job-scout. Schedule defined in vercel.json (weekly, UTC).
// Two passes:
//   1. Discover — searches JSearch for live postings matching Osman's GRC/
//      security direction, tracks any not already in the ledger (source
//      "job-scout", status "interested"). Firecrawl backfills thin descriptions
//      so there's real material to score against.
//   2. Score — re-runs fit-score over tracked roles that have enough notes
//      to score and don't have a score yet — this includes whatever pass 1
//      just discovered.
//   3. Notify — sends a Telegram message for any new matches with fit >= 75,
//      including the job URL so Osman can open it directly.
// JSearch free tier is 200 req/month — keep the query list short; this only
// runs weekly. Pure read + own-domain tracking + score; nothing gets applied
// to or messaged without going through the apply_to_job approval action.
import { prisma } from "@/lib/db";
import { discoverJobs, fitScore, trackJob } from "@/agents/athena";
import { sendTelegramMessage } from "@/lib/telegram";

const MIN_NOTES_LENGTH = 40;
const SCOUT_QUERIES = ["GRC compliance analyst", "security compliance auditor"];

export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  let discovered = 0;
  let tracked = 0;

  for (const user of users) {
    const existing = await prisma.jobListing.findMany({ where: { userId: user.id }, select: { url: true } });
    const knownUrls = new Set(existing.map((j) => j.url).filter(Boolean));

    const found = await Promise.allSettled(SCOUT_QUERIES.map((q) => discoverJobs(q)));
    const postings = found.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
    discovered += postings.length;

    for (const posting of postings) {
      if (!posting.url || knownUrls.has(posting.url)) continue;
      knownUrls.add(posting.url);
      await trackJob(user.id, {
        title: posting.title,
        company: posting.company,
        url: posting.url,
        source: "job-scout",
        notes: posting.description?.slice(0, 4000),
        postedAt: posting.postedAt ? new Date(posting.postedAt) : undefined,
      });
      tracked += 1;
    }
  }

  const candidates = await prisma.jobListing.findMany({
    where: { fitScore: null, status: { in: ["interested", "applied"] } },
  });

  const scoreable = candidates.filter((c) => (c.notes?.length ?? 0) >= MIN_NOTES_LENGTH);

  const results = await Promise.allSettled(
    scoreable.map(async (listing) => {
      const result = await fitScore(listing.userId, {
        jobTitle: listing.title,
        company: listing.company,
        jobDescription: listing.notes!,
        jobListingId: listing.id,
      });
      return { id: listing.id, title: listing.title, company: listing.company, score: result.score };
    })
  );

  const scored = results
    .filter((r): r is PromiseFulfilledResult<{ id: string; title: string; company: string; score: number }> => r.status === "fulfilled")
    .map((r) => r.value);

  await prisma.agentRun.create({
    data: {
      agentName: "athena",
      inputSummary: `job-scout: ${SCOUT_QUERIES.length} live queries found ${discovered} postings (${tracked} new, tracked) · ${candidates.length} unscored tracked roles, ${scoreable.length} had enough notes to score`,
      outputSummary: scored.map((s) => `${s.title} @ ${s.company}: ${s.score}`).join(" · ").slice(0, 2000),
      status: "completed",
    },
  });

  // Notify via Telegram for any new matches with fit score >= 75.
  const goodMatches = scored.filter((s) => s.score >= 75);
  if (goodMatches.length > 0 && process.env.TELEGRAM_OWNER_CHAT_ID) {
    try {
      const lines = await Promise.all(
        goodMatches.map(async (s) => {
          const listing = await prisma.jobListing.findUnique({ where: { id: s.id }, select: { url: true } });
          const link = listing?.url ? `\n  ${listing.url}` : "";
          return `${s.title} @ ${s.company} - ${s.score}% fit${link}`;
        })
      );
      await sendTelegramMessage(
        process.env.TELEGRAM_OWNER_CHAT_ID,
        `Athena found ${goodMatches.length} strong job match${goodMatches.length !== 1 ? "es" : ""}:\n\n${lines.join("\n\n")}`
      );
    } catch {
      // non-fatal — cron result still returns even if Telegram is down
    }
  }

  return Response.json({ ok: true, job: "job-scout", discovered, tracked, scanned: candidates.length, scored, notified: goodMatches.length });
}
