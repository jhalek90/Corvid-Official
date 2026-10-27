import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject } from 'react'
import {
  AtSign,
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  CircleStop,
  GitBranch,
  Hourglass,
  ListTodo,
  LoaderCircle,
  Maximize2,
  Minimize2,
  RotateCcw,
  Search,
  Sparkles,
  Terminal,
  X
} from 'lucide-react'
import type { SessionSummary, TerminalInfo, Worker } from '@shared/types'
import { needsYou, useAgents, type Agent, type AgentStatus, type Origin } from '../agents'
import { baseName } from '@shared/projects'
import { cardModel, displayModel } from '@shared/models'
import { api } from '../api'
import { closeTerminalTab, getState, hasTermTab, launch, mentionOnBoard, newSession, openTerminal, setState, toggleInline, useStore } from '../store'
import { normKey } from '@shared/projectList'
import { TermSlot, dropGoneTerminals } from '../components/AgentTerminal'
import { MessageBoard } from '../components/MessageBoard'
import { ErrorBoundary } from '../components/ErrorBoundary'
import { Approvals } from '../components/Approvals'
import { AgentsSummary, OverLimit, StopAll } from '../components/AgentsSummary'
import { OtherSessions, RecentSessions } from '../components/OtherSessions'
import { ContextTag } from '../components/bits'
import { prettyModel } from '../components/Assistant'
import { AgentAvatar, AV, workerLook } from '../components/AgentAvatar'
import { unreadFor } from '@shared/board'
import { clockTip } from '@shared/workerClock'
import { relTime } from '../format'
import { toolIcon } from '../feed'
import { useNow } from './UsageView'
import { setScope, useInScope, useScope } from '../scope'
import { ScopeChip } from '../components/ProjectSwitcher'
import { PackagerAgentCard } from '../components/PackagerWizard'
import { InfoTip } from '../components/Tooltip'
import { keyLabel } from '../keys'

const LABEL: Record<AgentStatus, string> = { waiting: 'Needs you', blocked: 'Needs you', busy: 'Working', starting: 'Starting', idle: 'Idle', exited: 'Exited' }

/** An ended worker's status word: how it ended. */
const ENDED: Record<Worker['state'], string> = { stopped: 'Stopped', finished: 'Finished', exited: 'Exited', running: 'Exited' }

const ORIGIN: Record<Origin, { label: string; tip: string }> = {
  worker: { label: 'Worker', tip: 'Started by Corvid to work on a task' },
  resumed: { label: 'Resumed', tip: 'A session you resumed here' },
  fork: { label: 'Fork', tip: 'A fork of an earlier session' },
  new: { label: 'New', tip: 'A fresh session started here' },
  shell: { label: 'Shell', tip: 'A plain shell' }
}

/** Below this width the cards and the board take turns, with a toggle, instead of sharing the view. */
const NARROW = 760

function useNarrow(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => el.clientWidth > 0 && setNarrow(el.clientWidth < NARROW))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, narrow]
}

/** Cards / Board, for a narrow window. */
function PaneSwitch(): ReactNode {
  const pane = useStore((s) => s.agentsPane)
  const unread = useStore((s) => unreadFor(s.board).length)
  return (
    <div className="seg ag-switch">
      <button className={pane === 'cards' ? 'on' : ''} onClick={() => setState({ agentsPane: 'cards' })}>
        Cards
      </button>
      <button className={pane === 'board' ? 'on' : ''} onClick={() => setState({ agentsPane: 'board' })}>
        Board{unread > 0 && <span className="ag-switch-n">{unread}</span>}
      </button>
    </div>
  )
}

/** Below this an inline terminal is too narrow to read, and the card offers its tab instead. */
const TERM_MIN = 240

/**
 * Agents (resumed sessions and workers) as a column of cards, with the message board beside them. A card's
 * chevron opens the agent's own terminal inside the card, and Expand moves that terminal into a tab of its
 * own; closing the tab hands it back to the card. On a narrow window the cards and the board take turns
 * behind a toggle. Only open terminals have an xterm (AgentTerminal.tsx), and at most MAX_INLINE cards
 * hold one at a time.
 */
