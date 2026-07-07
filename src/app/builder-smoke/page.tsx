'use client';

import React, { useState, useMemo } from 'react';

type TaskStatus = 'planned' | 'in_progress' | 'completed';

interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  focus?: boolean;
  createdAt: string;
}

interface Project {
  id: string;
  name: string;
  color: string;
}

interface ActivityItem {
  id: string;
  text: string;
  time: string;
}

const INITIAL_PROJECTS: Project[] = [
  { id: 'p1', name: 'Personal', color: '#60A5FA' },
  { id: 'p2', name: 'Work', color: '#34D399' },
  { id: 'p3', name: 'Study', color: '#FBBF24' },
];

const INITIAL_TASKS: Task[] = [
  { id: 't1', title: 'Define weekly OKRs', status: 'completed', createdAt: new Date(Date.now() - 86400000 * 2).toISOString() },
  { id: 't2', title: 'Prototype dashboard copy', status: 'in_progress', createdAt: new Date(Date.now() - 86400000).toISOString() },
  { id: 't3', title: 'Review accessibility checklist', status: 'planned', createdAt: new Date().toISOString() },
  { id: 't4', title: 'Write focus blocks for Friday', status: 'planned', createdAt: new Date().toISOString() },
  { id: 't5', title: 'Deploy branch preview', status: 'in_progress', createdAt: new Date().toISOString() },
];

const INITIAL_ACTIVITY: ActivityItem[] = [
  { id: 'a1', text: 'Added 3 tasks for Study project', time: '2h ago' },
  { id: 'a2', text: 'Moved Prototype dashboard copy to In Progress', time: '4h ago' },
  { id: 'a3', text: 'Completed Define weekly OKRs', time: 'Yesterday' },
  { id: 'a4', text: 'Created Work project', time: '2 days ago' },
];

