import Link from "next/link";

const projects = [
  { name: "Discovery", status: "Complete", progress: 100 },
  { name: "Implementation", status: "In progress", progress: 68 },
  { name: "Validation", status: "Queued", progress: 20 },
];

export default function ProjectControlDemoPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#07111f", color: "#f8fafc", padding: "clamp(24px, 6vw, 72px)" }}>
      <div style={{ maxWidth: 1040, margin: "0 auto" }}>
        <p style={{ color: "#7dd3fc", fontWeight: 700, letterSpacing: ".12em", textTransform: "uppercase" }}>Project control</p>
        <h1 style={{ fontSize: "clamp(2.25rem, 7vw, 5rem)", lineHeight: 1, margin: "12px 0 18px" }}>Work, made visible.</h1>
        <p style={{ color: "#bac7d8", maxWidth: 620, fontSize: "1.1rem" }}>A live view of delivery from first decision through verified completion.</p>
        <section aria-label="Project statuses" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 16, margin: "42px 0" }}>
          {projects.map((project) => (
            <article key={project.name} style={{ border: "1px solid #28415e", borderRadius: 18, padding: 22, background: "#0d1b2d" }}>
              <p style={{ color: "#93a7bf", margin: 0 }}>{project.status}</p>
              <h2 style={{ margin: "10px 0 24px" }}>{project.name}</h2>
              <div role="progressbar" aria-label={`${project.name} progress`} aria-valuenow={project.progress} aria-valuemin={0} aria-valuemax={100} style={{ height: 10, borderRadius: 99, background: "#21344a", overflow: "hidden" }}>
                <div style={{ width: `${project.progress}%`, height: "100%", background: "#38bdf8" }} />
              </div>
              <p style={{ marginBottom: 0 }}>{project.progress}%</p>
            </article>
          ))}
        </section>
        <Link href="/command-center" style={{ color: "#7dd3fc", fontWeight: 700, textUnderlineOffset: 5 }}>Back to Command Center</Link>
      </div>
    </main>
  );
}
