import Link from "next/link";

const statuses = ["Planning", "Building", "Complete"];

export default function ProjectControlSmokePage() {
  return (
    <main style={{ minHeight: "100vh", background: "#07110e", color: "#f3f7f2", padding: "clamp(24px, 7vw, 80px)", fontFamily: "Georgia, 'Times New Roman', serif" }}>
      <div style={{ maxWidth: 980, margin: "0 auto" }}>
        <p style={{ color: "#a8d5ba", fontFamily: "ui-monospace, monospace", fontWeight: 700, letterSpacing: ".14em", textTransform: "uppercase" }}>Hermes delivery signal</p>
        <h1 style={{ fontSize: "clamp(2.5rem, 8vw, 5.75rem)", lineHeight: .92, margin: "18px 0 42px", maxWidth: 820 }}>Project Control Smoke Test</h1>
        <section aria-label="Project statuses" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 16 }}>
          {statuses.map((status, index) => (
            <article key={status} style={{ border: "1px solid #36594a", borderRadius: 4, padding: "24px 22px", background: index === 1 ? "#173f31" : "#0d2019" }}>
              <span style={{ color: "#8eb7a0", fontFamily: "ui-monospace, monospace" }}>0{index + 1}</span>
              <h2 style={{ margin: "42px 0 0", fontSize: "clamp(1.35rem, 3vw, 2rem)" }}>{status}</h2>
            </article>
          ))}
        </section>
        <section aria-label="Overall progress" style={{ margin: "44px 0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 20, marginBottom: 12, fontFamily: "ui-monospace, monospace" }}><span>Overall progress</span><strong>60%</strong></div>
          <div role="progressbar" aria-label="Overall progress" aria-valuenow={60} aria-valuemin={0} aria-valuemax={100} style={{ height: 14, border: "1px solid #4d7663", background: "#0d2019", overflow: "hidden" }}>
            <div style={{ width: "60%", height: "100%", background: "#d8f28f" }} />
          </div>
        </section>
        <Link href="/command-center" style={{ color: "#d8f28f", fontFamily: "ui-monospace, monospace", fontWeight: 700, textUnderlineOffset: 6 }}>Back to Command Center</Link>
      </div>
    </main>
  );
}
