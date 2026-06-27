import { readSessionContextState, writeSessionContextState } from "@/lib/memory-context";
import type { BuildProjectContext, SessionContextState } from "@/lib/context-persistence";

type IntakeQuestion = "audience" | "mode" | "style" | "features";

type IntakeResult =
  | { action: "none" }
  | { action: "ask"; answer: string }
  | { action: "ready"; message: string };

const QUESTION_ORDER: IntakeQuestion[] = ["audience", "mode", "style", "features"];

const QUESTIONS: Record<IntakeQuestion, string> = {
  audience: "Who is the audience for this build?",
  mode: "What is the primary action or outcome this app should support?",
  style: "What style or brand feel should it have?",
  features: "What must-have features should I include, and is there anything I should avoid?",
};

function looksLikeBuildRequest(message: string): boolean {
  return /\b(build|create|make|design|develop)\b/i.test(message)
    && /\b(app|site|website|marketplace|store|shop|dashboard|tool|portal|page|product)\b/i.test(message);
}

function cleanAnswer(message: string): string {
  return message.replace(/\s+/g, " ").trim().slice(0, 400);
}

function firstMissingQuestion(intake: NonNullable<BuildProjectContext["intake"]>): IntakeQuestion | null {
  return QUESTION_ORDER.find((question) => !intake.answers[question]) ?? null;
}

function projectLabel(message: string): string {
  const match = message.match(/\b(?:build|create|make|design|develop)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(.{3,80}?)(?:[.!?]|$)/i);
  return cleanAnswer(match?.[1] ?? "New build");
}

function nextStateWithBuild(state: SessionContextState, buildProject: BuildProjectContext): SessionContextState {
  return {
    ...state,
    activeIntent: "active_build_project",
    rememberedEntities: {
      ...state.rememberedEntities,
      buildProject,
    },
  };
}

function buildReadyPrompt(intake: NonNullable<BuildProjectContext["intake"]>): string {
  return [
    intake.originalRequest,
    "",
    "Builder intake answers:",
    `Audience: ${intake.answers.audience}`,
    `Primary outcome: ${intake.answers.mode}`,
    `Style: ${intake.answers.style}`,
    `Must-have features and avoidances: ${intake.answers.features}`,
    "",
    "Use these answers as requirements. Do not guess or replace them with generic assumptions.",
  ].join("\n");
}

export async function handleBuildIntake(chatId: string, userId: string, message: string): Promise<IntakeResult> {
  const trimmed = message.trim();
  if (!trimmed) return { action: "none" };

  const state = await readSessionContextState(chatId, userId);
  const existing = state.rememberedEntities.buildProject;
  const intake = existing?.intake;

  if (state.activeIntent === "active_build_project" && intake?.status === "collecting" && intake.pendingQuestion) {
    const updatedIntake = {
      ...intake,
      answers: {
        ...intake.answers,
        [intake.pendingQuestion]: cleanAnswer(trimmed),
      },
      pendingQuestion: null as IntakeQuestion | null,
    };
    const nextQuestion = firstMissingQuestion(updatedIntake);
    updatedIntake.pendingQuestion = nextQuestion;
    updatedIntake.status = nextQuestion ? "collecting" : "ready";

    const buildProject: BuildProjectContext = {
      ...existing,
      rawRequest: intake.originalRequest,
      intake: updatedIntake,
    };
    await writeSessionContextState(chatId, userId, nextStateWithBuild(state, buildProject));

    if (nextQuestion) return { action: "ask", answer: QUESTIONS[nextQuestion] };
    return { action: "ready", message: buildReadyPrompt(updatedIntake) };
  }

  if (!looksLikeBuildRequest(trimmed)) return { action: "none" };

  const nextQuestion: IntakeQuestion = "audience";
  const buildProject: BuildProjectContext = {
    projectName: projectLabel(trimmed),
    rawRequest: trimmed,
    intake: {
      status: "collecting",
      originalRequest: trimmed,
      pendingQuestion: nextQuestion,
      answers: {},
    },
  };
  await writeSessionContextState(chatId, userId, nextStateWithBuild(state, buildProject));

  return { action: "ask", answer: QUESTIONS[nextQuestion] };
}
