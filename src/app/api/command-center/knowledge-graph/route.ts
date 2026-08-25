import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { buildObsidianKnowledgeGraph, readPermittedObsidianNote, type KnowledgeNodeType } from "@/lib/obsidian-knowledge";
import { publishKnowledgeSnapshot, readKnowledgeSnapshot, type KnowledgeSourceStatus } from "@/lib/knowledge-snapshot";

const TYPES = new Set<KnowledgeNodeType>(["PROJECT", "DECISION", "PROBLEM", "SOLUTION", "AGENT", "SKILL", "TOOL", "NOTE", "TASK", "ARCHITECTURE", "BUILD_MILESTONE", "BRANCH"]);

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  try {
    const notePath = url.searchParams.get("note");
    if (notePath) {
      try { return NextResponse.json({ note: await readPermittedObsidianNote(notePath) }); }
      catch { const snapshot = await readKnowledgeSnapshot(session.user.id); const node = snapshot?.graph.nodes.find((item) => item.relativePath === notePath); if (!node) throw new Error("Permitted note detail is unavailable while the Home PC is offline."); return NextResponse.json({ note: { relativePath: node.relativePath, title: node.label, content: node.summary, updatedAt: node.updatedAt }, source: snapshot?.source }); }
    }
    let graph; let source: KnowledgeSourceStatus;
    try { graph = await buildObsidianKnowledgeGraph(); await publishKnowledgeSnapshot(session.user.id, graph).catch(() => undefined); source = { source: "home_pc", state: "connected", updatedAt: graph.updatedAt, synchronized: true, message: "Home PC connected. Permitted knowledge is live." }; }
    catch { const snapshot = await readKnowledgeSnapshot(session.user.id); if (!snapshot) throw new Error("Knowledge unavailable. The Home PC has not published a permitted snapshot."); graph = snapshot.graph; source = snapshot.source; }
    const query = (url.searchParams.get("q") ?? "").trim().toLowerCase().slice(0, 120);
    const requestedType = (url.searchParams.get("type") ?? "").toUpperCase() as KnowledgeNodeType;
    const filteredNodes = graph.nodes.filter((node) => (!query || `${node.label} ${node.summary} ${node.relativePath}`.toLowerCase().includes(query)) && (!requestedType || !TYPES.has(requestedType) || node.type === requestedType));
    const allowed = new Set(filteredNodes.map((node) => node.id));
    return NextResponse.json({ ...graph, source, nodes: filteredNodes, edges: graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Knowledge graph unavailable.";
    return NextResponse.json({ error: message }, { status: /not configured|unavailable/i.test(message) ? 503 : 400 });
  }
}
