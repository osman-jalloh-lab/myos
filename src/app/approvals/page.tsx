import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";
import { listApprovals, approveAction, rejectAction, approvalCounts } from "@/lib/approvals";
import type { ApprovalActionView, ApprovalStatus } from "@/lib/approvals";

const STATUS_COLOR: Record<ApprovalStatus, string> = {
  pending: "var(--hermes)",
  approved: "var(--kairos)",
  rejected: "var(--argus)",
  executed: "var(--plutus)",
};

const ACTION_LABEL: Record<string, string> = {
  draft_email: "Draft email reply",
  send_email: "Send email",
  create_event: "Create calendar event",
  create_task: "Create task",
  label_email: "Label email",
  save_memory: "Save memory",
  delete_memory: "Remove stale memory",
  apply_to_job: "Apply to job",
  self_improvement_proposal: "Self-improvement proposal",
};

function summarizePayload(actionType: string, payload: unknown): string {
  if (!payload || typeof payload !== "object") return String(payload ?? "");
  const p = payload as Record<string, unknown>;
  switch (actionType) {
    case "draft_email":
      return `To: ${p.to ?? "?"} · Subject: "${p.subject ?? ""}"`;
    case "create_task":
      return `${p.title ?? "(untitled)"}${p.dueAt ? ` · due ${new Date(String(p.dueAt)).toLocaleDateString()}` : ""}`;
    case "save_memory":
      return String(p.fact ?? "");
    case "delete_memory":
      return `Remove: "${String(p.fact ?? p.memoryId ?? "")}"${p.reason ? ` — ${p.reason}` : ""}`;
    case "create_event":
      return `${p.summary ?? "(untitled)"} · ${p.start ?? ""}`;
    default:
      return JSON.stringify(p).slice(0, 140);
  }
}

