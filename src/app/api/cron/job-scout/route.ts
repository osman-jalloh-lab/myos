// Vercel Cron: job-scout. Schedule defined in vercel.json (UTC).
// TODO: implement per spec. Guard with CRON_SECRET. Nothing writes without approval.
export async function GET(req: Request) {
  if (req.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return new Response("Unauthorized", { status: 401 });
  }
  return Response.json({ ok: true, job: "job-scout", todo: "implement per spec" });
}
