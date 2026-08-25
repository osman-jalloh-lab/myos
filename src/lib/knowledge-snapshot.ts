import { prisma } from "@/lib/db";
import { buildObsidianKnowledgeGraph, isPermittedVaultPath, type KnowledgeGraph } from "@/lib/obsidian-knowledge";

export type KnowledgeSourceStatus = { source: "home_pc"; state: "connected" | "offline" | "unavailable"; updatedAt: string | null; synchronized: boolean; message: string };
type SnapshotRow = { graphJson: string; updatedAt: Date | string; workerId: string | null };

async function ensureSnapshotTable(): Promise<void> {
  await prisma.$executeRawUnsafe(`CREATE TABLE IF NOT EXISTS KnowledgeGraphSnapshot (userId TEXT PRIMARY KEY, graphJson TEXT NOT NULL, workerId TEXT, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}

export function sanitizeGraphSnapshot(graph: KnowledgeGraph): KnowledgeGraph {
  const nodes = graph.nodes.filter((node) => isPermittedVaultPath(node.relativePath)).slice(0, 600).map((node) => ({ ...node, label: node.label.slice(0, 120), summary: node.summary.slice(0, 260), relativePath: node.relativePath.replace(/\\/g, "/") })); const allowed = new Set(nodes.map((node) => node.id)); const edges = graph.edges.filter((edge) => allowed.has(edge.source) && allowed.has(edge.target)).slice(0, 2_000);
  return { nodes, edges, updatedAt: graph.updatedAt, truncated: graph.truncated || graph.nodes.length > 600 || graph.edges.length > 2_000 };
}

export async function publishKnowledgeSnapshot(userId: string, graph: KnowledgeGraph, workerId = "home-pc-local-runtime"): Promise<void> {
  await ensureSnapshotTable(); const safe = sanitizeGraphSnapshot(graph); const json = JSON.stringify(safe); if (json.length > 1_500_000) throw new Error("Knowledge snapshot exceeds the safe publication limit.");
  await prisma.$executeRawUnsafe(`INSERT INTO KnowledgeGraphSnapshot (userId, graphJson, workerId, updatedAt) VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(userId) DO UPDATE SET graphJson = excluded.graphJson, workerId = excluded.workerId, updatedAt = CURRENT_TIMESTAMP`, userId, json, workerId);
}

export async function readKnowledgeSnapshot(userId: string): Promise<{ graph: KnowledgeGraph; source: KnowledgeSourceStatus } | null> {
  await ensureSnapshotTable(); const rows = await prisma.$queryRawUnsafe<SnapshotRow[]>(`SELECT graphJson, workerId, updatedAt FROM KnowledgeGraphSnapshot WHERE userId = ? LIMIT 1`, userId); const row = rows[0]; if (!row) return null;
  const graph = sanitizeGraphSnapshot(JSON.parse(row.graphJson) as KnowledgeGraph); const updatedAt = new Date(row.updatedAt).toISOString();
  return { graph, source: { source: "home_pc", state: "offline", updatedAt, synchronized: true, message: "Home PC offline. Showing the last sanitized snapshot." } };
}

export async function refreshKnowledgeSnapshotsForUsers(workerId: string): Promise<number> {
  const graph = await buildObsidianKnowledgeGraph(); const users = await prisma.user.findMany({ select: { id: true }, take: 100 }); await Promise.all(users.map((user) => publishKnowledgeSnapshot(user.id, graph, workerId))); return users.length;
}
