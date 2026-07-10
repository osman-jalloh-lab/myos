import { prisma } from "@/lib/db";
import { checkDuplicateSkill, getRegisteredSkills, testSkillMatch } from "@/lib/skills/registry";

const REQUIRED_SKILLS = [
  "personal-context-anchor",
  "i9-hr-compliance-specialist",
  "job-application-ops",
  "it-help-desk-trainer",
  "grc-risk-role-screener",
  "student-work-authorization-guard",
  "writing-humanizer",
];

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer === secret || url.searchParams.get("token") === secret;
}

export async function GET(req: Request) {
  if (!authorized(req)) return new Response("Unauthorized", { status: 401 });
  const user = await prisma.user.findFirst({ select: { id: true } });
  if (!user) return Response.json({ ok: false, error: "No user found." }, { status: 404 });

  const skills = await getRegisteredSkills(user.id, true);
  const required = REQUIRED_SKILLS.map((id) => {
    const skill = skills.find((entry) => entry.id === id);
    return {
      id,
      present: Boolean(skill),
      name: skill?.name ?? null,
      description: skill?.description ?? null,
      ownerAgents: skill?.ownerAgents ?? [],
      tags: skill?.tags ?? [],
      safetyClass: skill?.safetyClass ?? null,
      source: skill?.source ?? null,
      validationStatus: skill?.validationStatus ?? null,
      skillQualityScore: skill?.skillQualityScore ?? null,
      skillQualityBand: skill?.skillQualityBand ?? null,
      triggerExamples: skill?.triggerExamples ?? [],
    };
  });
  const duplicate = await checkDuplicateSkill(user.id, "personal-context-anchor");
  const match = await testSkillMatch(user.id, "grc-risk-role-screener", "screen this risk management job for Security+ and CySA+ fit");

  return Response.json({
    ok: required.every((skill) => skill.present && skill.validationStatus === "valid")
      && required.every((skill) => Number(skill.skillQualityScore ?? 0) >= 85)
      && duplicate.duplicate
      && /already installed; no action taken/i.test(duplicate.message)
      && Boolean(match?.matched),
    registryCount: skills.length,
    required,
    duplicateAdd: {
      candidate: "personal-context-anchor",
      duplicate: duplicate.duplicate,
      message: duplicate.message,
      skillId: duplicate.skill?.id ?? null,
    },
    testMatch: match,
  });
}
