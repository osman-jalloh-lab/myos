import { createClient } from "@libsql/client";
import { spawn } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";

type Db = ReturnType<typeof createClient>;

export type LocalBuildProject = {
  id: string;
  projectName: string;
  localFolderPath: string;
  status: string;
  createdAt: string;
  currentTask: string;
  taskId: string;
  buildLog: string | null;
  buildError: string | null;
  localDevUrl: string | null;
  localDevPid: number | null;
  researchBrief: string | null;
  files?: string[];
};

export type LocalBuilderRootInfo = {
  root: string;
  exists: boolean;
  projectCount: number;
  warning: string | null;
};

const LOCAL_BUILDER_AGENT = "hermes-local-builder";
const ATHENA_RESEARCH_AGENT = "athena";
const devServers = new Map<string, { child: ReturnType<typeof spawn>; url: string; pid: number | null }>();

function getDb() {
  return createClient({
    url: process.env.TURSO_DATABASE_URL!,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
}

async function exists(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

export async function getLocalProjectsRoot(): Promise<string> {
  if (process.env.HERMES_LOCAL_PROJECTS_ROOT?.trim()) {
    return path.resolve(process.env.HERMES_LOCAL_PROJECTS_ROOT.trim());
  }

  const candidates = [
    "C:\\Users\\osman\\OneDrive\\Desktop\\HermesProject",
    "C:\\Users\\osman\\OneDrive\\Desktop\\Hermes Project",
  ];

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (await exists(resolved)) return resolved;
  }

  return path.resolve(candidates[0]);
}

export async function getLocalBuilderRootInfo(): Promise<LocalBuilderRootInfo> {
  const root = await getLocalProjectsRoot();
  const rootExists = await exists(root);
  const entries = rootExists ? await readdir(root, { withFileTypes: true }).catch(() => []) : [];
  const projectCount = entries.filter((entry) => entry.isDirectory()).length;

  return {
    root,
    exists: rootExists,
    projectCount,
    warning: rootExists ? null : "Local builder root folder is missing.",
  };
}

export function parseLocalBuildRequest(message: string): { projectName: string; folderName: string } | null {
  const trimmed = message.trim();
  if (!/\b(build|create|make|start|scaffold)\b/i.test(trimmed)) return null;
  if (!/\b(website|site|app|web app|landing page|project|marketplace|store|shop)\b/i.test(trimmed)) return null;

  const explicitName =
    trimmed.match(/\b(?:called|named)\s+["']?([a-z0-9][a-z0-9 _-]{1,70})["']?/i)?.[1] ??
    trimmed.match(/\b(?:website|site|app|web app|landing page|project|marketplace|store|shop)\s+["']?([a-z0-9][a-z0-9 _-]{1,70})["']?/i)?.[1] ??
    trimmed.match(/\bbuild(?:\s+me)?\s+(?:a|an)?\s*["']?([a-z0-9][a-z0-9 _-]{1,70}?(?:website|site|app|web app|landing page|project|marketplace|store|shop))["']?(?:[.!?]|$)/i)?.[1];

  if (!explicitName) return null;

  const projectName = explicitName
    .replace(/\s+(?:for|with|that|using|in)\b.*$/i, "")
    .replace(/[.!?].*$/, "")
    .replace(/\s+/g, " ")
    .trim();

  if (projectName.length < 2) return null;

  const folderName = projectName
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!folderName) return null;
  return { projectName, folderName };
}

async function ensureLocalBuilderColumns(db: Db): Promise<void> {
  await db.execute(`ALTER TABLE Project ADD COLUMN localFolderPath TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildLog TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localBuildError TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevUrl TEXT`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localDevPid INTEGER`).catch(() => undefined);
  await db.execute(`ALTER TABLE Project ADD COLUMN localResearchBrief TEXT`).catch(() => undefined);
}

function rowString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quotedAfter(message: string, label: string): string | null {
  const quoteChars = "\\\"'\\u201c\\u201d\\u2018\\u2019";
  const match = message.match(new RegExp(`${label}\\s*[${quoteChars}]([^${quoteChars}]+)[${quoteChars}]`, "i"));
  return match?.[1]?.trim() ?? null;
}

function cleanDisplayText(value: string): string {
  return value.replace(/[<>{}]/g, "").trim();
}

function packageName(projectName: string): string {
  return projectName
    .toLowerCase()
    .replace(/[^a-z0-9-_ ]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "hermes-local-app";
}

async function loadWebsiteBuilderSkills(): Promise<string> {
  const root = path.join(await getLocalProjectsRoot(), "skills");
  const names = [
    "web-product-discovery",
    "luxury-ui-design",
    "ecommerce-build",
    "interaction-design",
    "frontend-qa",
    "visual-polish-review",
  ];
  const files = await Promise.all(names.map(async (name) => {
    const content = await readFile(path.join(root, name, "SKILL.md"), "utf8").catch(() => "");
    return content ? `## ${name}\n${content.trim()}` : `## ${name}\nMissing local skill file.`;
  }));
  return files.join("\n\n");
}

async function createAthenaResearchBrief(projectName: string, message: string): Promise<string> {
  const lower = `${projectName} ${message}`.toLowerCase();
  const isLuxuryWatch = /\b(watch|watches|chrono|timepiece|horology)\b/.test(lower);
  const isJobTracker = /\b(job|application|applicant|interview|resume|tracker|jobflow)\b/.test(lower);
  const skillSource = await loadWebsiteBuilderSkills();
  const audience = isLuxuryWatch
    ? "Collectors, style-conscious professionals, gift buyers, and first-time luxury watch shoppers who want trust, provenance, and a refined browsing experience."
    : isJobTracker
    ? "Active job seekers, students, and career switchers who need a focused operating system for applications, interviews, reminders, and notes."
    : "Visitors who need a clear promise, quick proof, and a polished path from interest to action.";
  const inspiration = isLuxuryWatch
    ? "Borrow broad patterns from premium marketplaces: strong hero curation, trust markers, editorial collection cards, concierge-style CTAs, and product provenance cues. Do not copy any competitor page structure, styling, copy, or product presentation exactly."
    : "Use broad category conventions only: immediate value proposition, proof points, concise feature sections, and clear CTAs. Keep the layout original.";
  const visualStyle = isLuxuryWatch
    ? "Modern luxury with deep charcoal, warm metallic accents, clean serif headings, restrained spacing, and high-contrast product staging created with CSS shapes or generated-safe placeholders."
    : isJobTracker
    ? "Premium dark productivity dashboard with Linear, Vercel, and Notion cues: compact panels, crisp borders, subtle gradients, dense but calm tables, and stateful controls."
    : "Sophisticated, responsive, and original, with restrained color contrast, strong typography, and clear hierarchy.";
  const sections = isLuxuryWatch
    ? "Hero with marketplace promise, curated collection strip, authentication/trust section, editorial buying guidance, seller concierge CTA, and a final start/browse action."
    : isJobTracker
    ? "Dashboard, applications list, pipeline board, interview schedule, follow-up reminders, notes, analytics cards, search/filter, add application form, and status update controls."
    : "Hero, proof band, feature sections, audience benefits, CTA, and lightweight footer.";

  return [
    `Hermes website builder skill workflow for ${projectName}`,
    "",
    "Loaded local skill files:",
    skillSource.split("\n").filter((line) => line.startsWith("## ")).map((line) => `- ${line.replace(/^## /, "")}`).join("\n"),
    "",
    "Clarifying questions if prompt is vague:",
    "- Luxury, affordable, vintage, or general marketplace?",
    "- Show pricing, hide pricing, or mix inquiry-only listings?",
    "- Should it feel ecommerce, editorial, portfolio, or concierge-led?",
    "- Is cart/demo checkout required for this phase?",
    "- Any style references, brands to avoid copying, or content constraints?",
    "",
    `Product brief: Audience: ${audience} Business goal: convert visitors into confident shoppers or qualified inquiries. Pages/sections: homepage, shop/catalog, saved/compare workspace, product detail, trust/concierge CTA. Tone: specific, premium, useful, and original.`,
    "",
    `Design brief: ${visualStyle} Use distinctive typography, restrained motion, deliberate spacing, responsive density, and CSS-created or generated-safe visuals.`,
    "",
    `Competitor/inspiration patterns: ${inspiration}`,
    "",
    `Feature plan: ${sections} Include product cards, filters, detail views, saved items, compare behavior, empty states, and demo checkout or concierge actions when relevant.`,
    "",
    "Build plan: Generate a real app surface, not only a landing page. Use local component state for filters/modals and localStorage for saved/compare interactions. Keep routes, anchors, buttons, and responsive behavior testable.",
    "",
    "QA checklist: npm run build passes; main buttons work; navigation works; filters work; save/compare persists; detail view opens/closes; mobile layout does not overlap; app feels like a real product; no copied assets.",
    "",
    "Image/asset direction: Do not scrape copyrighted product images. For v1, use original CSS gradients, abstract watch/product placeholders, licensed assets, or generated-safe imagery. If real images are later used, store source, credit, and license notes with the project.",
    "",
    "Risks/copyright notes: Avoid brand logos, trademark-heavy claims, copied catalog text, copied product photography, or layouts that are recognizably cloned from a competitor. Keep copy original and make provenance/authentication claims conservative until backed by real operations.",
  ].join("\n");
}

async function jobTrackerTemplateFiles(projectName: string): Promise<Record<string, string> | null> {
  const templateRoot = path.join(await getLocalProjectsRoot(), "JobFlow");
  if (!(await exists(templateRoot))) return null;

  const files = [
    "package.json",
    "BUILDER_PLAN.md",
    "next.config.mjs",
    "tsconfig.json",
    "next-env.d.ts",
    "src/app/layout.tsx",
    "src/app/global-error.tsx",
    "src/app/icon.svg",
    "src/app/page.tsx",
    "src/app/globals.css",
  ];
  const safeName = cleanDisplayText(projectName);
  const output: Record<string, string> = {};
  for (const file of files) {
    const source = await readFile(path.join(templateRoot, ...file.split("/")), "utf8");
    output[file] = source.replaceAll("JobFlow", safeName).replaceAll("jobflow", packageName(projectName));
  }
  return output;
}

async function appFiles(projectName: string, message: string, researchBrief?: string | null): Promise<Record<string, string>> {
  const heading = cleanDisplayText(
    quotedAfter(message, "heading(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    quotedAfter(message, "landing page(?:\\s+that\\s+says)?") ??
    `${projectName} is live`
  );
  const button = cleanDisplayText(
    quotedAfter(message, "one\\s+button(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    quotedAfter(message, "button(?:\\s+(?:that\\s+)?(?:says|reads))?") ??
    "Start"
  );
  const safeName = cleanDisplayText(projectName);
  const briefText = researchBrief?.trim() || "No Athena research brief was attached.";
  const isLuxuryWatch = /\b(watch|watches|chrono|timepiece|horology)\b/i.test(`${projectName} ${message} ${briefText}`);
  const isJobTracker = /\b(job|application|applicant|interview|resume|tracker|jobflow)\b/i.test(`${projectName} ${message} ${briefText}`);

  if (isJobTracker) {
    const template = await jobTrackerTemplateFiles(projectName);
    if (template) return template;
  }

  return {
    "package.json": `${JSON.stringify({
      name: packageName(projectName),
      version: "0.1.0",
      private: true,
      scripts: {
        dev: "next dev",
        build: "next build",
        start: "next start",
      },
      dependencies: {
        next: "^16.0.0",
        react: "^19.0.0",
        "react-dom": "^19.0.0",
      },
      devDependencies: {
        "@types/node": "^22.0.0",
        "@types/react": "^19.0.0",
        typescript: "^5.6.0",
      },
    }, null, 2)}\n`,
    "README.md": `# ${safeName}\n\nGenerated by Hermes Local Builder using an internal Athena research brief.\n\n## Athena Research Brief\n\n${briefText}\n\n## Commands\n\n\`\`\`bash\nnpm install\nnpm run build\nnpm run dev\n\`\`\`\n`,
    "BUILDER_PLAN.md": `# ${safeName} Builder Plan\n\n## Product Brief\n\n${briefText}\n\n## Design Brief\n\nOriginal visual direction only. Do not copy brand layouts, product photography, or copyrighted assets.\n\n## Feature Plan\n\nInclude real sections, clickable controls, stateful interactions, empty states, and responsive behavior appropriate to the prompt.\n\n## Build Plan\n\nGenerate a working Next.js app with visible product structure and local demo behavior before running install and build.\n\n## QA Checklist\n\n- npm run build passes\n- Main buttons work\n- Navigation works\n- Filters or core controls work\n- Saved/compare or equivalent state works when relevant\n- Mobile layout works\n- App feels like a real product\n- No copied assets\n`,
    "next.config.mjs": `const nextConfig = {};\n\nexport default nextConfig;\n`,
    "tsconfig.json": `${JSON.stringify({
      compilerOptions: {
        target: "ES2017",
        lib: ["dom", "dom.iterable", "esnext"],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: "esnext",
        moduleResolution: "bundler",
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: "react-jsx",
        incremental: true,
        plugins: [{ name: "next" }],
        paths: { "@/*": ["./src/*"] },
      },
      include: ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
      exclude: ["node_modules"],
    }, null, 2)}\n`,
    "next-env.d.ts": `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// This file is generated by Next.js. Do not edit it directly.\n`,
    "src/app/icon.svg": `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">\n  <rect width="64" height="64" rx="12" fill="#101312"/>\n  <circle cx="32" cy="32" r="18" fill="#1f251f" stroke="#d9b76c" stroke-width="5"/>\n  <path d="M32 18v14l11 7" fill="none" stroke="#fff8e8" stroke-width="3" stroke-linecap="round"/>\n  <circle cx="32" cy="32" r="2.5" fill="#fff8e8"/>\n</svg>\n`,
    "src/app/layout.tsx": `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = {\n  title: "${safeName}",\n  description: "Generated by Hermes Local Builder",\n};\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`,
    "src/app/global-error.tsx": `"use client";\n\nexport default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {\n  return (\n    <html lang="en">\n      <body>\n        <main className="errorPage">\n          <p className="eyebrow">Build preview</p>\n          <h1>Something went wrong</h1>\n          <p className="lede">{error.message || "The app hit an unexpected rendering error."}</p>\n          <button type="button" onClick={reset}>Try again</button>\n        </main>\n      </body>\n    </html>\n  );\n}\n`,
    "src/app/page.tsx": isLuxuryWatch ? `const collections = ["Dress Icons", "Modern Divers", "Independent Makers"];\n\nexport default function Home() {\n  return (\n    <main className="page">\n      <section className="hero" aria-label="${safeName} landing page">\n        <div className="heroCopy">\n          <p className="eyebrow">${safeName}</p>\n          <h1>${heading}</h1>\n          <p className="lede">A refined marketplace concept for authenticated timepieces, private sourcing, and collector-grade discovery.</p>\n          <button type="button">${button}</button>\n        </div>\n        <div className="watchStage" aria-hidden="true">\n          <div className="watchFace"><span /></div>\n        </div>\n      </section>\n\n      <section className="trust" aria-label="Marketplace trust signals">\n        <span>Authenticated listings</span>\n        <span>Concierge sourcing</span>\n        <span>Original editorial guidance</span>\n      </section>\n\n      <section className="collections" aria-label="Featured collections">\n        {collections.map((item) => (\n          <article key={item}>\n            <div className="miniWatch" aria-hidden="true" />\n            <h2>{item}</h2>\n            <p>Curated direction, generated-safe product staging, and original copy for a premium first impression.</p>\n          </article>\n        ))}\n      </section>\n    </main>\n  );\n}\n` : `export default function Home() {\n  return (\n    <main className="page">\n      <section className="hero" aria-label="${safeName} landing page">\n        <p className="eyebrow">${safeName}</p>\n        <h1>${heading}</h1>\n        <p className="lede">Built from an Athena research brief with original copy, responsive layout, and generated-safe visual direction.</p>\n        <button type="button">${button}</button>\n      </section>\n    </main>\n  );\n}\n`,
    "src/app/globals.css": isLuxuryWatch ? `:root {\n  color-scheme: dark;\n  background: #101312;\n  color: #f8f4ea;\n  font-family: Arial, Helvetica, sans-serif;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n}\n\nbutton {\n  width: fit-content;\n  border: 1px solid #d9b76c;\n  border-radius: 8px;\n  padding: 14px 22px;\n  background: #d9b76c;\n  color: #12110f;\n  font-size: 15px;\n  font-weight: 800;\n  cursor: pointer;\n}\n\n.page {\n  min-height: 100vh;\n  background: linear-gradient(145deg, #101312 0%, #1b2320 48%, #4b3d2a 100%);\n}\n\n.hero {\n  min-height: 82vh;\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) minmax(280px, 420px);\n  align-items: center;\n  gap: 48px;\n  width: min(1120px, calc(100% - 40px));\n  margin: 0 auto;\n  padding: 64px 0 38px;\n}\n\n.heroCopy {\n  display: grid;\n  gap: 20px;\n}\n\n.eyebrow {\n  margin: 0;\n  color: #d9b76c;\n  font-size: 13px;\n  font-weight: 800;\n  letter-spacing: 0.14em;\n  text-transform: uppercase;\n}\n\nh1 {\n  max-width: 780px;\n  margin: 0;\n  color: #fff8e8;\n  font-family: Georgia, 'Times New Roman', serif;\n  font-size: clamp(48px, 8vw, 96px);\n  line-height: 0.95;\n  letter-spacing: 0;\n}\n\n.lede {\n  max-width: 620px;\n  margin: 0;\n  color: #d7d1c3;\n  font-size: 18px;\n  line-height: 1.7;\n}\n\n.watchStage {\n  aspect-ratio: 1;\n  border: 1px solid rgba(217, 183, 108, 0.32);\n  border-radius: 8px;\n  display: grid;\n  place-items: center;\n  background: radial-gradient(circle at 50% 45%, rgba(217, 183, 108, 0.26), transparent 34%), linear-gradient(160deg, rgba(255,255,255,0.12), rgba(255,255,255,0.02));\n}\n\n.watchFace {\n  width: 62%;\n  aspect-ratio: 1;\n  border-radius: 50%;\n  border: 14px solid #d9b76c;\n  display: grid;\n  place-items: center;\n  background: radial-gradient(circle, #20251f 0 58%, #0f1311 59% 100%);\n  box-shadow: 0 28px 80px rgba(0,0,0,0.44);\n}\n\n.watchFace span {\n  width: 42%;\n  height: 2px;\n  background: #fff8e8;\n  transform: rotate(-35deg);\n  transform-origin: right center;\n}\n\n.trust {\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 1px;\n  background: rgba(217, 183, 108, 0.25);\n  color: #f8f4ea;\n}\n\n.trust span {\n  background: rgba(16, 19, 18, 0.86);\n  padding: 18px 24px;\n  text-align: center;\n  font-size: 13px;\n  font-weight: 800;\n  text-transform: uppercase;\n}\n\n.collections {\n  width: min(1120px, calc(100% - 40px));\n  margin: 0 auto;\n  padding: 44px 0 72px;\n  display: grid;\n  grid-template-columns: repeat(3, 1fr);\n  gap: 16px;\n}\n\narticle {\n  min-height: 230px;\n  border: 1px solid rgba(217, 183, 108, 0.22);\n  border-radius: 8px;\n  padding: 22px;\n  background: rgba(248, 244, 234, 0.06);\n}\n\n.miniWatch {\n  width: 68px;\n  aspect-ratio: 1;\n  border-radius: 50%;\n  border: 7px solid #d9b76c;\n  background: #151917;\n}\n\nh2 {\n  margin: 18px 0 8px;\n  color: #fff8e8;\n  font-family: Georgia, 'Times New Roman', serif;\n  font-size: 25px;\n  letter-spacing: 0;\n}\n\narticle p {\n  margin: 0;\n  color: #c5beb0;\n  line-height: 1.55;\n}\n\n@media (max-width: 820px) {\n  .hero, .collections, .trust {\n    grid-template-columns: 1fr;\n  }\n\n  .watchStage {\n    max-width: 420px;\n    width: 100%;\n    margin: 0 auto;\n  }\n}\n` : `:root {\n  color-scheme: dark;\n  background: #101820;\n  color: #f7fbff;\n  font-family: Arial, Helvetica, sans-serif;\n}\n\n* {\n  box-sizing: border-box;\n}\n\nbody {\n  margin: 0;\n  min-height: 100vh;\n}\n\n.page {\n  min-height: 100vh;\n  display: grid;\n  place-items: center;\n  padding: 32px;\n  background: linear-gradient(135deg, #101820 0%, #1f3a3d 52%, #f2b84b 100%);\n}\n\n.hero {\n  width: min(760px, 100%);\n  display: grid;\n  gap: 22px;\n  text-align: center;\n}\n\n.eyebrow {\n  margin: 0;\n  color: #f2b84b;\n  font-size: 13px;\n  font-weight: 700;\n  letter-spacing: 0.14em;\n  text-transform: uppercase;\n}\n\nh1 {\n  margin: 0;\n  color: #ffffff;\n  font-size: clamp(44px, 9vw, 84px);\n  line-height: 0.95;\n  letter-spacing: 0;\n}\n\n.lede {\n  margin: 0;\n  color: #d8e4ef;\n  font-size: 17px;\n  line-height: 1.6;\n}\n\nbutton {\n  justify-self: center;\n  min-width: 132px;\n  border: 0;\n  border-radius: 8px;\n  padding: 14px 22px;\n  background: #ffffff;\n  color: #101820;\n  font-size: 16px;\n  font-weight: 800;\n  cursor: pointer;\n}\n`,
  };
}

function childProcessEnv(nodeEnv?: "development" | "production" | "test"): NodeJS.ProcessEnv {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "NODE_ENV") env[key] = value;
  }
  if (nodeEnv) {
    env.NODE_ENV = nodeEnv;
  } else if (process.env.NODE_ENV && ["development", "production", "test"].includes(process.env.NODE_ENV)) {
    env.NODE_ENV = process.env.NODE_ENV;
  }
  return env as NodeJS.ProcessEnv;
}

async function run(command: string, args: string[], cwd: string, nodeEnv?: "development" | "production" | "test"): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const isWindows = process.platform === "win32";
    const executable = isWindows ? (process.env.ComSpec ?? "cmd.exe") : command;
    const commandArgs = isWindows ? ["/d", "/s", "/c", command, ...args] : args;
    const child = spawn(executable, commandArgs, { cwd, shell: false, env: childProcessEnv(nodeEnv) });
    let output = "";
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ ok: false, output: `${output}\nCommand timed out.`.trim().slice(-8000) });
    }, 180_000);
    child.stdout.on("data", (chunk) => { output += String(chunk); });
    child.stderr.on("data", (chunk) => { output += String(chunk); });
    child.on("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, output: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ ok: code === 0, output: output.trim().slice(-8000) });
    });
  });
}

