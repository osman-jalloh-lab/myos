import { createClient } from "@libsql/client";
import { NextResponse } from "next/server";
import { handleBuildIntake, type BuildIntakeOption } from "@/lib/build-intake";

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const url = new URL(req.url);
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  return bearer === secret || url.searchParams.get("token") === secret;
}

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

async function defaultUserId(): Promise<string> {
  const db = getDb();
  const result = await db.execute("SELECT id FROM User ORDER BY createdAt ASC LIMIT 1");
  const id = result.rows[0]?.id;
  if (typeof id !== "string") throw new Error("No user available for build-intake verification.");
  return id;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buttonHtml(option: BuildIntakeOption): string {
  return `
    <button type="button" data-build-intake-option="${escapeHtml(option.id)}" data-value="${escapeHtml(option.value)}">
      <strong>${escapeHtml(option.label)}</strong>
      <span>${escapeHtml(option.description)}</span>
    </button>
  `;
}

function verificationHtml(params: {
  chatId: string;
  token: string;
  question: string;
  options: BuildIntakeOption[];
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Build Intake Verification</title>
  <style>
    body { margin: 0; background: #0e1424; color: #f1f4fb; font-family: system-ui, sans-serif; padding: 32px; }
    main { max-width: 760px; margin: 0 auto; }
    .bubble { border: 1px solid #28324a; background: rgba(40,50,74,.5); border-radius: 12px; padding: 14px 16px; line-height: 1.5; }
    .actions { display: grid; gap: 10px; margin-top: 12px; }
    button { text-align: left; border-radius: 8px; border: 1px solid rgba(52,211,153,.36); background: rgba(52,211,153,.12); color: #34d399; padding: 10px 12px; cursor: pointer; }
    button strong { display: block; font-size: 13px; }
    button span { display: block; margin-top: 3px; color: #94a3b8; font-size: 12px; line-height: 1.35; }
    pre { margin-top: 16px; white-space: pre-wrap; border: 1px solid #28324a; border-radius: 10px; padding: 12px; background: rgba(8,13,24,.55); }
  </style>
</head>
<body>
  <main>
    <div class="bubble" data-build-intake-question>${escapeHtml(params.question)}</div>
    <div class="actions" data-build-intake-options>
      ${params.options.map(buttonHtml).join("")}
    </div>
    <pre data-build-intake-result>Waiting for option click.</pre>
  </main>
  <script>
    const token = ${JSON.stringify(params.token)};
    const chatId = ${JSON.stringify(params.chatId)};
    document.querySelectorAll("[data-build-intake-option]").forEach((button) => {
      button.addEventListener("click", async () => {
        const result = document.querySelector("[data-build-intake-result]");
        result.textContent = "Sending selected option back into build intake...";
        const response = await fetch(
          "/api/cron/build-intake-verify?token=" + encodeURIComponent(token)
          + "&chatId=" + encodeURIComponent(chatId)
          + "&choice=" + encodeURIComponent(button.dataset.buildIntakeOption || "")
          + "&value=" + encodeURIComponent(button.dataset.value || "")
        );
        const data = await response.json();
        result.textContent = JSON.stringify(data, null, 2);
      });
    });
  </script>
</body>
</html>`;
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const userId = await defaultUserId();
  const chatId = url.searchParams.get("chatId") || `build-intake-live-verify:${crypto.randomUUID()}`;
  const initialMessage = "Build me a website";

  const choiceId = url.searchParams.get("choice");
  if (choiceId) {
    const selectedValue = url.searchParams.get("value")?.trim();
    if (!selectedValue) return NextResponse.json({ ok: false, error: "Missing selected option value." }, { status: 400 });
    const followUp = await handleBuildIntake(chatId, userId, selectedValue);
    return NextResponse.json({
      ok: followUp.action === "ask" || followUp.action === "ready",
      ambiguousRequest: initialMessage,
      clickedOption: { id: choiceId, value: selectedValue },
      followUp,
      fedBackIntoPipeline: followUp.action !== "none",
    });
  }

  const initial = await handleBuildIntake(chatId, userId, initialMessage);
  if (initial.action !== "ask") {
    return NextResponse.json({ ok: false, error: "Initial ambiguous build request did not request clarification.", initial }, { status: 500 });
  }

  const wantsHtml = req.headers.get("accept")?.includes("text/html") || url.searchParams.get("format") === "html";
  if (wantsHtml) {
    return new NextResponse(verificationHtml({
      chatId,
      token: url.searchParams.get("token") ?? "",
      question: initial.answer,
      options: initial.options,
    }), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  return NextResponse.json({
    ok: true,
    ambiguousRequest: initialMessage,
    question: initial.answer,
    quickActions: initial.options,
    chatId,
  }, { headers: { "cache-control": "no-store" } });
}
