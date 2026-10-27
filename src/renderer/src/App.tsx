import { useEffect, type ReactNode } from 'react'
import { FolderTree, MessageCircle, Moon, Search, Settings, Sun, Terminal, TriangleAlert } from 'lucide-react'
import { DEFAULT_DARK, DEFAULT_LIGHT, isThemeId, themeDef } from '@shared/themes'
import { api } from './api'
import { askCorvid, getState, launch, moveShellToSide, setState, shownShells, terminalKey, toggleExplorer, toggleTheme, useStore, type View } from './store'
import { useNow } from './views/UsageView'
import { TaskEditor } from './views/TasksView'
import { CommandPalette } from './components/CommandPalette'
import { DOCS_SEARCH_EVENT } from './views/DocsView'
import { RemoteApprovalDialog } from './components/RemoteSystems'
import { Explorer } from './components/Explorer'
import { SideTerminal } from './components/SideTerminal'
import { AgentBirds, Crow } from './components/Crow'
import { TourPlayer } from './components/TourPlayer'
import { TourButton } from './components/TourMenu'
import { ContextMenu } from './components/ContextMenu'
import { TooltipLayer } from './components/Tooltip'
import { Panes, VIEW_META, dragged, endDrag, openInSplit, useDrag } from './components/Panes'
import { focusedView, isShellTab, paneOf, shellIdOf, visibleViews } from './panes'
import { Sparkline, severity } from './components/charts'
import { statusLabel, whereLabel } from './components/bits'
import { until } from './format'
import { allModelsWeek, fableWeek } from '@shared/models'
import { forUser, unreadFor } from '@shared/board'
import { EmojiText } from './emoji'
import { Ticker } from './components/Ticker'
import { ProjectSwitcher } from './components/ProjectSwitcher'
import { useUnfiledNew } from './views/Unfiled'
import { RelocateDialog } from './components/RelocateDialog'
import { ErrorBoundary } from './components/ErrorBoundary'
import { ImportResults, useExtensionDrop } from './views/ExtensionsView'
import { UpdateBanner } from './components/UpdateBanner'
import { ctrlLabel, keyLabel, mod, platform } from './keys'

const NAV: View[] = ['terminals', 'tasks', 'usage', 'projects', 'notes', 'connections', 'extensions', 'docs', 'lineage']
/** Ctrl+1…8: the first five nav entries, Settings (6, as before the Connections tab came), Connections (7), then
 *  Extensions (8). */
const SHORTCUTS: View[] = ['terminals', 'tasks', 'usage', 'projects', 'notes', 'settings', 'connections', 'extensions']

