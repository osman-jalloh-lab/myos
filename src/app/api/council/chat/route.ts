import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { COUNCIL_TARGET, councilProviderTarget, listCouncilMessages, sendCouncilMessage } from "@/lib/model-council-chat";
import { rateLimit, rateLimitResponse } from "@/lib/rate-limit";
import type { ProviderFamily } from "@/lib/model-provider-registry";

const PROVIDER_FAMILIES = new Set<ProviderFamily>(["openai", "anthropic", "ollama"]);

function targetFromSearch(searchParams: URLSearchParams): string {
  const family = searchParams.get("provider") as ProviderFamily | null;
  if (family && PROVIDER_FAMILIES.has(family)) return councilProviderTarget(family);
  return COUNCIL_TARGET;
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const target = targetFromSearch(url.searchParams);
  const messages = await listCouncilMessages(session.user.id, target, 50);
  return NextResponse.json({ messages, target });
}

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const rl = rateLimit(`council-chat:${session.user.id}`, { limit: 10, windowMs: 60_000 });
  if (!rl.allowed) return rateLimitResponse(rl);

  const body = (await req.json().catch(() => null)) as { message?: string; mode?: string; providerFamily?: ProviderFamily } | null;
  const message = body?.message?.trim();
  if (!message) return NextResponse.json({ error: "message is required" }, { status: 400 });

  const mode = body?.mode === "provider" ? "provider" : "council";
  if (mode === "provider" && (!body?.providerFamily || !PROVIDER_FAMILIES.has(body.providerFamily))) {
    return NextResponse.json({ error: "valid providerFamily is required" }, { status: 400 });
  }

  const result = await sendCouncilMessage({
    userId: session.user.id,
    message,
    mode,
    providerFamily: body?.providerFamily,
  });
  return NextResponse.json({ ...result, status: "answered" });
}
