import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_MAX_DEPTH = 6;
const DEFAULT_MAX_FILE_BYTES = 256 * 1024;
const LINKED_FILE_ROOTS = new Set(["assets", "references", "scripts", "templates"]);

export type DiscoveredSkillDocument = {
  directory: string;
  instructionFile: string;
  relativePath: string;
  category: string | null;
};

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function ignoredDirectory(name: string): boolean {
  return name.startsWith(".") || name.startsWith("_") || name === "node_modules";
}

export async function discoverSkillDocuments(
  root: string,
  maxDepth = DEFAULT_MAX_DEPTH,
): Promise<DiscoveredSkillDocument[]> {
  const resolvedRoot = await realpath(root).catch(() => null);
  if (!resolvedRoot) return [];
  const skillRoot = resolvedRoot;

  const documents: DiscoveredSkillDocument[] = [];

  async function visit(directory: string, parts: string[]): Promise<void> {
    if (parts.length > maxDepth) return;
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const skillFile = entries.find((entry) => entry.isFile() && entry.name === "SKILL.md");

    if (parts.length > 0 && skillFile) {
      const instructionFile = path.join(directory, skillFile.name);
      const resolvedFile = await realpath(instructionFile).catch(() => null);
      if (resolvedFile && isWithin(skillRoot, resolvedFile)) {
        documents.push({
          directory,
          instructionFile,
          relativePath: parts.join("/"),
          category: parts.length > 1 ? parts.slice(0, -1).join("/") : null,
        });
      }
      return;
    }

    const childDirectories = entries
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !ignoredDirectory(entry.name))
      .sort((a, b) => a.name.localeCompare(b.name));

    await Promise.all(childDirectories.map((entry) => visit(path.join(directory, entry.name), [...parts, entry.name])));
  }

  await visit(skillRoot, []);
  return documents.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function normalizeLinkedPath(relativeFile: string): string | null {
  if (!relativeFile.trim() || relativeFile.includes("\0")) return null;
  const portable = relativeFile.replace(/\\/g, "/");
  if (portable.startsWith("/") || /^[A-Za-z]:\//.test(portable)) return null;
  const normalized = path.posix.normalize(portable);
  if (normalized === ".." || normalized.startsWith("../")) return null;
  if (normalized === "SKILL.md") return normalized;
  const [topLevel] = normalized.split("/");
  return LINKED_FILE_ROOTS.has(topLevel) ? normalized : null;
}

export async function readSkillFile(
  skillDirectory: string,
  relativeFile = "SKILL.md",
  maxBytes = DEFAULT_MAX_FILE_BYTES,
): Promise<string> {
  const normalized = normalizeLinkedPath(relativeFile);
  if (!normalized) throw new Error("Skill file path is not allowed.");
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_FILE_BYTES) {
    throw new Error(`Skill file size limit must be between 1 and ${DEFAULT_MAX_FILE_BYTES} bytes.`);
  }

  const resolvedRoot = await realpath(skillDirectory).catch(() => null);
  if (!resolvedRoot) throw new Error("Skill directory is unavailable.");
  const target = path.join(resolvedRoot, ...normalized.split("/"));
  const resolvedTarget = await realpath(target).catch(() => null);
  if (!resolvedTarget || !isWithin(resolvedRoot, resolvedTarget)) {
    throw new Error("Skill file is outside the skill directory or does not exist.");
  }

  const info = await stat(resolvedTarget);
  if (!info.isFile()) throw new Error("Skill file is not a regular file.");
  if (info.size > maxBytes) throw new Error(`Skill file exceeds the ${maxBytes}-byte limit.`);
  return readFile(resolvedTarget, "utf8");
}
