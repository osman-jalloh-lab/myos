import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { isPermittedVaultPath, resolveObsidianVaultRoot } from "@/lib/obsidian-knowledge";

export type ProblemStatus = "ACTIVE" | "CONFIRMED" | "UNVERIFIED" | "OUTDATED" | "SOLVED";
export type TroubleshootingRecord = {
  id: string; slug: string; title: string; status: ProblemStatus; firstSeen: string; lastSeen: string;
  affectedSystem: string; symptoms: string[]; errorSignature: string; reproductionConditions: string[];
  impact: string; frequency: number; suspectedCauses: string[]; confirmedRootCause: string;
  attemptedFixes: string[]; failedAttempts: string[]; successfulFix: string; validation: string[];
  prevention: string[]; relatedProject: string; relatedBranch: string; relatedCommit: string;
  relatedFiles: string[]; relatedExecutionRun: string; relatedTrace: string; relatedAgent: string;
  relatedExecutor: string; relativeNotePath: string; confidence: string; openQuestions: string[];
};

const RECORD_ROOT = "05 Knowledge/Troubleshooting/Hermes OS";
const SECRET_PATTERN = /(?:authorization\s*[:=]\s*(?:bearer\s+)?|bearer\s+|api[_ -]?key\s*[:=]\s*|token\s*[:=]\s*|password\s*[:=]\s*)[^\s,;]+/gi;

export function sanitizeProblemText(value: unknown, max = 2000): string {
  return String(value ?? "").replace(/\0/g, "").replace(SECRET_PATTERN, (match) => `${match.split(/[:=\s]/)[0]} [REDACTED]`).replace(/\b[A-Za-z0-9_-]{32,}\b/g, "[REDACTED]").replace(/\s+/g, " ").trim().slice(0, max);
}

