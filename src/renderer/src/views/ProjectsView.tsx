import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  ChevronRight,
  Download,
  Plus,
  Code,
  ExternalLink,
  FolderOpen,
  FolderPlus,
  GitBranch,
  ListTodo,
  MessageSquare,
  Pin,
  PinOff,
  RefreshCw,
  Search,
  SquareTerminal,
  TriangleAlert
} from 'lucide-react'
import type { ArchiveEntry, GitInfo } from '@shared/types'
import { projectKey } from '@shared/projects'
import { api } from '../api'
import { addProjectPath, makeTask, newProject, newSession, openProject, setState, snooze, togglePin, useStore } from '../store'
import { ImportPreview } from './ImportPreview'
import { buildProjects, type Project, type Risk } from '@shared/projectModel'
import { relTime } from '../format'
import { StatusDot } from '../components/bits'
import { useNow } from './UsageView'
import { ProjectPage } from './ProjectPage'
import { primaryFolder } from '@shared/projectList'
import { useScope } from '../scope'
import { Unfiled } from './Unfiled'
import { LocateButton } from '../components/RelocateDialog'

export function useProjects(): Project[] {
  const list = useStore((s) => s.projects)
  const sessions = useStore((s) => s.sessions)
  const live = useStore((s) => s.liveSessions)
  const git = useStore((s) => s.git)
  const config = useStore((s) => s.config)
  const now = useNow(60_000)
  return useMemo(() => buildProjects(list, sessions, live, git, config, now), [list, sessions, live, git, config, now])
}

