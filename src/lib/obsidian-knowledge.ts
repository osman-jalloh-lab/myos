import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const PRIVATE_SEGMENT = "90 private";
const MAX_NOTES = 600;
const MAX_NOTE_BYTES = 256_000;
const ALLOWED_TOP_LEVEL = new Set([
  "00 Inbox", "01 Daily Notes", "02 Projects", "03 Work", "04 School",
  "05 Knowledge", "06 People", "07 Tasks", "08 AI Memory", "09 Decisions",
  "10 Templates", "20 Attachments", "95 Imports", "99 Archive", "hermes", "work",
]);

export type KnowledgeNodeType = "PROJECT" | "DECISION" | "PROBLEM" | "SOLUTION" | "AGENT" | "SKILL" | "TOOL" | "NOTE" | "TASK" | "ARCHITECTURE" | "BUILD_MILESTONE" | "BRANCH";
export type KnowledgeGraphNode = { id: string; label: string; type: KnowledgeNodeType; source: "Obsidian"; relativePath: string; summary: string; updatedAt: string };
export type KnowledgeGraphEdge = { id: string; source: string; target: string; relation: "wikilink" | "fixed-by" | "validated-by" | "related-project" | "related-branch" };
export type KnowledgeGraph = { nodes: KnowledgeGraphNode[]; edges: KnowledgeGraphEdge[]; updatedAt: string; truncated: boolean };

export function normalizeVaultRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) || normalized.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("Unsafe Obsidian note path rejected.");
  return normalized;
}

export function isPermittedVaultPath(value: string): boolean {
  let normalized: string;
  try { normalized = normalizeVaultRelativePath(value); } catch { return false; }
  const parts = normalized.toLowerCase().split("/");
  if (parts.includes(PRIVATE_SEGMENT) || parts.some((part) => part.startsWith("."))) return false;
  return ALLOWED_TOP_LEVEL.has(normalized.split("/")[0]);
}

async function rootFromObsidianConfig(): Promise<string | null> {
  if (process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME) return null;
  const config = path.join(/* turbopackIgnore: true */ process.env.APPDATA || path.join(/* turbopackIgnore: true */ os.homedir(), "AppData", "Roaming"), "obsidian", "obsidian.json");
  try {
    const parsed = JSON.parse(await fs.readFile(config, "utf8")) as { vaults?: Record<string, { path?: string; open?: boolean }> };
    const vaults = Object.values(parsed.vaults ?? {}).filter((vault) => typeof vault.path === "string");
    return (vaults.find((vault) => vault.open)?.path ?? vaults[0]?.path) || null;
  } catch { return null; }
}

export async function resolveObsidianVaultRoot(explicitRoot?: string): Promise<string> {
  const configured = explicitRoot?.trim() || process.env.OBSIDIAN_VAULT_ROOT?.trim() || await rootFromObsidianConfig();
  if (!configured) throw new Error("Local Obsidian vault is not configured.");
  const resolved = await fs.realpath(path.resolve(/* turbopackIgnore: true */ configured));
  const stat = await fs.stat(resolved);
  if (!stat.isDirectory()) throw new Error("Configured Obsidian vault is unavailable.");
  return resolved;
}

async function permittedFile(root: string, relativePath: string): Promise<string> {
  const relative = normalizeVaultRelativePath(relativePath);
  if (!isPermittedVaultPath(relative)) throw new Error("Obsidian note path is outside the permitted knowledge boundary.");
  const candidate = path.resolve(/* turbopackIgnore: true */ root, ...relative.split("/"));
  const resolved = await fs.realpath(candidate);
  const prefix = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (!resolved.startsWith(prefix)) throw new Error("Obsidian link escape rejected.");
  return resolved;
}

function cleanText(value: unknown, max = 500): string {
  return String(value ?? "").replace(/\0/g, "").replace(/(?:bearer\s+|api[_ -]?key\s*[:=]\s*|token\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]").replace(/\s+/g, " ").trim().slice(0, max);
}

function frontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  return Object.fromEntries(match[1].split(/\r?\n/).map((line) => line.match(/^([\w-]+):\s*(.*)$/)).filter(Boolean).map((m) => [m![1], cleanText(m![2], 200)]));
}

function noteType(relativePath: string, meta: Record<string, string>, content: string): KnowledgeNodeType {
  const explicit = (meta.type ?? "").toLowerCase();
  if (explicit === "project") return "PROJECT";
  if (explicit === "problem") return "PROBLEM";
  if (explicit === "solution") return "SOLUTION";
  if (explicit === "decision") return "DECISION";
  if (explicit === "task") return "TASK";
  const value = `${explicit} ${relativePath} ${content.match(/^#\s+(.+)$/m)?.[1] ?? ""}`.toLowerCase();
  if (value.includes("troubleshoot") || /type:\s*problem/i.test(content)) return "PROBLEM";
  if (value.includes("solution")) return "SOLUTION";
  if (value.includes("project")) return "PROJECT";
  if (value.includes("decision")) return "DECISION";
  if (value.includes("architecture")) return "ARCHITECTURE";
  if (value.includes("milestone")) return "BUILD_MILESTONE";
  if (value.includes("branch")) return "BRANCH";
  if (value.includes("skill")) return "SKILL";
  if (value.includes("task")) return "TASK";
  if (value.includes("agent")) return "AGENT";
  if (value.includes("tool")) return "TOOL";
  return "NOTE";
}

