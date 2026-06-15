// Mercury / MCP Agent endpoint
//
// GET  /api/mcp-agent — returns the tool registry (which tools are connected)
// POST /api/mcp-agent — send a natural-language query to Mercury

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { handleMercuryRequest, TOOL_REGISTRY } from "@/agents/mercury";

export const dynamic = "force-dynamic";

// GET — tool registry: what's connected, what's not, what's missing
export async function GET() {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const tools = Object.values(TOOL_REGISTRY).map((t) => ({
    id: t.id,
    label: t.label,
    category: t.category,
    description: t.description,
    connected: t.connected,
    notConnectedHint: t.connected ? null : t.notConnectedHint,
  }));

  return Response.json({ tools });
}

// POST — query Mercury
export async function POST(req: Request) {
  const session = await auth();
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { query?: string; channel?: string };
  if (!body.query?.trim()) {
    return Response.json({ error: "query is required" }, { status: 400 });
  }

  const user = await prisma.user.findFirst({ orderBy: { createdAt: "asc" } });
  if (!user) return Response.json({ error: "No user row — sign in on the dashboard first" }, { status: 503 });

  const result = await handleMercuryRequest(user.id, body.query.trim(), body.channel ?? "dashboard");
  return Response.json(result);
}
