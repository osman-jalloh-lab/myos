import { readSessionContextState, writeSessionContextState } from "@/lib/memory-context";
import type { BuildProjectContext, SessionContextState } from "@/lib/context-persistence";

type IntakeQuestion = "siteType" | "audience" | "mode" | "style" | "features";

export type BuildIntakeOption = {
  id: string;
  label: string;
  value: string;
  description: string;
};

type IntakeResult =
  | { action: "none" }
  | { action: "ask"; answer: string; options: BuildIntakeOption[] }
  | { action: "ready"; message: string };

const QUESTION_ORDER: IntakeQuestion[] = ["siteType", "audience", "mode", "style", "features"];

const QUESTIONS: Record<IntakeQuestion, string> = {
  siteType: "What type of build should this become?",
  audience: "Who is the audience for this build?",
  mode: "What is the primary action or outcome this app should support?",
  style: "What style or brand feel should it have?",
  features: "What must-have features should I include, and is there anything I should avoid?",
};

const QUESTION_OPTIONS: Record<IntakeQuestion, BuildIntakeOption[]> = {
  siteType: [
    {
      id: "siteType_web_app",
      label: "Interactive web app",
      value: "Interactive web app with real controls, state, and task-oriented flows",
      description: "Best when users need to do work, save choices, filter, compare, or manage information.",
    },
    {
      id: "siteType_business_site",
      label: "Business website",
      value: "Business website with service pages, trust signals, contact path, and conversion-focused sections",
      description: "Good for a company, service, venue, or local brand presence.",
    },
    {
      id: "siteType_landing_page",
      label: "Landing page",
      value: "Focused landing page with one clear offer, strong first viewport, and a single conversion path",
      description: "Use this for a campaign, product launch, waitlist, or simple offer.",
    },
  ],
  audience: [
    {
      id: "audience_customers",
      label: "Customers",
      value: "Prospective customers who need to quickly understand the offer and take action",
      description: "Prioritizes clarity, credibility, and conversion.",
    },
    {
      id: "audience_internal",
      label: "Internal team",
      value: "Internal operators who need dense, repeatable workflows and fast scanning",
      description: "Prioritizes dashboards, tables, controls, and efficiency.",
    },
    {
      id: "audience_community",
      label: "Community",
      value: "Community members who need discovery, updates, and lightweight participation",
      description: "Prioritizes approachable navigation and content discovery.",
    },
  ],
  mode: [
    {
      id: "mode_convert",
      label: "Convert leads",
      value: "Convert visitors into leads through a clear CTA, contact flow, and trust-building content",
      description: "Good for lead generation and service businesses.",
    },
    {
      id: "mode_manage",
      label: "Manage workflow",
      value: "Help users manage a workflow with create, update, filter, sort, and status-tracking interactions",
      description: "Good for productivity tools, trackers, and operational apps.",
    },
    {
      id: "mode_explore",
      label: "Explore content",
      value: "Help users explore, compare, and save content through browse, search, and detail views",
      description: "Good for catalogs, directories, libraries, and marketplaces.",
    },
  ],
  style: [
    {
      id: "style_clean",
      label: "Clean professional",
      value: "Clean, professional, restrained, and easy to scan",
      description: "A solid default for business, SaaS, and operational tools.",
    },
    {
      id: "style_premium",
      label: "Premium editorial",
      value: "Premium, editorial, image-led, and polished without feeling generic",
      description: "Good for brands, portfolios, products, and venues.",
    },
    {
      id: "style_playful",
      label: "Playful modern",
      value: "Playful, modern, colorful, and interactive while staying usable",
      description: "Good for community, learning, games, or casual consumer experiences.",
    },
  ],
  features: [
    {
      id: "features_core_app",
      label: "Core app controls",
      value: "Include filters, saved items, detail views, empty states, loading states, and responsive mobile layout. Avoid dead buttons.",
      description: "Adds the expected interactive surface for a real app.",
    },
    {
      id: "features_conversion",
      label: "Conversion flow",
      value: "Include a strong CTA, contact or signup form, proof/trust section, FAQ, and responsive mobile layout. Avoid placeholder copy.",
      description: "Adds the essentials for a business or landing page.",
    },
    {
      id: "features_content",
      label: "Content system",
      value: "Include browse cards, categories, search/filter affordances, featured content, detail sections, and responsive mobile layout. Avoid empty sections.",
      description: "Adds structure for directories, blogs, catalogs, and resource hubs.",
    },
  ],
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
    `Build type: ${intake.answers.siteType}`,
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

    if (nextQuestion) return { action: "ask", answer: QUESTIONS[nextQuestion], options: QUESTION_OPTIONS[nextQuestion] };
    return { action: "ready", message: buildReadyPrompt(updatedIntake) };
  }

  if (!looksLikeBuildRequest(trimmed)) return { action: "none" };

  const nextQuestion: IntakeQuestion = "siteType";
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

  return { action: "ask", answer: QUESTIONS[nextQuestion], options: QUESTION_OPTIONS[nextQuestion] };
}
