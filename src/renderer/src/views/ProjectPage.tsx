import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArrowLeft,
  Pencil,
  X,
  Code,
  ExternalLink,
  FolderOpen,
  GitBranch,
  GitCommitHorizontal,
  GitFork,
  ListTodo,
  Pin,
  PinOff,
  Play,
  Plus,
  RefreshCw,
  Terminal
} from 'lucide-react'
import type { ConnectionsState, GitDetail, GitInfo, LiveSession, ProjectRecord, SafetyLevel, SessionSummary } from '@shared/types'
import { baseName } from '@shared/projects'
import { api } from '../api'
import { addProjectPath, editTask, launch, newSession, newSideShell, setState, toast, togglePin, updateProject, useStore } from '../store'
import { findRecord, folderFor, normKey, projectIdFor } from '@shared/projectList'
import { ProjectFolders, UndoMergeBar } from '../components/ProjectFolders'
import { LocateButton } from '../components/RelocateDialog'
import { buildProjects, days30, type Project } from '@shared/projectModel'
import { compact, duration, relTime, usd } from '../format'
import { DailyBars } from '../components/charts'
import { CommitGraph } from '../components/CommitGraph'
import { ModelTag, primaryModel, StatusDot, statusLabel } from '../components/bits'
import { gitSummary, RiskRow, useGitTracking } from './ProjectsView'
import { SecretScanPanel } from '../components/ProjectScanPanel'
import { useNow } from './UsageView'
import { CorvidPanel } from './CorvidPanel'

function remove(id: string, name: string): void {
  if (window.confirm(`Take ${name} off your project list? Its folder, sessions and tasks stay as they are.`)) {
    void api.removeProject(id).then(() => setState({ selectedProject: undefined }))
  }
}

/** Session rows shown before "Show all". */
const SESSION_ROWS = 14

const STATUS_LABEL: Record<string, string> = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', '??': 'new', U: 'conflict' }

type CommitView = 'list' | 'graph'
const COMMIT_VIEW_KEY = 'commitView'

function readCommitView(): CommitView {
  try {
    return localStorage.getItem(COMMIT_VIEW_KEY) === 'graph' ? 'graph' : 'list'
  } catch {
    return 'list'
  }
}

