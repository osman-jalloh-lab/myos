import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { signIn, signOut } from "@/lib/auth";
import { approvalCounts } from "@/lib/approvals";
import { plutusReport } from "@/agents/plutus";
import { appTrackerSummary } from "@/agents/athena";
import { readMemory } from "@/agents/mnemosyne";
import ChatPanel from "@/components/ChatPanel";
import AgentRoster from "@/components/AgentRoster";
import BriefingSidebar from "@/components/BriefingSidebar";

const AGENTS = [
  { id: "iris",    letter: "I", name: "Iris",      role: "Email",              color: "var(--iris)",   phase: 3 },
  { id: "kairos",  letter: "K", name: "Kairos",    role: "Calendar & time",    color: "var(--kairos)", phase: 1 },
  { id: "argus",   letter: "A", name: "Argus",     role: "Sentinel & brief",   color: "var(--argus)",  phase: 2 },
  { id: "plutus",  letter: "P", name: "Plutus",    role: "Finance & spend",    color: "var(--plutus)", phase: 5 },
  { id: "athena",  letter: "A", name: "Athena",    role: "Career & jobs",      color: "var(--athena)", phase: 5 },
  { id: "mnemo",   letter: "M", name: "Mnemosyne", role: "Memory",             color: "var(--mnemo)",  phase: 6 },
  { id: "sophos",  letter: "S", name: "Sophos",    role: "Skills & capability scout", color: "var(--sophos)", phase: 8 },
];

const ENDPOINTS = [
  { method: "GET",    path: "/api/accounts",           status: "live", note: "list linked Google accounts" },
  { method: "DELETE", path: "/api/accounts?id=",       status: "live", note: "disconnect an account" },
  { method: "GET",    path: "/api/accounts/link",       status: "live", note: "start OAuth link flow" },
  { method: "GET",    path: "/api/accounts/callback",   status: "live", note: "OAuth callback handler" },
  { method: "GET",    path: "/api/calendar?days=7",     status: "live", note: "upcoming events (all accounts)" },
  { method: "GET",    path: "/api/email",               status: "live", note: "Iris inbox triage (read-only)" },
  { method: "GET",    path: "/api/brief",               status: "live", note: "Argus morning brief (Groq-synthesized)" },
  { method: "GET",    path: "/api/approvals",           status: "live", note: "list approval-queue actions + counts" },
  { method: "POST",   path: "/api/approvals/:id",       status: "live", note: "approve or reject a proposed write" },
  { method: "GET",    path: "/api/finance",             status: "live", note: "Plutus finance + LLM-cost report (read-only)" },
  { method: "GET",    path: "/api/jobs",                status: "live", note: "Athena tracked roles + pipeline counts" },
  { method: "POST",   path: "/api/jobs",                status: "live", note: "log a role for Athena to track/score" },
  { method: "POST",   path: "/api/jobs/:id",            status: "live", note: "move a role through the pipeline" },
  { method: "GET",    path: "/api/github-scout?q=",     status: "live", note: "Athena public-repo scout (read-only)" },
  { method: "GET",    path: "/api/memory",              status: "live", note: "Mnemosyne approved memory + context cards" },
  { method: "POST",   path: "/api/memory",              status: "live", note: "propose a fact (queues save_memory approval)" },
  { method: "GET",    path: "/api/chat?agent=",         status: "live", note: "chat history — general Hermes thread, or a private agent thread" },
  { method: "POST",   path: "/api/chat",                status: "live", note: "send a message — routes to Hermes or a named agent, replies live" },
  { method: "GET",    path: "/api/tasks?agent=&status=",status: "live", note: "list tasks — the CEO-layer assignment + delegation audit trail" },
  { method: "POST",   path: "/api/tasks",               status: "live", note: "create + assign a task to an agent (or say \"ask Athena to…\" in chat)" },
  { method: "POST",   path: "/api/telegram/webhook",    status: "live", note: "Telegram bridge — owner-only, same routing core as dashboard chat" },
  { method: "POST",   path: "/api/telegram/setup",      status: "live", note: "registers the webhook URL with Telegram (one-time, session-gated)" },
  { method: "POST",   path: "/api/auth/callback/google",status: "live", note: "NextAuth primary sign-in" },
];

