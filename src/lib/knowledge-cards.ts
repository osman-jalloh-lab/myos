import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type CardFrontmatter = Record<string, string | number | boolean | string[] | null>;

export type KnowledgeCard = {
  frontmatter: CardFrontmatter;
  body: string;
  path: string;
};

export type CardFilter = Record<string, string | number | boolean | string[]>;

export type AgentBootstrapLoad = {
  collection: string;
  filter: CardFilter;
};

export type AgentBootstrapManifest = {
  agent: string;
  loads: AgentBootstrapLoad[];
};

const COLLECTION_TYPES: Record<string, string> = {
  senders: "sender",
  feeds: "feed",
  assets: "asset",
  policies: "policy",
  contacts: "contact",
  design: "design",
  skills: "skill",
  projects: "project",
  preferences: "preference",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function catalogRoot(root = process.cwd()): string {
  return path.resolve(root, "catalog");
}

function guardedCatalogPath(relativePath: string, root = process.cwd()): string {
  if (!relativePath || path.isAbsolute(relativePath)) {
    throw new Error("Catalog paths must be relative paths under catalog/.");
  }

  const normalized = relativePath.replace(/\\/g, "/").replace(/^catalog\//, "");
  if (normalized.split("/").some((part) => part === ".." || part === "")) {
    throw new Error("Unsafe catalog path rejected.");
  }

  const base = catalogRoot(root);
  const resolved = path.resolve(base, ...normalized.split("/"));
  const baseWithSep = base.endsWith(path.sep) ? base : `${base}${path.sep}`;
  if (resolved !== base && !resolved.startsWith(baseWithSep)) {
    throw new Error("Catalog writes are restricted to /catalog.");
  }
  return resolved;
}

function relativeCatalogPath(absolutePath: string, root = process.cwd()): string {
  return path.relative(catalogRoot(root), absolutePath).replace(/\\/g, "/");
}

function parseScalar(value: string): string | number | boolean | string[] | null {
  const trimmed = value.trim();
  if (trimmed === "null") return null;
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((part) => part.trim().replace(/^["']|["']$/g, ""));
  }
  return trimmed.replace(/^["']|["']$/g, "");
}

function serializeScalar(value: CardFrontmatter[string]): string {
  if (Array.isArray(value)) return `[${value.join(", ")}]`;
  if (value === null) return "null";
  return String(value);
}

export function parseCard(content: string, cardPath = ""): KnowledgeCard {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) throw new Error(`Knowledge card is missing YAML frontmatter${cardPath ? `: ${cardPath}` : ""}.`);

  const frontmatter: CardFrontmatter = {};
  for (const line of match[1].split(/\r?\n/)) {
    if (!line.trim()) continue;
    const idx = line.indexOf(":");
    if (idx === -1) throw new Error(`Invalid frontmatter line in ${cardPath || "card"}: ${line}`);
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1);
    frontmatter[key] = parseScalar(value);
  }

  return { frontmatter, body: match[2].trim(), path: cardPath };
}

export function formatCard(frontmatter: CardFrontmatter, body: string): string {
  validateCard({ frontmatter, body, path: "" });
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${serializeScalar(value)}`);
  return `---\n${lines.join("\n")}\n---\n${body.trim()}\n`;
}

export function validateCard(card: KnowledgeCard): void {
  const { frontmatter, body } = card;
  for (const key of ["type", "id", "updated"]) {
    if (typeof frontmatter[key] !== "string" || !String(frontmatter[key]).trim()) {
      throw new Error(`Knowledge card is missing required frontmatter key: ${key}`);
    }
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(frontmatter.updated))) {
    throw new Error("Knowledge card updated date must be YYYY-MM-DD.");
  }
  if (`${JSON.stringify(frontmatter)}\n${body}`.includes("—")) {
    throw new Error("Knowledge cards must not contain em dashes.");
  }
}

export async function readCard(cardPath: string, root = process.cwd()): Promise<KnowledgeCard> {
  const absolutePath = guardedCatalogPath(cardPath, root);
  const content = await readFile(absolutePath, "utf8");
  const card = parseCard(content, relativeCatalogPath(absolutePath, root));
  validateCard(card);
  return card;
}

export async function loadCollection(name: string, root = process.cwd()): Promise<KnowledgeCard[]> {
  if (!COLLECTION_TYPES[name]) throw new Error(`Unknown catalog collection: ${name}`);
  const dir = guardedCatalogPath(name, root);
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const cards = await Promise.all(entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => readCard(`${name}/${entry.name}`, root)));
  return cards.sort((a, b) => a.path.localeCompare(b.path));
}

function matchesFilterValue(actual: CardFrontmatter[string], expected: CardFilter[string]): boolean {
  if (Array.isArray(actual)) {
    return Array.isArray(expected)
      ? expected.every((item) => actual.includes(String(item)))
      : actual.includes(String(expected));
  }
  if (Array.isArray(expected)) return expected.map(String).includes(String(actual));
  return actual === expected;
}

export async function queryCards(name: string, filter: CardFilter, root = process.cwd()): Promise<KnowledgeCard[]> {
  const cards = await loadCollection(name, root);
  return cards.filter((card) => Object.entries(filter).every(([key, value]) => matchesFilterValue(card.frontmatter[key], value)));
}

function validatePathMatchesCard(cardPath: string, frontmatter: CardFrontmatter): void {
  const parts = cardPath.replace(/\\/g, "/").replace(/^catalog\//, "").split("/");
  if (parts.length !== 2 || !parts[1].endsWith(".md")) {
    throw new Error("Card path must look like catalog/<collection>/<id>.md.");
  }
  const [collection, file] = parts;
  const expectedType = COLLECTION_TYPES[collection];
  if (!expectedType) throw new Error(`Unknown card collection: ${collection}`);
  const id = file.replace(/\.md$/, "");
  if (frontmatter.type !== expectedType) throw new Error(`Card type must be ${expectedType} for ${collection}/.`);
  if (frontmatter.id !== id) throw new Error("Card id must match its filename.");
}

export async function writeCard(cardPath: string, frontmatter: CardFrontmatter, body: string, root = process.cwd()): Promise<KnowledgeCard> {
  const absolutePath = guardedCatalogPath(cardPath, root);
  const nextFrontmatter = { ...frontmatter, updated: today() };
  validatePathMatchesCard(cardPath, nextFrontmatter);
  const content = formatCard(nextFrontmatter, body);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content, "utf8");
  return readCard(cardPath, root);
}

export async function patchFrontmatter(cardPath: string, partial: CardFrontmatter, root = process.cwd()): Promise<KnowledgeCard> {
  const card = await readCard(cardPath, root);
  return writeCard(cardPath, { ...card.frontmatter, ...partial, updated: today() }, card.body, root);
}

export async function appendSection(cardPath: string, heading: string, content: string, root = process.cwd()): Promise<KnowledgeCard> {
  if (heading.includes("—") || content.includes("—")) throw new Error("Knowledge cards must not contain em dashes.");
  const card = await readCard(cardPath, root);
  const nextBody = `${card.body.trim()}\n\n## ${heading.trim()}\n${content.trim()}`;
  return writeCard(cardPath, { ...card.frontmatter, updated: today() }, nextBody, root);
}

function parseInlineFilter(value: string): CardFilter {
  const trimmed = value.trim().replace(/^\{|\}$/g, "").trim();
  if (!trimmed) return {};
  return Object.fromEntries(trimmed.split(",").map((entry) => {
    const [rawKey, ...rawValue] = entry.split(":");
    return [rawKey.trim(), parseScalar(rawValue.join(":").trim()) as CardFilter[string]];
  }));
}

export function parseAgentBootstrapManifest(content: string): AgentBootstrapManifest {
  const agent = content.match(/^agent:\s*(.+)$/m)?.[1]?.trim();
  if (!agent) throw new Error("Agent bootstrap manifest is missing agent.");

  const loads: AgentBootstrapLoad[] = [];
  let current: Partial<AgentBootstrapLoad> | null = null;
  for (const line of content.split(/\r?\n/)) {
    const collection = line.match(/^\s*-\s*collection:\s*(.+)$/)?.[1]?.trim();
    if (collection) {
      current = { collection, filter: {} };
      loads.push(current as AgentBootstrapLoad);
      continue;
    }
    const filter = line.match(/^\s*filter:\s*(\{.*\})\s*$/)?.[1];
    if (filter && current) current.filter = parseInlineFilter(filter);
  }

  return { agent, loads };
}

export async function loadAgentBootstrap(agent: string, root = process.cwd()): Promise<AgentBootstrapManifest> {
  const manifestPath = path.resolve(root, "agents", agent, "context.yaml");
  const agentsRoot = path.resolve(root, "agents");
  const agentsRootWithSep = agentsRoot.endsWith(path.sep) ? agentsRoot : `${agentsRoot}${path.sep}`;
  if (!manifestPath.startsWith(agentsRootWithSep)) throw new Error("Unsafe agent bootstrap path rejected.");
  return parseAgentBootstrapManifest(await readFile(manifestPath, "utf8"));
}

export async function loadAgentKnowledgeContext(agent: string, root = process.cwd()): Promise<KnowledgeCard[]> {
  const manifest = await loadAgentBootstrap(agent, root);
  const groups = await Promise.all(manifest.loads.map((entry) => queryCards(entry.collection, entry.filter, root)));
  return groups.flat();
}