/** Ask main to keep git status fresh for these folders, and take whatever it has cached. */
export function useGitTracking(paths: string[]): void {
  const sig = paths.map(projectKey).sort().join('|')
  useEffect(() => {
    if (!paths.length) return
    void api.gitTrack(paths).then((cached) =>
      setState((s) => {
        const next = { ...s.git }
        for (const c of cached) next[c.key] = c.info
        return { git: next }
      })
    )
  }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * A project page when one is picked; with a project chosen in the switcher (#77) and none picked, that
 * project's page. The page's back button picks '' (the list), so the full list stays one click away.
 */
export function ProjectsView(): ReactNode {
  const selected = useStore((s) => s.selectedProject)
  const scope = useScope()
  const scoped = selected === undefined && scope ? primaryFolder(scope) : ''
  if (selected) return <ProjectPage key={selected} path={selected} />
  return scoped ? <ProjectPage key={scoped} path={scoped} /> : <Board />
}

function Board(): ReactNode {
  const projects = useProjects()
  const [q, setQ] = useState('')
  const [archive, setArchive] = useState<ArchiveEntry[] | null>(null)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [importing, setImporting] = useState(false)
  const importOffered = useStore((s) => s.projects.importOffered)
  // the one-time import preview (#73): offered once, then "Import from sessions" stays for later
  useEffect(() => {
    if (!importOffered) setImporting(true)
  }, [importOffered])

  const shown = projects.filter((p) => showArchived || !p.archived)
  useGitTracking(shown.flatMap((p) => p.folders.map((f) => f.path)))

  useEffect(() => {
    void api.archive().then((a) => setArchive(a.entries))
  }, [])

  const needle = q.trim().toLowerCase()
  const match = (name: string, path: string): boolean => !needle || `${name} ${path}`.toLowerCase().includes(needle)
  const visible = shown.filter((p) => match(p.name, p.path))
  // Corvid's own project (#78) leads the pinned ones
  const pinned = visible.filter((p) => p.pinned && !p.archived).sort((a, b) => Number(!!b.builtin) - Number(!!a.builtin))
  const active = visible.filter((p) => !p.pinned && !p.archived)
  const archivedList = visible.filter((p) => p.archived)
  const archivedCount = projects.filter((p) => p.archived).length

  const shownKeys = new Set(projects.map((p) => p.key))
  const sessionCount = new Map(projects.map((p) => [p.key, p.sessions.length]))
  const archived = (archive ?? [])
    .filter((a) => !shownKeys.has(projectKey(a.path)) && match(a.name, a.path))
    .sort((a, b) => b.mtime - a.mtime)

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    await api.gitRefresh().finally(() => setRefreshing(false))
  }

  return (
    <div className="projects">
      <div className="projects-inner">
        <div className="page-head">
          <div>
            <h2>Projects</h2>
            <p>
              {projects.filter((p) => !p.archived).length} projects · {pinned.length} pinned ·{' '}
              <a className="link" onClick={() => setShowArchived(!showArchived)}>
                {showArchived ? 'hide' : 'show'} {archivedCount} archived
              </a>
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <div className="input-wrap" style={{ width: 240 }}>
              <Search size={14} />
              <input className="input" spellCheck placeholder="Find a project…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <button className="btn icon" title="Refresh git status" onClick={() => void refresh()}>
              <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            </button>
            <button className="btn" title="Pick projects from the folders your Claude sessions ran in" onClick={() => setImporting(true)}>
              <Download size={14} /> Import from sessions
            </button>
            <button className="btn primary" title="Add a folder to your project list; one with no git gets git init" onClick={() => void newProject()}>
              <FolderPlus size={14} /> New Project
            </button>
          </div>
        </div>

        {pinned.length > 0 && (
          <Section title="Pinned" count={pinned.length}>
            {pinned.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </Section>
        )}
        <Section title="Projects" count={active.length}>
          {active.map((p) => (
            <ProjectCard key={p.id} p={p} />
          ))}
        </Section>
        {projects.length === 0 && (
          <div className="muted" style={{ fontSize: 13 }}>
            No projects yet. Add one, or import them from the folders your sessions ran in.
          </div>
        )}
        {showArchived && archivedList.length > 0 && (
          <Section title="Archived" count={archivedList.length}>
            {archivedList.map((p) => (
              <ProjectCard key={p.id} p={p} />
            ))}
          </Section>
        )}
        {importing && <ImportPreview onClose={() => setImporting(false)} />}

        <Unfiled needle={needle} />

        <div className="card archive">
          <button className="archive-head" title="Everything else in your project folders; add one to your list" onClick={() => setArchiveOpen(!archiveOpen)}>
            <ChevronRight size={15} style={{ transform: archiveOpen || needle ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
            <span>Other folders</span>
            <span className="muted">{archive ? `${archived.length} folders` : 'scanning…'}</span>
          </button>
          {(archiveOpen || needle) &&
            archived.slice(0, needle ? 60 : 400).map((a) => (
              <div className="archive-row" key={a.path}>
                <span className="n">{a.name}</span>
                <span className="mono muted r">{a.root}</span>
                {a.hasGit ? (
                  <span className="chip">
                    <GitBranch size={11} /> git
                  </span>
                ) : (
                  <span />
                )}
                <span className="muted">{sessionCount.get(projectKey(a.path)) ? `${sessionCount.get(projectKey(a.path))} sessions` : ''}</span>
                <span className="muted num">{relTime(a.mtime)}</span>
                <button
                  className="btn ghost icon sm"
                  title="Add to your projects"
                  onClick={(e) => {
                    e.stopPropagation()
                    void addProjectPath(a.path)
                  }}
                >
                  <Plus size={13} />
                </button>
              </div>
            ))}
        </div>
      </div>
    </div>
  )
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }): ReactNode {
  return (
    <div>
      <div className="section-label" style={{ marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
        <span>{title}</span>
        <span>{count}</span>
      </div>
      <div className="pgrid">{children}</div>
    </div>
  )
}

export function RiskRow({ r, project: owner }: { r: Risk; project?: Project }): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const task = tasks.find((t) => t.source === r.id)
  return (
    <div className={`risk ${r.severity}`}>
      <TriangleAlert size={14} />
      <div className="txt" title={r.text}>
        <span>{r.text}</span>
      </div>
      {task ? (
        <button className="btn sm ghost" title={task.title} onClick={() => setState({ view: 'tasks' })}>
          <ListTodo size={12} /> #{task.id}
        </button>
      ) : (
        <button
          className="btn sm ghost"
          title="Add this to your task board"
          onClick={() =>
            void makeTask({
              title: owner ? `${owner.name}: ${r.text}` : r.text,
              project: owner?.path,
              source: r.id
            })
          }
        >
          <ListTodo size={12} /> Make task
        </button>
      )}
      <button className="btn sm ghost" title="Hide this for a week" onClick={() => snooze(r.id)}>
        Snooze 7d
      </button>
    </div>
  )
}

export function gitSummary(g: GitInfo | null | undefined): ReactNode {
  if (g === undefined) return <span className="muted">checking git…</span>
  if (g === null) return <span className="chip warn-chip">No git</span>
  if (g.error) return <span className="muted">git: {g.error}</span>
  const dirty = g.changed + g.untracked
  return (
    <>
      <span className="br">
        <GitBranch size={12} /> {g.branch || 'detached'}
      </span>
      <span className={dirty ? 'dirty' : 'muted'}>{dirty ? `${dirty} changed` : 'clean'}</span>
      {g.ahead > 0 && <span title="Commits not pushed">↑{g.ahead}</span>}
      {g.behind > 0 && <span title="Commits to pull">↓{g.behind}</span>}
    </>
  )
}

function MiniBars({ values }: { values: number[] }): ReactNode {
  const max = Math.max(1, ...values)
  const w = 3
  const gap = 1
  return (
    <svg width={values.length * (w + gap)} height={18} style={{ display: 'block' }}>
      {values.map((v, i) => {
        const h = v > 0 ? Math.max(2, (v / max) * 18) : 1
        return <rect key={i} x={i * (w + gap)} y={18 - h} width={w} height={h} rx={1} fill={v > 0 ? 'var(--opus)' : 'var(--bg-4)'} />
      })}
    </svg>
  )
}

function ProjectCard({ p }: { p: Project }): ReactNode {
  const g = p.git
  const liveTop = p.live.find((l) => l.status === 'waiting' || l.status === 'blocked') ?? p.live.find((l) => l.status === 'busy') ?? p.live[0]
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
  return (
    <div className={`pcard${p.risks.some((r) => r.severity === 'serious') ? ' serious' : p.risks.length ? ' warn' : ''}`} onClick={() => openProject(p.path)}>
      <div className="pc-head">
        {liveTop && <StatusDot live={liveTop} />}
        <b className="name">{p.name}</b>
        {p.builtin && <span className="chip builtin-chip" title="Corvid's own project: edit, rebuild and roll back your install">built in</span>}
        {p.folders.length > 1 && <span className="chip" title={p.folders.map((f) => f.path).join('\n')}>{p.folders.length} folders</span>}
        {p.missing && <span className="chip warn-chip">missing</span>}
        {p.archived && <span className="chip">archived</span>}
        <button className={`pin${p.pinned ? ' on' : ''}`} title={p.pinned ? 'Unpin' : 'Pin'} onClick={stop(() => togglePin(p.id))}>
          {p.pinned ? <Pin size={13} /> : <PinOff size={13} />}
        </button>
      </div>
      <div className="pc-path mono">{p.path}</div>
      {p.folders.length > 1 ? (
        // one line per folder: its own git state, or missing on its own (3/5)
        p.folders.map((f) => (
          <div key={f.path} className="pc-git">
            <span className="pc-folder">{f.name}</span>
            {f.missing ? (
              <>
                <span className="muted">missing</span> <LocateButton projectId={p.id} path={f.path} missing />
              </>
            ) : (
              gitSummary(f.git)
            )}
          </div>
        ))
      ) : (
        <div className="pc-git">
          {p.missing ? (
            <>
              <span className="muted">The folder isn’t there; history is kept</span> <LocateButton projectId={p.id} path={p.path} missing />
            </>
          ) : (
            gitSummary(g)
          )}
        </div>
      )}
      {g?.lastCommit && (
        <div className="pc-commit">
          <span className="subj">{g.lastCommit.subject}</span>
          <span className="muted">{relTime(g.lastCommit.ts)}</span>
        </div>
      )}
      <div className="pc-claude">
        <MessageSquare size={12} />
        <span>
          {p.sessions.length} session{p.sessions.length === 1 ? '' : 's'}
          {p.lastActivity ? ` · ${relTime(p.lastActivity)}` : ''}
        </span>
        <span style={{ marginLeft: 'auto' }} title="Claude output, last 30 days">
          <MiniBars values={p.daily30} />
        </span>
      </div>
      {p.risks.length > 0 && (
        <div className="pc-risks">
          {p.risks.map((r) => (
            <span key={r.id} className={`risk-chip ${r.severity}`}>
              <TriangleAlert size={11} /> {r.text}
            </span>
          ))}
        </div>
      )}
      <div className="pc-actions">
        <button className="btn sm ghost" disabled={p.missing} onClick={stop(() => void newSession(p.path, `${p.name} · new`))}>
          <SquareTerminal size={13} /> New session
        </button>
        <button className="btn sm ghost" disabled={p.missing} onClick={stop(() => void api.openVSCode(p.path))}>
          <Code size={13} /> VS Code
        </button>
        <button className="btn sm ghost icon" title="Open folder" disabled={p.missing} onClick={stop(() => void api.openFolder(p.path))}>
          <FolderOpen size={13} />
        </button>
        {g?.webUrl && (
          <button className="btn sm ghost icon" title={g.webUrl} onClick={stop(() => window.open(g.webUrl, '_blank'))}>
            <ExternalLink size={13} />
          </button>
        )}
      </div>
    </div>
  )
}
