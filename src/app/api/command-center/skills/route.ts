import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLocalProjectsRoot } from "@/lib/local-builder";
import { runSkillScout } from "@/lib/skill-scout/github";

type SkillView = {
  name: string;
  source: string;
  category: string;
  description: string;
  dateAdded: string | null;
  status: string;
  testResult: string;
};

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

function parseDescription(content: string): string {
  const desc = content.match(/^description:\s*(.+)$/m)?.[1] ?? content.split("\n").find((line) => line.trim() && !line.startsWith("#")) ?? "";
  return desc.replace(/^["']|["']$/g, "").trim().slice(0, 220) || "Local skill instructions.";
}

function categoryFor(name: string): string {
  if (/qa|audit|test/i.test(name)) return "QA";
  if (/design|polish|ui|visual/i.test(name)) return "Design";
  if (/ecommerce|market|product/i.test(name)) return "Build";
  if (/research|discovery/i.test(name)) return "Research";
  return "Workflow";
}

async function readSkillDir(root: string, source: string): Promise<SkillView[]> {
  if (!(await exists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  return Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const dir = path.join(root, entry.name);
    const skillFile = path.join(dir, "SKILL.md");
    const content = await readFile(skillFile, "utf8").catch(() => "");
    const info = await stat(dir).catch(() => null);
    return {
      name: entry.name,
      source,
      category: categoryFor(entry.name),
      description: parseDescription(content),
      dateAdded: info?.birthtime?.toISOString() ?? null,
      status: content ? "installed" : "folder only",
      testResult: content ? "Readable SKILL.md" : "Missing SKILL.md",
    };
  }));
}

export async function GET() {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Same root the local builder uses — one definition of where skills live.
  const projectsRoot = await getLocalProjectsRoot();
  const agentSkills = path.join(os.homedir(), ".agents", "skills");
  const localSkills = path.join(projectsRoot, "skills");
  const [agent, local] = await Promise.all([
    readSkillDir(agentSkills, ".agents/skills"),
    readSkillDir(localSkills, `${path.basename(projectsRoot)}/skills`),
  ]);

  return NextResponse.json({ skills: [...agent, ...local].sort((a, b) => a.name.localeCompare(b.name)) });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: string; repoUrl?: string } | null;

  if (body?.action !== "scoutRepo") return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
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