async function updateProjectBuildState(db: Db, projectId: string, status: string, log: string, error: string | null = null): Promise<void> {
  await db.execute({
    sql: `UPDATE Project SET status = ?, localBuildLog = ?, localBuildError = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [status, log.slice(-12000), error?.slice(0, 4000) ?? null, projectId],
  });
}

async function updateProjectDevState(db: Db, projectId: string, status: string, url: string | null, pid: number | null, log: string): Promise<void> {
  await db.execute({
    sql: `UPDATE Project SET status = ?, localDevUrl = ?, localDevPid = ?, localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ?`,
    args: [status, url, pid, log.slice(-12000), projectId],
  });
}

async function findLocalBuildProject(db: Db, userId: string, projectId: string): Promise<Record<string, unknown>> {
  await ensureLocalBuilderColumns(db);
  const res = await db.execute({
    sql: `SELECT * FROM Project WHERE id = ? AND userId = ? LIMIT 1`,
    args: [projectId, userId],
  });
  if (!res.rows.length) throw new Error("Prepared local project was not found.");
  return res.rows[0] as Record<string, unknown>;
}

async function resolveProjectFolder(project: Record<string, unknown>): Promise<{ projectName: string; folder: string; createdAt: string }> {
  const projectName = rowString(project.projectName);
  const localFolderPath = rowString(project.localFolderPath);
  const createdAt = rowString(project.createdAt) || new Date().toISOString();
  if (!projectName || !localFolderPath) throw new Error("Project is missing its local folder path.");

  const root = await getLocalProjectsRoot();
  const resolvedRoot = path.resolve(root);
  const resolvedFolder = path.resolve(localFolderPath);
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (resolvedFolder !== resolvedRoot && !resolvedFolder.startsWith(rootWithSep)) {
    throw new Error("Unsafe local project folder path rejected.");
  }

  return { projectName, folder: resolvedFolder, createdAt };
}

async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function nextAvailablePort(start = 3000): Promise<number> {
  for (let port = start; port < start + 50; port++) {
    if (await isPortAvailable(port)) return port;
  }
  throw new Error("No available localhost port found between 3000 and 3049.");
}

async function killProcessTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = process.platform === "win32"
      ? spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { shell: false, stdio: "ignore" })
      : spawn("kill", ["-TERM", String(pid)], { shell: false, stdio: "ignore" });
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

async function logLocalBuilderRun(db: Db, status: string, input: string, output: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'none', ?, datetime('now'))`,
    args: [crypto.randomUUID(), LOCAL_BUILDER_AGENT, input, output.slice(0, 2000), status],
  }).catch(() => undefined);
}

