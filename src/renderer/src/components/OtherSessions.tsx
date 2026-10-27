// Below the agent cards: the Claude sessions running outside Corvid (VS Code, another terminal), which
// Corvid only sees through ~/.claude/sessions, and the sessions that ran lately and can be resumed.
// Both came from the Live view (#64). Read-only: the card shows what the session is doing and leads to
// its project, or its VS Code window; Corvid never types into a session it didn't start.

import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, CircleCheck, Code, FolderOpen, FolderPlus, Hourglass, Play, Sparkles } from 'lucide-react'
import type { LiveSession, SessionSummary } from '@shared/types'
import { baseName } from '@shared/projects'
import { contextHigh } from '@shared/context'
import { normKey, projectIdFor, within } from '@shared/projectList'
import { api } from '../api'
import { addProjectPath, launch, showSession, useStore } from '../store'
import { compact, relTime } from '../format'
import { toolIcon } from '../feed'
import { ContextTag, whereLabel } from './bits'
import { useInScope } from '../scope'

const RECENT_MS = 6 * 3600_000
const RANK: Record<string, number> = { waiting: 0, blocked: 0, busy: 1, idle: 2 }
const needs = (l: LiveSession): boolean => l.status === 'waiting' || l.status === 'blocked'

function readOpen(): boolean {
  try {
    return localStorage.getItem('agentsRecentOpen') === '1'
  } catch {
    return false
  }
}

/** "Other sessions": one quiet card per live session that has no terminal here. */
export function OtherSessions({ now }: { now: number }): ReactNode {
  const liveSessions = useStore((s) => s.liveSessions)
  const sessions = useStore((s) => s.sessions)
  // the chosen project's only (#77); the Agents view counts the others that need you
  const inScope = useInScope()
  const list = useMemo(() => {
    // one per session id (a session can briefly show twice while a process restarts)
    const byId = new Map<string, LiveSession>()
    for (const l of liveSessions) if (!l.termId && inScope(l.cwd) && (!byId.has(l.sessionId) || l.status !== 'idle')) byId.set(l.sessionId, l)
    return [...byId.values()].sort(
      (x, y) => (RANK[x.status] ?? 3) - (RANK[y.status] ?? 3) || (sessions[y.sessionId]?.lastActivity ?? 0) - (sessions[x.sessionId]?.lastActivity ?? 0)
    )
  }, [liveSessions, sessions, inScope])
  if (!list.length) return null
  const waiting = list.filter(needs).length
  return (
    <>
      <div className="section-label ag-group" title="Claude sessions running outside Corvid, in VS Code or another terminal">
        Other sessions · {list.length}
        {waiting > 0 && <b className="ag-needs-count"> · {waiting} need{waiting === 1 ? 's' : ''} you</b>}
      </div>
      <div className="ag-cards">
        {list.map((l) => (
          <ExternalCard key={l.sessionId} l={l} s={sessions[l.sessionId]} now={now} />
        ))}
      </div>
    </>
  )
}

/** A folder that's no project yet and that the skip rules don't hide (worktrees, temp, Corvid's own) (#74). */
function useUnfiledFolder(cwd: string): boolean {
  const list = useStore((s) => s.projects)
  const hidden = useStore((s) => s.unfiled.hidden)
  return useMemo(() => {
    if (!cwd || projectIdFor(cwd, list.projects, list.cwds)) return false
    const k = normKey(cwd)
    return !hidden.some((h) => within(k, normKey(h)))
  }, [cwd, list, hidden])
}

