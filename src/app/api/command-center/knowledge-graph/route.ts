import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildObsidianKnowledgeGraph, readPermittedObsidianNote, type KnowledgeNodeType } from "@/lib/obsidian-knowledge";

const TYPES = new Set<KnowledgeNodeType>(["PROJECT", "DECISION", "PROBLEM", "SOLUTION", "AGENT", "SKILL", "TOOL", "NOTE", "TASK", "ARCHITECTURE", "BUILD_MILESTONE", "BRANCH"]);

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  try {
    const notePath = url.searchParams.get("note");
    if (notePath) return NextResponse.json({ note: await readPermittedObsidianNote(notePath) });
    const graph = await buildObsidianKnowledgeGraph();
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 120);
    const requestedType = (url.searchParams.get("type") ?? "").toUpperCase() as KnowledgeNodeType;
    const filteredNodes = graph.nodes.filter((node) => (!query || `${node.label} ${node.summary} ${node.relativePath}`.toLowerCase().includes(query)) && (!requestedType || !TYPES.has(requestedType) || node.type === requestedType));
    const allowed = new Set(filteredNodes.map((node) => node.id));
    return NextResponse.json({ ...graph, nodes: filteredNodes, edges: graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Knowledge graph unavailable.";
    return NextResponse.json({ error: message }, { status: /not configured|unavailable/i.test(message) ? 503 : 400 });
  }
}