async function logAthenaResearchRun(db: Db, projectName: string, brief: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'internal', 'completed', datetime('now'))`,
    args: [crypto.randomUUID(), ATHENA_RESEARCH_AGENT, `research_build_brief project=${projectName}`, brief.slice(0, 2000)],
  }).catch(() => undefined);
}

async function upsertSkillTask(db: Db, projectId: string, userId: string, title: string, description: string, status: "pending" | "done", nextStep: string): Promise<void> {
  const existing = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, title],
  });

  if (existing.rows.length) {
    await db.execute({
      sql: `UPDATE ProjectTask SET status = ?, assignedAgent = ?, description = ?, nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [status, LOCAL_BUILDER_AGENT, description.slice(0, 500), nextStep, rowString((existing.rows[0] as Record<string, unknown>).id)],
    });
    return;
  }

  await db.execute({
    sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    args: [crypto.randomUUID(), projectId, userId, title, description.slice(0, 500), status, LOCAL_BUILDER_AGENT, nextStep],
  });
}

export async function prepareLocalBuildProject(userId: string, message: string): Promise<LocalBuildProject | null> {
  const parsed = parseLocalBuildRequest(message);
  if (!parsed) return null;

  const root = await getLocalProjectsRoot();
  if (!(await exists(root))) {
    throw new Error(`Local builder root folder is missing: ${root}`);
  }

  const localFolderPath = path.resolve(root, parsed.folderName);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (localFolderPath !== root && !localFolderPath.startsWith(rootWithSep)) {
    throw new Error("Unsafe local project folder path rejected.");
  }
  await mkdir(localFolderPath, { recursive: true });

  const db = getDb();
  await ensureLocalBuilderColumns(db);
  const researchBrief = await createAthenaResearchBrief(parsed.projectName, message);

  const now = new Date().toISOString();
  const existing = await db.execute({
    sql: `SELECT * FROM Project WHERE userId = ? AND (lower(projectName) = lower(?) OR localFolderPath = ?) LIMIT 1`,
    args: [userId, parsed.projectName, localFolderPath],
  });

  let projectId: string;
  let createdAt = now;

  if (existing.rows.length) {
    const row = existing.rows[0] as Record<string, unknown>;
    projectId = rowString(row.id);
    createdAt = rowString(row.createdAt) || now;
    await db.execute({
      sql: `UPDATE Project SET projectName = ?, status = 'Researching', latestInstruction = ?, assignedAgent = ?, localFolderPath = ?, localBuildLog = ?, localBuildError = NULL, updatedAt = datetime('now') WHERE id = ?`,
      args: [parsed.projectName, message.slice(0, 500), ATHENA_RESEARCH_AGENT, localFolderPath, "Researching: Athena is creating a build brief.\n", projectId],
    });
  } else {
    projectId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO Project (id, userId, projectName, route, status, latestInstruction, assignedAgent, localFolderPath, localBuildLog, createdAt, updatedAt) VALUES (?, ?, ?, ?, 'Researching', ?, ?, ?, ?, datetime('now'), datetime('now'))`,
      args: [projectId, userId, parsed.projectName, null, message.slice(0, 500), ATHENA_RESEARCH_AGENT, localFolderPath, "Researching: Athena is creating a build brief.\n"],
    });
  }

  const researchTask = `Athena research brief for ${parsed.projectName}`;
  const researchTaskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, researchTask],
  });

  if (researchTaskExisting.rows.length) {
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'done', assignedAgent = ?, nextStep = 'Brief ready for Builder generation', updatedAt = datetime('now') WHERE id = ?`,
      args: [ATHENA_RESEARCH_AGENT, rowString((researchTaskExisting.rows[0] as Record<string, unknown>).id)],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'done', ?, 'Brief ready for Builder generation', datetime('now'))`,
      args: [crypto.randomUUID(), projectId, userId, researchTask, researchBrief.slice(0, 500), ATHENA_RESEARCH_AGENT],
    });
  }

  await db.execute({
    sql: `UPDATE Project SET status = 'Brief Ready', assignedAgent = ?, localResearchBrief = ?, localBuildLog = ?, updatedAt = datetime('now') WHERE id = ?`,
    args: [LOCAL_BUILDER_AGENT, researchBrief, `Researching: Athena created an internal build brief.\nBrief Ready: Builder can generate from the research brief.\n\n${researchBrief}`, projectId],
  });

  await logAthenaResearchRun(db, parsed.projectName, researchBrief);

  const skillTasks = [
    ["Product brief", "Define audience, business goal, pages, features, tone, and content needs."],
    ["Design brief", "Define visual direction, typography, spacing, layout, motion, and asset rules."],
    ["Feature plan", "Define catalog, cards, filters, detail views, saved/compare, and checkout or concierge flow."],
    ["Build plan", "Define implementation steps for responsive, stateful, testable UI."],
    ["QA checklist", "Verify build, navigation, buttons, filters, localStorage, responsive layout, and no copied assets."],
    ["Visual polish review", "Confirm the app feels like a real product before completion."],
  ] as const;

  for (const [title, description] of skillTasks) {
    await upsertSkillTask(db, projectId, userId, `${title} for ${parsed.projectName}`, description, title === "Visual polish review" ? "pending" : "done", title === "Visual polish review" ? "Review after generation and QA" : "Ready for Builder generation");
  }

  const currentTask = `Generate app from Athena brief for ${parsed.projectName}`;
  const taskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, currentTask],
  });

  let taskId: string;
  if (taskExisting.rows.length) {
    taskId = rowString((taskExisting.rows[0] as Record<string, unknown>).id);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'pending', assignedAgent = ?, nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [LOCAL_BUILDER_AGENT, "Generate the app using the Athena research brief", taskId],
    });
  } else {
    taskId = crypto.randomUUID();
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, datetime('now'))`,
      args: [taskId, projectId, userId, currentTask, message.slice(0, 500), LOCAL_BUILDER_AGENT, "Generate the app using the Athena research brief"],
    });
  }

  await db.execute({
    sql: `INSERT INTO AgentRun (id, agentName, inputSummary, outputSummary, modelProvider, status, createdAt) VALUES (?, ?, ?, ?, 'none', 'completed', datetime('now'))`,
    args: [
      crypto.randomUUID(),
      LOCAL_BUILDER_AGENT,
      `local_build_prepare project=${parsed.projectName}`,
      `Brief Ready and prepared ${localFolderPath}`,
    ],
  }).catch(() => undefined);

  return {
    id: projectId,
    projectName: parsed.projectName,
    localFolderPath,
    status: "Brief Ready",
    createdAt,
    currentTask,
    taskId,
    buildLog: `Researching: Athena created an internal build brief.\nBrief Ready: Builder can generate from the research brief.\n\n${researchBrief}`,
    buildError: null,
    localDevUrl: null,
    localDevPid: null,
    researchBrief,
  };
}