export function AgentsView({ visible }: { visible: boolean }): ReactNode {
  const [rootRef, narrow] = useNarrow()
  const pane = useStore((s) => s.agentsPane)
  const inline = useStore((s) => s.inlineTerms)
  const workers = useStore((s) => s.assistant.workers)
  const scope = useScope()
  const now = useNow(5000)

  const all = useAgents()

  // An agent that's gone takes its xterm with it.
  const ids = all.map((g) => g.t.termId).join(' ')
  useEffect(() => dropGoneTerminals(new Set(ids.split(' '))), [ids])

  // While a card holds a terminal the cards keep their places, so one doesn't move under the pointer
  // when another changes status; they sort again (Needs you first) once every terminal is folded.
  const order = useRef<string[]>([])
  const held = inline.some((id) => all.some((g) => g.t.termId === id))
  const pos = new Map(order.current.map((id, i) => [id, i]))
  const sorted = held ? [...all].sort((x, y) => (pos.get(x.t.termId) ?? 1e9) - (pos.get(y.t.termId) ?? 1e9)) : all
  order.current = sorted.map((g) => g.t.termId)

  // the project switcher (#77) narrows the cards to one project's agents
  const inScope = useInScope()
  const mine = sorted.filter((g) => inScope(agentFolder(g)))
  const agents = mine.filter((g) => g.origin !== 'shell')
  const shells = mine.filter((g) => g.origin === 'shell')

  // Ended agents fold away under the live ones. One whose terminal is open, or that was among the live cards
  // while a terminal holds them still, stays where it is until then, so nothing moves under the pointer.
  const wasLive = useRef(new Set<string>())
  const live = agents.filter((g) => g.status !== 'exited' || inline.includes(g.t.termId) || (held && wasLive.current.has(g.t.termId)))
  wasLive.current = new Set(live.map((g) => g.t.termId))
  const ended = endedOf(agents, live, workers, inScope)
  const [endedOpen, setEndedOpen] = useState(false)

  const running = agents.filter((g) => g.status !== 'exited').length
  const needs = agents.filter((g) => needsYou(g.status)).length
  const busy = agents.filter((g) => g.status === 'busy').length
  // The project only earns a spot on the card when the agents span more than one.
  const showProject = new Set(mine.map(projectOf)).size > 1

  // Wide: cards | board. Narrow: one at a time.
  const boardOnly = narrow && pane === 'board'
  const boardMode = boardOnly ? 'full' : narrow ? 'hidden' : 'full'
  const card = (g: Agent): ReactNode => (
    <ErrorBoundary key={g.t.termId} area={`Agent card: ${g.worker?.agentName ?? g.t.agentName ?? g.t.title}`}>
      <AgentCard g={g} now={now} showProject={showProject} open={inline.includes(g.t.termId)} />
    </ErrorBoundary>
  )
  const empty = running ? undefined : all.length > mine.length ? 'No agents running in this project' : 'No agents running'

  return (
    <div ref={rootRef} data-tour="agents.view" className={`agents${held ? ' has-term' : ''}${narrow ? ' narrow' : ''}${boardOnly ? ' board-only' : ''}`}>
      <div className="ag-list">
        <div className="page-head ag-head">
          <div>
            <h2>
              Agents
              <ScopeChip />
            </h2>
            <ErrorBoundary area="Agents summary">
              <AgentsSummary running={running} busy={busy} needs={needs} empty={empty} scoped={!!scope} />
            </ErrorBoundary>
          </div>
          <StopAll />
          {narrow && <PaneSwitch />}
        </div>

        <ErrorBoundary area="Agents summary">
          <OverLimit />
          <PackagerAgentCard />
          <Elsewhere all={all} />
          <Approvals />
        </ErrorBoundary>

        {live.length > 0 ? (
          <div className="ag-cards">{live.map(card)}</div>
        ) : ended.length > 0 ? null : (
          <div className="card ag-empty">
            <Bot size={28} color="var(--text-4)" />
            <div>
              <div className="ag-empty-title">
                No agents yet{' '}
                <InfoTip tip={`Agents are the Claude sessions running inside Corvid. Resume one from Recent below, a project page or search (${keyLabel('K')}), or press Automate on a task card to start a worker.`} />
              </div>
              <div className="actions">
                <button className="btn sm" onClick={() => setState({ paletteOpen: true })}>
                  <Search size={13} /> Search sessions
                </button>
                <button className="btn sm" onClick={() => setState({ view: 'tasks' })}>
                  <ListTodo size={13} /> Open tasks
                </button>
              </div>
            </div>
          </div>
        )}

        {ended.length > 0 && (
          <>
            <button
              className="section-label ag-group ag-fold"
              aria-expanded={endedOpen}
              onClick={() => setEndedOpen(!endedOpen)}
              title="Agents that stopped, finished or exited. They drop off the list after a while; mention one on the board to bring it back."
            >
              {endedOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />} Ended · {ended.length}
            </button>
            {endedOpen && (
              <div className="ag-cards ag-ended-cards">
                {ended.map((e) =>
                  e.g ? (
                    card(e.g)
                  ) : (
                    <ErrorBoundary key={e.w.id} area={`Agent card: ${e.w.agentName ?? `#${e.w.taskId}`}`}>
                      <EndedCard w={e.w} now={now} showProject={showProject} />
                    </ErrorBoundary>
                  )
                )}
              </div>
            )}
          </>
        )}

        {shells.length > 0 && (
          <>
            <div className="section-label ag-group">Shells from the old Terminals view</div>
            <div className="ag-cards">{shells.map(card)}</div>
          </>
        )}

        <OtherSessions now={now} />
        <RecentSessions now={now} />
      </div>

      <ErrorBoundary area="Message board">
        <MessageBoard mode={boardMode} active={visible} switcher={narrow ? <PaneSwitch /> : undefined} />
      </ErrorBoundary>
    </div>
  )
}

/** The folder an agent belongs to, for the project switcher: its worker's project, else its session's or terminal's folder. */
const agentFolder = (g: Agent): string => g.worker?.project || g.s?.cwd || g.t.cwd

const nameOf = (g: Agent): string | undefined => g.worker?.agentName ?? g.t.agentName

/** An ended agent: its card while its terminal (and output) is still here, else just its worker, after the tab was closed. */
type Ended = { g: Agent; w?: undefined } | { g?: undefined; w: Worker }

/**
 * The Ended group, newest first: agents whose process has ended, and ended workers whose terminal was closed. Each
 * agent shows once: an earlier run of one that's live again (resumed by a mention, #62) isn't listed, and of
 * several ended runs only the latest is. Ended workers drop out with main's clean-up (pruneEnded) as before.
 */
function endedOf(agents: Agent[], live: Agent[], workers: Worker[], inScope: (folder: string) => boolean): Ended[] {
  const shown = new Set(live.flatMap((g) => [nameOf(g) ?? g.t.termId]))
  const terms = new Set(getState().terminals.map((t) => t.termId))
  const endedAt = (e: Ended): number => (e.g ? (e.g.worker?.endedAt ?? e.g.t.createdAt) : (e.w.endedAt ?? e.w.startedAt))
  const list: Ended[] = [
    ...agents.filter((g) => !live.includes(g)).map((g) => ({ g })),
    // a worker whose terminal is gone: the user closed its card or tab, and only the worker is left
    ...workers.filter((w) => w.state !== 'running' && !terms.has(w.termId) && inScope(w.project)).map((w) => ({ w }))
  ].sort((x, y) => endedAt(y) - endedAt(x))
  return list.filter((e) => {
    const key = (e.g ? nameOf(e.g) : e.w.agentName) ?? (e.g ? e.g.t.termId : e.w.id)
    if (shown.has(key)) return false
    shown.add(key)
    return true
  })
}

/**
 * With a project chosen, what needs the user in other projects: agents waiting on them, worker approvals and
 * sessions running outside Corvid. They're never hidden without a word: this counts them, with a way back.
 */
function Elsewhere({ all }: { all: Agent[] }): ReactNode {
  const scope = useScope()
  const inScope = useInScope()
  const proposals = useStore((s) => s.assistant.proposals)
  const liveSessions = useStore((s) => s.liveSessions)
  if (!scope) return null
  const agents = all.filter((g) => needsYou(g.status) && !inScope(agentFolder(g))).length
  const approvals = proposals.filter((p) => !inScope(p.project)).length
  const outside = new Set(liveSessions.filter((l) => !l.termId && (l.status === 'waiting' || l.status === 'blocked') && !inScope(l.cwd)).map((l) => l.sessionId)).size
  const n = agents + outside
  if (!n && !approvals) return null
  const parts = [n ? `${n} more need${n === 1 ? 's' : ''} you` : '', approvals ? `${approvals} approval${approvals === 1 ? '' : 's'} waiting` : ''].filter(Boolean)
  return (
    <div className="scope-elsewhere" role="status">
      <Hourglass size={13} color="var(--warn)" />
      <span>
        <b>{parts.join(' and ')}</b> in other projects.
      </span>
      <a className="link" onClick={() => setScope(undefined)}>
        Show all projects
      </a>
    </div>
  )
}

/** Starts an exited agent again: a resume when its session is known, otherwise a fresh one. */
function restart(t: TerminalInfo, s?: SessionSummary): void {
  void api.closeTerminal(t.termId)
  if (s) void launch(s, 'resume', true)
  else void newSession(t.cwd, t.title)
}

/** Under an ended agent's final output in its tab. */
function EndedBar({ t }: { t: TerminalInfo }): ReactNode {
  const s = useStore((st) => (t.sessionId ? st.sessions[t.sessionId] : undefined))
  // closed by the dashboard after its done post (#70): not a failure
  const finished = useStore((st) => st.assistant.workers.find((w) => w.termId === t.termId && w.state === 'finished'))
  return (
    <div className="ag-ended" role="status">
      {finished ? <CircleCheck size={14} /> : <CircleStop size={14} />}
      <span className="lbl">{finished ? <b>{finished.reason ?? 'Finished'}</b> : <><b>Agent ended</b> · exit code {t.exited}</>}</span>
      {t.kind === 'claude' && (
        <button className="btn sm" onClick={() => restart(t, s)}>
          <RotateCcw size={13} /> {s ? 'Resume' : 'Start again'}
        </button>
      )}
      <button className="btn sm ghost" title="Close this tab. The output stays on its card until you remove it." onClick={() => closeTerminalTab(t.termId)}>
        <X size={13} /> Close tab
      </button>
    </div>
  )
}

/** What the agent is actually doing: its task for a worker, otherwise its session or tab title. */
function realTitle(g: Agent, name?: string): ReactNode {
  if (g.worker)
    return (
      <>
        <b className="num">#{g.worker.taskId}</b> {g.task?.title ?? g.worker.taskTitle}
      </>
    )
  const title = g.s?.title ?? g.live?.name ?? g.t.title
  // a named agent's session title ends with its name, which already shows above
  return name && title.endsWith(` · ${name}`) ? title.slice(0, -name.length - 3) : title
}

/** A named agent's crow, beside its name. Its worker's if it has one (a resumed worker's session finds
 *  it by name), else seeded from the name. Only the working card's crow moves, and only a little. */
function Face({ g, name, size, moving }: { g: Agent; name: string; size: string; moving?: boolean }): ReactNode {
  const workers = useStore((s) => s.assistant.workers)
  const w = g.worker ?? workers.find((x) => x.agentName === name)
  return <AgentAvatar look={workerLook(w, name)} name={name} size={size} moving={moving} />
}

/** The bar's one-line title: a goofy-named agent's name, then its real task. */
function barTitle(g: Agent): ReactNode {
  const name = g.worker?.agentName ?? g.t.agentName
  if (!name) return realTitle(g)
  return (
    <>
      <Face g={g} name={name} size={AV.bar} />
      {name}
      <span className="ag-real"> · {realTitle(g, name)}</span>
    </>
  )
}

function projectOf(g: Agent): string {
  const w = g.worker?.project
  // a worker in a project with several folders (3/5): the project's name and which folder it works in
  const rec = w ? getState().projects.projects.find((p) => p.folders.some((f) => normKey(f.path) === normKey(w))) : undefined
  if (rec) {
    const f = rec.folders.find((x) => normKey(x.path) === normKey(w!))!
    return rec.folders.length > 1 ? `${rec.name} · ${f.label || baseName(f.path)}` : rec.name
  }
  return g.s?.projectName ?? baseName(w ?? g.t.cwd) ?? 'session'
}

const dotOf = (st: AgentStatus): string => (needsYou(st) ? 'waiting' : st === 'busy' ? 'busy' : st === 'exited' ? 'off' : 'idle')

/** One small marker: a dot (a diamond for Needs you) and one word. `dot` off when the dot sits on the agent's crow instead. */
function Status({ g, dot = true }: { g: Agent; dot?: boolean }): ReactNode {
  const { status, live } = g
  if (g.origin === 'shell' && status !== 'exited') return null
  if (needsYou(status))
    return (
      <span className="ag-status needs" title={live?.waitingFor ? `Waiting on ${live.waitingFor}` : 'Waiting for your input'}>
        {dot && <span className="dot waiting" />} Needs you
      </span>
    )
  return (
    <span className={`ag-status ${status}`}>
      {dot && <span className={`dot ${dotOf(status)}`} />} {status === 'exited' && g.worker ? ENDED[g.worker.state] : LABEL[status]}
    </span>
  )
}

function NowLine({ g, now }: { g: Agent; now: number }): ReactNode {
  const { status, live, a, worker, t } = g
  if (t.kind === 'shell')
    return (
      <div className="ag-now">
        <Terminal size={13} />
        <span className="lbl mono">{t.cwd}</span>
      </div>
    )
  if (status === 'exited')
    return (
      <div className="ag-now">
        {worker?.state === 'finished' ? <CircleCheck size={13} /> : <CircleStop size={13} />}
        <span className="lbl">{endedLine(worker) ?? `Process exited with code ${t.exited}`}</span>
      </div>
    )
  if (needsYou(status))
    return (
      <div className="ag-now warn">
        <Hourglass size={13} />
        <span className="lbl">{live?.waitingFor ? `Waiting on ${live.waitingFor}` : 'Waiting for your input'}</span>
      </div>
    )
  if (status === 'starting')
    return (
      <div className="ag-now">
        <LoaderCircle size={13} className="spin" />
        <span className="lbl">Starting. If it stays here, open it: a folder trust prompt may be up.</span>
      </div>
    )
  const lastTool = status === 'busy' && a ? a.events.findLast((e) => e.kind === 'tool') : undefined
  if (lastTool) {
    const Icon = toolIcon(lastTool)
    return (
      <div className="ag-now busy" title={relTime(lastTool.ts, now)}>
        <Icon size={13} />
        <span className="lbl">
          {lastTool.agent ? <span className="agent-tag">{lastTool.agent}</span> : <b>{lastTool.tool}</b>} {lastTool.label}
        </span>
      </div>
    )
  }
  if (status === 'busy')
    return (
      <div className="ag-now busy">
        <Sparkles size={13} />
        <span className="lbl">Thinking…</span>
      </div>
    )
  return (
    <div className="ag-now">
      <CircleCheck size={13} />
      <span className="lbl">{a?.lastText || 'Ready for input'}</span>
    </div>
  )
}

/** Why a worker ended, in plain words, and what was kept of its branch when that matters ("… · kept 2 commits not merged into main"). */
function endedLine(w?: Worker): string | undefined {
  if (!w?.reason) return undefined
  const kept = w.git?.state === 'kept' && w.git.message ? w.git.message.replace(/^\S+ kept: /, '').replace(/\.$/, '') : ''
  return kept ? `${w.reason} · kept ${kept}` : w.reason
}

/**
 * A worker's branch and where it stands, quiet beside the details. It turns amber when the branch needs a look: work kept
 * unmerged when it ended, or a finished agent held open over unmerged work. The git message is its tooltip.
 */
function Branch({ w }: { w?: Worker }): ReactNode {
  if (!w?.branch) return null
  const st = w.git?.state
  const attn = st === 'kept' || (w.state === 'running' && !!w.closeHeld)
  const label = st === 'kept' ? 'kept' : st === 'merged' ? 'merged' : st === 'removed' ? 'cleaned up' : ''
  const tip = [w.git?.message ?? (w.closeHeld && `${w.closeHeld}.`), w.worktree && `Worktree: ${w.worktree}`].filter(Boolean).join('\n')
  return (
    <span className={`ag-branch mono${attn ? ' attn' : ''}`} title={tip || undefined}>
      <GitBranch size={11} />
      <span className="b">{w.branch}</span>
      {label && <span className="st">{label}</span>}
    </span>
  )
}

/**
 * The model the agent runs on (#234), a quiet tag in the details: a worker's model, its 'default' resolved to the Claude
 * Code default when that's known; for a session Corvid didn't start, the model its replies used, else nothing. It gives
 * way right after the branch, so the actions stay on the row. Fable, the costliest, gets a faint accent.
 */
function ModelTag({ model, effort, seen }: { model?: string; effort?: string; seen?: Record<string, number> }): ReactNode {
  const claudeDefault = useStore((s) => s.claudeDefaultModel)
  const m = cardModel(model, claudeDefault, seen)
  if (!m) return null
  const tip =
    model === 'default'
      ? `Runs on your Claude Code default model${claudeDefault ? `: ${prettyModel(claudeDefault)}` : ". Corvid couldn't read which one that is."}`
      : model
        ? `Runs on ${displayModel(model)}`
        : 'The model its replies came from'
  // its effort (#238), when it was started with one: "Opus · high"
  return (
    <span className={`ag-model${m.family === 'fable' ? ' fable' : ''}`} title={effort ? `${tip}, at ${effort} effort` : tip}>
      {effort ? `${m.label} · ${effort}` : m.label}
    </span>
  )
}

/** A finished agent's countdown to closing (#70), with Keep open, or the quiet note on why it stays open. Nothing otherwise. */
function Closing({ w }: { w?: Worker }): ReactNode {
  if (w?.state !== 'running') return null
  if (w.closeHeld)
    return (
      <span className="ag-closing" title={`${w.closeHeld}. It stays open until that's merged or cleaned up; have a look at its branch.`}>
        {w.closeHeld.split(':')[0]}
      </span>
    )
  return w.closeAt ? <Countdown id={w.id} at={w.closeAt} /> : null
}

function Countdown({ id, at }: { id: string; at: number }): ReactNode {
  const now = useNow(1000)
  const s = Math.max(0, Math.ceil((at - now) / 1000))
  return (
    <span className="ag-closing" title="It posted its done post and has gone quiet. Once closed, mention it on the board to bring it back.">
      Closing in <span className="num">{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</span>
      <button
        className="btn ghost sm"
        title="Keep it open until it works again and posts another done post"
        onClick={(e) => {
          e.stopPropagation()
          void api.keepOpen(id)
        }}
      >
        Keep open
      </button>
    </span>
  )
}

/** Stop for a running worker (its process ends, the output stays), Close to remove the terminal. */
const stop = (fn: () => void) => (e: MouseEvent) => {
  e.stopPropagation()
  fn()
}

/** Brings an ended worker back the #62 way: its name in the board's box, for the user to say what next and send. */
function ResumeByMention({ name }: { name: string }): ReactNode {
  return (
    <button className="btn ghost icon sm" title={`Resume: puts @${name} in the board's box. Say what it should do and send it to bring it back.`} onClick={stop(() => mentionOnBoard(name))}>
      <AtSign size={13} />
    </button>
  )
}

function Actions({ g, lead }: { g: Agent; lead?: ReactNode }): ReactNode {
  const { t, worker, s } = g
  return (
    <span className="ag-actions">
      {lead}
      {worker?.state === 'running' && t.exited === undefined && (
        <button
          className="btn ghost icon sm"
          title="Stop this worker. Its output stays readable here."
          aria-label="Stop"
          onClick={stop(() => void api.stopWorker(worker.id))}
        >
          <CircleStop size={13} />
        </button>
      )}
      {t.exited !== undefined && t.kind === 'claude' && (worker?.agentName ? <ResumeByMention name={worker.agentName} /> : (
        <button className="btn ghost icon sm" title={s ? 'Resume it again' : 'Start it again'} onClick={stop(() => restart(t, s))}>
          <RotateCcw size={13} />
        </button>
      ))}
      {(!worker || worker.state !== 'running' || t.exited !== undefined) && (
        <button
          className="btn ghost icon sm"
          title={t.exited === undefined ? 'Close: ends this process and removes its terminal' : 'Remove from the list'}
          onClick={stop(() => {
            void api.closeTerminal(t.termId)
            if (worker && worker.state !== 'running') void api.dismissWorker(worker.id)
          })}
        >
          <X size={13} />
        </button>
      )}
    </span>
  )
}

/**
 * Description first (the name, then the task under it), then what it's doing, then status and context
 * as small details. Project and origin, which used to head the card, live in its tooltip. A named
 * agent's card leads with its crow, the name and status word beside it and the task under them; the
 * status dot moves onto the crow's corner, so the card gains no row. The chevron in the foot opens the
 * agent's terminal under all that, inside the same card; clicking the card opens it too, but only the
 * chevron folds it, so a stray click never closes a terminal someone was reading.
 */
function AgentCard({ g, now, showProject, open }: { g: Agent; now: number; showProject: boolean; open: boolean }): ReactNode {
  const name = g.worker?.agentName ?? g.t.agentName
  const tabbed = useStore((s) => hasTermTab(s, g.t.termId))
  const limitMin = useStore((s) => s.config?.limits.workerMinutes ?? 45)
  const id = g.t.termId
  // a worker's real working time sits in the tooltip, off the card itself (#43, #81); its model is on the card (#234)
  const clock = g.worker ? ` ${clockTip(g.worker, now, limitMin)}` : ''
  const show = (): void => {
    if (window.getSelection()?.toString()) return // the end of a text selection, not a click
    if (tabbed) openTerminal(id)
    else if (!open) toggleInline(id, true)
  }
  const onKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
    e.preventDefault()
    show()
  }
  const lead = (
    <>
      <button className="btn ghost icon sm" title="Open in its own tab" aria-label="Expand to a tab" onClick={stop(() => openTerminal(id))}>
        <Maximize2 size={13} />
      </button>
      <button
        className="btn ghost icon sm"
        title={open ? 'Hide the terminal. The agent keeps running.' : 'Show the terminal'}
        aria-label={open ? 'Hide terminal' : 'Show terminal'}
        aria-expanded={open}
        onClick={stop(() => toggleInline(id))}
      >
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
    </>
  )
  return (
    <div
      className={`agcard ${g.status}${g.status === 'exited' ? ' ended' : ''}${open ? ' term-open' : ''}`}
      data-tour="agents.worker-card"
      data-term={id}
      role="button"
      tabIndex={0}
      title={`${projectOf(g)} · ${ORIGIN[g.origin].tip}.${clock} ${tabbed ? 'Click to go to its tab.' : open ? 'Its terminal is open below.' : 'Click to show its terminal.'}`}
      onClick={show}
      onKeyDown={onKey}
    >
      {name ? (
        <div className="ag-head">
          <span className="ag-face">
            <Face g={g} name={name} size={AV.card} moving={g.status === 'busy'} />
            <span className={`dot ${dotOf(g.status)}`} />
          </span>
          <div className="ag-head-main">
            <div className="ag-title ag-name">
              <span>{name}</span>
              <Status g={g} dot={false} />
            </div>
            <div className="ag-desc">{realTitle(g, name)}</div>
          </div>
        </div>
      ) : (
        <div className="ag-title">{realTitle(g)}</div>
      )}
      <NowLine g={g} now={now} />
      <div className="ag-foot">
        {!name && <Status g={g} />}
        {g.s && <ContextTag s={g.s} />}
        <ModelTag model={g.worker?.model} effort={g.worker?.effort} seen={g.s?.models} />
        <Closing w={g.worker} />
        <Branch w={g.worker} />
        {showProject && <span className="ag-proj">{projectOf(g)}</span>}
        <Actions g={g} lead={lead} />
      </div>
      {open && <InlineTerminal g={g} tabbed={tabbed} />}
    </div>
  )
}

/**
 * An ended worker whose terminal is gone (its card or tab was closed): the same card, ended style, from what the
 * worker list remembers. Nothing to open; Resume puts its name on the board (#62), Remove takes it off the list.
 */
function EndedCard({ w, now, showProject }: { w: Worker; now: number; showProject: boolean }): ReactNode {
  const task = useStore((s) => s.tasks.find((t) => t.id === w.taskId))
  const limitMin = useStore((s) => s.config?.limits.workerMinutes ?? 45)
  const tip = `${baseName(w.project)} · ${ORIGIN.worker.tip}. ${clockTip(w, now, limitMin)}${w.agentName ? ' Mention it on the board to bring it back.' : ''}`
  return (
    <div className="agcard exited ended" title={tip}>
      <div className="ag-head">
        {w.agentName && (
          <span className="ag-face">
            <AgentAvatar look={workerLook(w)} name={w.agentName} size={AV.card} />
            <span className="dot off" />
          </span>
        )}
        <div className="ag-head-main">
          <div className="ag-title ag-name">
            <span>{w.agentName ?? `#${w.taskId}`}</span>
            <span className="ag-status exited">{ENDED[w.state]}</span>
          </div>
          <div className="ag-desc">
            <b className="num">#{w.taskId}</b> {task?.title ?? w.taskTitle}
          </div>
        </div>
      </div>
      <div className="ag-now">
        {w.state === 'finished' ? <CircleCheck size={13} /> : <CircleStop size={13} />}
        <span className="lbl">{endedLine(w) ?? 'Ended'}</span>
      </div>
      <div className="ag-foot">
        <ModelTag model={w.model} effort={w.effort} />
        <Branch w={w} />
        {showProject && <span className="ag-proj">{baseName(w.project)}</span>}
        <span className="ag-actions">
          {w.agentName && <ResumeByMention name={w.agentName} />}
          <button className="btn ghost icon sm" title="Remove from the list" onClick={() => void api.dismissWorker(w.id)}>
            <X size={13} />
          </button>
        </span>
      </div>
    </div>
  )
}

/** The agent's own terminal inside its card. Clicks and keys stay in here, so typing never toggles the card. */
function InlineTerminal({ g, tabbed }: { g: Agent; tabbed: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [narrow, setNarrow] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current!
    const ro = new ResizeObserver(() => el.clientWidth > 0 && setNarrow(el.clientWidth < TERM_MIN))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const id = g.t.termId
  return (
    <div
      ref={ref}
      className="ag-term"
      // an empty title keeps the card's tooltip off the terminal
      title=""
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {tabbed ? (
        <div className="ag-term-note">
          <span className="lbl">Open in its own tab.</span>
          <button className="btn xs" onClick={() => openTerminal(id)}>
            Go to tab
          </button>
          <button className="btn xs ghost" title="Close the tab and show the terminal here" onClick={() => closeTerminalTab(id)}>
            Show here
          </button>
        </div>
      ) : narrow ? (
        <div className="ag-term-note">
          <span className="lbl">Too narrow to read here.</span>
          <button className="btn xs" onClick={() => openTerminal(id)}>
            <Maximize2 size={12} /> Expand
          </button>
        </div>
      ) : (
        <>
          <TermSlot term={g.t} fontSize={12} className="ag-term-slot" />
          <div className="ag-term-tools">
            {g.t.exited !== undefined && <span className="lbl">Agent ended · exit code {g.t.exited}</span>}
            <button className="btn ghost xs" title="Open in its own tab" onClick={() => openTerminal(id)}>
              <Maximize2 size={12} /> Expand
            </button>
          </div>
        </>
      )}
    </div>
  )
}

/** An agent's terminal in a tab of its own: its summary, the full-size terminal, and the Agent ended bar once it stops. */
export function AgentTab({ termId }: { termId: string }): ReactNode {
  const g = useAgents().find((x) => x.t.termId === termId)
  // a removed agent's tab closes on the next terminals update
  if (!g) return <div className="pane-body" />
  return (
    <div className="pane-body ag-tab">
      <AgentBar g={g} />
      <div className="ag-tab-term">
        <TermSlot term={g.t} fontSize={13} focus />
      </div>
      {g.t.exited !== undefined && <EndedBar t={g.t} />}
    </div>
  )
}

/** The tab's label: the agent's crow and name (or its title), and a status dot. */
export function AgentTabLabel({ termId }: { termId: string }): ReactNode {
  const g = useAgents().find((x) => x.t.termId === termId)
  if (!g) return <span className="t">Terminal</span>
  const name = g.worker?.agentName ?? g.t.agentName
  return (
    <>
      {name ? <Face g={g} name={name} size="16px" /> : <Terminal size={13} strokeWidth={1.75} />}
      <span className="t">{name ?? g.s?.title ?? g.t.title}</span>
      <span className={`dot ${dotOf(g.status)}`} />
    </>
  )
}

/** The tab's summary above its terminal. */
function AgentBar({ g }: { g: Agent }): ReactNode {
  return (
    <div className={`ag-bar ${g.status}`}>
      <div className="ag-bar-main">
        <div className="ag-title">{barTitle(g)}</div>
        <div className="ag-bar-meta">
          <span>{projectOf(g)}</span>
          <span>{ORIGIN[g.origin].label}</span>
          {g.worker?.branch && (
            <span className="mono" title={[g.worker.worktree && `Worktree: ${g.worker.worktree}`, g.worker.git?.message].filter(Boolean).join('\n')}>
              {g.worker.branch}
              {g.worker.git && g.worker.git.state !== 'working' ? ` · ${g.worker.git.state}` : ''}
            </span>
          )}
          {g.s && <ContextTag s={g.s} />}
        </div>
      </div>
      <Status g={g} />
      <Actions g={g} />
      <button
        className="btn ghost icon sm"
        title="Back to its card: closes this tab and shows the terminal there. The agent keeps running."
        onClick={() => {
          toggleInline(g.t.termId, true)
          closeTerminalTab(g.t.termId)
          setState({ view: 'terminals', agentsPane: 'cards' })
        }}
      >
        <Minimize2 size={14} />
      </button>
    </div>
  )
}
