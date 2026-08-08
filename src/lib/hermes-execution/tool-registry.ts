// Hermes Execution Layer — policy-aware tool registry.
// Registration describes a capability; it never grants execution authority.

import type { ExecutionRisk, ToolDefinition } from "./types";

export type ToolSource =
  | "native"
  | "hermes-derived"
  | "mcp"
  | "local-worker"
  | "builder"
  | "system"
  | "unknown";

export type ToolRisk = "read" | "write" | "privileged" | "external-side-effect";
export type ToolAvailability = "available" | "degraded" | "configuration-required" | "unavailable";
export type ToolPermission =
  | "authenticated"
  | "authorized"
  | "approval"
  | "secret-access"
  | "local-worker"
  | "budget"
  | "audit";
export type ToolExecutionEnvironment = "server" | "local-worker" | "browser" | "external-service" | "unknown";

export interface ToolMetadata {
  source: ToolSource;
  toolsets: readonly string[];
  risk: ToolRisk;
  availability: ToolAvailability;
  permissions: readonly ToolPermission[];
  requiresApproval: boolean;
  timeoutMs: number;
  maxResultBytes: number;
  executionEnvironment: ToolExecutionEnvironment;
  description: string;
  capabilityTags?: readonly string[];
}

export interface NormalizedToolMetadata extends Omit<ToolMetadata, "capabilityTags"> {
  capabilityTags: readonly string[];
}

export interface ToolRegistration {
  tool: ToolDefinition;
  metadata: ToolMetadata;
}

export interface RegisteredTool {
  toolId: string;
  metadata: NormalizedToolMetadata;
  registrationMode: "legacy-compatible" | "policy-gated";
}

interface StoredToolRegistration {
  toolId: string;
  tool: ToolDefinition;
  metadata: NormalizedToolMetadata;
  registrationMode: RegisteredTool["registrationMode"];
}

export interface ToolsetSummary {
  name: string;
  toolIds: string[];
}

export interface ToolRegistrationOptions {
  allowOverride?: boolean;
  reason?: string;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const LEGACY_RESULT_BUDGET_BYTES = 256 * 1024;
const CONSERVATIVE_RESULT_BUDGET_BYTES = 64 * 1024;

const SOURCES = new Set<ToolSource>([
  "native", "hermes-derived", "mcp", "local-worker", "builder", "system", "unknown",
]);
const RISKS = new Set<ToolRisk>(["read", "write", "privileged", "external-side-effect"]);
const AVAILABILITY = new Set<ToolAvailability>([
  "available", "degraded", "configuration-required", "unavailable",
]);
const PERMISSION_ORDER: ToolPermission[] = [
  "authenticated", "authorized", "approval", "secret-access", "local-worker", "budget", "audit",
];
const PERMISSIONS = new Set<ToolPermission>(PERMISSION_ORDER);
const ENVIRONMENTS = new Set<ToolExecutionEnvironment>([
  "server", "local-worker", "browser", "external-service", "unknown",
]);

const registry = new Map<string, StoredToolRegistration>();
const policyGatedDefinitions = new WeakSet<ToolDefinition>();

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean))).sort(compareCodePoints);
}

function orderedPermissions(values: readonly ToolPermission[]): ToolPermission[] {
  const selected = new Set(values);
  return PERMISSION_ORDER.filter((permission) => selected.has(permission));
}

function legacyRisk(risk: ExecutionRisk): ToolRisk {
  if (risk === "internal_write") return "write";
  if (risk === "external_write") return "external-side-effect";
  if (risk === "dangerous") return "privileged";
  return "read";
}

function maxRisk(first: ToolRisk, second: ToolRisk): ToolRisk {
  const rank: Record<ToolRisk, number> = {
    read: 0,
    write: 1,
    privileged: 2,
    "external-side-effect": 3,
  };
  return rank[first] >= rank[second] ? first : second;
}

function requiredPermissions(risk: ToolRisk, requiresApproval: boolean): ToolPermission[] {
  const permissions: ToolPermission[] = ["authenticated", "authorized"];
  if (requiresApproval || risk === "privileged" || risk === "external-side-effect") permissions.push("approval");
  return permissions;
}