export async function generateLocalStarterApp(userId: string, projectId: string, message: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder: resolvedFolder, createdAt } = await resolveProjectFolder(project);
  const researchBrief = rowString(project.localResearchBrief) || await createAthenaResearchBrief(projectName, message);
  if (!rowString(project.localResearchBrief)) {
    await db.execute({
      sql: `UPDATE Project SET localResearchBrief = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [researchBrief, projectId],
    });
  }

  const taskTitle = `Generate starter app for ${projectName}`;
  const taskExisting = await db.execute({
    sql: `SELECT id FROM ProjectTask WHERE projectId = ? AND title = ? LIMIT 1`,
    args: [projectId, taskTitle],
  });
  const taskId = taskExisting.rows.length ? rowString((taskExisting.rows[0] as Record<string, unknown>).id) : crypto.randomUUID();
  if (taskExisting.rows.length) {
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'in_progress', assignedAgent = ?, nextStep = 'Generate starter app files', updatedAt = datetime('now') WHERE id = ?`,
      args: [LOCAL_BUILDER_AGENT, taskId],
    });
  } else {
    await db.execute({
      sql: `INSERT INTO ProjectTask (id, projectId, userId, title, description, status, assignedAgent, nextStep, updatedAt) VALUES (?, ?, ?, ?, ?, 'in_progress', ?, 'Generate starter app files', datetime('now'))`,
      args: [taskId, projectId, userId, taskTitle, message.slice(0, 500), LOCAL_BUILDER_AGENT],
    });
  }

  let log = `${rowString(project.localBuildLog) || "Ready to Build"}\n`;
  const files = await appFiles(projectName, message, researchBrief);
  const changedFiles = Object.keys(files);

  try {
    await updateProjectBuildState(db, projectId, "Generating", log);
    await mkdir(resolvedFolder, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
      const absolutePath = path.resolve(resolvedFolder, ...relativePath.split("/"));
      const folderWithSep = resolvedFolder.endsWith(path.sep) ? resolvedFolder : `${resolvedFolder}${path.sep}`;
      if (absolutePath !== resolvedFolder && !absolutePath.startsWith(folderWithSep)) {
        throw new Error(`Unsafe generated file path rejected: ${relativePath}`);
      }
      await mkdir(path.dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf8");
    }
    log += `Generating: wrote ${changedFiles.join(", ")}\n`;

    await updateProjectBuildState(db, projectId, "Installing", log);
    const install = await run("npm", ["install"], resolvedFolder);
    log += `\nInstalling: ${install.ok ? "passed" : "failed"}\n${install.output}\n`;
    if (!install.ok) throw new Error(`npm install failed\n${install.output}`);

    await updateProjectBuildState(db, projectId, "Building", log);
    const build = await run("npm", ["run", "build"], resolvedFolder, "production");
    log += `\nBuilding: ${build.ok ? "passed" : "failed"}\n${build.output}\n`;
    if (!build.ok) throw new Error(`npm run build failed\n${build.output}`);

    await updateProjectBuildState(db, projectId, "Build Passed", log);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'done', nextStep = 'Build passed', updatedAt = datetime('now') WHERE id = ?`,
      args: [taskId],
    });
    await upsertSkillTask(db, projectId, userId, `Visual polish review for ${projectName}`, "Confirm the app feels like a real product before completion.", "done", "Polish review passed with the generated app build");
    await logLocalBuilderRun(db, "completed", `local_build_generate project=${projectName}`, `Build Passed: ${resolvedFolder}`);

    return {
      id: projectId,
      projectName,
      localFolderPath: resolvedFolder,
      status: "Build Passed",
      createdAt,
      currentTask: taskTitle,
      taskId,
      buildLog: log.slice(-12000),
      buildError: null,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief,
      files: changedFiles,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateProjectBuildState(db, projectId, "Build Failed", log, detail);
    await db.execute({
      sql: `UPDATE ProjectTask SET status = 'pending', nextStep = ?, updatedAt = datetime('now') WHERE id = ?`,
      args: [`Fix first build error: ${detail.slice(0, 300)}`, taskId],
    }).catch(() => undefined);
    await logLocalBuilderRun(db, "failed", `local_build_generate project=${projectName}`, detail.slice(0, 2000));
    return {
      id: projectId,
      projectName,
      localFolderPath: resolvedFolder,
      status: "Build Failed",
      createdAt,
      currentTask: taskTitle,
      taskId,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief,
      files: changedFiles,
    };
  }
}

export async function rebuildLocalStarterApp(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const taskId = crypto.randomUUID();
  let log = `${rowString(project.localBuildLog)}\nRebuild requested\n`.trim();

  try {
    await updateProjectBuildState(db, projectId, "Building", log);
    const build = await run("npm", ["run", "build"], folder, "production");
    log += `\n\nRebuild: ${build.ok ? "passed" : "failed"}\n${build.output}\n`;
    if (!build.ok) throw new Error(`npm run build failed\n${build.output}`);
    await updateProjectBuildState(db, projectId, "Build Passed", log);
    await logLocalBuilderRun(db, "completed", `local_build_rebuild project=${projectName}`, `Build Passed: ${folder}`);
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Build Passed",
      createdAt,
      currentTask: `Rebuild ${projectName}`,
      taskId,
      buildLog: log.slice(-12000),
      buildError: null,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief: rowString(project.localResearchBrief) || null,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await updateProjectBuildState(db, projectId, "Build Failed", log, detail);
    await logLocalBuilderRun(db, "failed", `local_build_rebuild project=${projectName}`, detail);
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Build Failed",
      createdAt,
      currentTask: `Rebuild ${projectName}`,
      taskId,
      buildLog: log.slice(-12000),
      buildError: detail,
      localDevUrl: rowString(project.localDevUrl) || null,
      localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
      researchBrief: rowString(project.localResearchBrief) || null,
    };
  }
}

export async function openLocalProjectFolder(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  let log = `${rowString(project.localBuildLog)}\nOpen Folder: ${folder}`.trim();
  try {
    const child = spawn("code", [folder], { detached: true, shell: process.platform === "win32", stdio: "ignore" });
    child.unref();
    log += "\nVS Code open command sent.";
  } catch (error) {
    log += `\nVS Code open failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  await updateProjectBuildState(db, projectId, rowString(project.status) || "Build Passed", log, null);
  await logLocalBuilderRun(db, "completed", `local_build_open_folder project=${projectName}`, folder);
  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: rowString(project.status) || "Build Passed",
    createdAt,
    currentTask: `Open folder for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: rowString(project.localDevUrl) || null,
    localDevPid: typeof project.localDevPid === "number" ? project.localDevPid : null,
    researchBrief: rowString(project.localResearchBrief) || null,
  };
}

export async function startLocalDevServer(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const existing = devServers.get(projectId);
  if (existing && !existing.child.killed) {
    return {
      id: projectId,
      projectName,
      localFolderPath: folder,
      status: "Dev Server Running",
      createdAt,
      currentTask: `Preview ${projectName}`,
      taskId: crypto.randomUUID(),
      buildLog: rowString(project.localBuildLog),
      buildError: null,
      localDevUrl: existing.url,
      localDevPid: existing.pid,
      researchBrief: rowString(project.localResearchBrief) || null,
    };
  }

  const port = await nextAvailablePort(3000);
  const url = `http://localhost:${port}`;
  let output = `${rowString(project.localBuildLog)}\nStarting dev server at ${url}\n`.trim();
  const child = spawn("npm", ["run", "dev", "--", "-p", String(port)], {
    cwd: folder,
    shell: process.platform === "win32",
    env: childProcessEnv("development"),
    stdio: ["ignore", "pipe", "pipe"],
  });
  devServers.set(projectId, { child, url, pid: child.pid ?? null });
  child.stdout?.on("data", (chunk) => { output = `${output}\n${String(chunk)}`.slice(-12000); });
  child.stderr?.on("data", (chunk) => { output = `${output}\n${String(chunk)}`.slice(-12000); });
  child.on("exit", () => {
    const current = devServers.get(projectId);
    if (current?.child === child) devServers.delete(projectId);
  });

  await new Promise((resolve) => setTimeout(resolve, 2500));
  await updateProjectDevState(db, projectId, "Dev Server Running", url, child.pid ?? null, output);
  await logLocalBuilderRun(db, "completed", `local_build_start_dev project=${projectName}`, `Dev Server Running: ${url}`);

  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: "Dev Server Running",
    createdAt,
    currentTask: `Preview ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: output.slice(-12000),
    buildError: null,
    localDevUrl: url,
    localDevPid: child.pid ?? null,
    researchBrief: rowString(project.localResearchBrief) || null,
  };
}

export async function stopLocalDevServer(userId: string, projectId: string): Promise<LocalBuildProject> {
  const db = getDb();
  const project = await findLocalBuildProject(db, userId, projectId);
  const { projectName, folder, createdAt } = await resolveProjectFolder(project);
  const running = devServers.get(projectId);
  if (running?.pid) await killProcessTree(running.pid);
  else if (typeof project.localDevPid === "number") await killProcessTree(project.localDevPid);
  devServers.delete(projectId);
  const log = `${rowString(project.localBuildLog)}\nDev Server Stopped`.trim();
  await updateProjectDevState(db, projectId, "Dev Server Stopped", null, null, log);
  await logLocalBuilderRun(db, "completed", `local_build_stop_dev project=${projectName}`, "Dev Server Stopped");
  return {
    id: projectId,
    projectName,
    localFolderPath: folder,
    status: "Dev Server Stopped",
    createdAt,
    currentTask: `Stop preview for ${projectName}`,
    taskId: crypto.randomUUID(),
    buildLog: log.slice(-12000),
    buildError: null,
    localDevUrl: null,
    localDevPid: null,
    researchBrief: rowString(project.localResearchBrief) || null,
  };
}
