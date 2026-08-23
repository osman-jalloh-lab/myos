"use client";

import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";

type ReviewEdit = {
  name: string; description: string; purpose: string; whenToUse: string[]; requiredContext: string[];
  instructions: string; outputFormat: string; outputMustInclude: string[]; outputMustAvoid: string[];
};

type Review = {
  id: string; sessionId: string; projectId: string | null; projectName: string; status: string; trustLabel: string;
  revision: number; confidence: number; quality: { score: number; band: string; status: string; warnings: string[] };
  editable: ReviewEdit; safetyRules: string[]; approvalRequiredFor: string[]; effectiveCapabilitySummary: string;
  evidence: { eventCount: number; summary: string[] }; promotedSkillId: string | null; approvalId: string | null;
};

const panel: CSSProperties = { border: "1px solid rgba(139,123,255,.25)", borderRadius: 14, background: "linear-gradient(145deg, rgba(20,18,35,.94), rgba(9,14,26,.92))", padding: 18, boxShadow: "0 18px 50px rgba(0,0,0,.22)" };
const label: CSSProperties = { color: "#A9A2BE", fontSize: 10, fontWeight: 850, letterSpacing: ".11em", textTransform: "uppercase", marginBottom: 7 };
const input: CSSProperties = { width: "100%", boxSizing: "border-box", border: "1px solid rgba(148,163,184,.24)", borderRadius: 9, background: "rgba(5,8,16,.65)", color: "#F1F4FB", padding: "9px 11px", font: "inherit", fontSize: 13, outline: "none" };
const button = (tone: "primary" | "safe" | "danger" | "quiet"): CSSProperties => ({ borderRadius: 9, padding: "9px 13px", fontSize: 12, fontWeight: 850, cursor: "pointer", border: tone === "primary" ? "1px solid rgba(139,123,255,.55)" : tone === "safe" ? "1px solid rgba(52,211,153,.42)" : tone === "danger" ? "1px solid rgba(248,113,113,.42)" : "1px solid rgba(148,163,184,.25)", background: tone === "primary" ? "rgba(139,123,255,.18)" : tone === "safe" ? "rgba(52,211,153,.11)" : tone === "danger" ? "rgba(248,113,113,.1)" : "rgba(148,163,184,.07)", color: tone === "primary" ? "#C4B5FD" : tone === "safe" ? "#6EE7B7" : tone === "danger" ? "#FCA5A5" : "#CBD5E1" });

function lines(value: string) { return value.split("\n").map((line) => line.trim()).filter(Boolean); }
function confidenceLabel(value: number) { return value >= .8 ? "High" : value >= .6 ? "Medium" : "Low"; }
function trustColor(status: string) { return status.includes("APPROVED") ? "#34D399" : status.includes("REJECTED") ? "#F87171" : status.includes("PENDING") ? "#FBBF24" : "#A78BFA"; }

