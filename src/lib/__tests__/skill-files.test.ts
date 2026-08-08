import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverSkillDocuments, readSkillFile } from "@/lib/skills/skill-files";

describe("native skill files", () => {
  it("discovers direct and category-nested skills but ignores templates and nested support folders", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myos-skills-"));
    await Promise.all([
      mkdir(path.join(root, "direct"), { recursive: true }),
      mkdir(path.join(root, "research", "arxiv", "references"), { recursive: true }),
      mkdir(path.join(root, "_TEMPLATE"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, "direct", "SKILL.md"), "---\nname: Direct\n---\nDirect body."),
      writeFile(path.join(root, "research", "arxiv", "SKILL.md"), "---\nname: Arxiv\n---\nNested body."),
      writeFile(path.join(root, "research", "arxiv", "references", "SKILL.md"), "Not another skill."),
      writeFile(path.join(root, "_TEMPLATE", "SKILL.md"), "Template."),
    ]);

    const documents = await discoverSkillDocuments(root);
    expect(documents.map((document) => document.relativePath)).toEqual(["direct", "research/arxiv"]);
    expect(documents[1]).toMatchObject({ category: "research" });
  });

  it("loads skill instructions and approved linked files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myos-skill-load-"));
    await mkdir(path.join(root, "references"), { recursive: true });
    await writeFile(path.join(root, "SKILL.md"), "Skill instructions.");
    await writeFile(path.join(root, "references", "guide.md"), "Linked guide.");

    await expect(readSkillFile(root)).resolves.toBe("Skill instructions.");
    await expect(readSkillFile(root, "references/guide.md")).resolves.toBe("Linked guide.");
  });

  it("rejects traversal, unsupported paths, oversized files, and symlink escapes", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "myos-skill-safe-"));
    const root = path.join(parent, "skill");
    await mkdir(path.join(root, "references"), { recursive: true });
    await writeFile(path.join(root, "SKILL.md"), "Safe.");
    await writeFile(path.join(root, "notes.md"), "Not an approved linked-file location.");
    await writeFile(path.join(parent, "secret.txt"), "outside");

    await expect(readSkillFile(root, "../secret.txt")).rejects.toThrow("not allowed");
    await expect(readSkillFile(root, "notes.md")).rejects.toThrow("not allowed");
    await expect(readSkillFile(root, "SKILL.md", 2)).rejects.toThrow("exceeds");

    try {
      await symlink(path.join(parent, "secret.txt"), path.join(root, "references", "outside.txt"));
      await expect(readSkillFile(root, "references/outside.txt")).rejects.toThrow("outside");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });
});
