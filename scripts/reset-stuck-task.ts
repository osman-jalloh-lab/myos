import { createClient } from "@libsql/client";

const c = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function main() {
  // Reset the most recent stuck task back to queued so the executor can claim it
  const taskId = "cmqn2f9ki0000lgtqybs5az9l";
  await c.execute({
    sql: `UPDATE EngineeringTask SET status = 'queued', executorName = NULL, executorJobId = NULL, startedAt = NULL WHERE id = ?`,
    args: [taskId],
  });
  console.log(`Reset task ${taskId} back to queued`);

  const r = await c.execute({
    sql: `SELECT id, status, approvalStatus, operationType FROM EngineeringTask WHERE id = ?`,
    args: [taskId],
  });
  console.log(JSON.stringify(r.rows[0]));
}

main().catch(console.error);
