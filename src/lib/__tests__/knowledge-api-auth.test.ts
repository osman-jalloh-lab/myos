import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), graph: vi.fn(), note: vi.fn() }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/obsidian-knowledge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/obsidian-knowledge")>("@/lib/obsidian-knowledge");
  return { ...actual, buildObsidianKnowledgeGraph: mocks.graph, readPermittedObsidianNote: mocks.note };
});
import { GET } from "@/app/api/command-center/knowledge-graph/route";

describe("knowledge graph API boundary", () => {
  beforeEach(() => { vi.clearAllMocks(); mocks.graph.mockResolvedValue({ nodes: [{ id: "n1", label: "Hermes OS", type: "PROJECT", source: "Obsidian", relativePath: "02 Projects/Hermes OS.md", summary: "Project", updatedAt: "2026-08-24T00:00:00.000Z" }], edges: [], updatedAt: "2026-08-24T00:00:00.000Z", truncated: false }); });
  it("requires authentication before touching the vault", async () => { mocks.auth.mockResolvedValue(null); const response = await GET(new Request("http://localhost/api/command-center/knowledge-graph")); expect(response.status).toBe(401); expect(mocks.graph).not.toHaveBeenCalled(); });
  it("returns only the bounded server-produced graph", async () => { mocks.auth.mockResolvedValue({ user: { id: "owner" } }); const response = await GET(new Request("http://localhost/api/command-center/knowledge-graph?type=PROJECT")); expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ nodes: [{ relativePath: "02 Projects/Hermes OS.md" }] }); });
});
