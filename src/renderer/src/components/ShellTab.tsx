import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { RotateCcw, Terminal } from 'lucide-react'
import type { TerminalInfo } from '@shared/types'
import { api } from '../api'
import { getState, newSideShell, noteShell, useStore } from '../store'
import { paneOf, shellTab } from '../panes'
import { TermSlot } from './AgentTerminal'

// A general shell (#111), wherever it lives: docked in the side panel or in a pane tab of its own.
// Both show it through a TermSlot, so moving it hands the same xterm over and the process never notices.

/** Where a shell shows; the keyboard landing in it makes it the shell Ctrl+` brings back. */
export function ShellSlot({ term, focus }: { term: TerminalInfo; focus?: boolean }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current!
    const on = (): void => noteShell(term.termId)
    el.addEventListener('focusin', on)
    return () => el.removeEventListener('focusin', on)
  }, [term.termId])
  return (
    <div className="sh-slot" ref={ref}>
      <TermSlot term={term} fontSize={13} focus={focus} />
    </div>
  )
}

/** The bar under a shell that has stopped: restart it in the same place, or close it. */
export function ShellExited({ t }: { t: TerminalInfo }): ReactNode {
  return (
    <div className="term-exited">
      Exited with code {t.exited}.
      <button
        className="btn sm"
        // Open the replacement first (beside it, in the same place) so the side panel never sees zero tabs and hides.
        onClick={() => void newSideShell(t.shell, t.cwd, paneOf(getState().layout, shellTab(t.termId))?.id).then(() => api.closeTerminal(t.termId))}
      >
        <RotateCcw size={13} /> Restart
      </button>
      <button className="btn sm ghost" onClick={() => void api.closeTerminal(t.termId)}>
        Close
      </button>
    </div>
  )
}

/** A shell in a pane tab: just the terminal, like the side panel shows it. */
export function ShellTab({ termId }: { termId: string }): ReactNode {
  const t = useStore((s) => s.terminals.find((x) => x.termId === termId))
  // a closed shell's tab goes on the next terminals update
  if (!t) return <div className="pane-body" />
  return (
    <div className="pane-body sh-tab">
      <ShellSlot term={t} focus />
      {t.exited !== undefined && <ShellExited t={t} />}
    </div>
  )
}

const baseName = (p: string): string => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? p
const sameDir = (a: string, b: string): boolean => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase()

/** A shell's folder for its label, unless it is the home folder every shell starts in. */
export function shellFolder(t: TerminalInfo, home: string): string | undefined {
  return t.cwd && !(home && sameDir(t.cwd, home)) ? baseName(t.cwd) : undefined
}

/** What a shell's tab says when hovered: Shell, its name, and its folder. */
export function shellTitle(t: TerminalInfo | undefined): string {
  return t ? ['Shell', t.title, t.cwd].filter(Boolean).join(' · ') : 'Shell'
}

/** The tab's label: the shell icon (a dot once it has stopped), its name, and its folder when it isn't home. */
export function ShellTabLabel({ termId }: { termId: string }): ReactNode {
  const t = useStore((s) => s.terminals.find((x) => x.termId === termId))
  const home = useStore((s) => s.home)
  if (!t) return <span className="t">Shell</span>
  const folder = shellFolder(t, home)
  return (
    <>
      {t.exited !== undefined ? <span className="dot off" /> : <Terminal size={13} strokeWidth={1.75} />}
      <span className="t">
        {t.title}
        {folder && <span className="sh-dir"> · {folder}</span>}
      </span>
    </>
  )
}
