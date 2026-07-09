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
import {
  JOB_SCOUT_CATEGORIES,
  adjustJobScoutFitScore,
  inferJobScoutCategory,
  matchesJobScoutCategory,
  type JobScoutCategoryKey,
} from "@/lib/job-scout/pipeline";

const MIN_NOTES_LENGTH = 40;
const MAX_SCORE_PER_CATEGORY = 4;

type CategoryStats = {
  label: string;
  queries: number;
  discovered: number;
  matched: number;
  tracked: number;
  scored: number;
  sampleResults: Array<{ title: string; company: string; url?: string | null }>;
  topResults: Array<{ title: string; company: string; score: number; url?: string | null }>;
};

function emptyCategoryStats(): Record<JobScoutCategoryKey, CategoryStats> {
  const stats = {} as Record<JobScoutCategoryKey, CategoryStats>;
  for (const category of JOB_SCOUT_CATEGORIES) {
    stats[category.key] = { label: category.label, queries: category.queries.length, discovered: 0, matched: 0, tracked: 0, scored: 0, sampleResults: [], topResults: [] };
  }
  return stats;
}

function categoryNote(category: JobScoutCategoryKey, description?: string | null): string {
  return [`Category: ${category}`, description ?? ""].filter(Boolean).join("\n\n").slice(0, 4000);
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const users = await prisma.user.findMany({ select: { id: true } });
  let discovered = 0;
  let tracked = 0;
  const categoryStats = emptyCategoryStats();

  for (const user of users) {
    const existing = await prisma.jobListing.findMany({ where: { userId: user.id }, select: { url: true } });
    const knownUrls = new Set(existing.map((j) => j.url).filter(Boolean));

    for (const category of JOB_SCOUT_CATEGORIES) {
      const found = await Promise.allSettled(category.queries.map((q) => discoverJobs(q, undefined, 6)));
      const postings = found.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      categoryStats[category.key].discovered += postings.length;
      discovered += postings.length;

      for (const posting of postings) {
        if (!matchesJobScoutCategory(posting, category)) continue;
        categoryStats[category.key].matched += 1;
        if (categoryStats[category.key].sampleResults.length < 5) {
          categoryStats[category.key].sampleResults.push({ title: posting.title, company: posting.company, url: posting.url });
        }
        if (!posting.url || knownUrls.has(posting.url)) continue;
        knownUrls.add(posting.url);
        await trackJob(user.id, {
          title: posting.title,
          company: posting.company,
          url: posting.url,
          source: "job-scout",
          notes: categoryNote(category.key, posting.description),
          postedAt: posting.postedAt ? new Date(posting.postedAt) : undefined,
        });
        categoryStats[category.key].tracked += 1;
        tracked += 1;
      }
    }
  }

  const candidates = await prisma.jobListing.findMany({
    where: { fitScore: null, status: { in: ["interested", "applied"] } },
  });

  const scoreableCandidates = candidates
    .map((listing) => ({ listing, category: inferJobScoutCategory({ title: listing.title, company: listing.company, notes: listing.notes }) }))
    .filter((entry): entry is { listing: typeof candidates[number]; category: JobScoutCategoryKey } => Boolean(entry.category) && (entry.listing.notes?.length ?? 0) >= MIN_NOTES_LENGTH);
  const scoreCounts = new Map<JobScoutCategoryKey, number>();
  const scoreable = scoreableCandidates.filter(({ category }) => {
    const count = scoreCounts.get(category) ?? 0;
    if (count >= MAX_SCORE_PER_CATEGORY) return false;
    scoreCounts.set(category, count + 1);
    return true;
  });

  const results = await Promise.allSettled(
    scoreable.map(async ({ listing, category }) => {
      const result = await fitScore(listing.userId, {
        jobTitle: listing.title,
        company: listing.company,
        jobDescription: listing.notes!,
        jobListingId: listing.id,
      });
      const adjustedScore = adjustJobScoutFitScore(result.score, { title: listing.title, company: listing.company, notes: listing.notes }, category);
      if (adjustedScore !== result.score) {
        await prisma.jobListing.update({ where: { id: listing.id }, data: { fitScore: adjustedScore } });
      }
      categoryStats[category].scored += 1;
      categoryStats[category].topResults.push({ title: listing.title, company: listing.company, score: adjustedScore, url: listing.url });
      return { id: listing.id, title: listing.title, company: listing.company, score: adjustedScore, category };
    })
  );

  const scored = results
    .filter((r): r is PromiseFulfilledResult<{ id: string; title: string; company: string; score: number; category: JobScoutCategoryKey }> => r.status === "fulfilled")
    .map((r) => r.value);

  for (const stats of Object.values(categoryStats)) {
    stats.topResults.sort((a, b) => b.score - a.score);
    stats.topResults = stats.topResults.slice(0, 5);
  }

  await prisma.agentRun.create({
    data: {
      agentName: "athena",
      inputSummary: `job-scout: ${JOB_SCOUT_CATEGORIES.length} categories / ${JOB_SCOUT_CATEGORIES.reduce((sum, category) => sum + category.queries.length, 0)} live queries found ${discovered} postings (${tracked} new, tracked) · ${candidates.length} unscored tracked roles, ${scoreable.length} category-matched roles had enough notes to score`,
      outputSummary: scored.map((s) => `[${s.category}] ${s.title} @ ${s.company}: ${s.score}`).join(" · ").slice(0, 2000),
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

  return Response.json({ ok: true, job: "job-scout", categories: categoryStats, discovered, tracked, scanned: candidates.length, scored, notified: goodMatches.length });
}