export default async function Home() {
  const session = await auth();
  const userId = session?.user?.id;

  const accounts = userId
    ? await prisma.googleAccount.findMany({
        where: { userId },
        select: { id: true, email: true, label: true, isDefault: true },
        orderBy: { createdAt: "asc" },
      })
    : [];

  const counts = userId ? await approvalCounts(userId) : { pending: 0, approved: 0, rejected: 0, executed: 0 };
  const plutus = userId ? await plutusReport(userId) : null;
  const athena = userId ? await appTrackerSummary(userId) : null;
  const memories = userId ? await readMemory(userId) : [];
  const sophosBrief = userId
    ? await prisma.agentRun.findFirst({ where: { agentName: "sophos" }, orderBy: { createdAt: "desc" } })
    : null;

  const CURRENT_PHASE = 8;

  return (
    <div style={{ ...shell, gridTemplateColumns: userId ? "248px 1fr minmax(0, 280px)" : "248px 1fr" }}>
      {/* ── SIDEBAR ── */}
      <aside style={side}>
        <div style={brand}>
          <svg width="34" height="34" viewBox="0 0 32 32" fill="none" style={{ flexShrink: 0 }}>
            <circle cx="16" cy="16" r="15" stroke="rgba(216,162,74,.4)" />
            <path d="M16 6v20M16 9c-3 0-5 2-5 4s2 3 5 3 5 1 5 3-2 4-5 4" stroke="#d8a24a" strokeWidth="1.6" strokeLinecap="round" />
            <path d="M9 8c2 1.5 5 1.5 7 0M16 8c2 1.5 5 1.5 7 0" stroke="#d8a24a" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          <div>
            <h1 style={{ fontFamily: "var(--serif)", fontWeight: 500, fontSize: 20, lineHeight: 1 }}>Hermes</h1>
            <span style={{ fontFamily: "var(--mono)", fontSize: 9, letterSpacing: "1.5px", color: "var(--faint)" }}>PERSONAL OS</span>
          </div>
        </div>

        <div style={rosterLabel}>THE AGENTS · click to chat privately</div>
        <AgentRoster agents={AGENTS} currentPhase={CURRENT_PHASE} />

        <div style={sideFooter}>
          <div style={orchRow}>
            <div style={{ ...av, background: "rgba(216,162,74,.18)", color: "var(--hermes)" }}>H</div>
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--hermes)" }}>Hermes</div>
              <div style={{ fontSize: 10, color: "var(--muted)" }}>Orchestrator · routes & gates</div>
            </div>
          </div>
          <div style={hostChip}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--plutus)", flexShrink: 0 }} />
            PHASE {CURRENT_PHASE} / 8 · ALL AGENTS BUILT
          </div>
        </div>
      </aside>

      {/* ── MAIN ── */}
      <main style={mainArea}>
        {/* topbar */}
        <div style={topbar}>
          <div>
            <h2 style={{ fontFamily: "var(--serif)", fontWeight: 500, fontSize: 22, lineHeight: 1.05 }}>
              {session ? `Good to go, ${session.user.name?.split(" ")[0] ?? "Osman"}.` : "Hermes OS — Phase 1 ready."}
            </h2>
            <div style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--faint)", letterSpacing: ".6px", marginTop: 5 }}>
              8 AGENTS LIVE · PER-AGENT CHAT + TASK ASSIGNMENT · APPROVAL QUEUE GATES EVERY WRITE · BUILD CLEAN
            </div>
          </div>

          {session ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <a href="/command-center" style={{ ...approvalLink, background: "linear-gradient(180deg, #6F4FE0, #5B2EC8)", borderColor: "rgba(139,92,246,.5)" }}>
                Command Center
              </a>
              <a href="/approvals" style={approvalLink}>
                Approval queue
                {counts.pending > 0 && <span style={pendingBadge}>{counts.pending}</span>}
              </a>
              <form action={async () => { "use server"; await signOut({ redirectTo: "/" }); }}>
                <button type="submit" style={btnSecondary}>Sign out</button>
              </form>
            </div>
          ) : (
            <form action={async () => { "use server"; await signIn("google", { redirectTo: "/" }); }}>
              <button type="submit" style={btnPrimary}>Connect Google</button>
            </form>
          )}
        </div>

        {/* scroll content */}
        <div style={scroll}>

          {/* auth / accounts section */}
          <section style={{ marginBottom: 24 }}>
            <div style={sectionHeader}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>
                {session ? "Linked accounts" : "Sign in to start"}
              </span>
              <span style={ownerChip}><span style={{ ...odot, background: "var(--kairos)" }} />Kairos + Iris use these</span>
            </div>

            {!session && (
              <div style={emptyState}>
                <p style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.6 }}>
                  Sign in with Google to link your first account. Hermes stores tokens encrypted.<br />
                  Add up to 3 accounts (Work · UT · Personal) — all calendar data aggregates automatically.
                </p>
              </div>
            )}

            {accounts.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {accounts.map((acc) => (
                  <div key={acc.id} style={accountCard}>
                    <div style={{ width: 32, height: 32, borderRadius: 9, background: "rgba(121,194,201,.16)", color: "var(--iris)", display: "grid", placeItems: "center", fontFamily: "var(--serif)", fontWeight: 600, fontSize: 14, flexShrink: 0 }}>G</div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{acc.email}</div>
                      <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 1, fontFamily: "var(--mono)" }}>{acc.label}{acc.isDefault ? " · default" : ""}</div>
                    </div>
                    <span style={{ ...phaseChip, background: "rgba(95,182,163,.13)", color: "var(--plutus)" }}>active</span>
                  </div>
                ))}

                {accounts.length < 3 && (
                  <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
                    {(["Work", "UT", "Personal"] as const)
                      .filter((l) => !accounts.some((a) => a.label === l))
                      .map((label) => (
                        <a key={label} href={`/api/accounts/link?label=${label}`} style={linkBtn}>
                          + {label}
                        </a>
                      ))}
                  </div>
                )}
              </div>
            )}
          </section>

          {/* Plutus — finance & spend */}
          {plutus && (
            <section style={{ marginBottom: 24 }}>
              <div style={sectionHeader}>
                <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>Plutus — finance & spend</span>
                <span style={ownerChip}><span style={{ ...odot, background: "var(--plutus)" }} />read-only · never moves money</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 8, marginBottom: 8 }}>
                <div style={statCard}>
                  <div style={statLabel}>This month — net</div>
                  <div style={{ ...statValue, color: plutus.finance.net >= 0 ? "var(--kairos)" : "var(--argus)" }}>
                    {plutus.finance.net >= 0 ? "+" : "-"}${Math.abs(plutus.finance.net).toFixed(2)}
                  </div>
                  <div style={statSub}>income ${plutus.finance.income.toFixed(2)} · spend ${plutus.finance.expenses.toFixed(2)}</div>
                </div>

                <div style={statCard}>
                  <div style={statLabel}>LLM spend vs. cap</div>
                  <div style={{ ...statValue, color: plutus.budget.level === "over" ? "var(--argus)" : plutus.budget.level === "warning" ? "var(--hermes)" : "var(--kairos)" }}>
                    ${plutus.budget.spentUsd.toFixed(4)} <span style={{ fontSize: 12, color: "var(--faint)" }}>/ ${plutus.budget.capUsd.toFixed(2)}</span>
                  </div>
                  <div style={statSub}>{plutus.budget.percentUsed.toFixed(1)}% used · {plutus.budget.level}</div>
                </div>

                <div style={statCard}>
                  <div style={statLabel}>Model calls logged</div>
                  <div style={statValue}>{plutus.costs.totalCalls}</div>
                  <div style={statSub}>
                    {plutus.costs.byProvider.length > 0
                      ? plutus.costs.byProvider.map((p) => `${p.provider}: ${p.calls}`).join(" · ")
                      : "no calls logged this month"}
                  </div>
                </div>

                <div style={statCard}>
                  <div style={statLabel}>Debt payoff progress</div>
                  <div style={statValue}>
                    {plutus.debt.percentPaidOff !== null ? `${plutus.debt.percentPaidOff.toFixed(1)}%` : "—"}
                  </div>
                  <div style={statSub}>
                    {plutus.debt.currentBalance !== null
                      ? `balance $${plutus.debt.currentBalance.toFixed(2)} · paid $${plutus.debt.totalPaid.toFixed(2)}`
                      : "no debt entries logged yet"}
                  </div>
                </div>
              </div>

              {plutus.finance.byCategory.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {plutus.finance.byCategory.slice(0, 5).map((c) => (
                    <div key={c.category} style={endpointRow}>
                      <span style={{ fontSize: 12, color: "var(--text)", flex: 1 }}>{c.category}</span>
                      <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--muted)" }}>${c.total.toFixed(2)}</span>
                    </div>
                  ))}
                </div>
              )}

              {plutus.finance.byCategory.length === 0 && plutus.finance.income === 0 && plutus.finance.expenses === 0 && (
                <div style={emptyState}>
                  <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
                    No finance entries logged yet this month — Plutus reads from a manual ledger
                    Osman keeps (income, expenses, debt balances). The LLM-cost panel above is
                    already live from real Groq usage logged by Argus.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* Athena — career & jobs */}
          {athena && (
            <section style={{ marginBottom: 24 }}>
              <div style={sectionHeader}>
                <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>Athena — career & jobs</span>
                <span style={ownerChip}><span style={{ ...odot, background: "var(--athena)" }} />drafts only · never applies</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 8, marginBottom: 8 }}>
                {([
                  ["interested", "Interested"],
                  ["applied", "Applied"],
                  ["interview", "Interview"],
                  ["offer", "Offer"],
                  ["rejected", "Rejected"],
                ] as [keyof typeof athena.byStatus, string][]).map(([key, label]) => (
                  <div key={key} style={statCard}>
                    <div style={statLabel}>{label}</div>
                    <div style={statValue}>{athena.byStatus[key]}</div>
                  </div>
                ))}
              </div>

              {athena.recent.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {athena.recent.map((j) => (
                    <div key={j.id} style={endpointRow}>
                      <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {j.title} <span style={{ color: "var(--faint)", fontWeight: 400 }}>· {j.company}</span>
                      </span>
                      {j.fitScore !== null && (
                        <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: "var(--athena)" }}>fit {j.fitScore}</span>
                      )}
                      <span style={{ ...phaseChip, background: "rgba(186,148,212,.13)", color: "var(--athena)" }}>{j.status}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={emptyState}>
                  <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
                    No roles tracked yet. Log one via <code style={{ fontFamily: "var(--mono)" }}>POST /api/jobs</code> —
                    Athena will score fit, surface skill gaps, and draft a tailored resume and cover
                    letter for review. Applying always waits in the approval queue.
                  </p>
                </div>
              )}
            </section>
          )}

          {/* Mnemosyne — memory */}
          <section style={{ marginBottom: 24 }}>
            <div style={sectionHeader}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>Mnemosyne — memory</span>
              <span style={ownerChip}><span style={{ ...odot, background: "var(--mnemo)" }} />suggests only · approval-gated writes</span>
            </div>

            {memories.length > 0 ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                {memories.slice(0, 6).map((m) => (
                  <div key={m.id} style={endpointRow}>
                    <span style={{ fontSize: 12, color: "var(--text)", flex: 1 }}>{m.fact}</span>
                    {m.source && (
                      <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--faint)" }}>{m.source}</span>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <div style={emptyState}>
                <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
                  No approved memories yet. Mnemosyne never writes directly — every suggestion
                  (<code style={{ fontFamily: "var(--mono)" }}>POST /api/memory</code>) queues a
                  <code style={{ fontFamily: "var(--mono)" }}> save_memory</code> approval, and
                  stale-cleanup queues <code style={{ fontFamily: "var(--mono)" }}>delete_memory</code> proposals.
                  Both land in the queue at <a href="/approvals" style={{ color: "var(--mnemo)" }}>/approvals</a> for review.
                </p>
              </div>
            )}
          </section>

          {/* Sophos — skills & capability scout */}
          <section style={{ marginBottom: 24 }}>
            <div style={sectionHeader}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>Sophos — skills & capability scout</span>
              <span style={ownerChip}><span style={{ ...odot, background: "var(--sophos)" }} />read-only watcher · digests only, never installs</span>
            </div>

            {sophosBrief ? (
              <div style={{ ...accountCard, alignItems: "flex-start" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--sophos)", flexShrink: 0, marginTop: 6 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 4 }}>
                    <span style={{ fontSize: 12.5, fontWeight: 500, color: "var(--text)" }}>Latest skill brief</span>
                    <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: "var(--faint)" }}>
                      {sophosBrief.createdAt.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  </div>
                  <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6, margin: 0 }}>{sophosBrief.outputSummary}</p>
                </div>
              </div>
            ) : (
              <div style={emptyState}>
                <p style={{ fontSize: 12.5, color: "var(--muted)", lineHeight: 1.6 }}>
                  No skill brief yet — <code style={{ fontFamily: "var(--mono)" }}>cron/skills-scout</code> runs
                  weekly: it watches Claude/Anthropic release notes, scouts GitHub for capability/tooling repos,
                  and surfaces relevant videos, then synthesizes it all into a short "what's worth your attention
                  and why" digest. Sophos never installs or applies anything — a digest is the entire output. Ask
                  Hermes <span style={{ fontStyle: "italic" }}>"what's new in skills?"</span> any time to pull the latest.
                </p>
              </div>
            )}
          </section>

          {/* Talk to Hermes */}
          <section style={{ marginBottom: 24 }}>
            <div style={sectionHeader}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>Talk to Hermes</span>
              <span style={ownerChip}><span style={{ ...odot, background: "var(--hermes)" }} />routes to agents · gates writes through /approvals</span>
            </div>
            {userId ? (
              <ChatPanel />
            ) : (
              <div style={emptyState}>
                <p style={{ fontSize: 12.5, color: "var(--muted)" }}>Sign in to talk to Hermes.</p>
              </div>
            )}
          </section>

          {/* API endpoints built */}
          <section style={{ marginBottom: 24 }}>
            <div style={sectionHeader}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>Live endpoints</span>
              <span style={ownerChip}><span style={{ ...odot, background: "var(--hermes)" }} />Phase 1 routes</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {ENDPOINTS.map((ep, i) => (
                <div key={i} style={endpointRow}>
                  <span style={{ ...methodBadge, background: ep.method === "GET" ? "rgba(168,192,122,.13)" : ep.method === "DELETE" ? "rgba(221,122,108,.13)" : "rgba(216,162,74,.13)", color: ep.method === "GET" ? "var(--kairos)" : ep.method === "DELETE" ? "var(--argus)" : "var(--hermes)" }}>{ep.method}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--text)", flex: 1 }}>{ep.path}</span>
                  <span style={{ fontSize: 11, color: "var(--muted)" }}>{ep.note}</span>
                  <span style={{ ...phaseChip, background: "rgba(95,182,163,.13)", color: "var(--plutus)" }}>live</span>
                </div>
              ))}
            </div>
          </section>

          {/* build status */}
          <section>
            <div style={sectionHeader}>
              <span style={{ fontFamily: "var(--serif)", fontSize: 15, fontWeight: 500 }}>Build status</span>
              <span style={ownerChip}><span style={{ ...odot, background: "var(--argus)" }} />7 phases total</span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {[
                { phase: 1, label: "Multi-account Google OAuth + calendar aggregation", done: true },
                { phase: 2, label: "Calendar daily brief — Kairos + Argus → daily_briefs", done: true },
                { phase: 3, label: "Gmail read + triage — Iris (no send)", done: true },
                { phase: 4, label: "Approval queue — approval_actions + UI", done: true },
                { phase: 5, label: "Plutus + Athena — finance tracking + job scout", done: true },
                { phase: 6, label: "Model router — data classification + cost panel", done: true },
                { phase: 7, label: "Scheduled automation — morning brief + cron", done: true },
                { phase: 8, label: "Telegram bridge + dashboard chat + live job-board search + Sophos", done: true },
              ].map((p) => (
                <div key={p.phase} style={{ ...phaseRow, opacity: p.done ? 1 : 0.5 }}>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10.5, color: p.done ? "var(--plutus)" : "var(--faint)", width: 24, flexShrink: 0 }}>P{p.phase}</span>
                  <span style={{ flex: 1, fontSize: 12.5 }}>{p.label}</span>
                  <span style={{ fontFamily: "var(--mono)", fontSize: 10, color: p.done ? "var(--plutus)" : "var(--faint)" }}>{p.done ? "done" : "pending"}</span>
                </div>
              ))}
            </div>
          </section>

        </div>
      </main>

      {userId && <BriefingSidebar userId={userId} />}

      <style>{`
        @keyframes blip { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const shell: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "248px 1fr minmax(0, 280px)",
  width: "100vw",
  height: "100dvh",
  background: "radial-gradient(1100px 700px at 12% -8%,rgba(216,162,74,.09),transparent 58%), radial-gradient(900px 600px at 110% 115%,rgba(95,182,163,.05),transparent 55%), #060608",
  overflow: "hidden",
};

const side: React.CSSProperties = {
  background: "linear-gradient(180deg,#0c0c10,#0a0a0d)",
  borderRight: "1px solid var(--line)",
  display: "flex",
  flexDirection: "column",
  padding: "20px 14px",
  overflow: "hidden",
};

const brand: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 11,
  padding: "4px 6px 18px",
  borderBottom: "1px solid var(--line)",
  marginBottom: 4,
};

const rosterLabel: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: "1.6px",
  color: "var(--faint)", margin: "14px 8px 8px",
};

const av: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 9, flexShrink: 0,
  display: "grid", placeItems: "center",
  fontFamily: "var(--serif)", fontSize: 14, fontWeight: 600,
};

const phaseChip: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".4px",
  padding: "2px 7px", borderRadius: 6,
};

const sideFooter: React.CSSProperties = {
  marginTop: "auto", paddingTop: 14,
  borderTop: "1px solid var(--line)",
};

const orchRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  padding: "9px 10px", borderRadius: 12,
  background: "linear-gradient(135deg,rgba(216,162,74,.14),transparent)",
  border: "1px solid rgba(216,162,74,.22)",
};

const hostChip: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 7,
  fontFamily: "var(--mono)", fontSize: 9.5, color: "var(--plutus)",
  marginTop: 11, padding: "0 6px",
};

const mainArea: React.CSSProperties = {
  display: "flex", flexDirection: "column", minWidth: 0,
};

const topbar: React.CSSProperties = {
  padding: "20px 26px 16px",
  borderBottom: "1px solid var(--line)",
  display: "flex", alignItems: "flex-start",
  justifyContent: "space-between", gap: 16,
};

const scroll: React.CSSProperties = {
  flex: 1, overflowY: "auto", padding: "22px 26px 32px",
};

const sectionHeader: React.CSSProperties = {
  display: "flex", alignItems: "center",
  justifyContent: "space-between", marginBottom: 11,
};

const ownerChip: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 6,
  fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".5px",
  textTransform: "uppercase", color: "var(--faint)",
};

const odot: React.CSSProperties = { width: 8, height: 8, borderRadius: 3 };

const glassCard: React.CSSProperties = {
  background: "var(--glass-bg)",
  backdropFilter: "var(--glass-blur)",
  WebkitBackdropFilter: "var(--glass-blur)",
  border: "1px solid var(--glass-border)",
  boxShadow: "var(--glass-shadow)",
};

const emptyState: React.CSSProperties = {
  ...glassCard,
  borderRadius: 14, padding: "16px 20px",
};

const accountCard: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  ...glassCard,
  borderRadius: 12, padding: "12px 14px",
};

const endpointRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  ...glassCard,
  borderRadius: 10, padding: "9px 14px",
  marginBottom: 4,
};

const methodBadge: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".4px",
  padding: "3px 7px", borderRadius: 6, flexShrink: 0,
};

const phaseRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  ...glassCard,
  borderRadius: 10, padding: "10px 14px",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--hermes)", color: "#1a1407",
  border: "none", borderRadius: 10, padding: "9px 18px",
  fontFamily: "var(--sans)", fontWeight: 600, fontSize: 13,
  cursor: "pointer", whiteSpace: "nowrap",
};

const approvalLink: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", gap: 7,
  background: "var(--surface)", color: "var(--text)",
  border: "1px solid var(--line-2)", borderRadius: 10, padding: "9px 16px",
  fontFamily: "var(--sans)", fontWeight: 600, fontSize: 13,
  textDecoration: "none", whiteSpace: "nowrap",
};

const pendingBadge: React.CSSProperties = {
  display: "inline-flex", alignItems: "center", justifyContent: "center",
  minWidth: 18, height: 18, borderRadius: 9, padding: "0 5px",
  background: "var(--hermes)", color: "#1a1407",
  fontFamily: "var(--mono)", fontSize: 10, fontWeight: 700,
};

const btnSecondary: React.CSSProperties = {
  background: "var(--surface)", color: "var(--muted)",
  border: "1px solid var(--line-2)", borderRadius: 10, padding: "9px 18px",
  fontFamily: "var(--sans)", fontWeight: 600, fontSize: 13,
  cursor: "pointer", whiteSpace: "nowrap",
};

const statCard: React.CSSProperties = {
  ...glassCard,
  borderRadius: 12, padding: "12px 14px",
  display: "flex", flexDirection: "column", gap: 3,
};

const statLabel: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9.5, letterSpacing: ".5px",
  textTransform: "uppercase", color: "var(--faint)",
};

const statValue: React.CSSProperties = {
  fontFamily: "var(--serif)", fontSize: 19, fontWeight: 600, color: "var(--text)",
};

const statSub: React.CSSProperties = {
  fontSize: 10.5, color: "var(--muted)",
};

const linkBtn: React.CSSProperties = {
  display: "inline-block",
  background: "var(--surface-2)", color: "var(--muted)",
  border: "1px solid var(--line)", borderRadius: 8,
  padding: "6px 14px", fontSize: 12, fontFamily: "var(--mono)",
  textDecoration: "none", cursor: "pointer",
};
