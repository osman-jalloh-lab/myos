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

export type FuguGateVerdict = "pass" | "revise" | "unavailable" | "error";
export type FuguGateMode = "off" | "recommended" | "required";

export type FuguDesignGate = {
  verdict: FuguGateVerdict;
  score: number | null;
  threshold: number;
  summary: string;
  strengths: string[];
  mustFixBeforeBuild: string[];
  recommendedChanges: string[];
  designSystem: {
    visualDirection: string;
    layoutStrategy: string;
    typographyGuidance: string;
    colorGuidance: string;
    interactionGuidance: string;
    componentGuidance: string[];
  };
  reviewedAt: string;
};

export type FuguDesignGateInput = {
  originalIdea: string;
  buildBrief: string;
  intendedUsers: string;
  firstReleaseGoal: string;
  featurePriorities: string;
  visualDirection: string;
  pagesAndComponents: string;
  athenaResearchBrief: string;
  existingProjectContext?: string;
  designReferenceNotes?: string;
};

const FUGU_TRANSIENT_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const FUGU_GATE_MAX_ATTEMPTS = 3;

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

function listOfStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 12);
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getFuguDesignPassScore(): number {
  const configured = Number(process.env.FUGU_DESIGN_PASS_SCORE ?? 7);
  if (!Number.isFinite(configured)) return 7;
  return Math.max(1, Math.min(10, Math.round(configured)));
}

export function getFuguDesignGateMode(): FuguGateMode {
  const value = process.env.FUGU_DESIGN_GATE_MODE?.trim().toLowerCase();
  return value === "off" || value === "recommended" || value === "required" ? value : "required";
}

export function validateFuguDesignGatePayload(payload: unknown, threshold = getFuguDesignPassScore()): FuguDesignGate {
  if (!payload || typeof payload !== "object") {
    throw new Error("Fugu returned malformed design-gate JSON.");
  }
  const data = payload as Record<string, unknown>;
  const score = boundedScore(data.score);
  if (score === null) throw new Error("Fugu design-gate JSON did not include a numeric score.");
  const designSystem = data.designSystem && typeof data.designSystem === "object"
    ? data.designSystem as Record<string, unknown>
    : {};
  const gate: FuguDesignGate = {
    verdict: score >= threshold ? "pass" : "revise",
    score,
    threshold,
    summary: str(data.summary) || (score >= threshold ? "Fugu approved the design direction." : "Fugu requested design revisions before build."),
    strengths: listOfStrings(data.strengths),
    mustFixBeforeBuild: listOfStrings(data.mustFixBeforeBuild),
    recommendedChanges: listOfStrings(data.recommendedChanges),
    designSystem: {
      visualDirection: str(designSystem.visualDirection),
      layoutStrategy: str(designSystem.layoutStrategy),
      typographyGuidance: str(designSystem.typographyGuidance),
      colorGuidance: str(designSystem.colorGuidance),
      interactionGuidance: str(designSystem.interactionGuidance),
      componentGuidance: listOfStrings(designSystem.componentGuidance),
    },
    reviewedAt: new Date().toISOString(),
  };
  if (!gate.mustFixBeforeBuild.length && gate.verdict === "revise") {
    gate.mustFixBeforeBuild = ["Raise the design direction to the pass threshold before starting a normal build."];
  }
  return gate;
}

export function unavailableFuguDesignGate(threshold = getFuguDesignPassScore()): FuguDesignGate {
  return {
    verdict: "unavailable",
    score: null,
    threshold,
    summary: FUGU_NOT_CONNECTED_MESSAGE,
    strengths: [],
    mustFixBeforeBuild: ["Connect SAKANA_API_KEY or use an explicit Fugu override before building in required mode."],
    recommendedChanges: ["Add SAKANA_API_KEY to the server environment and retry the Fugu design gate."],
    designSystem: {
      visualDirection: "",
      layoutStrategy: "",
      typographyGuidance: "",
      colorGuidance: "",
      interactionGuidance: "",
      componentGuidance: [],
    },
    reviewedAt: new Date().toISOString(),
  };
}

export function errorFuguDesignGate(summary: string, threshold = getFuguDesignPassScore()): FuguDesignGate {
  return {
    ...unavailableFuguDesignGate(threshold),
    verdict: "error",
    summary,
    mustFixBeforeBuild: ["Retry Fugu or record an explicit override reason before building in required mode."],
    recommendedChanges: ["Check Fugu connectivity and response format, then run the design gate again."],
  };
}

export function transientUnavailableFuguDesignGate(summary: string, threshold = getFuguDesignPassScore()): FuguDesignGate {
  return {
    ...unavailableFuguDesignGate(threshold),
    summary,
    mustFixBeforeBuild: ["Fugu is temporarily unavailable; retry later or record an explicit override reason before building in required mode."],
    recommendedChanges: ["Retry the Fugu design gate after the provider recovers or rate limits reset."],
  };
}

function fuguRetryDelayMs(attempt: number): number {
  const configured = Number(process.env.FUGU_RETRY_BASE_MS ?? 750);
  const base = Number.isFinite(configured) ? Math.max(0, configured) : 750;
  return base * (2 ** attempt);
}

async function waitForFuguRetry(attempt: number): Promise<void> {
  const delay = fuguRetryDelayMs(attempt);
  if (delay <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
}

function transientFetchError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return error.name === "AbortError" || error instanceof TypeError;
}