export default async function ApprovalsPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const session = await auth();
  if (!session?.user?.id) redirect("/");

  const { status: statusParam } = await searchParams;
  const status =
    statusParam && ["pending", "approved", "rejected", "executed"].includes(statusParam)
      ? (statusParam as ApprovalStatus)
      : undefined;

  const userId = session.user.id;
  const [actions, counts] = await Promise.all([listApprovals(userId, status), approvalCounts(userId)]);

  async function approve(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user?.id) return;
    await approveAction(session.user.id, String(formData.get("id")));
    redirect("/approvals" + (status ? `?status=${status}` : ""));
  }

  async function reject(formData: FormData) {
    "use server";
    const session = await auth();
    if (!session?.user?.id) return;
    await rejectAction(session.user.id, String(formData.get("id")));
    redirect("/approvals" + (status ? `?status=${status}` : ""));
  }

  const tabs: { key: ApprovalStatus | "all"; label: string }[] = [
    { key: "all", label: "All" },
    { key: "pending", label: "Pending" },
    { key: "approved", label: "Approved" },
    { key: "executed", label: "Executed" },
    { key: "rejected", label: "Rejected" },
  ];

  return (
    <div style={shell}>
      <div style={inner}>
        <div style={header}>
          <div>
            <a href="/" style={backLink}>← Hermes</a>
            <h1 style={{ fontFamily: "var(--serif)", fontWeight: 500, fontSize: 24, marginTop: 6 }}>Approval queue</h1>
            <p style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 4, maxWidth: 560, lineHeight: 1.6 }}>
              Every write any agent proposes lands here first. Nothing reaches Gmail, Calendar,
              memory, or a job board without your click — per master-spec section 7.
            </p>
          </div>
          <div style={countRow}>
            {(["pending", "approved", "executed", "rejected"] as ApprovalStatus[]).map((s) => (
              <div key={s} style={countCard}>
                <span style={{ ...countDot, background: STATUS_COLOR[s] }} />
                <span style={{ fontSize: 18, fontWeight: 700, fontFamily: "var(--mono)" }}>{counts[s]}</span>
                <span style={{ fontSize: 10, color: "var(--faint)", textTransform: "uppercase", letterSpacing: ".5px" }}>{s}</span>
              </div>
            ))}
          </div>
        </div>

        <div style={tabRow}>
          {tabs.map((t) => {
            const active = (t.key === "all" && !status) || t.key === status;
            return (
              <a
                key={t.key}
                href={t.key === "all" ? "/approvals" : `/approvals?status=${t.key}`}
                style={{ ...tab, ...(active ? tabActive : {}) }}
              >
                {t.label}
              </a>
            );
          })}
        </div>

        {actions.length === 0 ? (
          <div style={emptyState}>
            <p style={{ fontSize: 13, color: "var(--muted)" }}>
              Nothing here{status ? ` with status "${status}"` : ""}. Agents propose actions as they
              find things worth doing — Iris's email triage, for example, can draft replies that
              wait here for your review.
            </p>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {actions.map((a: ApprovalActionView) => (
              <div key={a.id} style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ ...statusDot, background: STATUS_COLOR[a.status] }} />
                  <span style={{ fontSize: 13, fontWeight: 600 }}>{ACTION_LABEL[a.actionType] ?? a.actionType}</span>
                  <span style={{ ...statusChip, color: STATUS_COLOR[a.status], background: `color-mix(in srgb, ${STATUS_COLOR[a.status]} 15%, transparent)` }}>
                    {a.status}
                  </span>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--faint)", fontFamily: "var(--mono)" }}>
                    {new Date(a.createdAt).toLocaleString()}
                  </span>
                </div>
                <div style={{ fontSize: 12.5, color: "var(--muted)", marginTop: 8, lineHeight: 1.6 }}>
                  {summarizePayload(a.actionType, a.payload)}
                </div>
                {a.executionNote && (
                  <div style={{ fontSize: 11, color: "var(--faint)", marginTop: 6, fontStyle: "italic" }}>
                    {a.executionNote}
                  </div>
                )}
                {a.status === "pending" && (
                  <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                    <form action={approve}>
                      <input type="hidden" name="id" value={a.id} />
                      <button type="submit" style={btnApprove}>Approve</button>
                    </form>
                    <form action={reject}>
                      <input type="hidden" name="id" value={a.id} />
                      <button type="submit" style={btnReject}>Reject</button>
                    </form>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

const shell: React.CSSProperties = {
  minHeight: "100dvh", width: "100vw",
  background: "radial-gradient(1100px 700px at 12% -8%,rgba(216,162,74,.07),transparent 58%), #060608",
  color: "var(--text)", display: "flex", justifyContent: "center",
};

const inner: React.CSSProperties = { width: "100%", maxWidth: 880, padding: "32px 26px 60px" };

const header: React.CSSProperties = {
  display: "flex", alignItems: "flex-start", justifyContent: "space-between",
  gap: 24, marginBottom: 22, flexWrap: "wrap",
};

const backLink: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 11, color: "var(--faint)", textDecoration: "none",
};

const countRow: React.CSSProperties = { display: "flex", gap: 8 };

const countCard: React.CSSProperties = {
  display: "flex", flexDirection: "column", alignItems: "center", gap: 2,
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 12, padding: "10px 16px", minWidth: 64,
};

const countDot: React.CSSProperties = { width: 6, height: 6, borderRadius: "50%", marginBottom: 4 };

const tabRow: React.CSSProperties = { display: "flex", gap: 6, marginBottom: 18 };

const tab: React.CSSProperties = {
  fontSize: 12, fontFamily: "var(--mono)", padding: "6px 14px", borderRadius: 8,
  color: "var(--muted)", textDecoration: "none", border: "1px solid var(--line)",
  background: "var(--surface)",
};

const tabActive: React.CSSProperties = {
  color: "var(--text)", background: "var(--surface-2)", borderColor: "var(--line-2)",
};

const emptyState: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 14, padding: "20px 22px",
};

const card: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 14, padding: "16px 18px",
};

const statusDot: React.CSSProperties = { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 };

const statusChip: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".4px",
  textTransform: "uppercase", padding: "2px 8px", borderRadius: 6,
};

const btnApprove: React.CSSProperties = {
  background: "var(--kairos)", color: "#16210a", border: "none",
  borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 12.5,
  cursor: "pointer", fontFamily: "var(--sans)",
};

const btnReject: React.CSSProperties = {
  background: "transparent", color: "var(--argus)", border: "1px solid rgba(221,122,108,.35)",
  borderRadius: 9, padding: "8px 16px", fontWeight: 600, fontSize: 12.5,
  cursor: "pointer", fontFamily: "var(--sans)",
};