export default function TeachHermesReviewPanel({ onRegistryChanged }: { onRegistryChanged: () => Promise<void> }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [edit, setEdit] = useState<ReviewEdit | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/command-center/teach?review=1");
    const data = await response.json() as { reviews?: Review[]; error?: string };
    if (!response.ok) throw new Error(data.error ?? "Could not load Teach Hermes drafts.");
    setReviews(data.reviews ?? []);
    setSelectedId((current) => current && data.reviews?.some((review) => review.id === current) ? current : data.reviews?.[0]?.id ?? null);
  }, []);

  useEffect(() => { void load().catch((error) => setMessage(error instanceof Error ? error.message : "Review load failed.")); }, [load]);
  const review = useMemo(() => reviews.find((item) => item.id === selectedId) ?? null, [reviews, selectedId]);
  useEffect(() => { setEdit(review ? structuredClone(review.editable) : null); setMessage(null); }, [review]);

  const action = async (body: Record<string, unknown>) => {
    const response = await fetch("/api/command-center/teach", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await response.json() as Record<string, unknown> & { error?: string };
    if (!response.ok) throw new Error(data.error ?? "Teach Hermes action failed.");
    return data;
  };

  const save = async () => {
    if (!review || !edit) return null;
    setBusy("save"); setMessage(null);
    try {
      const data = await action({ action: "updateReview", draftId: review.id, revision: review.revision, edit });
      await load(); setMessage("Draft saved. Revision incremented; the skill is still not active.");
      return data.review as Review;
    } finally { setBusy(null); }
  };

  const approve = async () => {
    if (!review) return;
    setBusy("approve"); setMessage(null);
    try {
      let current = review;
      if (review.status === "draft" && edit) {
        const data = await action({ action: "updateReview", draftId: review.id, revision: review.revision, edit });
        current = data.review as Review;
      }
      let approvalId = current.approvalId;
      if (current.status === "draft") {
        const requested = await action({ action: "requestApproval", draftId: current.id });
        approvalId = (requested.approval as { id?: string } | null)?.id ?? null;
      }
      if (!approvalId) throw new Error("Normal My OS approval was not created.");
      const response = await fetch(`/api/approvals/${approvalId}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ decision: "approve" }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "Approval failed.");
      await Promise.all([load(), onRegistryChanged()]);
      setMessage("Approved and promoted through the normal My OS skill registry.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Approval failed."); }
    finally { setBusy(null); }
  };

  const reject = async () => {
    if (!review || !window.confirm("Reject this draft? The safe demonstration evidence will be preserved.")) return;
    setBusy("reject"); setMessage(null);
    try { await action({ action: "rejectDraft", draftId: review.id }); await load(); setMessage("Draft rejected. It remains unroutable and its evidence was preserved."); }
    catch (error) { setMessage(error instanceof Error ? error.message : "Rejection failed."); }
    finally { setBusy(null); }
  };

  if (!reviews.length) return <section style={panel}><div style={label}>Teach Hermes</div><div style={{ color: "#CBD5E1", fontSize: 13 }}>No generated teaching drafts are waiting for review.</div></section>;
  if (!review || !edit) return null;
  const editable = review.status === "draft";
  const failureLines = edit.instructions.split(/(?<=[.!?])\s+/).filter((line) => /if|fail|unable|error|missing/i.test(line));

  return (
    <section aria-label="Teach Hermes draft review" style={{ ...panel, display: "grid", gap: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 16, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div><div style={{ ...label, color: "#A99BFF" }}>Teach Hermes · Human Review</div><h2 style={{ margin: 0, fontFamily: "Fraunces, serif", fontSize: 24 }}>What Hermes learned</h2><p style={{ margin: "7px 0 0", color: "#94A3B8", fontSize: 13 }}>Review the reusable workflow before it can join the skill registry.</p></div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ border: `1px solid ${trustColor(review.trustLabel)}66`, background: `${trustColor(review.trustLabel)}16`, color: trustColor(review.trustLabel), borderRadius: 999, padding: "6px 10px", fontSize: 10, fontWeight: 900, letterSpacing: ".08em" }}>{review.trustLabel}</span>
          <select aria-label="Select teaching draft" value={review.id} onChange={(event) => setSelectedId(event.target.value)} style={{ ...input, width: "auto" }}>{reviews.map((item) => <option key={item.id} value={item.id}>{item.editable.name} · r{item.revision}</option>)}</select>
        </div>
      </div>

      {review.status !== "approved" && <div role="note" style={{ borderLeft: "3px solid #A78BFA", background: "rgba(167,139,250,.08)", padding: "10px 12px", color: "#DDD6FE", fontSize: 13 }}><strong>This skill is a draft. Hermes cannot use it yet.</strong></div>}
      {message && <div role="status" style={{ color: message.toLowerCase().includes("fail") || message.toLowerCase().includes("stale") ? "#FCA5A5" : "#93C5FD", fontSize: 12 }}>{message}</div>}

      <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1.45fr) minmax(280px,.75fr)", gap: 14 }}>
        <div style={{ display: "grid", gap: 13 }}>
          <label><div style={label}>Skill name</div><input aria-label="Skill name" disabled={!editable} value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} style={input} /></label>
          <label><div style={label}>Purpose</div><textarea aria-label="Purpose" disabled={!editable} value={edit.purpose} onChange={(e) => setEdit({ ...edit, purpose: e.target.value })} rows={3} style={{ ...input, resize: "vertical" }} /></label>
          <label><div style={label}>Description / when to use</div><textarea aria-label="When to use" disabled={!editable} value={[edit.description, ...edit.whenToUse].join("\n")} onChange={(e) => { const [description = "", ...whenToUse] = lines(e.target.value); setEdit({ ...edit, description, whenToUse }); }} rows={5} style={{ ...input, resize: "vertical" }} /></label>
          <label><div style={label}>Inputs · one per line</div><textarea aria-label="Skill inputs" disabled={!editable} value={edit.requiredContext.join("\n")} onChange={(e) => setEdit({ ...edit, requiredContext: lines(e.target.value) })} rows={4} style={{ ...input, resize: "vertical" }} /></label>
          <label><div style={label}>Steps / instructions / validation</div><textarea aria-label="Skill instructions" disabled={!editable} value={edit.instructions} onChange={(e) => setEdit({ ...edit, instructions: e.target.value })} rows={8} style={{ ...input, resize: "vertical", lineHeight: 1.55 }} /></label>
          <label><div style={label}>What it returns</div><input aria-label="Output description" disabled={!editable} value={edit.outputFormat} onChange={(e) => setEdit({ ...edit, outputFormat: e.target.value })} style={input} /></label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label><div style={label}>How Hermes checks success</div><textarea aria-label="Success checks" disabled={!editable} value={edit.outputMustInclude.join("\n")} onChange={(e) => setEdit({ ...edit, outputMustInclude: lines(e.target.value) })} rows={4} style={{ ...input, resize: "vertical" }} /></label>
            <label><div style={label}>Failure handling</div><textarea aria-label="Failure handling" disabled={!editable} value={failureLines.join("\n") || "Review the instructions and report a safe failure without inventing data."} onChange={(e) => setEdit({ ...edit, instructions: `${edit.instructions.replace(/\s*If .*$/i, "").trim()} ${e.target.value.trim()}`.trim() })} rows={4} style={{ ...input, resize: "vertical" }} /></label>
          </div>
        </div>

        <aside style={{ display: "grid", gap: 12, alignContent: "start" }}>
          <div style={{ ...panel, padding: 14, boxShadow: "none" }}><div style={label}>Confidence & quality</div><div style={{ fontFamily: "Fraunces, serif", fontSize: 22, color: review.quality.status === "needs_review" ? "#FBBF24" : "#34D399" }}>{confidenceLabel(review.confidence)} · {Math.round(review.confidence * 100)}%</div><div style={{ color: "#CBD5E1", fontSize: 12, marginTop: 6 }}>Quality {review.quality.score}/100 · {review.quality.band}</div><div style={{ color: review.quality.status === "needs_review" ? "#FBBF24" : "#34D399", fontSize: 11, fontWeight: 850, marginTop: 5 }}>{review.quality.status.replace(/_/g, " ").toUpperCase()}</div></div>
          <div style={{ ...panel, padding: 14, boxShadow: "none" }}><div style={label}>Approval / safety boundaries</div><ul style={{ paddingLeft: 18, margin: 0, color: "#CBD5E1", fontSize: 12, lineHeight: 1.55 }}>{review.safetyRules.map((rule) => <li key={rule}>{rule}</li>)}{review.approvalRequiredFor.map((rule) => <li key={rule}>Approval required: {rule}</li>)}</ul><div style={{ marginTop: 9, color: "#A9A2BE", fontSize: 11 }}>{review.effectiveCapabilitySummary}</div></div>
          <div style={{ ...panel, padding: 14, boxShadow: "none" }}><div style={label}>Warnings</div>{review.quality.warnings.length ? <ul style={{ paddingLeft: 18, margin: 0, color: "#FCD34D", fontSize: 11, lineHeight: 1.5 }}>{review.quality.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul> : <div style={{ color: "#6EE7B7", fontSize: 12 }}>No generation warnings.</div>}</div>
          <div style={{ ...panel, padding: 14, boxShadow: "none" }}><div style={label}>Source demonstration · {review.evidence.eventCount} events</div><ol style={{ paddingLeft: 18, margin: 0, color: "#CBD5E1", fontSize: 11, lineHeight: 1.6 }}>{review.evidence.summary.map((item) => <li key={item}>{item.replace(/^\d+\.\s*/, "")}</li>)}</ol></div>
        </aside>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", borderTop: "1px solid rgba(148,163,184,.14)", paddingTop: 14 }}>
        <div style={{ color: "#64748B", fontSize: 11 }}>Project: {review.projectName} · Draft revision {review.revision}</div>
        <div style={{ display: "flex", gap: 8 }}>
          {review.status === "draft" && <button disabled={Boolean(busy)} onClick={() => void save().catch((error) => setMessage(error instanceof Error ? error.message : "Save failed."))} style={button("quiet")}>{busy === "save" ? "Saving…" : "Save Draft"}</button>}
          {(review.status === "draft" || review.status === "pending_approval") && <button disabled={Boolean(busy)} onClick={() => void reject()} style={button("danger")}>{busy === "reject" ? "Rejecting…" : "Reject Draft"}</button>}
          {(review.status === "draft" || review.status === "pending_approval") && <button disabled={Boolean(busy)} onClick={() => void approve()} style={button("safe")}>{busy === "approve" ? "Approving…" : "Approve Skill"}</button>}
        </div>
      </div>
    </section>
  );
}
