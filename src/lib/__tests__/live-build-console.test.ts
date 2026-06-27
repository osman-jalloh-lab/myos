import { describe, expect, it } from "vitest";
import { buildStatusMeaning, extractBuildFiles, inferAppType, redactBuildText } from "../live-build-console";

describe("live build console helpers", () => {
  it("classifies a watch website without inventing a marketplace", () => expect(inferAppType("Build a watch website called ChronoTest")).toBe("watch website"));
  it("extracts generated app files", () => expect(extractBuildFiles("Files created: package.json, src/app/page.tsx, src/app/layout.tsx")).toEqual(["package.json", "src/app/page.tsx", "src/app/layout.tsx"]));
  it("redacts credential-shaped log values", () => expect(redactBuildText("GITHUB_TOKEN=secret-value")).toBe("GITHUB_TOKEN=[redacted]"));
  it("uses plain status language", () => expect(buildStatusMeaning("Building", "local_worker", "npm run build", false)).toBe("Running build check"));
});
