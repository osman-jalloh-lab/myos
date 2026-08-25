import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildObsidianKnowledgeGraph, isPermittedVaultPath, readPermittedObsidianNote } from "@/lib/obsidian-knowledge";

const roots: string[] = [];
async function vault() { const root = await mkdtemp(path.join(os.tmpdir(), "hermes-graph-")); roots.push(root); for (const folder of ["02 Projects", "05 Knowledge/Troubleshooting/Hermes OS", "90 Private"]) await mkdir(path.join(root, ...folder.split("/")), { recursive: true }); return root; }
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("Obsidian knowledge graph", () => {
  it("extracts real note nodes and explicit wikilink edges", async () => {
    const root = await vault();
    await writeFile(path.join(root, "02 Projects", "Hermes OS.md"), "---\ntype: project\n---\n# Hermes OS\nSee [[05 Knowledge/Troubleshooting/Hermes OS/Preview failure]].");
    await writeFile(path.join(root, "05 Knowledge", "Troubleshooting", "Hermes OS", "Preview failure.md"), "---\ntype: problem\nstatus: solved\n---\n# Preview failure\n## Successful fix\n\nRestart only the Builder-owned preview container.\n");
    const graph = await buildObsidianKnowledgeGraph({ root });
    expect(graph.nodes.map((node) => [node.label, node.type])).toEqual(expect.arrayContaining([["Hermes OS", "PROJECT"], ["Preview failure", "PROBLEM"], ["Solution · Preview failure", "SOLUTION"]]));
    expect(graph.edges.map((edge) => edge.relation)).toEqual(expect.arrayContaining(["wikilink", "fixed-by"]));
  });

  it("excludes the private boundary before traversal or graph output", async () => {
    const root = await vault();
    await writeFile(path.join(root, "02 Projects", "Public.md"), "# Public\n[[90 Private/Never Read]]");
    await writeFile(path.join(root, "90 Private", "Never Read.md"), "# Private sentinel that must never be processed");
    const graph = await buildObsidianKnowledgeGraph({ root });
    expect(isPermittedVaultPath("90 Private/Never Read.md")).toBe(false);
    expect(JSON.stringify(graph)).not.toMatch(/90 Private|Private sentinel|Never Read/);
    await expect(readPermittedObsidianNote("90 Private/Never Read.md", root)).rejects.toThrow("outside the permitted");
  });

  it("rejects traversal, absolute paths, and unapproved top-level folders", async () => {
    for (const unsafe of ["../secret.md", "C:/secret.md", "/secret.md", "Secrets/note.md", "02 Projects/../../secret.md"]) expect(isPermittedVaultPath(unsafe)).toBe(false);
  });
});
