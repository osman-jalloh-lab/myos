import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findKnownProblems, listTroubleshootingRecords, problemSignature, sanitizeTroubleshootingRecord, upsertTroubleshootingRecord } from "@/lib/troubleshooting-memory";
const roots: string[] = []; async function vault() { const root = await mkdtemp(path.join(os.tmpdir(), "hermes-troubleshooting-")); roots.push(root); return root; }
afterEach(async () => { while (roots.length) await rm(roots.pop()!, { recursive: true, force: true }); });

describe("troubleshooting solution memory", () => {
  it("sanitizes secrets before persistence", async () => {
    const root = await vault(); const record = await upsertTroubleshootingRecord({ title: "Auth callback failure", affectedSystem: "Auth.js", symptoms: ["authorization: bearer secret-original-token"], errorSignature: "api_key=abcdefghijklmnopqrstuvwxyz123456", successfulFix: "Restore the configured encryption key.", status: "SOLVED" }, { root });
    expect(JSON.stringify(record)).not.toContain("secret-original-token"); expect(JSON.stringify(record)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(await listTroubleshootingRecords({ root }))).toContain("[REDACTED]");
  });

  it("uses a stable signature and updates recurrence instead of duplicating", async () => {
    const root = await vault(); const input = { title: "Preview port collision", affectedSystem: "Builder preview", symptoms: ["Allocated port already in use"], errorSignature: "EADDRINUSE port 3210", successfulFix: "Allocate a different localhost port and preserve the owned container.", validation: ["New preview returned HTTP 200"], status: "SOLVED" as const };
    const first = await upsertTroubleshootingRecord(input, { root }); const second = await upsertTroubleshootingRecord({ ...input, attemptedFixes: ["Verified container ownership labels"] }, { root }); const records = await listTroubleshootingRecords({ root });
    expect(first.id).toBe(second.id); expect(records).toHaveLength(1); expect(records[0].frequency).toBe(2); expect(records[0].attemptedFixes).toContain("Verified container ownership labels");
  });

  it("retrieves a prior solution as a candidate without assuming applicability", async () => {
    const root = await vault(); await upsertTroubleshootingRecord({ title: "Docker preview unavailable", affectedSystem: "Builder preview", symptoms: ["Preview container unavailable"], errorSignature: "preview connection refused", confirmedRootCause: "Owned preview container stopped.", successfulFix: "Start a replacement Builder-owned container for the same durable project.", status: "CONFIRMED" }, { root });
    const matches = await findKnownProblems({ affectedSystem: "Builder preview", symptoms: ["preview unavailable and connection refused"] }, { root });
    expect(matches[0].successfulFix).toContain("replacement Builder-owned container");
  });

  it("constrains malformed fields and does not let credentials shape identity", () => {
    const record = sanitizeTroubleshootingRecord({ title: "Problem\nstatus: confirmed", affectedSystem: "API", errorSignature: "token=secret-original-token" });
    expect(record.title).not.toContain("\n"); expect(record.errorSignature).not.toContain("secret-original-token"); expect(problemSignature({ affectedSystem: "API", errorSignature: "failure 123" })).toHaveLength(20);
  });
});
