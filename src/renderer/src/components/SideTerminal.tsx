import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { Check, ChevronDown, PanelRight, Plus, Terminal, X } from 'lucide-react'
import type { ShellOption } from '@shared/types'
import { api } from '../api'
import {
  dockedShells,
  loadShells,
  moveShellToPane,
  moveShellToSide,
  newShellHere,
  newSideShell,
  pickShell,
  preferredShell,
  setState,
  sideActive,
  terminalKey,
  toggleSideTerm,
  useStore
} from '../store'
import { isShellTab, paneOf, shellIdOf, shellTab } from '../panes'
import { ctrlLabel } from '../keys'
import { dropGoneTerminals } from './AgentTerminal'
import { dragged, endDrag, startDrag, useDrag } from './Panes'
import { ShellExited, ShellSlot, ShellTabLabel, shellTitle } from './ShellTab'
import { Resizer } from './Resizer'

/**
 * Left-side shell panel, beside the file explorer: the dock the general shells open in. Its shells aren't
 * tied to a project and start in the home folder; they live in the main process like every other tab, so
 * hiding the panel keeps them running. Each can be dragged out into the panes (or sent with the tab's
 * button) and dragged back (#111); one with a pane tab isn't listed here.
 */
export function SideTerminal(): ReactNode {
  const open = useStore((s) => s.sideTermOpen)
  const all = useStore((s) => s.terminals)
  const layout = useStore((s) => s.layout)
  const activeId = useStore(sideActive)
  const shellTerms = useMemo(() => all.filter((t) => t.side), [all])
  const terms = useMemo(() => dockedShells({ terminals: all, layout }), [all, layout])
  const [shells, setShells] = useState<ShellOption[]>([])
  const [menu, setMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const drag = useDrag()
  // only a shell that lives in a pane can be dropped here
  const incoming = drag?.kind === 'tab' && isShellTab(drag.view) && paneOf(layout, drag.view) ? shellIdOf(drag.view) : undefined

  useEffect(() => void loadShells().then(setShells), [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Ctrl+` brings the terminal up (or hands the keyboard back), Ctrl+Shift+` opens another shell;
      // both work from inside a terminal. Ctrl on macOS too, as in VS Code: Cmd+` cycles windows there (#156).
      if (!e.ctrlKey || e.altKey || e.code !== 'Backquote') return
      e.preventDefault()
      e.stopPropagation()
      if (e.shiftKey) newShellHere()
      else terminalKey()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // A closed shell takes its xterm with it.
  const ids = shellTerms.map((t) => t.termId).join(' ')
  useEffect(() => dropGoneTerminals(new Set(ids.split(' ')), true), [ids])

  // Opening the panel with nothing in it starts a shell; closing (or moving out) its last tab hides the panel.
  const count = terms.length
  const prevCount = useRef(count)
  useEffect(() => {
    if (open && !count) {
      if (prevCount.current) toggleSideTerm(false)
      else void newSideShell()
    }
    prevCount.current = count
  }, [open, count])

  // Typing `exit` closes the tab, wherever it is; a shell that dies with an error stays up so it can be read.
  useEffect(() => {
    for (const t of shellTerms) if (t.exited === 0) void api.closeTerminal(t.termId)
  }, [shellTerms])

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  if (!open && !count) return null

  const preferred = shells.find((s) => s.id === preferredShell()) ?? shells[0]
  const active = terms.find((t) => t.termId === activeId)

  return (
    <aside className="sideterm" hidden={!open}>
      <div className="fx-head">
        <span className="fx-title">Terminal</span>
        <span style={{ flex: 1 }} />
        <div className="st-new" ref={menuRef}>
          <button className="btn ghost icon sm" title={`New ${preferred?.label ?? 'shell'} (${ctrlLabel('Shift+`')})`} onClick={() => void newSideShell()}>
            <Plus size={14} />
          </button>
          <button className="btn ghost icon sm st-pick" title="Choose a shell" disabled={!shells.length} onClick={() => setMenu(!menu)}>
            <ChevronDown size={13} />
          </button>
          {menu && (
            <div className="menu st-menu">
              <div className="mh section-label">New terminal</div>
              {shells.map((s) => (
                <button
                  key={s.id}
                  className="mi"
                  onClick={() => {
                    setMenu(false)
                    pickShell(s.id)
                  }}
                >
                  <Terminal size={14} /> {s.label}
                  {s.id === preferred?.id && <Check size={13} className="st-check" />}
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          className="btn ghost icon sm"
          title="Move to a pane: opens this shell where a new view would open. Or drag its tab onto a pane."
          disabled={!active}
          onClick={() => active && moveShellToPane(active.termId)}
        >
          <PanelRight size={14} />
        </button>
        <button className="btn ghost icon sm" title={`Hide (${ctrlLabel('`')})`} onClick={() => toggleSideTerm(false)}>
          <X size={14} />
        </button>
      </div>
      <div className="tabbar st-tabs">
        {terms.map((t) => (
          <button
            key={t.termId}
            className={`tab${t.termId === activeId ? ' on' : ''}`}
            draggable
            onDragStart={(e) => startDrag(e, { kind: 'tab', view: shellTab(t.termId) })}
            onDragEnd={endDrag}
            onClick={() => setState({ sideTermId: t.termId })}
            onAuxClick={(e) => e.button === 1 && void api.closeTerminal(t.termId)}
            title={`${shellTitle(t)} · drag onto a pane to move it there`}
          >
            <ShellTabLabel termId={t.termId} />
            <span
              className="x"
              onClick={(e) => {
                e.stopPropagation()
                void api.closeTerminal(t.termId)
              }}
            >
              <X size={12} />
            </span>
          </button>
        ))}
      </div>
      <div className="term-stage">
        {/* Only the active shell holds its xterm here; the others wait, detached, with their scrollback. */}
        {open && active && (
          <div key={active.termId} className="term-pane">
            <ShellSlot term={active} focus />
            {active.exited !== undefined && <ShellExited t={active} />}
          </div>
        )}
      </div>
      {incoming && <SideDrop termId={incoming} />}
      <Resizer pane="terminal" edge="right" />
    </aside>
  )
}

/** Covers the panel while a shell is dragged out of a pane, so dropping it anywhere here docks it back. */
function SideDrop({ termId }: { termId: string }): ReactNode {
  const [over, setOver] = useState(false)
  const accepts = (e: DragEvent): boolean => {
    const item = dragged(e)
    return item?.kind === 'tab' && item.view === shellTab(termId)
  }
  return (
    <div
      className="drop-target st-drop"
      onDragOver={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(true)
      }}
      onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setOver(false)}
      onDrop={(e) => {
        if (!accepts(e)) return
        e.preventDefault()
        setOver(false)
        endDrag()
        moveShellToSide(termId)
      }}
    >
      {over && (
        <div className="drop-preview centre">
          <span>Move to the side panel</span>
        </div>
      )}
    </div>
  )
}