export default function BuilderSmokePage() {
  const [projects] = useState<Project[]>(INITIAL_PROJECTS);
  const [tasks, setTasks] = useState<Task[]>(INITIAL_TASKS);
  const [activity, setActivity] = useState<ActivityItem[]>(INITIAL_ACTIVITY);
  const [modalOpen, setModalOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState<TaskStatus>('planned');
  const [projectId, setProjectId] = useState<string>(projects[0]?.id || '');
  const [focusTitle, setFocusTitle] = useState('Friday deploy review + accessibility audit');

  const counts = useMemo(() => {
    const activeProjects = projects.length;
    const completed = tasks.filter(t => t.status === 'completed').length;
    const focusHours = tasks.filter(t => t.status === 'in_progress' || t.status === 'completed').length * 1.25;
    const weeklyProgress = Math.round((completed / (tasks.length || 1)) * 100);
    return { activeProjects, completed, focusHours: Math.round(focusHours * 10) / 10, weeklyProgress };
  }, [projects, tasks]);

  const moveTask = (id: string, next: TaskStatus) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, status: next, focus: next === 'in_progress' } : t));
    setActivity(prev => [{ id: `act-${Date.now()}`, text: `Moved task to ${next.replace('_', ' ')}`, time: 'Just now' }, ...prev].slice(0, 20));
  };

  const addTask = () => {
    if (!title.trim()) return;
    const newTask: Task = {
      id: `t-${Date.now()}`,
      title: title.trim(),
      status,
      createdAt: new Date().toISOString(),
    };
    setTasks(prev => [newTask, ...prev]);
    setActivity(prev => [{ id: `act-${Date.now()}`, text: `Added "${newTask.title}"`, time: 'Just now' }, ...prev].slice(0, 20));
    setTitle('');
    setStatus('planned');
    setModalOpen(false);
  };

  const taskColumns: { key: TaskStatus; label: string }[] = [
    { key: 'planned', label: 'Planned' },
    { key: 'in_progress', label: 'In Progress' },
    { key: 'completed', label: 'Completed' },
  ];

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <header style={styles.header}>
          <div>
            <h1 style={styles.title}>FocusFlow</h1>
            <p style={styles.subtitle}>Plan goals, execute tasks, and protect weekly focus.</p>
          </div>
          <button
            type="button"
            onClick={() => setModalOpen(true)}
            style={styles.primaryButton}
            aria-haspopup="dialog"
            aria-expanded={modalOpen}
          >
            + Add Task
          </button>
        </header>

        <section style={styles.section} aria-label="Overview">
          <div style={styles.grid4}>
            <Card label="Active projects" value={String(counts.activeProjects)} accent="#60A5FA" />
            <Card label="Tasks completed" value={String(counts.completed)} accent="#34D399" />
            <Card label="Focus hours" value={String(counts.focusHours)} accent="#FBBF24" />
            <Card label="Weekly progress" value={`${counts.weeklyProgress}%`} accent="#A78BFA" />
          </div>
        </section>

        <div style={styles.stack}>
          <section style={styles.card} aria-label="Today's Focus">
            <h2 style={styles.heading}>Today’s Focus</h2>
            <p style={styles.body}>{focusTitle}</p>
            <div style={styles.progressWrap}>
              <div style={{ ...styles.progressTrack, width: '100%' }}>
                <div style={{ ...styles.progressFill, width: `${Math.min(counts.weeklyProgress, 100)}%`, background: '#A78BFA' }} />
              </div>
              <div style={styles.progressLabel}>{counts.weeklyProgress}% weekly completion</div>
            </div>
          </section>

          <section style={styles.section} aria-label="Task board">
            <div style={styles.columns}>
              {taskColumns.map(col => (
                <div key={col.key} style={styles.column}>
                  <div style={styles.columnHeader}>
                    <span style={{ ...styles.dot, background: col.key === 'planned' ? '#60A5FA' : col.key === 'in_progress' ? '#34D399' : '#94A3B8' }} />
                    <span style={{ fontWeight: 700, color: '#E6E8EE' }}>{col.label}</span>
                  </div>
                  <div style={styles.list} role="list" aria-label={col.label}>
                    {tasks.filter(t => t.status === col.key).map(task => (
                      <div key={task.id} style={styles.taskCard} role="listitem">
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ color: '#F1F4FB', fontSize: 13, lineHeight: 1.45, wordBreak: 'break-word' }}>{task.title}</div>
                          <div style={{ color: '#8a8f9c', fontSize: 11, marginTop: 4 }}>
                            {new Date(task.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                          </div>
                        </div>
                        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                          {col.key !== 'planned' && (
                            <button type="button" onClick={() => moveTask(task.id, 'planned')} style={{ ...styles.iconButton, padding: '6px 10px' }} aria-label="Move to Planned">←</button>
                          )}
                          {col.key === 'planned' && (
                            <button type="button" onClick={() => moveTask(task.id, 'in_progress')} style={{ ...styles.iconButton, padding: '6px 10px' }} aria-label="Move to In Progress">→</button>
                          )}
                          {col.key === 'in_progress' && (
                            <button type="button" onClick={() => moveTask(task.id, 'completed')} style={{ ...styles.iconButton, padding: '6px 10px' }} aria-label="Mark complete">✓</button>
                          )}
                          {col.key === 'completed' && (
                            <button type="button" onClick={() => moveTask(task.id, 'in_progress')} style={{ ...styles.iconButton, padding: '6px 10px' }} aria-label="Reopen">↺</button>
                          )}
                        </div>
                      </div>
                    ))}
                    {tasks.filter(t => t.status === col.key).length === 0 && (
                      <div style={styles.emptyState}>No tasks yet.</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section style={styles.card} aria-label="Activity">
            <h2 style={styles.heading}>Recent Activity</h2>
            <div style={styles.timeline}>
              {activity.map(item => (
                <div key={item.id} style={styles.timelineRow}>
                  <span style={styles.timelineTime}>{item.time}</span>
                  <span style={styles.timelineText}>{item.text}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>

      {modalOpen && (
        <div role="dialog" aria-modal="true" aria-label="Add task" style={styles.backdrop} onClick={() => setModalOpen(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.heading}>Add Task</h3>
            <label style={styles.label}>
              Title
              <input
                value={title}
                onChange={e => setTitle(e.target.value)}
                placeholder="What do you want to focus on?"
                style={styles.input}
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addTask();
                  if (e.key === 'Escape') setModalOpen(false);
                }}
              />
            </label>
            <label style={styles.label}>
              Status
              <select value={status} onChange={e => setStatus(e.target.value as TaskStatus)} style={styles.select}>
                <option value="planned">Planned</option>
                <option value="in_progress">In Progress</option>
                <option value="completed">Completed</option>
              </select>
            </label>
            <div style={{ ...styles.actions, marginTop: 14 }}>
              <button type="button" onClick={addTask} style={styles.primaryButton}>Save</button>
              <button type="button" onClick={() => setModalOpen(false)} style={styles.secondaryButton}>Cancel</button>
            </div>
          </div>
        </div>
      )}
      <style>{`
        @media (max-width: 680px) {
          .ff-overview { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
          .ff-board { grid-template-columns: 1fr !important; }
          .ff-header { flex-direction: column; align-items: flex-start !important; }
        }
      `}</style>
    </div>
  );
}

function Card({ label, value, accent }: { label: string; value: string; accent: string }) {
  return (
    <div style={{ ...styles.card, borderLeft: `3px solid ${accent}` }}>
      <div style={{ color: '#8a8f9c', fontSize: 12, fontWeight: 700, letterSpacing: '0.06em' }}>{label}</div>
      <div style={{ color: '#F1F4FB', fontSize: 24, fontWeight: 800, marginTop: 6 }}>{value}</div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    background: 'radial-gradient(1200px 800px at 10% 10%, rgba(96,165,250,0.12), transparent), radial-gradient(1200px 800px at 90% 0%, rgba(167,139,250,0.12), transparent), #070B14',
    color: '#E6E8EE',
    minHeight: '100vh',
    padding: '24px 16px',
    fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji", "Segoe UI Emoji"',
  },
  container: {
    maxWidth: 1200,
    margin: '0 auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 18,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 12,
    flexWrap: 'wrap',
  },
  title: {
    margin: 0,
    color: '#F1F4FB',
    fontSize: 32,
    fontWeight: 800,
    letterSpacing: '-0.02em',
  },
  subtitle: {
    margin: '6px 0 0',
    color: '#8a8f9c',
    fontSize: 14,
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  grid4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
    gap: 12,
  },
  card: {
    background: 'rgba(22,28,48,0.75)',
    border: '1px solid #28324A',
    borderRadius: 16,
    padding: '16px',
    boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
  },
  heading: {
    margin: '0 0 8px',
    color: '#E6E8EE',
    fontSize: 16,
    fontWeight: 700,
  },
  body: {
    color: '#8a8f9c',
    fontSize: 13,
    lineHeight: 1.5,
    margin: 0,
  },
  stack: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  progressWrap: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    marginTop: 12,
    flexWrap: 'wrap',
  },
  progressTrack: {
    height: 8,
    borderRadius: 999,
    background: 'rgba(255,255,255,0.08)',
    overflow: 'hidden',
    minWidth: 80,
    flex: 1,
  },
  progressFill: {
    height: '100%',
    borderRadius: 999,
    transition: 'width .4s ease',
  },
  progressLabel: {
    color: '#8a8f9c',
    fontSize: 12,
    fontWeight: 700,
    whiteSpace: 'nowrap',
  },
  columns: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
    gap: 12,
  },
  column: {
    background: 'rgba(22,28,48,0.55)',
    border: '1px solid #28324A',
    borderRadius: 16,
    padding: 14,
    minHeight: 220,
  },
  columnHeader: {
    display: 'flex',
    gap: 8,
    alignItems: 'center',
    marginBottom: 10,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    boxShadow: '0 0 0 3px rgba(255,255,255,0.06)',
  },
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
  },
  taskCard: {
    background: 'rgba(14,20,36,0.55)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 14,
    padding: '10px 12px',
    display: 'flex',
    gap: 10,
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  emptyState: {
    color: '#4B5563',
    fontSize: 12,
    textAlign: 'center',
    padding: '18px 8px',
  },
  timeline: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    borderLeft: '1px solid rgba(255,255,255,0.08)',
    paddingLeft: 14,
  },
  timelineRow: {
    display: 'flex',
    gap: 10,
    alignItems: 'baseline',
    flexWrap: 'wrap',
  },
  timelineTime: {
    color: '#8a8f9c',
    fontSize: 12,
    minWidth: 64,
  },
  timelineText: {
    color: '#D8DEEB',
    fontSize: 13,
    lineHeight: 1.4,
    flex: 1,
  },
  primaryButton: {
    padding: '10px 14px',
    borderRadius: 12,
    border: '1px solid rgba(96,165,250,0.35)',
    background: 'rgba(96,165,250,0.15)',
    color: '#60A5FA',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  secondaryButton: {
    padding: '10px 14px',
    borderRadius: 12,
    border: '1px solid rgba(255,255,255,0.12)',
    background: 'rgba(255,255,255,0.06)',
    color: '#E6E8EE',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
  },
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 16,
    zIndex: 50,
  },
  modal: {
    background: '#0F1525',
    border: '1px solid #28324A',
    borderRadius: 16,
    padding: 16,
    width: '100%',
    maxWidth: 520,
    maxHeight: '90vh',
    overflow: 'auto',
    boxShadow: '0 20px 60px rgba(0,0,0,0.45)',
  },
  label: {
    color: '#8a8f9c',
    fontSize: 12,
    fontWeight: 700,
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 10,
  },
  input: {
    background: 'rgba(8,13,24,0.62)',
    border: '1px solid #28324A',
    borderRadius: 12,
    padding: '10px 12px',
    color: '#F1F4FB',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  select: {
    background: 'rgba(8,13,24,0.62)',
    border: '1px solid #28324A',
    borderRadius: 12,
    padding: '10px 12px',
    color: '#F1F4FB',
    fontSize: 13,
    outline: 'none',
    fontFamily: 'inherit',
  },
  actions: {
    display: 'flex',
    gap: 10,
    justifyContent: 'flex-end',
  },
};
