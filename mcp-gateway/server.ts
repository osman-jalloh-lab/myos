// Parawi MCP Gateway
// Standalone MCP server — Claude Desktop connects to this via stdio.
// This gateway reads skill definitions from /skills/*.json and proxies
// tool calls to the live Parawi execution API at PARAWI_URL/api/hermes/execute.
//
// Parawi does NOT depend on this gateway being open. The gateway is purely
// additive — it lets Claude Desktop call Parawi tools without a browser session.
//
// Setup: see ../docs/mcp-gateway.md

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── config ────────────────────────────────────────────────────────────────────

const PARAWI_URL = (process.env.PARAWI_URL ?? "https://www.parawi.com").replace(/\/$/, "");
const API_KEY = process.env.PARAWI_MCP_API_KEY ?? "";

if (!API_KEY) {
  console.error("[parawi-mcp-gateway] WARNING: PARAWI_MCP_API_KEY is not set. Calls to Parawi will fail auth.");
}

// ── load skills ───────────────────────────────────────────────────────────────

interface SkillDef {
  name: string;
  description: string;
  inputs?: Record<string, { type: string; description: string }>;
  required?: string[];
  examples?: string[];
  execution?: { tool: string; risk: string; requiresApproval: boolean };
}

const skillsDir = join(__dirname, "../skills");

function loadSkills(): SkillDef[] {
  if (!existsSync(skillsDir)) {
    console.error(`[parawi-mcp-gateway] skills/ directory not found at ${skillsDir}`);
    return [];
  }
  return readdirSync(skillsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      try {
        return JSON.parse(readFileSync(join(skillsDir, f), "utf-8")) as SkillDef;
      } catch {
        console.error(`[parawi-mcp-gateway] Failed to parse skill file: ${f}`);
        return null;
      }
    })
    .filter(Boolean) as SkillDef[];
}

const skills = loadSkills();
console.error(`[parawi-mcp-gateway] Loaded ${skills.length} skills from ${skillsDir}`);

// ── MCP server ────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "parawi-mcp-gateway",
  version: "1.0.0",
});

// ── register each skill as an MCP tool ───────────────────────────────────────

for (const skill of skills) {
  // Build Zod schema from the skill's inputs
  const schemaShape: Record<string, z.ZodTypeAny> = {};

  for (const [key, def] of Object.entries(skill.inputs ?? {})) {
    let field: z.ZodTypeAny = z.string().describe(def.description);
    if (!(skill.required ?? []).includes(key)) {
      field = field.optional();
    }
    schemaShape[key] = field;
  }

  // Always include a fallback message field
  if (!schemaShape.message) {
    schemaShape.message = z.string().describe("Natural language command for this skill");
  }

  const schema = z.object(schemaShape);

  const examplesLine = skill.examples?.length
    ? `\n\nExamples:\n${skill.examples.map((e) => `  • ${e}`).join("\n")}`
    : "";

  server.tool(
    skill.name,
    `${skill.description}${examplesLine}`,
    schema.shape,
    async (args: Record<string, unknown>) => {
      const message = (args.message as string) ?? JSON.stringify(args);

      let result: { answer?: string; status?: string; artifacts?: unknown[] };
      try {
        const res = await fetch(`${PARAWI_URL}/api/hermes/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Parawi-Key": API_KEY,
          },
          body: JSON.stringify({
            message,
            source: "api",
            context: { mcpTool: skill.name, originalArgs: args },
          }),
        });

        if (!res.ok) {
          const text = await res.text();
          return {
            content: [
              {
                type: "text" as const,
                text: `Parawi execution failed (${res.status}): ${text}`,
              },
            ],
            isError: true,
          };
        }

        result = (await res.json()) as typeof result;
      } catch (err) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Network error calling Parawi: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }

      const answer = result.answer ?? JSON.stringify(result);
      const statusNote =
        result.status === "approval_required"
          ? "\n\n⚠️ This action requires your approval in the Parawi dashboard before it takes effect."
          : result.status === "blocked"
          ? "\n\n🚫 This action is blocked — it requires manual execution."
          : "";

      return {
        content: [
          {
            type: "text" as const,
            text: `${answer}${statusNote}`,
          },
        ],
      };
    }
  );
}

// ── start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
console.error(`[parawi-mcp-gateway] Ready. Connected to ${PARAWI_URL}`);
