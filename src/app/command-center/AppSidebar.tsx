"use client";

export type CommandCenterDestination =
  | "overview" | "chat" | "agents" | "runs" | "projects" | "approvals"
  | "builder" | "live" | "skills" | "teach" | "health" | "logs" | "memory" | "knowledge" | "troubleshooting";

type NavItem = { id: CommandCenterDestination; label: string; icon: string };

export const commandCenterNavigation: Array<{ label: string; items: NavItem[] }> = [
  { label: "Command", items: [
    { id: "overview", label: "Overview", icon: "⌂" },
    { id: "chat", label: "Ask Hermes", icon: "✦" },
    { id: "agents", label: "Agent Network", icon: "◈" },
    { id: "runs", label: "Tasks", icon: "✓" },
    { id: "projects", label: "Projects", icon: "◇" },
    { id: "approvals", label: "Approvals", icon: "◎" },
  ] },
  { label: "Tools", items: [
    { id: "builder", label: "Builder Office", icon: "⌁" },
    { id: "live", label: "Live Console", icon: ">_" },
    { id: "skills", label: "Skills", icon: "◆" },
    { id: "teach", label: "Teach Hermes", icon: "+" },
  ] },
  { label: "System", items: [
    { id: "health", label: "Health & Integrations", icon: "◉" },
    { id: "memory", label: "Memory", icon: "◌" },
    { id: "knowledge", label: "Knowledge Graph", icon: "⌘" },
    { id: "troubleshooting", label: "Problems & Solutions", icon: "◇" },
    { id: "logs", label: "Audit & Activity", icon: "≡" },
  ] },
];

export default function AppSidebar({ active, pendingApprovals, systemStatus, systemLabel, userName, open, onClose, onNavigate }: {
  active: CommandCenterDestination;
  pendingApprovals: number;
  systemStatus: "healthy" | "warning";
  systemLabel: string;
  userName: string;
  open: boolean;
  onClose: () => void;
  onNavigate: (destination: CommandCenterDestination) => void;
}) {
  return <>
    {open && <button className="os-sidebar-scrim" aria-label="Close navigation" onClick={onClose} />}
    <aside className={`os-sidebar${open ? " is-open" : ""}`} aria-label="My OS navigation">
      <div className="os-brand">
        <span className="os-brand-mark" aria-hidden="true">H</span>
        <span><strong>HERMES OS</strong><small>Agentic command center</small></span>
        <button className="os-sidebar-close" onClick={onClose} aria-label="Close navigation">×</button>
      </div>
      <nav className="os-nav" aria-label="Command Center navigation">
        {commandCenterNavigation.map((group) => <section key={group.label} className="os-nav-group" aria-labelledby={`nav-${group.label}`}>
          <h2 id={`nav-${group.label}`}>{group.label}</h2>
          {group.items.map((item) => {
            const selected = active === item.id;
            const badge = item.id === "approvals" ? pendingApprovals : 0;
            return <button key={`${group.label}-${item.label}`} className={`os-nav-item${selected ? " is-active" : ""}`} aria-current={selected ? "page" : undefined} onClick={() => { onNavigate(item.id); onClose(); }}>
              <span className="os-nav-icon" aria-hidden="true">{item.icon}</span><span>{item.label}</span>
              {Boolean(badge) && <span className="os-nav-badge" aria-label={`${badge} pending`}>{badge}</span>}
            </button>;
          })}
        </section>)}
      </nav>
      <div className="os-sidebar-user"><span className="os-user-avatar" aria-hidden="true">{userName.slice(0, 2).toUpperCase()}</span><span><strong>{userName}</strong><small>Authenticated workspace</small></span></div>
      <div className="os-sidebar-status"><span className={`os-status-dot ${systemStatus === "healthy" ? "is-live" : "is-warning"}`} aria-hidden="true" /><span><strong>{systemLabel}</strong><small>Docker Builder · Teach Hermes</small></span></div>
    </aside>
  </>;
}
