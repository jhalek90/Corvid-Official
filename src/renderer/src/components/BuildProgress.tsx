import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Ban, Bot, Check, Circle, CircleAlert, CircleDot, ClipboardList, Clock, FileDiff, FolderOpen, Hand, Loader, MessageSquare, Minus, ShieldAlert, Square, Terminal, X } from 'lucide-react'
import type { ExtensionRecord } from '@shared/extensions'
import { buildProgress, END_WORDS, fmtMinutes, STAGES, type BuildProgress, type LineSource, type LiveAgent, type StageState, type TouchedFile } from '@shared/buildProgress'
import { fmtTokens } from '@shared/costEstimate'
import type { BoardMessage } from '@shared/board'
import type { Worker } from '@shared/types'
import { api } from '../api'
import { editTask, getState, openTerminal, setState, toast, useStore } from '../store'
import { relTime } from '../format'
import { InfoTip } from './Tooltip'
import '../buildProgress.css'

// Live build progress for an extension (#108, docs/EXTENSIONS.md "Build progress"): a compact form for the card and the
// full panel on the extension's page. It reads the ledger record (#98's build, #97's cost), the build agent's own
// report_progress milestones, and what the Agents page already knows (the worker, its status, its activity feed, its
// session's tokens, the board). Display and Stop build only: approving and merging stay on #98's review screen.

const SOURCE_WORDS: Record<LineSource, string> = { agent: 'the agent', corvid: 'Corvid', inferred: 'its activity' }
const AGENT_WORDS: Record<BuildProgress['agent'], string> = {
  working: 'Working',
  idle: 'Idle',
  'needs-you': 'Needs you',
  starting: 'Starting',
  ended: 'Ended',
  none: 'Not started'
}