export function ProjectPage({ path }: { path: string }): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const live = useStore((s) => s.liveSessions)
  const git = useStore((s) => s.git)
  const config = useStore((s) => s.config)
  const list = useStore((s) => s.projects)
  const selectedId = useStore((s) => s.selectedId)
  const now = useNow(60_000)
  const [naming, setNaming] = useState<string | null>(null)
  const [detail, setDetail] = useState<GitDetail | null>(null)
  const [commitView, setCommitView] = useState<CommitView>(readCommitView)
  const pickCommitView = (v: CommitView): void => {
    setCommitView(v)
    try {
      localStorage.setItem(COMMIT_VIEW_KEY, v)
    } catch {
      /* ignore */
    }
  }

  // every folder of the project keeps its git state fresh (3/5)
  const rec = findRecord(list.projects, path)
  useGitTracking(rec ? rec.folders.map((f) => f.path) : [path])
  const [folderSel, setFolderSel] = useState<string | undefined>()
  const p = useMemo(() => {
    const all = buildProjects(list, sessions, live, git, config, now)
    const id = findRecord(list.projects, path)?.id ?? projectIdFor(path, list.projects, list.cwds)
    const found = all.find((x) => x.id === id)
    if (found) return found
    // A folder that isn't on the list (an old folder, a link from a note): shown with its sessions and an
    // Add button. id '' marks it as not listed.
    const stub: ProjectRecord = { id: '', name: baseName(path), pinned: false, archived: false, createdAt: 0, folders: [{ path, primary: true, pastPaths: [] }], remotes: [] }
    const p = buildProjects({ ...list, projects: [stub], missing: [] }, sessions, live, git, config, now)[0]
    return { ...p, risks: [] }
  }, [list, sessions, live, git, config, now, path])
  const listed = p.id !== ''
  const several = p.folders.length > 1
  // the git panels show one folder at a time; the primary one unless another tab is picked
  const sel = p.folders.find((f) => f.path === folderSel) ?? p.folders.find((f) => f.primary) ?? p.folders[0]
  const record = list.projects.find((r) => r.id === p.id)
  // sessions in the primary folder go unlabelled, like the risk rows; the others name their folder
  const folderOf = (s: SessionSummary): string | undefined => {
    if (!several || !record || !s.cwd) return undefined
    const f = folderFor(s.cwd, record, list.cwds[normKey(s.cwd)])
    return f && !f.primary ? f.label || baseName(f.path) : undefined
  }

  const g = sel ? sel.git : p?.git
  const repoRoot = g?.repoRoot
  useEffect(() => {
    if (!repoRoot) return
    let cancelled = false
    void api.gitDetail(repoRoot).then((d) => !cancelled && setDetail(d))
    return () => {
      cancelled = true
    }
  }, [repoRoot, g?.checkedAt])

  if (!p) return null

  const totals = p.sessions.reduce(
    (acc, s) => ({ out: acc.out + s.tokens.output, cost: acc.cost + s.costUsd, hours: acc.hours + s.activeHours }),
    { out: 0, cost: 0, hours: 0 }
  )
  const dates = days30(now)
  const daily = dates.map((date, i) => ({ date, byModel: { out: p.daily30[i] } }))

  // Only files inside the project; the same file can be logged as D:\ or d:/ depending on the tool.
  const prefixes = p.folders.map((f) => ({ name: f.primary ? '' : f.name, pre: f.path.replace(/[\\/]+$/, '').replace(/\//g, '\\').toLowerCase() + '\\' }))
  const edited = new Map<string, { rel: string; n: number }>()
  for (const s of p.sessions) {
    for (const [f, n] of Object.entries(s.editedFiles)) {
      const norm = f.replace(/\//g, '\\')
      const k = norm.toLowerCase()
      const hit = prefixes.find((x) => k.startsWith(x.pre))
      if (!hit) continue
      const e = edited.get(k) ?? { rel: (hit.name ? `${hit.name}/` : '') + norm.slice(hit.pre.length), n: 0 }
      e.n += n
      edited.set(k, e)
    }
  }
  const topEdited = [...edited.values()].sort((a, b) => b.n - a.n).slice(0, 12)
  const editMax = topEdited[0]?.n ?? 1
  const latest = p.sessions.find((s) => !s.deleted)

  return (
    <div className="projects">
      <div className="projects-inner">
        {/* '' is the list itself, even with a project chosen in the switcher (#77) */}
        <button className="btn ghost sm back" onClick={() => setState({ selectedProject: '' })}>
          <ArrowLeft size={14} /> Projects
        </button>

        <div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {naming !== null ? (
              <input
                className="input"
                autoFocus
                value={naming}
                onChange={(e) => setNaming(e.target.value)}
                onBlur={() => setNaming(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setNaming(null)
                  if (e.key === 'Enter') {
                    if (naming.trim()) updateProject(p.id, { name: naming.trim() })
                    setNaming(null)
                  }
                }}
              />
            ) : (
              <h1 className="ptitle">{p.name}</h1>
            )}
            {listed ? (
              <>
                <button className="btn sm" onClick={() => togglePin(p.id)}>
                  {p.pinned ? <PinOff size={13} /> : <Pin size={13} />} {p.pinned ? 'Unpin' : 'Pin'}
                </button>
                <button className="btn sm" title="Rename this project (the folder keeps its name)" onClick={() => setNaming(p.name)}>
                  <Pencil size={13} /> Rename
                </button>
                {p.builtin ? (
                  <span className="chip builtin-chip" title="Corvid's own project: always on the list. It can be unpinned, not removed.">built in</span>
                ) : (
                  <>
                    <button className="btn sm" title={p.archived ? 'Show it in the list again' : 'Hide it from the list; nothing is deleted'} onClick={() => updateProject(p.id, { archived: !p.archived })}>
                      <Archive size={13} /> {p.archived ? 'Unarchive' : 'Archive'}
                    </button>
                    <button className="btn sm" title="Take it off the list. No folder, session or task is deleted." onClick={() => remove(p.id, p.name)}>
                      <X size={13} /> Remove
                    </button>
                  </>
                )}
              </>
            ) : (
              <button className="btn sm primary" onClick={() => void addProjectPath(p.path)}>
                <Plus size={13} /> Add to projects
              </button>
            )}
            {p.missing && (
              <span className="chip warn-chip" title="Moved, renamed, deleted, or on a drive that isn’t connected. History, sessions, tasks and notes are kept.">
                missing: {several ? 'the primary folder' : 'the folder'} isn’t there
              </span>
            )}
            {listed && !several && <LocateButton projectId={p.id} path={p.path} missing={p.missing} />}
            {several && <span className="chip">{p.folders.length} folders</span>}
            {p.live.map((l) => (
              <span key={l.pid} className={`chip status-text ${l.status}`}>
                <StatusDot live={l} /> {statusLabel(l)}
              </span>
            ))}
          </div>
          <div className="path" style={{ display: 'flex', gap: 14, color: 'var(--text-3)', fontSize: 12, marginTop: 6, flexWrap: 'wrap' }}>
            <span className="mono">{p.path}</span>
            {g?.nested && <span>repo in subfolder <span className="mono">{baseName(g.repoRoot)}</span></span>}
            {g?.remoteUrl && <span className="mono">{g.remoteUrl}</span>}
          </div>
        </div>

        {p.builtin && <CorvidPanel />}

        <div className="actions">
          <button className="btn primary" disabled={p.missing} title={p.missing ? 'The folder isn’t there: use Locate folder… first' : undefined} onClick={() => void newSession(p.path, `${p.name} · new`)}>
            <Plus size={14} /> New Claude session
          </button>
          {latest && (
            <button className="btn" onClick={() => void launch(latest, 'resume')} title={latest.title}>
              <Play size={14} /> Resume latest
            </button>
          )}
          <button className="btn" disabled={p.missing} title={p.missing ? 'The folder isn’t there: use Locate folder… first' : undefined} onClick={() => void api.openVSCode(p.path).catch((e) => toast(String((e as Error).message ?? e), 'error'))}>
            <Code size={14} /> VS Code
          </button>
          <button className="btn" disabled={p.missing} title={p.missing ? 'The folder isn’t there: use Locate folder… first' : 'Open a shell in this folder in the sidebar terminal'} onClick={() => void newSideShell(undefined, p.path)}>
            <Terminal size={14} /> Terminal
          </button>
          <button className="btn" disabled={p.missing} onClick={() => void api.openFolder(p.path)}>
            <FolderOpen size={14} /> Folder
          </button>
          {g?.webUrl && (
            <button className="btn" onClick={() => window.open(g.webUrl, '_blank')}>
              <ExternalLink size={14} /> {new URL(g.webUrl).host.replace('www.', '')}
            </button>
          )}
          <button className="btn" onClick={() => editTask({ projectId: p.id || undefined, project: p.path })}>
            <ListTodo size={14} /> Add task
          </button>
          <div style={{ flex: 1 }} />
          <button className="btn ghost icon" title="Refresh git" onClick={() => p.folders.forEach((f) => void api.gitRefresh(f.path))}>
            <RefreshCw size={14} />
          </button>
        </div>

        {listed && <UndoMergeBar p={p} />}
        {several && <FolderSummary p={p} />}
        {p.risks.map((r) => (
          <RiskRow key={r.id} r={r} project={p} />
        ))}
        <SecretScanPanel root={p.path} missing={p.missing} />

        <div className="stat-strip">
          <div>
            <div className="section-label">Sessions</div>
            <div className="v">{p.sessions.length}</div>
            <div className="s">{p.lastActivity ? `last ${relTime(p.lastActivity, now)}` : 'none yet'}</div>
          </div>
          <div>
            <div className="section-label">Claude time</div>
            <div className="v">{totals.hours ? duration(totals.hours * 3600_000) : '—'}</div>
            <div className="s">clock hours with replies</div>
          </div>
          <div>
            <div className="section-label">Output</div>
            <div className="v">{compact(totals.out)}</div>
            <div className="s">tokens, all sessions</div>
          </div>
          <div>
            <div className="section-label">Est. value</div>
            <div className="v">{usd(totals.cost)}</div>
            <div className="s">API-equivalent</div>
          </div>
          <div>
            <div className="section-label">Branch</div>
            <div className="v">{p.missing ? 'folder missing' : g ? g.branch || 'detached' : g === null ? 'no git' : '…'}</div>
            <div className="s">
              {g ? (g.upstream ? `${g.ahead ? `↑${g.ahead} ` : ''}${g.behind ? `↓${g.behind} ` : ''}${!g.ahead && !g.behind ? 'in sync with ' : 'vs '}${g.upstream}` : 'no upstream') : ''}
            </div>
          </div>
          <div>
            <div className="section-label">Last commit</div>
            <div className="v">{g?.lastCommit ? relTime(g.lastCommit.ts, now) : '—'}</div>
            <div className="s">{g ? `${g.changed + g.untracked} uncommitted` : ''}</div>
          </div>
        </div>

        <div className="two-col">
          <div className="card panel">
            <div className="section-label">
              <span>Sessions</span>
              <span>{p.sessions.length}</span>
            </div>
            <SessionList sessions={p.sessions} live={p.live} selectedId={selectedId} now={now} folderOf={folderOf} />
          </div>
          <div className="card panel">
            <div className="section-label">
              <span>Claude output · last 30 days</span>
            </div>
            <DailyBars
              data={daily}
              height={170}
              order={['out']}
              color={() => 'var(--opus)'}
              label={() => 'Output tokens'}
              labelEvery={7}
            />
            <div className="section-label" style={{ margin: '18px 0 10px' }}>
              Files Claude edits most
            </div>
            <div className="barlist">
              {topEdited.map(({ rel, n }) => (
                <div className="item" key={rel} style={{ gridTemplateColumns: 'minmax(0, 1.4fr) 1fr 40px' }}>
                  <div className="label mono" title={rel}>
                    {rel}
                  </div>
                  <div className="track">
                    <div className="fill" style={{ width: `${(n / editMax) * 100}%`, background: 'var(--text-3)' }} />
                  </div>
                  <div className="val">{n}</div>
                </div>
              ))}
              {!topEdited.length && <div className="muted">No edits recorded.</div>}
            </div>
          </div>
        </div>

        {listed && <ProjectFolders p={p} />}
        {listed && <ProjectConnections projectId={p.id} />}

        {several && (
          <div className="seg folder-tabs" role="tablist" aria-label="Folder shown in the git panels">
            {p.folders.map((f) => (
              <button key={f.path} className={f === sel ? 'on' : ''} title={f.path} onClick={() => setFolderSel(f.path)}>
                {f.name}
                {f.missing ? ' (missing)' : ''}
              </button>
            ))}
          </div>
        )}
        {sel?.missing && (
          // git state, files and new sessions need the folder; history, sessions, tasks and notes don't (4/5)
          <div className="card panel muted missing-note">
            <span>
              {several ? sel.name : p.name}’s folder isn’t at <span className="mono">{sel.path}</span>: moved, renamed, deleted, or on a drive that isn’t
              connected. Its history, sessions, tasks and notes are kept; git state, Files and new sessions come back once it’s found.
            </span>
            {listed && several && <LocateButton projectId={p.id} path={sel.path} missing />}
          </div>
        )}

        {g && (
          <div className="two-col">
            <div className="card panel">
              <div className="section-label">
                <span>Uncommitted changes</span>
                <span>{detail?.changes.length ?? '…'}</span>
              </div>
              <div className="changes">
                {detail?.changes.slice(0, 40).map((c) => (
                  <div key={c.path} className="change">
                    <span className={`st st-${c.status.replace('?', 'q')}`} title={STATUS_LABEL[c.status] ?? c.status}>
                      {c.status === '??' ? 'new' : c.status}
                    </span>
                    <span className="mono">{c.path}</span>
                  </div>
                ))}
                {detail && detail.changes.length > 40 && <div className="muted">+{detail.changes.length - 40} more</div>}
                {detail?.changes.length === 0 && <div className="muted">Working tree clean.</div>}
              </div>
            </div>
            <div className="card panel">
              <div className="section-label">
                <span className="commits-head">
                  <span>{commitView === 'graph' ? 'Commit graph' : 'Recent commits'}</span>
                  <span className="seg xs">
                    {(['list', 'graph'] as CommitView[]).map((v) => (
                      <button key={v} className={commitView === v ? 'on' : ''} onClick={() => pickCommitView(v)}>
                        {v === 'list' ? 'List' : 'Graph'}
                      </button>
                    ))}
                  </span>
                </span>
                <span>
                  <GitBranch size={11} style={{ verticalAlign: -1 }} /> {g.branch}
                </span>
              </div>
              {commitView === 'graph' && <CommitGraph key={g.repoRoot} repoRoot={g.repoRoot} refreshKey={g.checkedAt} now={now} />}
              <div className="commits" hidden={commitView === 'graph'}>
                {detail?.commits.map((c) => (
                  <div key={c.hash} className="commit">
                    <GitCommitHorizontal size={13} />
                    <span className="subj" title={c.subject}>
                      {c.subject}
                    </span>
                    <span className="mono muted">{c.hash.slice(0, 7)}</span>
                    <span className="muted num">{relTime(c.ts, now)}</span>
                  </div>
                ))}
                {detail?.commits.length === 0 && <div className="muted">No commits yet.</div>}
              </div>
            </div>
          </div>
        )}
        {g === null && (
          <div className="card panel muted">
            {gitSummary(null)} &nbsp;This folder isn't in a git repository, and none was found in its subfolders.
          </div>
        )}
      </div>
    </div>
  )
}

const SAFETY_WORD: Record<SafetyLevel, string> = { free: 'Free', 'approve-writes': 'Approve writes', strict: 'Strict' }

/** The connections linked to this project (#88): what its agents can reach. Names and settings only, never a secret. */
function ProjectConnections({ projectId }: { projectId: string }): ReactNode {
  const remote = useStore((s) => s.remote)
  const [state, setConnState] = useState<ConnectionsState | null>(null)
  useEffect(() => {
    let cancelled = false
    void api.connectionsState().then((st) => !cancelled && setConnState(st))
    return () => {
      cancelled = true
    }
  }, [remote])
  if (!state) return null
  const linked = state.connections.filter((c) => c.projectIds.includes(projectId))
  const typeName = (id: string): string => state.connectors.find((c) => c.id === id)?.name ?? id
  return (
    <div className="card panel">
      <div className="section-label">
        <span>Connections</span>
        <button className="btn ghost sm" onClick={() => setState({ view: 'connections', connectionsFocus: { area: 'connections', projectId } })}>
          Manage in Connections
        </button>
      </div>
      {linked.length ? (
        <div className="changes">
          {linked.map((c) => (
            <div key={c.id} className="change">
              <span className="mono">{c.name}</span>
              <span className="muted">{typeName(c.connectorId)}</span>
              <span style={{ flex: 1 }} />
              <span className={c.safety === 'strict' ? '' : 'muted'}>{SAFETY_WORD[c.safety]}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="muted">No connections are linked to this project; agents here can't reach any servers, APIs or databases.</div>
      )}
      {state.killSwitch && <div className="muted" style={{ marginTop: 8 }}>All connectors are disabled right now.</div>}
    </div>
  )
}

/** Click picks a row, double-click or Enter resumes it; the picked row also offers fork and the outside apps. */
/** The combined git state of a multi-folder project (3/5), one line above its risk rows. */
function FolderSummary({ p }: { p: Project }): ReactNode {
  const gits = p.folders.map((f) => f.git).filter((x): x is GitInfo => !!x && !x.error)
  const dirty = gits.reduce((a, x) => a + x.changed + x.untracked, 0)
  const ahead = gits.reduce((a, x) => a + x.ahead, 0)
  const behind = gits.reduce((a, x) => a + x.behind, 0)
  const missing = p.folders.filter((f) => f.missing).length
  const noGit = p.folders.filter((f) => f.git === null).length
  const serious = p.risks.filter((r) => r.severity === 'serious').length
  const parts = [
    `${p.folders.length} folders`,
    dirty ? `${dirty} uncommitted` : 'all clean',
    ahead ? `${ahead} unpushed` : '',
    behind ? `${behind} to pull` : '',
    noGit ? `${noGit} without git` : '',
    missing ? `${missing} missing` : '',
    p.risks.length ? `${p.risks.length} flag${p.risks.length === 1 ? '' : 's'}${serious ? ` (${serious} serious)` : ''}` : 'no flags'
  ].filter(Boolean)
  return <div className={`folder-summary${serious ? ' serious' : p.risks.length ? ' warn' : ''}`}>{parts.join(' · ')}</div>
}

function SessionList({
  sessions,
  live,
  selectedId,
  now,
  folderOf
}: {
  sessions: SessionSummary[]
  live: LiveSession[]
  selectedId?: string
  now: number
  folderOf?: (s: SessionSummary) => string | undefined
}): ReactNode {
  const [all, setAll] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const buried = sessions.findIndex((s) => s.id === selectedId) >= SESSION_ROWS
  const shown = all ? sessions : sessions.slice(0, SESSION_ROWS)

  // Arriving from search or a link: open the full list if need be and bring the picked session into view.
  useEffect(() => {
    if (buried) setAll(true)
  }, [selectedId, buried])
  useEffect(() => {
    listRef.current?.querySelector('.psrow.sel')?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, all])

  const wt = (s: SessionSummary, mode: 'resume' | 'fork'): void =>
    void api.openWT({ mode, cwd: s.cwd, sessionId: s.id, title: s.title }).catch((e) => toast(String(e), 'error'))
  // always there on Windows and macOS; on Linux it hides when no terminal is found (#157)
  const [canTerminal, setCanTerminal] = useState(true)
  useEffect(() => {
    void api.terminalAvailable().then(setCanTerminal, () => setCanTerminal(false))
  }, [])

  const onKey = (e: React.KeyboardEvent): void => {
    const i = shown.findIndex((s) => s.id === selectedId)
    const s = shown[i]
    if (e.key === 'ArrowDown' && shown[i + 1]) setState({ selectedId: shown[i + 1].id })
    else if (e.key === 'ArrowUp' && i > 0) setState({ selectedId: shown[i - 1].id })
    else if (e.key === 'Enter' && s && !s.deleted) void launch(s, 'resume')
    else return
    e.preventDefault()
  }

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }

  return (
    <div className={`psessions${all ? ' all' : ''}`} ref={listRef} tabIndex={0} onKeyDown={onKey}>
      {shown.map((s) => {
        const l = live.find((x) => x.sessionId === s.id)
        return (
          <div
            key={s.id}
            className={`psrow${s.id === selectedId ? ' sel' : ''}${s.deleted ? ' deleted' : ''}`}
            onClick={() => setState({ selectedId: s.id })}
            onDoubleClick={() => !s.deleted && void launch(s, 'resume')}
          >
            <span style={{ width: 10 }}>{l && <StatusDot live={l} />}</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="t" title={s.title}>
                {s.title}
              </div>
              <div className="m">
                {folderOf?.(s) && <span className="chip folder-chip">{folderOf(s)}</span>}
                {relTime(s.lastActivity, now)} · <ModelTag model={primaryModel(s.models)} /> · {compact(s.tokens.output)} out
                {s.deleted ? ' · transcript gone (Claude Code removed it): summary kept, can’t be resumed' : ''}
              </div>
            </div>
            {!s.deleted && (
              <>
                <span className="ps-more">
                  <button className="btn sm ghost icon" title="Fork: resume as a new branch (--fork-session)" onClick={stop(() => void launch(s, 'fork'))}>
                    <GitFork size={12} />
                  </button>
                  <button className="btn sm ghost icon" title="Open in the VS Code extension" onClick={stop(() => void api.openVSCode(s.cwd, s.id))}>
                    <Code size={12} />
                  </button>
                  {canTerminal && (
                    <button className="btn sm ghost icon" title="Resume in a terminal window" onClick={stop(() => wt(s, 'resume'))}>
                      <ExternalLink size={12} />
                    </button>
                  )}
                </span>
                <button className="btn sm ghost" onClick={stop(() => void launch(s, 'resume'))}>
                  <Play size={12} /> Resume
                </button>
              </>
            )}
          </div>
        )
      })}
      {sessions.length > SESSION_ROWS && (
        <button className="btn sm ghost ps-all" onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${sessions.length}`}
        </button>
      )}
      {!sessions.length && <div className="muted">No Claude sessions here yet.</div>}
    </div>
  )
}
