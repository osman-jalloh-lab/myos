"use client";

import React, { useState, useRef, useCallback } from "react";
import VoiceInput from "./VoiceInput";
import ChatPanel from "./ChatPanel";

type Risk = "green" | "yellow" | "red";

type PlanState = {
  planId: string;
  requestText: string;
  normalizedIntent: string;
  capabilityName: string;
  summary: string;
  risk: Risk;
  riskReason: string;
  requestedPermissions: string[];
  filesLikelyAffected: string[];
  requiredTests: string[];
  rollback: string;
  executor: string;
  executionProfile: string;
  requiresApproval: boolean;
  status: string;
  createdAt: string;
} | null;

type ApprovalState = { id: string; status: string; createdAt: string } | null;

type TaskState = { taskId: string; status: string; executor: string; executionProfile: string; branch: string } | null;

const emptyPlan: PlanState = null;
const emptyApproval: ApprovalState = null;
const emptyTask: TaskState = null;

function RiskBadge({ risk }: { risk: Risk }) {
  const color = risk === "red" ? "#ef4444" : risk === "yellow" ? "#f59e0b" : "#22c55e";
  return <span style={{ border: `1px solid ${color}`, color, padding: "2px 10px", borderRadius: "999px", fontSize: "12px", background: `${color}18` }}>{risk.toUpperCase()}</span>;
}

export default function ImproveMyOS() {
  const [requestText, setRequestText] = useState("");
  const [plan, setPlan] = useState<PlanState>(emptyPlan);
  const [approval, setApproval] = useState<ApprovalState>(emptyApproval);
  const [task, setTask] = useState<TaskState>(emptyTask);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingTranscript, setEditingTranscript] = useState("");

  const resetFlow = useCallback(() => {
    setPlan(emptyPlan);
    setApproval(emptyApproval);
    setTask(emptyTask);
    setError(null);
  }, []);

  const submitRequest = useCallback(async (text: string) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/improve/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestText: text, source: "voice" }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Plan creation failed");
      setPlan(json);
      setEditingTranscript(text);
      resetFlow();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Plan creation failed");
    } finally {
      setLoading(false);
    }
  }, [resetFlow]);

  const requestApproval = useCallback(async () => {
    if (!plan) return;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/improve/approve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.planId }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Approval request failed");
      setApproval(json.approval);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approval request failed");
    } finally {
      setLoading(false);
    }
  }, [plan]);

  const executePlan = useCallback(async () => {
    if (!plan) return;
    setLoading(true);
    setError(null);
    try {
      const approvalId = approval?.id;
      const response = await fetch("/api/improve/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId: plan.planId, approvalId }),
      });
      const json = await response.json();
      if (!response.ok) throw new Error(json.error || "Execution failed");
      setTask({ taskId: json.taskId, status: json.status || "queued", executor: plan.executor, executionProfile: plan.executionProfile, branch: `improve-${plan.normalizedIntent}-${Date.now()}` });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Execution failed");
    } finally {
      setLoading(false);
    }
  }, [plan, approval]);

  const handleVoiceError = useCallback((message: string) => {
    setError(message);
  }, []);

  return (
    <div style={{ display: "grid", gap: "16px" }}>
      <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "12px" }}>
        <h2 style={{ margin: 0, fontSize: "16px" }}>Request</h2>
        <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
          <input
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            aria-label="Describe what you want MyOS to improve"
            placeholder="Describe what you want MyOS to improve…"
            style={{ flex: 1, minWidth: "220px", background: "rgba(0,0,0,0.35)", color: "#e6e8ee", border: "1px solid rgba(255,255,255,0.1)", borderRadius: "8px", padding: "10px 12px" }}
          />
          <button type="button" onClick={() => submitRequest(requestText)} disabled={loading || !requestText.trim()} style={{ padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.06)", color: "#e6e8ee" }}>
            Send
          </button>
          <VoiceInput onSubmit={submitRequest} busy={loading} onError={handleVoiceError} disabled={loading} />
        </div>
        <div style={{ fontSize: "12px", color: "#8a8f9c" }}>Examples: Add voice commands, Improve dashboard design, Create a project tracker.</div>
        {error && <div style={{ color: "#ef4444", fontSize: "12px" }}>{error}</div>}
      </section>

      {plan && (
        <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <h2 style={{ margin: 0, fontSize: "16px" }}>Plan</h2>
            <RiskBadge risk={plan.risk} />
            <span style={{ color: "#a5a8b1", fontSize: "12px" }}>{plan.status}</span>
          </div>
          <div style={{ color: "#cdd0d7" }}>{editingTranscript || plan.requestText}</div>
          <div style={{ color: "#a5a8b1", fontSize: "14px" }}>{plan.summary}</div>
          <div style={{ fontSize: "12px", color: "#8a8f9c", display: "grid", gap: "4px" }}>
            <div>Why: {plan.riskReason}</div>
            <div>Permissions: {(plan.requestedPermissions || []).join(", ")}</div>
            <div>Files likely affected: {(plan.filesLikelyAffected || []).join(", ")}</div>
            <div>Required tests: {(plan.requiredTests || []).join(", ")}</div>
            <div>Rollback: {plan.rollback}</div>
            <div>Executor: {plan.executor}, Profile: {plan.executionProfile}</div>
          </div>
        </section>
      )}

      {plan && (plan.risk === "red" ? (
        <section style={{ border: "1px solid rgba(239,68,68,0.3)", borderRadius: "12px", background: "rgba(239,68,68,0.06)", padding: "16px", display: "grid", gap: "8px" }}>
          <h3 style={{ margin: 0, fontSize: "14px" }}>Manual review required</h3>
          <div style={{ fontSize: "12px", color: "#8a8f9c" }}>Red-class work cannot be executed automatically. Export or copy this request for separate manual review.</div>
        </section>
      ) : (
        <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "16px" }}>Approval</h3>
          {!approval && (
            <button type="button" onClick={requestApproval} disabled={loading} style={{ padding: "10px 14px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.12)", background: "rgba(255,255,255,0.06)", color: "#e6e8ee" }}>
              Approve and create task
            </button>
          )}
          {approval && (
            <div style={{ fontSize: "12px", color: "#8a8f9c" }}>
              Approval {approval.id}: {approval.status} at {new Date(approval.createdAt).toLocaleString()}
              {approval.status === "approved" && plan && !task && (
                <button type="button" onClick={executePlan} disabled={loading} style={{ marginLeft: 12, padding: "8px 14px", borderRadius: "8px", border: "1px solid rgba(52,211,153,0.38)", background: "rgba(52,211,153,0.15)", color: "#34D399", fontWeight: 800 }}>
                  Execute approved plan
                </button>
              )}
            </div>
          )}
        </section>
      ))}

      {task && (
        <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
          <h3 style={{ margin: 0, fontSize: "16px" }}>Execution</h3>
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
      )}

      <section style={{ border: "1px solid rgba(255,255,255,0.08)", borderRadius: "12px", background: "rgba(255,255,255,0.02)", padding: "16px", display: "grid", gap: "10px" }}>
        <h3 style={{ margin: 0, fontSize: "16px" }}>Recent</h3>
        <ChatPanel />
      </section>
    </div>
  );
}
