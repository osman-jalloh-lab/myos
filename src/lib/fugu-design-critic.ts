export const FUGU_NOT_CONNECTED_MESSAGE = "Fugu not connected — add SAKANA_API_KEY to environment.";

export type FuguDesignCritiqueInput = {
  projectInfo: string;
  pageSummary: string;
  buildNotes: string;
};

export type FuguDesignCritiqueResult = {
  connected: boolean;
  score: number | null;
  review: string;
};

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;

  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function boundedScore(value: unknown): number | null {
  const score = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(score)) return null;
  return Math.max(1, Math.min(10, Math.round(score)));
}

function formatCritique(payload: unknown, fallback: string): { review: string; score: number | null } {
  if (!payload || typeof payload !== "object") {
    return { review: fallback.trim(), score: null };
  }

  const data = payload as Record<string, unknown>;
  const score = boundedScore(data.score);
  const list = (value: unknown) => Array.isArray(value) ? value.map((item) => `- ${String(item)}`).join("\n") : String(value ?? "").trim();
  const review = [
    `Score: ${score ?? "unscored"}/10`,
    "",
    "What feels basic",
    list(data.whatFeelsBasic),
    "",
    "What needs to improve",
    list(data.whatNeedsToImprove),
    "",
    "Specific changes Builder should make",
    list(data.specificBuilderChanges),
  ].join("\n").trim();

  return { review, score };
}

export async function runFuguDesignCritique(input: FuguDesignCritiqueInput): Promise<FuguDesignCritiqueResult> {
  const apiKey = process.env.SAKANA_API_KEY?.trim();
  if (!apiKey) {
    return {
      connected: false,
      score: null,
      review: FUGU_NOT_CONNECTED_MESSAGE,
    };
  }

  const instructions = [
    "You are Sakana Fugu acting only as a UX/design critic for Hermes Builder.",
    "Do not generate code. Do not propose automatic edits. Return guidance Builder can use later.",
    "Review whether the app feels too basic and needs UX/design critique.",
    "Evaluate visual quality, realism, navigation, clickable interactions, missing pages, empty or dead buttons, mobile layout, and overall polish.",
    "Return strict JSON with keys: score, whatFeelsBasic, whatNeedsToImprove, specificBuilderChanges.",
    "score must be an integer from 1 to 10. The other keys must be arrays of concise strings.",
  ].join("\n");

  const userContent = [
    "Project info:",
    input.projectInfo,
    "",
    "Page summary:",
    input.pageSummary,
    "",
    "Build notes:",
    input.buildNotes,
  ].join("\n");

  const response = await fetch("https://api.sakana.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "fugu",
      messages: [
        { role: "system", content: instructions },
        { role: "user", content: userContent },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const safeDetail = detail ? ` (${response.status}: ${detail.slice(0, 500)})` : ` (${response.status})`;
    throw new Error(`Fugu design review failed${safeDetail}`);
  }

  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = data.choices?.[0]?.message?.content?.trim() ?? "";
  const formatted = formatCritique(extractJson(content), content);

  return {
    connected: true,
    score: formatted.score,
    review: formatted.review,
  };
}
