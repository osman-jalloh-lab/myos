// Hermes Execution Layer — MCP adapter
// This repo does not currently use MCP (Model Context Protocol).
// All tool integrations are via direct API calls and OAuth tokens.
// This file is a graceful no-op that exists so the registry initializer
// can safely import it without blowing up.
//
// TODO: If MCP tools are added in future, register them here:
//
//   import { registerTool } from "./tool-registry";
//
//   if (mcp.github) {
//     registerTool({
//       name: "mcp.github.inspectRepo",
//       description: "Inspect a GitHub repo via MCP",
//       risk: "read",
//       requiresApproval: false,
//       execute: async (input, ctx) => mcp.github.readRepo(input.url as string),
//     });
//   }

export async function loadMcpToolsIntoRegistry(): Promise<void> {
  // No MCP tools in this repo — nothing to register.
  // The planner falls back to internal.* tools automatically.
  return;
}
