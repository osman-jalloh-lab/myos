import type { Metadata } from "next";
import { enforcePreviewModeOr404 } from "@/lib/preview-mode";

export const metadata: Metadata = {
  title: "Voice Preview",
};

export default async function VoicePreviewPage() {
  await enforcePreviewModeOr404();

  const plan = {
    id: "preview-plan-1",
    normalizedIntent: "add_voice_capability",
    capabilityName: "Voice Command Center",
    summary: "Add push-to-talk and typed-command interface with risk-aware approval gating.",
    risk: "yellow" as const,
    riskReason: "New code, route, and integration work.",
    requestedPermissions: ["filesystem:write", "build"],
    filesLikelyAffected: ["src/lib/voice.ts", "src/app/command-center/VoiceInput.tsx", "src/app/api/voice/*"],
    requiredTests: ["unit tests", "lint", "build", "preview"],
    rollback: "Revert branch; delete created folder/files.",
    executor: "local_worker" as const,
    executionProfile: "build" as const,
    requiresApproval: true,
    createdAt: new Date().toISOString(),
    status: "planned" as const,
  };

  const task = {
    taskId: "preview-task-1",
    status: "queued" as const,
    executor: "local_worker" as const,
    executionProfile: "build" as const,
    branch: "improve-add_voice_capability-preview",
  };

  return (
    <main style={{ minHeight: "100vh", background: "rgba(10,13,18,1)", color: "#e6e8ee", padding: "24px" }}>
      <div style={{ maxWidth: "1020px", margin: "0 auto", display: "grid", gap: "16px" }}>
        <header style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <h1 style={{ fontSize: "22px", margin: 0 }}>MyOS — Improve MyOS</h1>
            <p style={{ margin: "6px 0 0", color: "#8a8f9c" }}>Visual Preview Only — static demo data</p>
          </div>
          <div style={{ padding: "6px 10px", borderRadius: "8px", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", fontSize: "12px", color: "#d6d8de" }}>
            Preview mode
          </div>
        </header>

        <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>Request</h2>
          <div style={{ color: "#cdd0d7" }}>Add voice commands to MyOS.</div>
          <div style={{ fontSize: "12px", color: "#8a8f9c" }}>Source: typed</div>
        </section>

        <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>Plan</h2>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <span style={{ padding: "4px 10px", borderRadius: "999px", border: "1px solid currentColor", color: "#ffb74d", background: "rgba(255,183,77,0.12)", fontSize: "12px" }}>YELLOW</span>
            <span style={{ color: "#cdd0d7" }}>{plan.capabilityName}</span>
          </div>
          <div style={{ color: "#a5a8b1", fontSize: "14px" }}>{plan.summary}</div>
          <div style={{ fontSize: "12px", color: "#8a8f9c" }}>
            <div>Why: {plan.riskReason}</div>
            <div>Permissions: {plan.requestedPermissions.join(", ")}</div>
            <div>Files likely affected: {plan.filesLikelyAffected.join(", ")}</div>
            <div>Required tests: {plan.requiredTests.join(", ")}</div>
            <div>Rollback: {plan.rollback}</div>
            <div>Executor: {plan.executor}, Profile: {plan.executionProfile}</div>
          </div>
        </section>

        <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>Approval</h2>
          <div style={{ padding: "10px 12px", borderRadius: "10px", background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.1)" }}>
            Approval required for Yellow work.
          </div>
        </section>

        <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
          <h2 style={{ margin: 0, fontSize: "16px" }}>Execution</h2>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: "10px", fontSize: "13px", color: "#cdd0d7" }}>
            <div>
              <div style={{ color: "#8a8f9c", fontSize: "11px" }}>Task ID</div>
              <div>{task.taskId}</div>
            </div>
            <div>
              <div style={{ color: "#8a8f9c", fontSize: "11px" }}>Status</div>
              <div>{task.status}</div>
            </div>
            <div>
              <div style={{ color: "#8a8f9c", fontSize: "11px" }}>Executor</div>
              <div>{task.executor}</div>
            </div>
            <div>
              <div style={{ color: "#8a8f9c", fontSize: "11px" }}>Profile</div>
              <div>{task.executionProfile}</div>
            </div>
            <div>
              <div style={{ color: "#8a8f9c", fontSize: "11px" }}>Branch</div>
              <div>{task.branch}</div>
            </div>
          </div>
        </section>

        <footer style={{ color: "#8a8f9c", fontSize: "12px" }}>
          Voice unavailable in preview mode. Type your request instead.
        </footer>
      </div>
    </main>
  );
}
