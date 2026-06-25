import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

type SkillView = {
  name: string;
  source: string;
  category: string;
  description: string;
  dateAdded: string | null;
  status: string;
  testResult: string;
};

const DEFAULT_SKILL_SOURCE_URL = "https://github.com/rampstackco/claude-skills/tree/main/skills/accessibility-audit";
const DEFAULT_SKILL_REPO = "rampstackco/claude-skills";
const DEFAULT_SKILL_PATH = "skills/accessibility-audit/SKILL.md";

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

  const userRoot = process.env.USERPROFILE ?? "C:\\Users\\osman";
  const agentSkills = path.join(userRoot, ".agents", "skills");
  const localSkills = path.join("C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject", "skills");
  const [agent, local] = await Promise.all([
    readSkillDir(agentSkills, ".agents/skills"),
    readSkillDir(localSkills, "HermesProject/skills"),
  ]);

  return NextResponse.json({ skills: [...agent, ...local].sort((a, b) => a.name.localeCompare(b.name)) });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { action?: string; repoUrl?: string } | null;

  if (body?.action !== "scout") return NextResponse.json({ error: "Unsupported action" }, { status: 400 });

  const sourceUrl = body.repoUrl?.trim() || DEFAULT_SKILL_SOURCE_URL;
  const taskTitle = "Review accessibility-audit skill for possible install";
  const taskDescription = [
    "Sophos recommended an accessibility audit skill for generated app QA.",
    `Source: ${sourceUrl}`,
    `Repository: ${DEFAULT_SKILL_REPO}`,
    `Path: ${DEFAULT_SKILL_PATH}`,
    "Install only after manual approval and repository review.",
  ].join("\n");

  const existingTask = await prisma.task.findFirst({
    where: {
      userId: session.user.id,
      source: "skill-scout",
      sourceRef: sourceUrl,
      status: { not: "done" },
    },
    orderBy: { createdAt: "desc" },
  });

  const task = existingTask ?? await prisma.task.create({
    data: {
      userId: session.user.id,
      title: taskTitle,
      description: taskDescription,
      source: "skill-scout",
      sourceRef: sourceUrl,
      assignedAgent: "sophos",
      delegatedBy: "sophos",
      priority: "medium",
    },
  });

  const candidate = {
    name: "accessibility-audit",
    source: sourceUrl,
    sourceUrl,
    repository: DEFAULT_SKILL_REPO,
    path: DEFAULT_SKILL_PATH,
    category: "QA",
    description: "A safe skill that would audit generated apps for keyboard navigation, contrast, labels, responsive overlap, and common accessibility regressions.",
    whyItHelps: "Hermes now builds richer local apps; accessibility QA catches issues that npm build cannot see.",
    installCommand: "Manual review required before choosing an install command.",
    riskyFiles: ["No repository downloaded.", "No scripts executed.", "Review task created before any install."],
    approvalRequired: true,
    status: "candidate only",
    testResult: "Not installed; recommendation saved for review.",
    taskId: task.id,
    taskTitle: task.title,
    taskStatus: task.status,
    createdAt: new Date().toISOString(),
  };

  await prisma.memory.create({
    data: {
      userId: session.user.id,
      fact: `Skill Scout recommendation: ${candidate.name}. Source: ${sourceUrl}. Review task: ${task.id}. ${candidate.whyItHelps} Status: candidate only; no install without approval.`,
      source: "skill-scout:manual",
      approvedAt: new Date(),
    },
  });

  return NextResponse.json({ candidate });
}