export function problemSignature(input: { affectedSystem: string; symptoms?: string[]; errorSignature?: string }): string {
  const canonical = [input.affectedSystem, input.errorSignature, ...(input.symptoms ?? [])].map((value) => sanitizeProblemText(value, 500).toLowerCase().replace(/\b\d+\b/g, "#").replace(/[^a-z#]+/g, " ").trim()).filter(Boolean).join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 20);
}

export function problemSlug(title: string, signature: string): string {
  const base = sanitizeProblemText(title, 100).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 64) || "problem";
  return `${base}-${signature.slice(0, 8)}`;
}
function safeSlug(value: unknown): string { return String(value ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90); }

function lines(value: unknown): string[] { return Array.isArray(value) ? value.map((item) => sanitizeProblemText(item, 1000)).filter(Boolean).slice(0, 50) : []; }
function safeStatus(value: unknown): ProblemStatus { return ["ACTIVE", "CONFIRMED", "UNVERIFIED", "OUTDATED", "SOLVED"].includes(String(value).toUpperCase()) ? String(value).toUpperCase() as ProblemStatus : "UNVERIFIED"; }

export function sanitizeTroubleshootingRecord(input: Partial<TroubleshootingRecord> & { title: string; affectedSystem: string }): TroubleshootingRecord {
  const signature = problemSignature({ affectedSystem: input.affectedSystem, symptoms: input.symptoms, errorSignature: input.errorSignature });
  const now = new Date().toISOString();
  return {
    id: signature, slug: input.slug ? safeSlug(input.slug) : problemSlug(input.title, signature),
    title: sanitizeProblemText(input.title, 160), status: safeStatus(input.status), firstSeen: sanitizeProblemText(input.firstSeen, 40) || now,
    lastSeen: sanitizeProblemText(input.lastSeen, 40) || now, affectedSystem: sanitizeProblemText(input.affectedSystem, 160),
    symptoms: lines(input.symptoms), errorSignature: sanitizeProblemText(input.errorSignature, 800), reproductionConditions: lines(input.reproductionConditions),
    impact: sanitizeProblemText(input.impact, 1000), frequency: Math.max(1, Math.min(100_000, Number(input.frequency) || 1)),
    suspectedCauses: lines(input.suspectedCauses), confirmedRootCause: sanitizeProblemText(input.confirmedRootCause, 2000), attemptedFixes: lines(input.attemptedFixes),
    failedAttempts: lines(input.failedAttempts), successfulFix: sanitizeProblemText(input.successfulFix, 3000), validation: lines(input.validation), prevention: lines(input.prevention),
    relatedProject: sanitizeProblemText(input.relatedProject, 160), relatedBranch: sanitizeProblemText(input.relatedBranch, 200), relatedCommit: sanitizeProblemText(input.relatedCommit, 80),
    relatedFiles: lines(input.relatedFiles), relatedExecutionRun: sanitizeProblemText(input.relatedExecutionRun, 100), relatedTrace: sanitizeProblemText(input.relatedTrace, 200),
    relatedAgent: sanitizeProblemText(input.relatedAgent, 100), relatedExecutor: sanitizeProblemText(input.relatedExecutor, 100), relativeNotePath: `${RECORD_ROOT}/${input.slug ? safeSlug(input.slug) : problemSlug(input.title, signature)}.md`,
    confidence: sanitizeProblemText(input.confidence, 40) || "unverified", openQuestions: lines(input.openQuestions),
  };
}

function section(title: string, values: string[]): string { return `## ${title}\n\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "- None recorded"}`; }
function recordMarkdown(record: TroubleshootingRecord): string {
  return `---\ntype: problem\nstatus: ${record.status.toLowerCase()}\nproblem_id: ${record.id}\ncreated: ${record.firstSeen.slice(0, 10)}\nlast_seen: ${record.lastSeen}\nfrequency: ${record.frequency}\naffected_system: ${record.affectedSystem}\nrelated_project: ${record.relatedProject}\nrelated_branch: ${record.relatedBranch}\nrelated_commit: ${record.relatedCommit}\nconfidence: ${record.confidence}\n---\n\n# ${record.title}\n\n${section("Symptoms", record.symptoms)}\n\n## Sanitized error signature\n\n${record.errorSignature || "Not recorded"}\n\n${section("Reproduction conditions", record.reproductionConditions)}\n\n## Impact\n\n${record.impact || "Not recorded"}\n\n${section("Suspected causes", record.suspectedCauses)}\n\n## Confirmed root cause\n\n${record.confirmedRootCause || "Not confirmed"}\n\n${section("Attempted fixes", record.attemptedFixes)}\n\n${section("Failed attempts", record.failedAttempts)}\n\n## Successful fix\n\n${record.successfulFix || "Not confirmed"}\n\n${section("Validation", record.validation)}\n\n${section("Regression prevention", record.prevention)}\n\n${section("Related files", record.relatedFiles)}\n\n## Related evidence\n\n- Execution run: ${record.relatedExecutionRun || "None"}\n- Trace: ${record.relatedTrace || "None"}\n- Agent: ${record.relatedAgent || "None"}\n- Executor/provider: ${record.relatedExecutor || "None"}\n\n${section("Open questions", record.openQuestions)}\n`;
}

function parseList(content: string, title: string): string[] {
  const body = content.match(new RegExp(`^## ${title}\\r?\\n\\r?\\n([\\s\\S]*?)(?=^## |\\s*$)`, "mi"))?.[1] ?? "";
  return body.split(/\r?\n/).map((line) => line.replace(/^-\s*/, "").trim()).filter((line) => line && line !== "None recorded");
}
function parseScalar(content: string, title: string): string { return sanitizeProblemText(content.match(new RegExp(`^## ${title}\\r?\\n\\r?\\n([^\\r\\n]+)`, "mi"))?.[1] ?? "", 3000); }
function parseMeta(content: string): Record<string, string> { const block = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""; return Object.fromEntries(block.split(/\r?\n/).map((line) => line.match(/^([\w_]+):\s*(.*)$/)).filter(Boolean).map((m) => [m![1], sanitizeProblemText(m![2], 500)])); }

export function parseTroubleshootingRecord(content: string, relativeNotePath: string): TroubleshootingRecord {
  const meta = parseMeta(content); const title = sanitizeProblemText(content.match(/^#\s+(.+)$/m)?.[1] ?? path.posix.basename(relativeNotePath, ".md"), 160);
  return sanitizeTroubleshootingRecord({
    title, affectedSystem: meta.affected_system || "Unknown", status: safeStatus(meta.status), firstSeen: meta.created, lastSeen: meta.last_seen,
    frequency: Number(meta.frequency) || 1, symptoms: parseList(content, "Symptoms"), errorSignature: parseScalar(content, "Sanitized error signature"),
    reproductionConditions: parseList(content, "Reproduction conditions"), impact: parseScalar(content, "Impact"), suspectedCauses: parseList(content, "Suspected causes"),
    confirmedRootCause: parseScalar(content, "Confirmed root cause"), attemptedFixes: parseList(content, "Attempted fixes"), failedAttempts: parseList(content, "Failed attempts"),
    successfulFix: parseScalar(content, "Successful fix"), validation: parseList(content, "Validation"), prevention: parseList(content, "Regression prevention"), relatedFiles: parseList(content, "Related files"),
    relatedProject: meta.related_project, relatedBranch: meta.related_branch, relatedCommit: meta.related_commit, confidence: meta.confidence, slug: path.posix.basename(relativeNotePath, ".md"),
  });
}

export async function listTroubleshootingRecords(options: { root?: string } = {}): Promise<TroubleshootingRecord[]> {
  const root = await resolveObsidianVaultRoot(options.root); const directory = path.join(/* turbopackIgnore: true */ root, ...RECORD_ROOT.split("/"));
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const records: TroubleshootingRecord[] = [];
  for (const entry of entries.slice(0, 200)) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".md")) continue;
    const relative = `${RECORD_ROOT}/${entry.name}`; if (!isPermittedVaultPath(relative)) continue;
    records.push(parseTroubleshootingRecord(await fs.readFile(path.join(/* turbopackIgnore: true */ directory, entry.name), "utf8"), relative));
  }
  return records.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

export async function upsertTroubleshootingRecord(input: Partial<TroubleshootingRecord> & { title: string; affectedSystem: string }, options: { root?: string } = {}): Promise<TroubleshootingRecord> {
  const root = await resolveObsidianVaultRoot(options.root); const incoming = sanitizeTroubleshootingRecord(input);
  const records = await listTroubleshootingRecords({ root }); const existing = records.find((record) => record.id === incoming.id || record.slug === incoming.slug);
  const merged = sanitizeTroubleshootingRecord({ ...existing, ...incoming, slug: existing?.slug ?? incoming.slug, firstSeen: existing?.firstSeen ?? incoming.firstSeen, frequency: existing ? existing.frequency + 1 : incoming.frequency, attemptedFixes: [...new Set([...(existing?.attemptedFixes ?? []), ...incoming.attemptedFixes])], failedAttempts: [...new Set([...(existing?.failedAttempts ?? []), ...incoming.failedAttempts])], validation: [...new Set([...(existing?.validation ?? []), ...incoming.validation])], prevention: [...new Set([...(existing?.prevention ?? []), ...incoming.prevention])] });
  const relative = `${RECORD_ROOT}/${merged.slug}.md`; if (!isPermittedVaultPath(relative)) throw new Error("Troubleshooting path rejected.");
  const directory = path.join(/* turbopackIgnore: true */ root, ...RECORD_ROOT.split("/")); await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(/* turbopackIgnore: true */ directory, `${merged.slug}.md`), recordMarkdown({ ...merged, relativeNotePath: relative }), { encoding: "utf8", flag: "w" });
  return { ...merged, relativeNotePath: relative };
}

function tokens(value: string): Set<string> { return new Set(sanitizeProblemText(value, 3000).toLowerCase().split(/[^a-z0-9]+/).filter((item) => item.length > 2)); }
export function rankProblemMatches(query: { affectedSystem: string; symptoms?: string[]; errorSignature?: string }, records: TroubleshootingRecord[]): TroubleshootingRecord[] {
  const queryTokens = tokens([query.affectedSystem, query.errorSignature, ...(query.symptoms ?? [])].join(" "));
  return records.map((record) => { const candidate = tokens([record.affectedSystem, record.errorSignature, ...record.symptoms, record.confirmedRootCause].join(" ")); const overlap = [...queryTokens].filter((token) => candidate.has(token)).length; return { record, overlap }; }).filter((item) => item.overlap > 0).sort((a, b) => b.overlap - a.overlap || b.record.lastSeen.localeCompare(a.record.lastSeen)).map((item) => item.record).slice(0, 5);
}

export async function findKnownProblems(query: { affectedSystem: string; symptoms?: string[]; errorSignature?: string }, options: { root?: string } = {}) { return rankProblemMatches(query, await listTroubleshootingRecords(options)); }

export const __testOnly = { recordMarkdown, parseMeta, parseList, parseScalar };
