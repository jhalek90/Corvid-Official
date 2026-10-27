import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { BookPlus, ClipboardPaste, Copy, Link, Redo2, Scissors, TextSelect, Undo2 } from 'lucide-react'
import type { ContextMenuInfo } from '@shared/types'
import { api } from '../api'
import { terminalAt } from './TerminalPane'
import { keyLabel, platform } from '../keys'

interface Item {
  label: string
  icon?: typeof Copy
  keys?: string
  disabled?: boolean
  strong?: boolean
  run: () => void
}
type Entry = Item | 'sep'

// Chromium tells main about the click but not which element it hit, so the DOM event is
// remembered here. It always fires before main's context-menu event reaches us.
let last: { target: Element; x: number; y: number } | null = null
window.addEventListener(
  'contextmenu',
  (e) => {
    if (e.target instanceof Element) last = { target: e.target, x: e.clientX, y: e.clientY }
  },
  true
)

/** The nearest scrolling region around the click: what "Select all" means outside a text field. */
function contentRoot(el: Element): Element | null {
  for (let e: Element | null = el; e && e !== document.body; e = e.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(e).overflowY)) return e
  }
  return null
}

function selectContents(el: Element): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function buildItems(info: ContextMenuInfo, target: Element): Entry[] {
  const run = api.contextMenuRun
  const out: Entry[] = []
  const sep = (): void => void (out.length && out[out.length - 1] !== 'sep' && out.push('sep'))

  // Terminals: xterm keeps its own selection, and paste goes through it so bracketed paste applies.
  const xt = terminalAt(target)
  if (xt) {
    out.push({ label: 'Copy', icon: Copy, keys: keyLabel('C'), disabled: !xt.hasSelection(), run: () => void navigator.clipboard.writeText(xt.getSelection()) })
    out.push({ label: 'Paste', icon: ClipboardPaste, keys: keyLabel('V'), run: () => void navigator.clipboard.readText().then((t) => t && xt.paste(t)) })
    out.push('sep', { label: 'Select all', icon: TextSelect, run: () => xt.selectAll() })
    return out
  }

  if (info.misspelledWord) {
    const word = info.misspelledWord
    for (const s of info.suggestions) out.push({ label: s, strong: true, run: () => void run('replace', s) })
    if (!info.suggestions.length) out.push({ label: 'No spelling suggestions', disabled: true, run: () => {} })
    out.push({ label: 'Add to dictionary', icon: BookPlus, run: () => void run('learn', word) })
    sep()
  }

  if (info.isEditable) {
    if (info.canUndo || info.canRedo) {
      out.push({ label: 'Undo', icon: Undo2, keys: keyLabel('Z'), disabled: !info.canUndo, run: () => void run('undo') })
      out.push({ label: 'Redo', icon: Redo2, keys: keyLabel(platform.isMac ? 'Shift+Z' : 'Y'), disabled: !info.canRedo, run: () => void run('redo') })
      sep()
    }
    out.push({ label: 'Cut', icon: Scissors, keys: keyLabel('X'), disabled: !info.canCut, run: () => void run('cut') })
    out.push({ label: 'Copy', icon: Copy, keys: keyLabel('C'), disabled: !info.canCopy, run: () => void run('copy') })
    out.push({ label: 'Paste', icon: ClipboardPaste, keys: keyLabel('V'), disabled: !info.canPaste, run: () => void run('paste') })
    sep()
    out.push({ label: 'Select all', icon: TextSelect, keys: keyLabel('A'), disabled: !info.canSelectAll, run: () => void run('selectAll') })
    return out
  }

  if (info.linkURL) {
    const url = info.linkURL
    out.push({ label: 'Copy link address', icon: Link, run: () => void run('copyText', url) })
    sep()
  }
  if (info.selectionText.trim()) out.push({ label: 'Copy', icon: Copy, keys: keyLabel('C'), run: () => void run('copy') })
  // Buttons, tabs and other chrome are unselectable; "Select all" there would select nothing useful.
  const root = getComputedStyle(target).userSelect === 'none' ? null : contentRoot(target)
  if (root) out.push({ label: 'Select all', icon: TextSelect, run: () => selectContents(root) })
  if (out[out.length - 1] === 'sep') out.pop()
  return out
}

export function ContextMenu(): ReactNode {
  const [menu, setMenu] = useState<{ x: number; y: number; items: Entry[] } | null>(null)
  const [active, setActive] = useState(-1)
  const [pos, setPos] = useState({ left: 0, top: 0 })
  const ref = useRef<HTMLDivElement>(null)

  useEffect(
    () =>
      api.on('ctx:menu', (info) => {
        if (!last) return
        const items = buildItems(info, last.target)
        setActive(-1)
        setMenu(items.length ? { x: last.x, y: last.y, items } : null)
        last = null
      }),
    []
  )

  // Keep the menu on screen when opened near the bottom or right edge.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!menu || !r) return
    setPos({ left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)) })
  }, [menu])

  const choose = (it: Item): void => {
    setMenu(null)
    it.run()
  }

  // Focus stays in the field that was right-clicked (edit commands act on it), so the menu takes
  // its keys from the window instead of from a focused button.
  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    const usable = menu.items.flatMap((e, i) => (e !== 'sep' && !e.disabled ? [i] : []))
    const away = (ev: MouseEvent): void => {
      if (!ref.current?.contains(ev.target as Node)) close()
    }
    const key = (ev: KeyboardEvent): void => {
      const step = ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowUp' ? -1 : 0
      if (step) {
        const at = usable.indexOf(active)
        const next = at < 0 ? (step > 0 ? 0 : usable.length - 1) : (at + step + usable.length) % usable.length
        setActive(usable[next] ?? -1)
      } else if (ev.key === 'Enter' && active >= 0) choose(menu.items[active] as Item)
      else {
        // Escape is swallowed; any other key closes the menu and carries on as usual.
        close()
        if (ev.key !== 'Escape') return
      }
      ev.preventDefault()
      ev.stopPropagation()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', key, true)
    document.addEventListener('wheel', close, true)
    window.addEventListener('blur', close)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', key, true)
      document.removeEventListener('wheel', close, true)
      window.removeEventListener('blur', close)
      window.removeEventListener('resize', close)
    }
  }, [menu, active])

  if (!menu) return null
  return (
    <div
      ref={ref}
      className="menu ctx-menu"
      role="menu"
      style={pos}
      onMouseDown={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((e, i) => {
        if (e === 'sep') return <div key={i} className="sep" />
        const Icon = e.icon
        return (
          <button
            key={i}
            className={`mi${i === active ? ' on' : ''}${e.strong ? ' strong' : ''}`}
            role="menuitem"
            tabIndex={-1}
            disabled={e.disabled}
            onMouseEnter={() => setActive(e.disabled ? -1 : i)}
            onClick={() => choose(e)}
          >
            <span className="ctx-icon">{Icon && <Icon size={14} />}</span>
            {e.label}
            {e.keys && <small>{e.keys}</small>}
          </button>
        )
      })}
    </div>
  )
}