function legacyMetadata(tool: ToolDefinition): NormalizedToolMetadata {
  const risk = legacyRisk(tool.risk);
  const requiresApproval = tool.requiresApproval || risk === "privileged" || risk === "external-side-effect";
  return Object.freeze({
    source: "native" as const,
    toolsets: Object.freeze(["legacy"]),
    risk,
    availability: "available" as const,
    permissions: Object.freeze(requiredPermissions(risk, requiresApproval)),
    requiresApproval,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    maxResultBytes: LEGACY_RESULT_BUDGET_BYTES,
    executionEnvironment: "server" as const,
    description: tool.description,
    capabilityTags: Object.freeze([]),
  });
}

function validPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function normalizePolicyMetadata(tool: ToolDefinition, input: ToolMetadata): NormalizedToolMetadata {
  const raw = input as Partial<ToolMetadata>;
  const complete =
    SOURCES.has(raw.source as ToolSource)
    && Array.isArray(raw.toolsets)
    && raw.toolsets.every((toolset) => typeof toolset === "string")
    && RISKS.has(raw.risk as ToolRisk)
    && AVAILABILITY.has(raw.availability as ToolAvailability)
    && Array.isArray(raw.permissions)
    && raw.permissions.every((permission) => PERMISSIONS.has(permission))
    && typeof raw.requiresApproval === "boolean"
    && validPositiveInteger(raw.timeoutMs)
    && validPositiveInteger(raw.maxResultBytes)
    && ENVIRONMENTS.has(raw.executionEnvironment as ToolExecutionEnvironment)
    && typeof raw.description === "string"
    && raw.description.trim().length > 0
    && (raw.capabilityTags === undefined
      || (Array.isArray(raw.capabilityTags) && raw.capabilityTags.every((tag) => typeof tag === "string")));

  const source = SOURCES.has(raw.source as ToolSource) ? raw.source as ToolSource : "unknown";
  const requestedRisk = complete ? raw.risk as ToolRisk : "privileged";
  const risk = maxRisk(requestedRisk, legacyRisk(tool.risk));
  const requestedApproval = complete ? Boolean(raw.requiresApproval) : true;
  const requiresApproval = tool.requiresApproval
    || requestedApproval
    || risk === "privileged"
    || risk === "external-side-effect";
  const suppliedPermissions = complete ? raw.permissions as readonly ToolPermission[] : [];
  const permissions = orderedPermissions([
    ...requiredPermissions(risk, requiresApproval),
    ...suppliedPermissions,
  ]);

  return Object.freeze({
    source,
    toolsets: Object.freeze(complete ? sortedUnique(raw.toolsets as readonly string[]) : []),
    risk,
    availability: complete ? raw.availability as ToolAvailability : "unavailable",
    permissions: Object.freeze(permissions),
    requiresApproval,
    timeoutMs: complete ? raw.timeoutMs as number : DEFAULT_TIMEOUT_MS,
    maxResultBytes: complete ? raw.maxResultBytes as number : CONSERVATIVE_RESULT_BUDGET_BYTES,
    executionEnvironment: complete ? raw.executionEnvironment as ToolExecutionEnvironment : "unknown",
    description: complete ? (raw.description as string).trim() : tool.description,
    capabilityTags: Object.freeze(complete ? sortedUnique(raw.capabilityTags ?? []) : []),
  });
}

function isPolicyRegistration(value: ToolDefinition | ToolRegistration): value is ToolRegistration {
  return "tool" in value && "metadata" in value;
}

