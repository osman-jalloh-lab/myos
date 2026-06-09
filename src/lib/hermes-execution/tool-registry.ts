// Hermes Execution Layer — tool registry
// Does NOT replace MCP. Wraps both internal MyOS tools and any future MCP tools
// under a single interface so the planner/executor can call either.

import type { ToolDefinition } from "./types";

const registry = new Map<string, ToolDefinition>();

export function registerTool(tool: ToolDefinition): void {
  registry.set(tool.name, tool);
}

export function getTool(name: string): ToolDefinition | undefined {
  return registry.get(name);
}

export function listTools(): ToolDefinition[] {
  return Array.from(registry.values());
}

export function hasTool(name: string): boolean {
  return registry.has(name);
}

// Called at startup to seed the registry with all registered tools.
// MCP tools, if any, are loaded separately via mcp-adapter.ts.
// Keep this lazy so tools are only imported when the execution layer is active.
let _initialized = false;

export async function ensureRegistryInitialized(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  // Import and register all internal tools
  const { registerInternalTools } = await import("./tools/internal-tools");
  registerInternalTools();

  // Attempt MCP adapter (no-op if no MCP config exists)
  try {
    const { loadMcpToolsIntoRegistry } = await import("./mcp-adapter");
    await loadMcpToolsIntoRegistry();
  } catch {
    // MCP adapter is optional — silently continue if unavailable
  }
}
