/**
 * Queries Vercel for the current state of a specific deployment and updates
 * the corresponding EngineeringTask row to reflect the accurate terminal state.
 *
 * Usage: npx tsx scripts/backfill-phase3-task.ts
 */
import { createClient } from "@libsql/client";

const TASK_ID = "cmqn4uaa2000054tqwsw8f9ai";
const VERCEL_DEPLOYMENT_ID = "dpl_B4CJaGCfJNZWk7jpatkrJCgkyNNT";
const PREVIEW_URL = "https://myos-k1p13pyuu-osman-jalloh-labs-projects.vercel.app";

const db = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  const rawToken = process.env.VERCEL_TOKEN ?? "";
  const vercelToken = rawToken.replace(/^﻿/, "").trim();
  if (!vercelToken) throw new Error("VERCEL_TOKEN is required");

  // Poll Vercel for current state
  const url = `https://api.vercel.com/v13/deployments/${VERCEL_DEPLOYMENT_ID}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${vercelToken}`, "Content-Type": "application/json" },
  });

  if (!res.ok) throw new Error(`Vercel API returned ${res.status}: ${await res.text()}`);

  const json = (await res.json()) as {
    readyState?: string;
    state?: string;
    errorCode?: string;
    url?: string;
    alias?: string[];
  };

  const readyState = json.readyState ?? json.state ?? "UNKNOWN";
  const errorCode = json.errorCode;

  console.log(JSON.stringify({ vercelDeploymentId: VERCEL_DEPLOYMENT_ID, readyState, errorCode }, null, 2));

  // Map Vercel state to task status
  let newStatus: string;
  let deployCompletedAt: string | null = null;
  let errorReference: string | null = null;
  let resultSummary: string;

  if (readyState === "READY") {
    newStatus = "deployed";
    deployCompletedAt = new Date().toISOString();
    resultSummary = [
      "Preview deployment ready (backfilled)",
      `Vercel deployment ID: ${VERCEL_DEPLOYMENT_ID}`,
      `Preview URL: ${PREVIEW_URL}`,
      "State: READY",
    ].join("\n");
  } else if (["ERROR", "CANCELED"].includes(readyState)) {
    newStatus = "deployment_failed";
    errorReference = `Vercel deployment ${VERCEL_DEPLOYMENT_ID} reached state ${readyState}${errorCode ? ` (${errorCode})` : ""}`;
    resultSummary = [
      "Preview deployment failed (backfilled)",
      `Vercel deployment ID: ${VERCEL_DEPLOYMENT_ID}`,
      `Terminal state: ${readyState}`,
      errorCode ? `Error code: ${errorCode}` : "",
    ].filter(Boolean).join("\n");
  } else {
    // Still in progress (INITIALIZING, BUILDING, QUEUED)
    newStatus = "deployment_in_progress";
    resultSummary = [
      "Preview deployment in progress (backfilled)",
      `Vercel deployment ID: ${VERCEL_DEPLOYMENT_ID}`,
      `Preview URL: ${PREVIEW_URL}`,
      `Last known state: ${readyState}`,
    ].join("\n");
  }

  await db.execute({
    sql: `UPDATE EngineeringTask
          SET status = ?, deployStatus = ?, deployCompletedAt = ?,
              errorReference = ?, resultSummary = ?, updatedAt = ?
          WHERE id = ?`,
    args: [
      newStatus,
      readyState,
      deployCompletedAt,
      errorReference,
      resultSummary,
      new Date().toISOString(),
      TASK_ID,
    ],
  });

  console.log(JSON.stringify({
    taskId: TASK_ID,
    newStatus,
    deployStatus: readyState,
    deployCompletedAt,
    previewUrl: PREVIEW_URL,
  }, null, 2));
}

main().catch((err) => { console.error(err); process.exit(1); });