export function registerTool(
  value: ToolDefinition | ToolRegistration,
  options: ToolRegistrationOptions = {},
): void {
  const policyGated = isPolicyRegistration(value);
  const suppliedTool = policyGated ? value.tool : value;
  if (typeof suppliedTool.name !== "string" || suppliedTool.name.length === 0 || suppliedTool.name.trim() !== suppliedTool.name) {
    throw new Error("Tool ID must be a non-empty string without surrounding whitespace.");
  }
  const toolId = suppliedTool.name;
  const tool = suppliedTool;
  const existing = registry.get(toolId);

  if (!policyGated && policyGatedDefinitions.has(tool)) {
    throw new Error(`Tool "${toolId}" cannot be downgraded to legacy-compatible registration.`);
  }

  if (existing?.registrationMode === "policy-gated" && !policyGated) {
    throw new Error(`Tool "${tool.name}" cannot be downgraded to legacy-compatible registration.`);
  }
  if (existing && policyGated) {
    if (!options.allowOverride) throw new Error(`Tool "${tool.name}" is already registered.`);
    if (!options.reason?.trim()) throw new Error(`Tool "${tool.name}" override reason is required.`);
  }

  if (policyGated) policyGatedDefinitions.add(tool);

  const registration: StoredToolRegistration = Object.freeze({
    toolId,
    tool,
    metadata: policyGated ? normalizePolicyMetadata(tool, value.metadata) : legacyMetadata(tool),
    registrationMode: policyGated ? "policy-gated" : "legacy-compatible",
  });
  registry.set(toolId, registration);
}

// Compatibility resolver for existing My OS tools only. Policy-gated tools are
// intentionally not executable through this legacy path.
export function getTool(name: string): ToolDefinition | undefined {
  const registration = registry.get(name);
  if (registration?.registrationMode !== "legacy-compatible") return undefined;
  if (registration.metadata.availability !== "available") return undefined;
  return registration.tool;
}

function listStoredRegistrations(): StoredToolRegistration[] {
  return Array.from(registry.values()).sort((a, b) => compareCodePoints(a.toolId, b.toolId));
}

function describeRegistration(registration: StoredToolRegistration): RegisteredTool {
  return Object.freeze({
    toolId: registration.toolId,
    metadata: registration.metadata,
    registrationMode: registration.registrationMode,
  });
}

export function getToolRegistration(name: string): RegisteredTool | undefined {
  const registration = registry.get(name);
  return registration ? describeRegistration(registration) : undefined;
}

// Existing callers continue to see only tools executable through existing My OS policy.
export function listTools(): ToolDefinition[] {
  return listStoredRegistrations()
    .filter((registration) => registration.registrationMode === "legacy-compatible")
    .filter((registration) => registration.metadata.availability === "available")
    .map((registration) => registration.tool);
}

export function listToolRegistrations(): RegisteredTool[] {
  return listStoredRegistrations().map(describeRegistration);
}

export function getToolset(name: string): RegisteredTool[] {
  return listToolRegistrations().filter((registration) => registration.metadata.toolsets.includes(name));
}

export function listToolsets(): ToolsetSummary[] {
  const toolsets = new Map<string, string[]>();
  for (const registration of listToolRegistrations()) {
    for (const toolset of registration.metadata.toolsets) {
      const ids = toolsets.get(toolset) ?? [];
      ids.push(registration.toolId);
      toolsets.set(toolset, ids);
    }
  }
  return Array.from(toolsets.entries())
    .sort(([a], [b]) => compareCodePoints(a, b))
    .map(([name, toolIds]) => ({ name, toolIds }));
}

export function hasTool(name: string): boolean {
  return getTool(name) !== undefined;
}

export function hasToolRegistration(name: string): boolean {
  return registry.has(name);
}

export function clearToolRegistryForTests(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Tool registry reset is only available in test environments.");
  }
  registry.clear();
  _initialized = false;
}

// Called at startup to seed the registry with all registered tools.
// MCP tools, if any, are loaded separately via mcp-adapter.ts.
// Keep this lazy so tools are only imported when the execution layer is active.
let _initialized = false;

export async function ensureRegistryInitialized(): Promise<void> {
  if (_initialized) return;
  _initialized = true;

  const { registerInternalTools } = await import("./tools/internal-tools");
  registerInternalTools();

  try {
    const { loadMcpToolsIntoRegistry } = await import("./mcp-adapter");
    await loadMcpToolsIntoRegistry();
  } catch {
    // MCP adapter is optional — silently continue if unavailable.
  }
}