export function formatFuguDesignGate(gate: FuguDesignGate): string {
  return [
    `Fugu Design Gate: ${gate.verdict === "pass" ? "Passed" : gate.verdict === "revise" ? "Needs Revision" : gate.verdict === "unavailable" ? "Unavailable" : "Error"}`,
    `Score: ${gate.score ?? "unscored"}/10`,
    `Threshold: ${gate.threshold}/10`,
    "",
    gate.summary,
    "",
    "Strengths:",
    gate.strengths.length ? gate.strengths.map((item) => `- ${item}`).join("\n") : "- None recorded.",
    "",
    "Must fix before build:",
    gate.mustFixBeforeBuild.length ? gate.mustFixBeforeBuild.map((item) => `- ${item}`).join("\n") : "- None.",
    "",
    "Recommended changes:",
    gate.recommendedChanges.length ? gate.recommendedChanges.map((item) => `- ${item}`).join("\n") : "- None.",
    "",
    "Design system constraints:",
    `- Visual direction: ${gate.designSystem.visualDirection || "Not specified."}`,
    `- Layout strategy: ${gate.designSystem.layoutStrategy || "Not specified."}`,
    `- Typography: ${gate.designSystem.typographyGuidance || "Not specified."}`,
    `- Color: ${gate.designSystem.colorGuidance || "Not specified."}`,
    `- Interaction: ${gate.designSystem.interactionGuidance || "Not specified."}`,
    ...(gate.designSystem.componentGuidance.length ? gate.designSystem.componentGuidance.map((item) => `- Component: ${item}`) : ["- Component: Not specified."]),
  ].join("\n");
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

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  const response = await fetch("https://api.sakana.ai/v1/chat/completions", {
    method: "POST",
    signal: controller.signal,
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
  }).finally(() => clearTimeout(timeout));

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

export async function runFuguDesignGate(input: FuguDesignGateInput): Promise<FuguDesignGate> {
  const threshold = getFuguDesignPassScore();
  const apiKey = process.env.SAKANA_API_KEY?.trim();
  if (!apiKey) return unavailableFuguDesignGate(threshold);

  const instructions = [
    "You are Sakana Fugu acting only as a read-only UX/design gate for Hermes Builder.",
    "Do not generate code. Do not suggest tool execution. Do not approve deployment.",
    "You are reviewing the design system and product plan before code generation, not a rendered screenshot.",
    "Return strict JSON only with keys: score, summary, strengths, mustFixBeforeBuild, recommendedChanges, designSystem.",
    "designSystem must include: visualDirection, layoutStrategy, typographyGuidance, colorGuidance, interactionGuidance, componentGuidance.",
    "score must be an integer from 1 to 10. Arrays must contain concise strings.",
  ].join("\n");
  const userContent = [
    "Original user idea:",
    input.originalIdea,
    "",
    "Prometheus build brief answers:",
    input.buildBrief,
    "",
    "Intended users:",
    input.intendedUsers,
    "",
    "First-release goal:",
    input.firstReleaseGoal,
    "",
    "Feature priorities:",
    input.featurePriorities,
    "",
    "Visual direction:",
    input.visualDirection,
    "",
    "Pages and components planned:",
    input.pagesAndComponents,
    "",
    "Athena research brief:",
    input.athenaResearchBrief,
    "",
    "Existing project context:",
    input.existingProjectContext || "No rebuild context supplied.",
    "",
    "User-provided design reference notes:",
    input.designReferenceNotes || "No design reference notes supplied.",
  ].join("\n");

  let transientSummary: string | null = null;
  for (let attempt = 0; attempt < FUGU_GATE_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    let response: Response;
    try {
      response = await fetch("https://api.sakana.ai/v1/chat/completions", {
        method: "POST",
        signal: controller.signal,
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
          temperature: 0.1,
        }),
      });
    } catch (error) {
      if (!transientFetchError(error)) {
        return errorFuguDesignGate("Fugu design gate returned an unsafe or unavailable response.", threshold);
      }
      transientSummary = error instanceof Error && error.name === "AbortError"
        ? "Fugu design gate timed out after retries."
        : "Fugu design gate provider connection failed after retries.";
      if (attempt < FUGU_GATE_MAX_ATTEMPTS - 1) {
        await waitForFuguRetry(attempt);
        continue;
      }
      return transientUnavailableFuguDesignGate(transientSummary, threshold);
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      if (FUGU_TRANSIENT_STATUSES.has(response.status)) {
        transientSummary = `Fugu design gate temporarily unavailable (${response.status}) after retries.`;
        if (attempt < FUGU_GATE_MAX_ATTEMPTS - 1) {
          await waitForFuguRetry(attempt);
          continue;
        }
        return transientUnavailableFuguDesignGate(transientSummary, threshold);
      }
      return errorFuguDesignGate(`Fugu design gate failed safely (${response.status}).`, threshold);
    }

    try {
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content?.trim() ?? "";
      const payload = extractJson(content);
      return validateFuguDesignGatePayload(payload, threshold);
    } catch {
      return errorFuguDesignGate("Fugu design gate returned an unsafe or unavailable response.", threshold);
    }
  }

  return transientUnavailableFuguDesignGate(transientSummary ?? "Fugu design gate temporarily unavailable after retries.", threshold);
}
