import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { runSkillScout } from "@/lib/skill-scout/github";
import {
  checkDuplicateSkill,
  getRegisteredSkills,
  PERSONAL_SKILL_IDS,
  setSkillEnabled,
  testSkillMatch,
} from "@/lib/skills/registry";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const refresh = url.searchParams.get("refresh") === "1";
  const skills = await getRegisteredSkills(session.user.id, refresh);
  return NextResponse.json({
    skills,
    registry: {
      refreshed: refresh,
      lastUpdated: new Date().toISOString(),
      personalSkills: PERSONAL_SKILL_IDS.map((id) => ({
        id,
        present: skills.some((skill) => skill.id === id),
      })),
      quality: {
        average: skills.length ? Math.round(skills.reduce((sum, skill) => sum + skill.skillQualityScore, 0) / skills.length) : 0,
        personalAverage: PERSONAL_SKILL_IDS.length
          ? Math.round(PERSONAL_SKILL_IDS.reduce((sum, id) => sum + (skills.find((skill) => skill.id === id)?.skillQualityScore ?? 0), 0) / PERSONAL_SKILL_IDS.length)
          : 0,
        personalBelow85: PERSONAL_SKILL_IDS.filter((id) => (skills.find((skill) => skill.id === id)?.skillQualityScore ?? 0) < 85),
      },
    },
  });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as {
    action?: string;
    repoUrl?: string;
    skillId?: string;
    enabled?: boolean;
    message?: string;
    candidateName?: string;
  } | null;

  if (body?.action === "scoutRepo") {
    if (!body.repoUrl?.trim()) return NextResponse.json({ error: "repoUrl is required" }, { status: 400 });
    try {
      const result = await runSkillScout(session.user.id, body.repoUrl);
      return NextResponse.json({ result });
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Skill Scout failed." },
        { status: 400 }
      );
    }
  }

  if (body?.action === "setEnabled") {
    if (!body.skillId) return NextResponse.json({ error: "skillId is required" }, { status: 400 });
    const skill = await setSkillEnabled(session.user.id, body.skillId, Boolean(body.enabled));
    if (!skill) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    return NextResponse.json({ skill, message: `${skill.name} ${skill.enabled ? "enabled" : "disabled"}.` });
  }

  if (body?.action === "testMatch") {
    if (!body.skillId) return NextResponse.json({ error: "skillId is required" }, { status: 400 });
    const result = await testSkillMatch(session.user.id, body.skillId, body.message?.trim() || "");
    if (!result) return NextResponse.json({ error: "Skill not found" }, { status: 404 });
    return NextResponse.json({ result });
  }

  if (body?.action === "addSkill") {
    const candidateName = body.candidateName?.trim() || body.skillId?.trim();
    if (!candidateName) return NextResponse.json({ error: "candidateName or skillId is required" }, { status: 400 });
    const duplicate = await checkDuplicateSkill(session.user.id, candidateName);
    if (duplicate.duplicate) {
      return NextResponse.json({ status: "noop", message: duplicate.message, skill: duplicate.skill });
    }
    return NextResponse.json({ status: "needs_approval", message: `${candidateName} is not installed. Use Skill Scout approval before importing.` });
  }

  return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
}
