import { describe, expect, it } from "vitest";
import {
  hasFormLabels,
  hasMeaningfulNavigation,
  hasNoDeadSectionHints,
  hasRecordedBuildSuccess,
  BuilderRuntimeUnavailableError,
  createBuilderDockerRunSpec,
  discoverBuilderDockerExecutable,
  validateBuilderExecutableSource,
  validateBuilderPackageManifest,
  validateBuilderProjectSourcePath,
} from "../local-builder";

describe("local Builder QA signals", () => {
  it("accepts form controls nested in visible labels", () => {
    const result = hasFormLabels(`
      <form>
        <label>Customer <input name="customer" placeholder="Morgan Warehouse..." /></label>
        <label>Scope <textarea name="scope" /></label>
      </form>
    `);

    expect(result).toMatchObject({ passed: true, skipped: false });
  });

  it("recognizes aria labels that appear after JSX arrow handlers", () => {
    const result = hasFormLabels(`
      <form>
        <select value={filter} onChange={(event) => setFilter(event.target.value)} aria-label="Filter leads">
          <option>All</option>
        </select>
      </form>
    `);

    expect(result).toMatchObject({ passed: true, skipped: false });
  });

  it("recognizes a successful post-Codex production build after an earlier QA failure", () => {
    expect(hasRecordedBuildSuccess("Codex build: passed\nCommand: npm run build", "failed")).toBe(true);
  });

  it("accepts stateful button navigation inside a nav landmark", () => {
    expect(hasMeaningfulNavigation(`
      <nav aria-label="CRM sections">
        <button type="button" onClick={() => setActiveSection("jobs")}>Jobs</button>
      </nav>
    `)).toBe(true);
  });

  it("allows only a controlled Next.js package manifest before host execution", () => {
    expect(validateBuilderPackageManifest(JSON.stringify({
      scripts: { build: "next build", dev: "next dev" },
      dependencies: { next: "16.2.7", react: "19.2.4", "react-dom": "19.2.4" },
      devDependencies: { typescript: "^5.9.0", "@types/node": "^24.0.0" },
    }))).toBeNull();
    expect(validateBuilderPackageManifest(JSON.stringify({ scripts: { build: "next build", postinstall: "node steal.js" } }))).toMatch(/lifecycle script/i);
    expect(validateBuilderPackageManifest(JSON.stringify({ scripts: { build: "node arbitrary.js" } }))).toMatch(/build script/i);
    expect(validateBuilderPackageManifest(JSON.stringify({ scripts: { build: "next build", dev: "node arbitrary.js" } }))).toMatch(/dev script/i);
    expect(validateBuilderPackageManifest(JSON.stringify({ scripts: { build: "next build" }, dependencies: { evil: "https://example.com/evil.tgz" } }))).toMatch(/dependency/i);
  });

  it("rejects generated build-time source with host capabilities", () => {
    expect(validateBuilderExecutableSource("next.config.ts", 'import type { NextConfig } from "next"; const nextConfig: NextConfig = { reactStrictMode: true }; export default nextConfig;')).toBeNull();
    expect(validateBuilderExecutableSource("next.config.ts", 'process.env.SECRET; export default {};')).toMatch(/host capability/i);
    expect(validateBuilderExecutableSource("app/page.tsx", 'import fs from "node:fs"; export default function Page() { return <main />; }')).toMatch(/host capability/i);
    expect(validateBuilderExecutableSource("app/page.tsx", 'import fs from "fs/promises"; export default function Page() { return <main />; }')).toMatch(/module import/i);
    expect(validateBuilderExecutableSource("app/tools.ts", 'export * from "fs";')).toMatch(/module import/i);
    expect(validateBuilderExecutableSource("app/page.tsx", 'const name = "fs"; import(`${name}/promises`); export default function Page() { return <main />; }')).toMatch(/dynamic module loading/i);
  });

  it("constructs a confined Docker command for generated installs, builds, and previews", () => {
    const build = createBuilderDockerRunSpec({
      dockerExecutable: "C:/Docker/docker.exe", folder: "C:/Builder/project-1", projectId: "project-1", runId: "run-1",
      command: ["npm", "run", "build"],
    });
    const preview = createBuilderDockerRunSpec({
      dockerExecutable: "C:/Docker/docker.exe", folder: "C:/Builder/project-1", projectId: "project-1", runId: "run-2",
      detached: true, hostPort: 3012, command: ["npm", "run", "start", "--", "--hostname", "0.0.0.0", "--port", "3000"],
    });
    expect(build.args).toEqual(expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--memory", "2g", "--cpus", "2", "--pids-limit", "256", "--mount", "type=bind,src=C:/Builder/project-1,dst=/workspace", "node:22-bookworm-slim", "npm", "run", "build"]));
    expect(build.args.filter((arg) => arg === "--mount")).toHaveLength(1);
    expect(build.args.join(" ")).not.toMatch(/docker\.sock|--privileged|--network\s+host|\.ssh/i);
    expect(preview.args).toEqual(expect.arrayContaining(["-d", "-p", "127.0.0.1:3012:3000", "--name"]));
    expect(preview.args[preview.args.indexOf("--name") + 1]).toMatch(/^builder-preview-project-1-run-2$/);
  });

  it("fails closed when no approved Docker executable exists", async () => {
    await expect(discoverBuilderDockerExecutable(["C:/definitely-missing/docker.exe"])).rejects.toBeInstanceOf(BuilderRuntimeUnavailableError);
  });

  it("accepts normal Next project paths and rejects traversal, drive, and UNC escapes", () => {
    for (const file of ["src/app/page.tsx", "src/pages/index.tsx", "src/components/Card.tsx", "src/lib/format.ts", "app/layout.tsx", "pages/api/health.ts", "components/Nav.tsx", "lib/data.ts", "public/icon.svg", "styles/globals.css", "next-env.d.ts", "tsconfig.json"]) {
      expect(validateBuilderProjectSourcePath(file)).toBeNull();
    }
    expect(validateBuilderProjectSourcePath("../outside.ts")).toMatch(/traversal/i);
    expect(validateBuilderProjectSourcePath("C:\\outside.ts")).toMatch(/absolute/i);
    expect(validateBuilderProjectSourcePath("\\\\server\\share\\outside.ts")).toMatch(/absolute|UNC/i);
  });

  it("does not treat real input placeholder attributes as dead sections", () => {
    expect(hasNoDeadSectionHints(`
      <main>
        <form onSubmit={saveLead}>
          <label>Lead <input placeholder="Morgan Warehouse..." /></label>
        </form>
      </main>
    `, "input:focus-visible { outline: 2px solid blue; }")).toBe(true);
  });
});