function ExternalCard({ l, s, now }: { l: LiveSession; s?: SessionSummary; now: number }): ReactNode {
  const a = useStore((st) => st.activity[l.sessionId])
  const unfiled = useUnfiledFolder(s?.cwd || l.cwd)
  const project = s?.projectName ?? baseName(l.cwd) ?? 'session'
  const where = whereLabel(l.entrypoint)
  const vscode = l.entrypoint?.includes('vscode')
  const waiting = needs(l)
  const lastTool = a?.events.findLast((e) => e.kind === 'tool')
  const open = (): void => showSession(l.sessionId, l.cwd)

  let line: ReactNode
  if (waiting)
    line = (
      <div className="ag-now warn">
        <Hourglass size={13} />
        <span className="lbl">{l.waitingFor ? `Waiting on ${l.waitingFor}` : 'Waiting for your input'}</span>
      </div>
    )
  else if (l.status === 'busy' && lastTool) {
    const Icon = toolIcon(lastTool)
    line = (
      <div className="ag-now busy" title={relTime(lastTool.ts, now)}>
        <Icon size={13} />
        <span className="lbl">
          {lastTool.agent ? <span className="agent-tag">{lastTool.agent}</span> : <b>{lastTool.tool}</b>} {lastTool.label}
        </span>
      </div>
    )
  } else if (l.status === 'busy')
    line = (
      <div className="ag-now busy">
        <Sparkles size={13} />
        <span className="lbl">Thinking…</span>
      </div>
    )
  else
    line = (
      <div className="ag-now">
        <CircleCheck size={13} />
        <span className="lbl">{a?.lastText || 'Ready for input'}</span>
      </div>
    )

  return (
    <div
      className={`agcard ext ${l.status}`}
      role="button"
      tabIndex={0}
      title={`${project} · running in ${where}. Read-only here: click for its project page.`}
      onClick={open}
      onKeyDown={(e) => {
        if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault()
          open()
        }
      }}
    >
      <div className="ag-title">{s?.title ?? l.name ?? 'New session'}</div>
      {line}
      <div className="ag-foot">
        {waiting ? (
          <span className="ag-status needs">
            <span className="dot waiting" /> Needs you
          </span>
        ) : (
          <span className={`ag-status ${l.status}`}>
            <span className={`dot ${l.status === 'busy' ? 'busy' : 'idle'}`} /> {l.status === 'busy' ? 'Working' : 'Idle'}
          </span>
        )}
        {s && <ContextTag s={s} />}
        {unfiled && (
          <span className="chip ag-unfiled" title="This folder isn't one of your projects yet">
            Unfiled
          </span>
        )}
        <span className="ag-proj">
          {project} · {where}
        </span>
        <span className="ag-actions">
          {vscode && (
            <button
              className="btn ghost icon sm"
              title="Go to its VS Code window"
              onClick={(e) => {
                e.stopPropagation()
                void api.openVSCode(s?.cwd || l.cwd, l.sessionId)
              }}
            >
              <Code size={13} />
            </button>
          )}
          {unfiled && (
            <button
              className="btn ghost icon sm"
              title="Add this folder as a project"
              onClick={(e) => {
                e.stopPropagation()
                void addProjectPath(s?.cwd || l.cwd)
              }}
            >
              <FolderPlus size={13} />
            </button>
          )}
          <button
            className="btn ghost icon sm"
            title="Open its project page"
            onClick={(e) => {
              e.stopPropagation()
              open()
            }}
          >
            <FolderOpen size={13} />
          </button>
        </span>
      </div>
    </div>
  )
}

/** "Recent": sessions not running now that were active in the last 6 hours, each with Resume. Folded by default. */
export function RecentSessions({ now }: { now: number }): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const liveSessions = useStore((s) => s.liveSessions)
  const terminals = useStore((s) => s.terminals)
  const workers = useStore((s) => s.assistant.workers)
  const [open, setOpen] = useState(readOpen)
  const inScope = useInScope()
  // re-read the 6-hour window once a minute, not on every 5-second tick
  const minute = Math.floor(now / 60_000)
  const recent = useMemo(() => {
    // an agent with a card (live, or in the Ended group) isn't listed again here
    const busy = new Set([
      ...liveSessions.map((l) => l.sessionId),
      ...terminals.flatMap((t) => (t.sessionId ? [t.sessionId] : [])),
      ...workers.flatMap((w) => (w.sessionId ? [w.sessionId] : []))
    ])
    const at = minute * 60_000
    return Object.values(sessions)
      .filter((s) => !busy.has(s.id) && at - s.lastActivity < RECENT_MS && inScope(s.cwd))
      .sort((a, b) => b.lastActivity - a.lastActivity)
  }, [sessions, liveSessions, terminals, workers, minute, inScope])
  if (!recent.length) return null
  const toggle = (): void => {
    setOpen(!open)
    try {
      localStorage.setItem('agentsRecentOpen', open ? '0' : '1')
    } catch {
      /* ignore */
    }
  }
  return (
    <>
      <button className="section-label ag-group ag-fold" aria-expanded={open} onClick={toggle} title="Sessions that ran in the last 6 hours and aren't running now">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Recent · {recent.length}
      </button>
      {open && (
        <div className="ag-recent">
          {recent.map((s) => (
            <div className="recent-row" key={s.id} title="Click for its project page" onClick={() => showSession(s.id)}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div className="t">{s.title}</div>
                <div className="m">
                  {s.projectName} · {relTime(s.lastActivity, now)}
                  {(s.context > 0 || s.baseContext > 0) && (
                    <>
                      {' · '}
                      <ContextTag s={s} />
                    </>
                  )}
                </div>
              </div>
              <button
                className="btn sm"
                title={contextHigh(s) ? `Resume here. Context is ${compact(s.context)}, so a fresh session may be cheaper.` : 'Resume here'}
                onClick={(e) => {
                  e.stopPropagation()
                  void launch(s, 'resume')
                }}
              >
                <Play size={12} /> Resume
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
