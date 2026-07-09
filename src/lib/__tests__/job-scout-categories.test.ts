import { describe, expect, it } from "vitest";
import { JOB_SCOUT_CATEGORIES, adjustJobScoutFitScore, inferJobScoutCategory, matchesJobScoutCategory } from "@/lib/job-scout/pipeline";

function category(key: string) {
  const found = JOB_SCOUT_CATEGORIES.find((entry) => entry.key === key);
  if (!found) throw new Error(`Missing category ${key}`);
  return found;
}

describe("job scout categories", () => {
  it("keeps the active search scope to four confirmed categories", () => {
    expect(JOB_SCOUT_CATEGORIES.map((entry) => entry.key)).toEqual([
      "fall_internship",
      "full_time_it",
      "soc",
      "risk_management",
    ]);
  });

  it("filters internships to explicit fall-term availability", () => {
    expect(matchesJobScoutCategory({
      title: "Cybersecurity Internship - Fall 2026",
      company: "Example",
      description: "Fall semester internship supporting SOC alert triage.",
    }, category("fall_internship"))).toBe(true);

    expect(matchesJobScoutCategory({
      title: "Cybersecurity Internship",
      company: "Example",
      description: "Summer internship supporting SOC alert triage.",
    }, category("fall_internship"))).toBe(false);
  });

  it("infers and boosts SOC and risk roles that match Security+ and CySA+", () => {
    const soc = {
      title: "Entry Level SOC Analyst",
      company: "Example",
      description: "Monitor SIEM alerts. Security+ and CySA+ preferred.",
    };
    const risk = {
      title: "Technology Risk Analyst",
      company: "Example",
      description: "GRC, audit controls, NIST, and CompTIA Security+ preferred.",
    };

    expect(inferJobScoutCategory(soc)).toBe("soc");
    expect(inferJobScoutCategory(risk)).toBe("risk_management");
    expect(adjustJobScoutFitScore(70, soc, "soc")).toBeGreaterThan(70);
    expect(adjustJobScoutFitScore(70, risk, "risk_management")).toBeGreaterThan(70);
  });
});