export function App(): ReactNode {
  // The rail marks the focused pane's view, and more faintly the views showing in other panes.
  const view = useStore((s) => focusedView(s.layout))
  const shown = new Set(useStore((s) => visibleViews(s.layout).join(' ')).split(' '))
  const paletteOpen = useStore((s) => s.paletteOpen)
  const terminals = useStore((s) => s.terminals)
  const toast = useStore((s) => s.toast)
  // open tasks: Done ones are finished (#138)
  const taskCount = useStore((s) => s.tasks.filter((t) => t.column !== 'done').length)
  const unreadNotes = useStore((s) => s.notes.filter((n) => n.unread).length)
  const unfiledNew = useUnfiledNew()
  const boardNew = useStore((s) => unreadFor(s.board).length)
  const boardToYou = useStore((s) => unreadFor(s.board).some(forUser))
  const explorerOpen = useStore((s) => s.explorerOpen)
  // the Terminal button is on while a shell shows, in the side panel or a pane (#111)
  const shellShown = useStore((s) => shownShells(s).length > 0)
  // a shell dragged out of a pane can be dropped on the Terminal button to dock it in the side panel
  const drag = useDrag()
  const layout = useStore((s) => s.layout)
  const shellDrag = drag?.kind === 'tab' && isShellTab(drag.view) && paneOf(layout, drag.view) ? shellIdOf(drag.view) : undefined
  // connector approvals and commands waiting for the user (#88): a count on the Connections tab
  const approvalsWaiting = useStore((s) => s.remote.approvals.length)
  const draftsWaiting = useStore((s) => s.remote.drafts ?? 0)
  const liveSessions = useStore((s) => s.liveSessions)
  // worker proposals waiting in the Agents view count as agents that need the user
  const proposals = useStore((s) => s.assistant.proposals.length)
  useExtensionDrop()

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        // in the Docs view it goes to the docs' own search box (#188); the palette finds docs pages too
        if (focusedView(getState().layout) === 'docs' && !getState().paletteOpen) window.dispatchEvent(new Event(DOCS_SEARCH_EVENT))
        else setState((s) => ({ paletteOpen: !s.paletteOpen }))
      } else if (mod(e) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'j') {
        // Talk to Corvid: the board with its message box set to Corvid, from any view
        e.preventDefault()
        askCorvid()
      } else if (mod(e) && /^[1-8]$/.test(e.key)) {
        const v = SHORTCUTS[Number(e.key) - 1]
        if (v) {
          e.preventDefault()
          setState({ view: v })
        }
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Agents: the Claude terminals in the Agents view; the badge turns amber when one needs you.
  const agentIds = new Set(terminals.filter((t) => !t.side && t.kind === 'claude' && t.exited === undefined).map((t) => t.termId))
  const agentsNeed =
    liveSessions.filter((l) => l.termId && agentIds.has(l.termId) && (l.status === 'waiting' || l.status === 'blocked')).length + proposals

  return (
    <div className="app">
      <TitleBar />
      <nav className="rail" data-tip-side="right">
        {NAV.map((v) => {
          const { icon: Icon, label } = VIEW_META[v]
          return (
            <button
              key={v}
              data-view={v}
              data-tour={`nav.${v}`}
              className={`rail-btn${view === v ? ' active' : shown.has(v) ? ' shown' : ''}`}
              data-tip={
                v === 'terminals' && (agentsNeed || boardNew)
                  ? [
                      label,
                      agentsNeed ? `${agentsNeed} need${agentsNeed === 1 ? 's' : ''} you${proposals ? ` (${proposals} awaiting approval)` : ''}` : '',
                      boardNew ? `${boardNew} new on the board${boardToYou ? ', some for you' : ''}` : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : v === 'notes' && unreadNotes
                    ? `${label} · ${unreadNotes} new from agents`
                    : v === 'connections' && (approvalsWaiting || draftsWaiting)
                    ? [label, approvalsWaiting ? `${approvalsWaiting} waiting for your approval` : '', draftsWaiting ? `${draftsWaiting} proposed by agents` : ''].filter(Boolean).join(' · ')
                    : v === 'projects' && unfiledNew
                      ? `${label} · ${unfiledNew} new unfiled folder${unfiledNew === 1 ? '' : 's'}`
                      : label
              }
              onClick={(e) => {
                if (v === 'projects') setState({ selectedProject: undefined })
                if (e.shiftKey) openInSplit(v)
                else setState({ view: v })
              }}
              // a middle-click opens it the other way, like a Ctrl+click (#109; store.ts placement)
              onMouseDown={(e) => e.button === 1 && e.preventDefault()}
              onAuxClick={(e) => {
                if (e.button !== 1) return
                if (v === 'projects') setState({ selectedProject: undefined })
                setState({ view: v })
              }}
            >
              <Icon size={18} strokeWidth={1.75} />
              {v === 'terminals' && (agentIds.size > 0 || proposals > 0) && <span className={`badge${agentsNeed ? ' warn' : ''}`}>{agentIds.size || proposals}</span>}
              {v === 'terminals' && boardNew > 0 && <span className={`rail-dot${boardToYou ? ' you' : ''}`} />}
              {v === 'tasks' && taskCount > 0 && <span className="badge">{taskCount}</span>}
              {v === 'notes' && unreadNotes > 0 && <span className="badge">{unreadNotes}</span>}
              {v === 'projects' && unfiledNew > 0 && <span className="badge">{unfiledNew}</span>}
              {v === 'connections' && approvalsWaiting + draftsWaiting > 0 && <span className={`badge${approvalsWaiting ? ' warn' : ''}`}>{approvalsWaiting + draftsWaiting}</span>}
            </button>
          )
        })}
        <div className="rail-sep" />
        <button className={`rail-btn${explorerOpen ? ' on' : ''}`} data-tip={`Files (${keyLabel('B')})`} onClick={() => toggleExplorer()}>
          <FolderTree size={18} strokeWidth={1.75} />
        </button>
        <button
          className={`rail-btn${shellShown ? ' on' : ''}${shellDrag ? ' drop' : ''}`}
          data-tip={shellDrag ? 'Drop to move to the side panel' : `Terminal (${ctrlLabel('`')})`}
          onClick={() => terminalKey(true)}
          onDragOver={(e) => {
            if (!shellDrag || dragged(e) !== drag) return
            e.preventDefault()
            e.dataTransfer.dropEffect = 'move'
          }}
          onDrop={(e) => {
            if (!shellDrag || dragged(e) !== drag) return
            e.preventDefault()
            endDrag()
            moveShellToSide(shellDrag)
          }}
        >
          <Terminal size={18} strokeWidth={1.75} />
        </button>
        <div className="rail-spacer" />
        <button
          data-tour="nav.settings"
          className={`rail-btn${view === 'settings' ? ' active' : shown.has('settings') ? ' shown' : ''}`}
          data-tip="Settings"
          onClick={(e) => (e.shiftKey ? openInSplit('settings') : setState({ view: 'settings' }))}
          onMouseDown={(e) => e.button === 1 && e.preventDefault()}
          onAuxClick={(e) => e.button === 1 && setState({ view: 'settings' })}
        >
          <Settings size={18} strokeWidth={1.75} />
        </button>
      </nav>
      <ErrorBoundary area="Explorer">
        <Explorer />
      </ErrorBoundary>
      <ErrorBoundary area="Side terminal">
        <SideTerminal />
      </ErrorBoundary>
      <Panes />
      <ErrorBoundary area="Ticker" floating>
        <Ticker />
      </ErrorBoundary>
      {paletteOpen && (
        <ErrorBoundary area="Search" floating onReset={() => setState({ paletteOpen: false })}>
          <CommandPalette />
        </ErrorBoundary>
      )}
      <ErrorBoundary area="Dialogs" floating>
        <ConflictDialog />
        <RelocateDialog />
        <RemoteApprovalDialog />
        <ImportResults />
      </ErrorBoundary>
      <ErrorBoundary area="Task editor" floating onReset={() => setState({ taskEditor: undefined })}>
        <TaskEditor />
      </ErrorBoundary>
      <ErrorBoundary area="Crows" floating>
        <Crow />
        <AgentBirds />
      </ErrorBoundary>
      <ErrorBoundary area="Guided tour" floating>
        <TourPlayer />
      </ErrorBoundary>
      <ContextMenu />
      <TooltipLayer />
      <ErrorBoundary area="Update notice" floating>
        <UpdateBanner />
      </ErrorBoundary>
      {toast && (
        <div className={`toast ${toast.kind}`}>
          <EmojiText text={toast.text} />
          {toast.action && (
            <button
              className="btn sm"
              style={{ marginLeft: 12 }}
              onClick={() => {
                toast.action!.run()
                setState({ toast: undefined })
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TitleBar(): ReactNode {
  const quota = useStore((s) => s.quota)
  const live = useStore((s) => s.liveSessions)
  const minutes = useStore((s) => s.liveTokens?.minutes)
  const light = useStore((s) => themeDef(s.theme).kind === 'light')
  const config = useStore((s) => s.config)
  // the other pick, or the default of its kind while it's an extension theme that is gone (#114)
  const otherId = config && (light ? config.themeDark : config.themeLight)
  const other = config && themeDef(isThemeId(otherId) ? otherId : light ? DEFAULT_DARK : DEFAULT_LIGHT).name
  const now = useNow(30_000)
  const busy = live.filter((l) => l.status === 'busy').length
  const needs = live.filter((l) => l.status === 'waiting' || l.status === 'blocked').length
  const week = allModelsWeek(quota?.weeks)
  const fable = fableWeek(quota?.weeks)

  return (
    <header className="titlebar">
      <div className="brand">
        <div className="brand-mark">&gt;_</div>
        <span className="brand-name">Corvid</span>
      </div>
      <ErrorBoundary area="Project switcher">
        <ProjectSwitcher />
      </ErrorBoundary>
      <button className="search-trigger" onClick={() => setState({ paletteOpen: true })}>
        <Search size={14} />
        <span>Search sessions…</span>
        <kbd>{platform.modLabel} K</kbd>
      </button>
      <div className="title-stats">
        {minutes && (
          <div className="mini-meter" onClick={() => setState({ view: 'usage' })} title="Output tokens per minute, last 20 min">
            <Sparkline values={minutes.slice(-20).map((m) => m.output)} width={56} height={16} />
          </div>
        )}
        {quota?.session && (
          <div
            className="mini-meter"
            onClick={() => setState({ view: 'usage' })}
            title={`5-hour session · resets in ${until(quota.session.resetsAtMs, now)}`}
          >
            5h
            <div className="track">
              <div className="fill" style={{ width: `${quota.session.pct}%`, background: severity(quota.session.pct) }} />
            </div>
            <b>{quota.session.pct}%</b>
          </div>
        )}
        {week && (
          <div className="mini-meter" onClick={() => setState({ view: 'usage' })} title={`Week (${week.label}) · resets in ${until(week.resetsAtMs, now)}`}>
            wk
            <div className="track">
              <div className="fill" style={{ width: `${week.pct}%`, background: severity(week.pct) }} />
            </div>
            <b>{week.pct}%</b>
          </div>
        )}
        {fable && (
          <div className="mini-meter" onClick={() => setState({ view: 'usage' })} title={`Fable weekly limit · resets in ${until(fable.resetsAtMs, now)}`}>
            Fable
            <div className="track">
              <div className="fill" style={{ width: `${fable.pct}%`, background: severity(fable.pct) }} />
            </div>
            <b>{fable.pct}%</b>
          </div>
        )}
        <div
          className={`live-pill${live.length ? ' on' : ''}`}
          onClick={() => setState({ view: 'terminals', agentsPane: 'cards' })}
          title={`${live.map((l) => `${l.name ?? l.sessionId.slice(0, 8)}: ${statusLabel(l)}`).join('\n') || 'No live sessions'}\n\nClick for the Agents page`}
        >
          <span className={`dot ${needs ? 'waiting' : busy ? 'busy' : live.length ? 'idle' : 'off'}`} />
          {live.length} live{needs ? ` · ${needs} need you` : busy ? ` · ${busy} working` : ''}
        </div>
        <button className="btn ghost sm ask-corvid" onClick={() => askCorvid()} title={`Talk to Corvid on the message board (${keyLabel('J')})`}>
          <MessageCircle size={14} /> Ask Corvid
        </button>
        <button className="btn ghost icon sm" onClick={toggleTheme} title={`Switch to ${other ?? (light ? 'the dark theme' : 'the light theme')}${config?.themeFollowSystem ? ' (stops following the system)' : ''}`}>
          {light ? <Moon size={14} /> : <Sun size={14} />}
        </button>
        <ErrorBoundary area="Guided tours menu">
          <TourButton />
        </ErrorBoundary>
      </div>
    </header>
  )
}

function ConflictDialog(): ReactNode {
  const conflict = useStore((s) => s.conflict)
  if (!conflict) return null
  const { session, live } = conflict
  const close = (): void => setState({ conflict: undefined })
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <TriangleAlert size={17} color="var(--warn)" /> This session is open in {whereLabel(live.entrypoint)}
        </h3>
        <p>
          “{session.title}” is live right now ({statusLabel(live).toLowerCase()}). Resuming it here as well would put two
          processes on the same transcript. Fork it instead to branch off with the full history, or switch to where it’s
          running.
        </p>
        <div className="actions">
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          {live.entrypoint?.includes('vscode') && (
            <button
              className="btn"
              onClick={() => {
                close()
                void api.openVSCode(session.cwd, session.id)
              }}
            >
              Go to VS Code
            </button>
          )}
          <button className="btn" onClick={() => void launch(session, 'resume', true)}>
            Resume anyway
          </button>
          <button className="btn primary" onClick={() => void launch(session, 'fork')}>
            Fork here
          </button>
        </div>
      </div>
    </div>
  )
}
