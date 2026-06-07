import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { signIn, signOut } from "@/lib/auth";

const AGENTS = [
  { id: "iris",    letter: "I", name: "Iris",      role: "Email",              color: "var(--iris)",   phase: 3 },
  { id: "kairos",  letter: "K", name: "Kairos",    role: "Calendar & time",    color: "var(--kairos)", phase: 1 },
  { id: "argus",   letter: "A", name: "Argus",     role: "Sentinel & brief",   color: "var(--argus)",  phase: 2 },
  { id: "plutus",  letter: "P", name: "Plutus",    role: "Finance & spend",    color: "var(--plutus)", phase: 5 },
  { id: "athena",  letter: "A", name: "Athena",    role: "Career & jobs",      color: "var(--athena)", phase: 5 },
  { id: "mnemo",   letter: "M", name: "Mnemosyne", role: "Memory",             color: "var(--mnemo)",  phase: 6 },
];

const ENDPOINTS = [
  { method: "GET",    path: "/api/accounts",           status: "live", note: "list linked Google accounts" },
  { method: "DELETE", path: "/api/accounts?id=",       status: "live", note: "disconnect an account" },
  { method: "GET",    path: "/api/accounts/link",       status: "live", note: "start OAuth link flow" },
  { method: "GET",    path: "/api/accounts/callback",   status: "live", note: "OAuth callback handler" },
  { method: "GET",    path: "/api/calendar?days=7",     status: "live", note: "upcoming events (all accounts)" },
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

  const CURRENT_PHASE = 1;

  return (
    <div style={shell}>
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

        <div style={rosterLabel}>THE AGENTS</div>
        {AGENTS.map((a) => {
          const built = a.phase <= CURRENT_PHASE;
          return (
            <div key={a.id} style={{ ...agentRow, opacity: built ? 1 : 0.45 }}>
              <div style={{ ...av, background: `color-mix(in srgb, ${a.color} 16%, transparent)`, color: a.color, position: "relative" }}>
                {a.letter}
                <span style={{ ...dot, background: built ? "var(--plutus)" : "var(--faint)", animation: built ? "blip 2.6s infinite" : "none" }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, lineHeight: 1.1 }}>{a.name}</div>
                <div style={{ fontSize: 10.5, color: "var(--faint)", marginTop: 1 }}>{a.role}</div>
              </div>
              <span style={{ ...phaseChip, marginLeft: "auto", background: built ? "rgba(95,182,163,.13)" : "rgba(255,255,255,.06)", color: built ? "var(--plutus)" : "var(--faint)" }}>
                P{a.phase}
              </span>
            </div>
          );
        })}

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
            PHASE {CURRENT_PHASE} / 7 · BUILD IN PROGRESS
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
              PHASE 1 COMPLETE · MULTI-ACCOUNT OAUTH · CALENDAR AGGREGATION · BUILD CLEAN
            </div>
          </div>

          {session ? (
            <form action={async () => { "use server"; await signOut({ redirectTo: "/" }); }}>
              <button type="submit" style={btnSecondary}>Sign out</button>
            </form>
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
                { phase: 2, label: "Calendar daily brief — Kairos + Argus → daily_briefs", done: false },
                { phase: 3, label: "Gmail read + triage — Iris (no send)", done: false },
                { phase: 4, label: "Approval queue — approval_actions + UI", done: false },
                { phase: 5, label: "Plutus + Athena — finance tracking + job scout", done: false },
                { phase: 6, label: "Model router — data classification + cost panel", done: false },
                { phase: 7, label: "Scheduled automation — morning brief + cron", done: false },
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

      <style>{`
        @keyframes blip { 0%,100%{opacity:1} 50%{opacity:.4} }
      `}</style>
    </div>
  );
}

// ── styles ────────────────────────────────────────────────────────────────────

const shell: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "248px 1fr",
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

const agentRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 11,
  padding: "8px 10px", borderRadius: 12, marginBottom: 1,
};

const av: React.CSSProperties = {
  width: 30, height: 30, borderRadius: 9, flexShrink: 0,
  display: "grid", placeItems: "center",
  fontFamily: "var(--serif)", fontSize: 14, fontWeight: 600,
};

const dot: React.CSSProperties = {
  position: "absolute", right: -2, bottom: -2,
  width: 9, height: 9, borderRadius: "50%",
  border: "2px solid #0a0a0d",
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

const emptyState: React.CSSProperties = {
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 14, padding: "16px 20px",
};

const accountCard: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 12, padding: "12px 14px",
};

const endpointRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 10,
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 10, padding: "9px 14px",
  marginBottom: 4,
};

const methodBadge: React.CSSProperties = {
  fontFamily: "var(--mono)", fontSize: 9, letterSpacing: ".4px",
  padding: "3px 7px", borderRadius: 6, flexShrink: 0,
};

const phaseRow: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 12,
  background: "var(--surface)", border: "1px solid var(--line)",
  borderRadius: 10, padding: "10px 14px",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--hermes)", color: "#1a1407",
  border: "none", borderRadius: 10, padding: "9px 18px",
  fontFamily: "var(--sans)", fontWeight: 600, fontSize: 13,
  cursor: "pointer", whiteSpace: "nowrap",
};

const btnSecondary: React.CSSProperties = {
  background: "var(--surface)", color: "var(--muted)",
  border: "1px solid var(--line-2)", borderRadius: 10, padding: "9px 18px",
  fontFamily: "var(--sans)", fontWeight: 600, fontSize: 13,
  cursor: "pointer", whiteSpace: "nowrap",
};

const linkBtn: React.CSSProperties = {
  display: "inline-block",
  background: "var(--surface-2)", color: "var(--muted)",
  border: "1px solid var(--line)", borderRadius: 8,
  padding: "6px 14px", fontSize: 12, fontFamily: "var(--mono)",
  textDecoration: "none", cursor: "pointer",
};
