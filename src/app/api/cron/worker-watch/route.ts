// Vercel Cron: worker-watch.
// Checks the local worker heartbeat and sends a Telegram alert when it goes
// offline ("local worker offline — nothing is building right now"), once per
// offline episode. See src/lib/worker-watch.ts.

import { checkLocalWorkerAndAlert } from "@/lib/worker-watch";

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET || req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const result = await checkLocalWorkerAndAlert();
  return Response.json({ ok: true, job: "worker-watch", ...result });
}