function noteSummary(content: string): string {
  return cleanText(content.replace(/^---[\s\S]*?---\s*/, "").replace(/^#+\s+.*$/gm, "").replace(/\[\[([^\]|#]+)(?:#[^\]|]+)?(?:\|([^\]]+))?\]\]/g, (_all, target: string, alias?: string) => target.toLowerCase().split(/[\\/]/).includes(PRIVATE_SEGMENT) ? "" : alias || target), 260);
}

function nodeId(relativePath: string): string { return createHash("sha256").update(relativePath.toLowerCase()).digest("hex").slice(0, 20); }
function titleOf(relativePath: string, content: string): string { return cleanText(content.match(/^#\s+(.+)$/m)?.[1] ?? path.posix.basename(relativePath, ".md"), 120); }

async function collectMarkdown(root: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (absolute: string, relative = "") => {
    if (output.length >= MAX_NOTES) return;
    const entries = await fs.readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isPermittedVaultPath(rel)) continue;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path.join(/* turbopackIgnore: true */ absolute, entry.name), rel);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) output.push(rel);
      if (output.length >= MAX_NOTES) break;
    }
  };
  for (const folder of ALLOWED_TOP_LEVEL) {
    const absolute = path.join(/* turbopackIgnore: true */ root, folder);
    if ((await fs.stat(absolute).catch(() => null))?.isDirectory()) await visit(absolute, folder);
    if (output.length >= MAX_NOTES) break;
  }
  return output;
}

function resolveWikilink(target: string, notes: Array<{ relativePath: string; title: string }>): string | null {
  const clean = target.split("#")[0].trim().replace(/\\/g, "/").replace(/\.md$/i, "").toLowerCase();
  if (!clean || clean.split("/").includes(PRIVATE_SEGMENT)) return null;
  const exact = notes.filter((note) => note.relativePath.replace(/\.md$/i, "").toLowerCase() === clean);
  if (exact.length === 1) return exact[0].relativePath;
  const byTitle = notes.filter((note) => note.title.toLowerCase() === clean || path.posix.basename(note.relativePath, ".md").toLowerCase() === clean);
  return byTitle.length === 1 ? byTitle[0].relativePath : null;
}

export async function buildObsidianKnowledgeGraph(options: { root?: string } = {}): Promise<KnowledgeGraph> {
  const root = await resolveObsidianVaultRoot(options.root);
  const relativePaths = await collectMarkdown(root);
  const notes: Array<{ relativePath: string; title: string; content: string; updatedAt: string; node: KnowledgeGraphNode }> = [];
  for (const relativePath of relativePaths) {
    const absolute = await permittedFile(root, relativePath);
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_NOTE_BYTES) continue;
    const content = await fs.readFile(absolute, "utf8");
    const meta = frontmatter(content);
    const title = titleOf(relativePath, content);
    notes.push({ relativePath, title, content, updatedAt: stat.mtime.toISOString(), node: { id: nodeId(relativePath), label: title, type: noteType(relativePath, meta, content), source: "Obsidian", relativePath, summary: noteSummary(content), updatedAt: stat.mtime.toISOString() } });
  }
  const edges: KnowledgeGraphEdge[] = [];
  const derivedNodes: KnowledgeGraphNode[] = [];
  const seen = new Set<string>();
  for (const note of notes) {
    for (const match of note.content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
      const targetPath = resolveWikilink(match[1], notes);
      if (!targetPath || targetPath === note.relativePath) continue;
      const key = `${note.relativePath}->${targetPath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ id: createHash("sha256").update(key).digest("hex").slice(0, 20), source: nodeId(note.relativePath), target: nodeId(targetPath), relation: "wikilink" });
    }
    if (note.node.type === "PROBLEM") {
      const successfulFix = cleanText(note.content.match(/^## Successful fix\r?\n\r?\n([^\r\n]+)/mi)?.[1] ?? "", 500);
      if (successfulFix && !/^not (?:confirmed|recorded)$/i.test(successfulFix)) {
        const solutionId = `${note.node.id}:solution`;
        derivedNodes.push({ id: solutionId, label: `Solution · ${note.title}`, type: "SOLUTION", source: "Obsidian", relativePath: note.relativePath, summary: successfulFix, updatedAt: note.updatedAt });
        edges.push({ id: createHash("sha256").update(`${note.node.id}:fixed-by:${solutionId}`).digest("hex").slice(0, 20), source: note.node.id, target: solutionId, relation: "fixed-by" });
      }
      const meta = frontmatter(note.content);
      for (const [field, relation] of [["related_project", "related-project"], ["related_branch", "related-branch"]] as const) {
        const value = meta[field]; if (!value) continue;
        const target = notes.find((candidate) => candidate.title.toLowerCase() === value.toLowerCase() || candidate.node.summary.toLowerCase().includes(value.toLowerCase()));
        if (target) edges.push({ id: createHash("sha256").update(`${note.node.id}:${relation}:${target.node.id}`).digest("hex").slice(0, 20), source: note.node.id, target: target.node.id, relation });
      }
    }
  }
  return { nodes: [...notes.map((note) => note.node), ...derivedNodes], edges, updatedAt: new Date().toISOString(), truncated: relativePaths.length >= MAX_NOTES };
}

export async function readPermittedObsidianNote(relativePath: string, explicitRoot?: string): Promise<{ relativePath: string; title: string; content: string; updatedAt: string }> {
  const root = await resolveObsidianVaultRoot(explicitRoot);
  const absolute = await permittedFile(root, relativePath);
  const stat = await fs.stat(absolute);
  if (stat.size > MAX_NOTE_BYTES) throw new Error("Obsidian note exceeds the safe read limit.");
  const content = await fs.readFile(absolute, "utf8");
  return { relativePath: normalizeVaultRelativePath(relativePath), title: titleOf(relativePath, content), content: cleanText(content, 20_000), updatedAt: stat.mtime.toISOString() };
}

export const __testOnly = { frontmatter, noteType, noteSummary, resolveWikilink, nodeId, cleanText };