/** The build's worker (the record's, else the newest on its task), and what its card shows. */
function useBuild(record: ExtensionRecord, checkTexts?: string[]): { p: BuildProgress | null; worker?: Worker; posts: BoardMessage[] } {
  const b = record.build
  const workers = useStore((s) => s.assistant.workers)
  const liveSessions = useStore((s) => s.liveSessions)
  const activity = useStore((s) => s.activity)
  const sessions = useStore((s) => s.sessions)
  const board = useStore((s) => s.board.messages)
  const capMultiple = useStore((s) => s.config?.extensionCapMultiple ?? 2)
  const [capAsking, setCapAsking] = useState(false)
  const [now, setNow] = useState(Date.now())
  const building = b?.state === 'building'
  useEffect(() => {
    if (!building) return
    let live = true
    const tick = (): void => {
      setNow(Date.now())
      void api.extensionBuildLive().then((r) => live && setCapAsking(r.capAsking))
    }
    tick()
    const t = setInterval(tick, 5000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [building])
  const worker = b?.taskId === undefined ? undefined : (workers.find((w) => w.id === b.workerId) ?? [...workers].reverse().find((w) => w.taskId === b.taskId))
  const posts = useMemo(() => (b?.taskId === undefined ? [] : board.filter((m) => m.taskId === b.taskId && m.author !== 'user' && m.ts >= (b.startedAt ?? 0)).slice(-5)), [board, b?.taskId, b?.startedAt])
  const p = useMemo(() => {
    const sid = worker?.sessionId
    const ls = worker ? liveSessions.find((l) => l.termId === worker.termId || (sid && l.sessionId === sid)) : undefined
    const a = sid ? activity[sid] : undefined
    // an unanswered question to the user from this build's agent (a later user post replying to it answers it)
    const asked = [...posts].reverse().find((m) => m.question)
    const answered = asked && board.some((m) => m.author === 'user' && m.replyTo === asked.id)
    const live: LiveAgent = {
      state: worker?.state,
      status: worker?.state === 'running' ? ((ls?.status ?? worker.liveStatus) as LiveAgent['status']) : worker ? 'exited' : undefined,
      events: a?.events,
      outputTokens: sid ? sessions[sid]?.tokens.output : undefined,
      capAsking: building && capAsking,
      question: asked && !answered ? asked.text : undefined
    }
    return buildProgress(record, live, now, capMultiple, checkTexts ?? [])
  }, [record, worker, liveSessions, activity, sessions, posts, board, capAsking, now, capMultiple, checkTexts, building])
  return { p, worker, posts }
}

const STAGE_ICON: Record<StageState, ReactNode> = {
  done: <Check size={12} />,
  current: <CircleDot size={12} />,
  pending: <Circle size={12} />,
  skipped: <Minus size={12} />
}
const STATE_WORDS: Record<StageState, string> = { done: 'done', current: 'now', pending: 'not yet', skipped: 'not seen' }

/** A thin stage indicator: one segment per stage, filled up to the current one. Not a percentage. */
function StageBar({ p }: { p: BuildProgress }): ReactNode {
  return (
    <div className={`bp-bar${p.end ? ` e-${p.end}` : ''}`} role="img" aria-label={`Stage: ${STAGES.find((s) => s.id === p.current)?.label}`}>
      {p.stages.map((s) => (
        <span key={s.id} className={`bp-seg ${s.state}`} title={s.label} />
      ))}
    </div>
  )
}

const stageWord = (p: BuildProgress): string => (p.end ? END_WORDS[p.end] : (STAGES.find((s) => s.id === p.current)?.label ?? ''))

function tokensText(p: BuildProgress): string | null {
  const t = p.tokens
  if (!t?.likely) return t?.used !== undefined ? `${fmtTokens(t.used)} output tokens` : null
  const cap = t.cap ? `, cap ${fmtTokens(t.cap)}` : ''
  return t.used !== undefined ? `${fmtTokens(t.used)} of about ${fmtTokens(t.likely)} output tokens (estimate)${cap}` : `Estimate about ${fmtTokens(t.likely)} output tokens${cap}; none measured yet`
}

/** The card's compact form: the stage, a thin indicator, elapsed time, cost against the estimate and the cap, and the
 *  agent's state. Shown while building and for a build that just stopped; nothing to click (the card opens the page). */
export function BuildChip({ record }: { record: ExtensionRecord }): ReactNode {
  const { p } = useBuild(record)
  const b = record.build
  if (!p || !b || (b.state !== 'building' && b.state !== 'failed')) return null
  const over = p.tokens?.cap !== undefined && (p.tokens.used ?? 0) > p.tokens.cap
  return (
    <div className={`bp-chip${p.needsYou ? ' needs' : ''}`}>
      <div className="bp-chip-top">
        {p.needsYou ? <Hand size={12} /> : b.state === 'building' ? <Loader size={12} className="bp-spin" /> : <CircleAlert size={12} />}
        <b>{stageWord(p)}</b>
        {b.state === 'building' && <span className={`bp-agent a-${p.agent}`}>{AGENT_WORDS[p.agent]}</span>}
      </div>
      <StageBar p={p} />
      <div className="bp-chip-meta">
        {p.elapsedMs !== undefined && (
          <span>
            <Clock size={11} /> {fmtMinutes(p.elapsedMs)}
          </span>
        )}
        {tokensText(p) && <span className={over ? 'bp-over' : ''}>{tokensText(p)}</span>}
      </div>
    </div>
  )
}

const groupFiles = (files: TouchedFile[]): [string, TouchedFile[]][] => {
  const m = new Map<string, TouchedFile[]>()
  for (const f of files) m.set(f.areaLabel, [...(m.get(f.areaLabel) ?? []), f])
  return [...m.entries()]
}

/** The live build panel on the extension's page, and the build log once it has finished. */
export function BuildProgressPanel({ record, checks }: { record: ExtensionRecord; checks?: string[] }): ReactNode {
  const b = record.build
  const { p, worker, posts } = useBuild(record, checks)
  const [files, setFiles] = useState<TouchedFile[] | null>(null)
  const [diff, setDiff] = useState<string | null>(null)
  const building = b?.state === 'building'
  useEffect(() => {
    if (!b || b.state === 'discarded') return
    let live = true
    const load = (): void => void api.extensionBuildFiles(record.key).then((r) => live && setFiles('error' in r ? null : r.files))
    load()
    if (!building) return () => void (live = false)
    const t = setInterval(load, 15_000)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [record.key, building, b?.tip, b?.worktree])
  if (!b || !p) return null

  const stop = async (): Promise<void> => {
    if (!window.confirm(`Stop the build of "${record.name}"? The agent ends, and its branch and the work so far are kept (the same as Stop at the budget cap). You can retry or discard it afterwards.`)) return
    const r = await api.extensionStopBuild(record.key)
    toast('error' in r ? r.error : r.message, 'error' in r ? 'error' : 'info')
  }
  const task = (): void => {
    const t = getState().tasks.find((x) => x.id === b.taskId)
    if (t) editTask(t)
    else setState({ view: 'tasks' })
  }
  const showDiff = async (): Promise<void> => {
    const r = await api.extensionBuildDiff(record.key)
    setDiff('error' in r ? r.error : r.text + (r.truncated ? '\n\n(cut off at 2 MB)' : ''))
  }
  const running = worker?.state === 'running'
  const flagged = (files ?? []).filter((f) => f.protected)

  // a finished build keeps a short build log: stages with times, cost, checks
  if (!building) {
    const done = p.stages.filter((s) => s.ms !== undefined)
    return (
      <section className="ext-sec bp-log">
        <h3>Build log</h3>
        <ol className="bp-stages compact">
          {p.stages
            .filter((s) => s.state !== 'pending')
            .map((s) => (
              <li key={s.id} className={s.state}>
                {STAGE_ICON[s.state]} {s.label}
                {s.ms !== undefined && <span className="bp-time">{fmtMinutes(s.ms)}</span>}
              </li>
            ))}
          {p.end && (
            <li className="end">
              <Ban size={12} /> {END_WORDS[p.end]}
            </li>
          )}
        </ol>
        <p className="ext-small">
          {p.timeText ? `The build ${p.timeText}. ` : ''}
          {tokensText(p) ? `${tokensText(p)}. ` : ''}
          {p.checksSummary ? `Checks: ${p.checksSummary}.` : ''}
          {!done.length && ' No stage times were recorded.'}
        </p>
        {p.end === 'interrupted' && (
          <p className="bp-interrupted">
            <CircleAlert size={13} /> Build interrupted: Corvid restarted while it ran. It was at "{STAGES.find((s) => s.id === p.current)?.label}"
            {p.elapsedMs !== undefined ? ` after ${fmtMinutes(p.elapsedMs)}` : ''}
            {files?.length ? `, with ${files.length} file${files.length === 1 ? '' : 's'} touched` : ''}. {b.branch ? `The branch ${b.branch} is kept.` : ''} Retry,
            discard or open the branch below.
          </p>
        )}
        {p.end === 'no-report' && (
          <p className="bp-interrupted">
            <CircleAlert size={13} /> The build agent ended without sending its report, so there is nothing to review. The branch is kept.
          </p>
        )}
      </section>
    )
  }

  return (
    <section className={`ext-sec bp-panel${p.needsYou ? ' needs' : ''}`}>
      <div className="bp-head">
        <h3>
          <Loader size={14} className="bp-spin" /> Building: {stageWord(p)}
        </h3>
        <span className={`bp-agent a-${p.agent}`}>
          <Bot size={12} /> {worker?.agentName ?? 'Build agent'}: {AGENT_WORDS[p.agent]}
        </span>
      </div>

      {p.needsYou && (
        <div className="bp-needs" role="alert">
          <Hand size={15} />
          <div>
            <b>Needs you.</b> {p.needsYou}
            {running && worker && (
              <button className="btn sm" onClick={() => openTerminal(worker.termId)}>
                <Terminal size={13} /> Open the agent
              </button>
            )}
          </div>
        </div>
      )}
      {worker && worker.state !== 'running' && (
        <p className="bp-interrupted">
          <CircleAlert size={13} /> The build agent has ended ({worker.reason ?? worker.state}) and no build report has arrived.
        </p>
      )}

      <ol className="bp-stages">
        {p.stages.map((s) => (
          <li key={s.id} className={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
            {STAGE_ICON[s.state]} <span>{s.label}</span>
            <span className="bp-time">{s.ms !== undefined ? fmtMinutes(s.ms) : STATE_WORDS[s.state]}</span>
          </li>
        ))}
      </ol>

      <p className="ext-small bp-numbers">
        {p.timeText && (
          <span>
            <Clock size={12} /> {p.timeText}
          </span>
        )}
        {tokensText(p) && <span>{tokensText(p)}</span>}
      </p>

      <div className="ext-buttons">
        <button className="btn sm danger" onClick={() => void stop()} title="Ends the agent and keeps its branch and the work so far">
          <Square size={13} /> Stop build
        </button>
        {worker && running && (
          <button className="btn sm" onClick={() => openTerminal(worker.termId)} title="Its terminal, to type to it">
            <Terminal size={13} /> Open the agent
          </button>
        )}
        <button className="btn sm" onClick={() => setState({ view: 'terminals', agentsPane: 'cards' })} title="Its card on the Agents page">
          <Bot size={13} /> Agents page
        </button>
        {b.taskId !== undefined && (
          <button className="btn sm" onClick={task}>
            <ClipboardList size={13} /> Open task #{b.taskId}
          </button>
        )}
      </div>

      <div className="bp-cols">
        <div>
          <h4>Activity</h4>
          <ul className="bp-lines">
            {p.lines.map((l, i) => (
              <li key={i}>
                <span className="bp-when">{relTime(l.at)}</span> {l.text} <span className={`bp-src s-${l.source}`}>from {SOURCE_WORDS[l.source]}</span>
              </li>
            ))}
            {!p.lines.length && <li className="muted">Nothing yet.</li>}
          </ul>
          {(b.progress?.dropped ?? 0) > 0 && <p className="ext-small">{b.progress!.dropped} progress reports were dropped for coming too fast.</p>}
        </div>
        <div>
          <h4>Acceptance checks</h4>
          {p.checksSummary && <p className="ext-small">{p.checksSummary}</p>}
          <ul className="bp-checks">
            {p.checks.map((c) => (
              <li key={c.check} className={`c-${c.state}`}>
                {c.state === 'pass' ? <Check size={12} /> : c.state === 'fail' ? <X size={12} /> : <Circle size={12} />}
                <span>
                  {c.check}. {c.text ?? ''} <b>{c.state === 'pass' ? 'passing' : c.state === 'fail' ? 'failing' : c.state === 'not-run' ? 'not run' : 'pending'}</b>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>

      <h4>
        Files touched so far {files && `(${files.length})`}
        <span className="ext-small"> from its worktree</span>
      </h4>
      {flagged.length > 0 && (
        <p className="inst-block">
          <ShieldAlert size={13} /> {flagged.length} protected path{flagged.length === 1 ? '' : 's'}: {flagged.map((f) => `${f.path} (${f.allowed ? 'allowed: tier 3, confirmed' : 'not allowed: needs a confirmed tier-3 build of that area'})`).join('; ')}
        </p>
      )}
      {files && files.length > 0 ? (
        <div className="bp-files">
          {groupFiles(files).map(([area, fs]) => (
            <div key={area}>
              <b>{area}</b> ({fs.length})
              <ul>
                {fs.slice(0, 30).map((f) => (
                  <li key={f.path} className={f.protected ? 'prot' : ''}>
                    <code>{f.path}</code>
                    {!f.committed && <span className="ext-small"> not committed</span>}
                    {f.protected && <ShieldAlert size={11} aria-label="protected path" />}
                  </li>
                ))}
                {fs.length > 30 && <li className="ext-small">and {fs.length - 30} more</li>}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <p className="ext-small">{files ? 'None yet.' : 'Reading the worktree...'}</p>
      )}

      {posts.length > 0 && (
        <>
          <h4>
            <MessageSquare size={13} /> Its board posts
          </h4>
          <ul className="bp-posts">
            {posts.map((m) => (
              <li key={m.id}>
                <span className="bp-when">{relTime(m.ts)}</span> {m.question && <b>Question: </b>}
                {m.text.slice(0, 400)}
              </li>
            ))}
          </ul>
        </>
      )}

      <p className="ext-small bp-branch">
        {b.branch && (
          <>
            Branch <code>{b.branch}</code>
          </>
        )}
        {b.worktree && (
          <button className="btn ghost sm" onClick={() => void api.openFolder(b.worktree!)}>
            <FolderOpen size={13} /> Open the worktree
          </button>
        )}
        {b.worktree && (
          <button className="btn ghost sm" onClick={() => void showDiff()}>
            <FileDiff size={13} /> The diff so far (read only)
          </button>
        )}
      </p>
      {diff !== null && <pre className="inst-diff">{diff}</pre>}
      <p className="ext-small">
        You approve and merge on the review screen{' '}
        <InfoTip tip="Approving and merging happen on the review screen once the build reports. This panel only shows the build and can stop it. Progress stays on this PC." />
      </p>
    </section>
  )
}
