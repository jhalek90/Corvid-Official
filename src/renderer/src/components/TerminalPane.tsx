import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { TerminalInfo } from '@shared/types'
import { termPalette, type ThemeId } from '@shared/themes'
import { api } from '../api'
import { platform } from '../keys'
import { showing } from '../termViewing'
import { countTerm } from '../termDebug'

// Lets the app-wide right-click menu reach the terminal under the pointer.
const byHost = new WeakMap<Element, Terminal>()
export function terminalAt(el: Element): Terminal | undefined {
  const host = el.closest('.term-host')
  return host ? byHost.get(host) : undefined
}

/** how long the size must hold before the process hears it */
const SEND_MS = 150
/** longest a new terminal stays hidden waiting for the process to redraw at its size */
const REVEAL_MS = 300

export interface Xterm {
  xt: Terminal
  fit: FitAddon
  /** fits to the host on the next frame, only while it is on screen */
  refit: () => void
  dispose: () => void
}

/**
 * One xterm on a terminal: replays the buffer, streams output, sends keys and its size. It fits on screen
 * at most once a frame, only while the host is on screen, so a hidden or moving terminal never resizes.
 * The process redraws its whole screen on every size it hears, so it is told only the settled size, once,
 * after the size has held for SEND_MS, and never the size it already has (#79).
 */
export function createXterm(host: HTMLElement, term: TerminalInfo, theme: ThemeId, fontSize = 13): Xterm {
  const xt = new Terminal({
    fontFamily: "'JetBrains Mono Variable', 'Cascadia Mono', Consolas, Menlo, 'DejaVu Sans Mono', monospace",
    fontSize,
    lineHeight: 1.18,
    cursorBlink: true,
    scrollback: 20000,
    allowProposedApi: true,
    theme: termPalette(theme),
    // ConPTY reflows and repaints on a resize itself; this keeps xterm from reflowing the same lines again
    ...(api.windowsBuild ? { windowsPty: { backend: 'conpty' as const, buildNumber: api.windowsBuild } } : {})
  })
  const fit = new FitAddon()
  xt.loadAddon(fit)
  xt.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank')))
  xt.open(host)
  byHost.set(host, xt)
  // Laid out but unseen until it has its real size and the replayed output, so 80x24 never shows.
  host.style.visibility = 'hidden'

  xt.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true
    // Ctrl+C copies when something is selected and otherwise reaches the shell as an interrupt.
    // preventDefault stops Chromium's own copy/paste on xterm's hidden textarea from doubling up.
    const key = e.key.toLowerCase()
    // macOS (#156): Ctrl stays the shell's (Ctrl+C always interrupts); Cmd+C and Cmd+V are left to the app
    // menu's Copy and Paste, whose copy and paste events xterm handles itself.
    if (platform.isMac) {
      if (e.metaKey && !e.altKey && (key === 'c' || key === 'v')) return false
    } else if (e.ctrlKey && !e.altKey && key === 'c' && xt.hasSelection()) {
      e.preventDefault()
      void navigator.clipboard.writeText(xt.getSelection())
      xt.clearSelection()
      return false
    }
    if (!platform.isMac && e.ctrlKey && !e.altKey && key === 'v') {
      e.preventDefault()
      void navigator.clipboard.readText().then((t) => t && xt.paste(t))
      return false
    }
    // Shift+Enter -> newline in Claude Code's prompt (sent as Meta+Enter). Shells keep plain Enter:
    // PSReadLine reads that Escape as "clear the line".
    if (e.shiftKey && e.key === 'Enter' && term.kind === 'claude') {
      api.input(term.termId, '\x1b\r')
      return false
    }
    return true
  })

  // sizes before the first real fit are xterm's 80x24, never the process's
  let fitted = false
  let sent = ''
  let sendTimer: ReturnType<typeof setTimeout> | undefined
  const sendNow = (): void => {
    clearTimeout(sendTimer)
    const size = `${xt.cols}x${xt.rows}`
    if (!fitted || size === sent) return
    sent = size
    countTerm('sent', size)
    api.resize(term.termId, xt.cols, xt.rows)
  }
  const send = (): void => {
    clearTimeout(sendTimer)
    sendTimer = setTimeout(sendNow, SEND_MS)
  }
  const resizeSub = xt.onResize(send)
  const renderSub = xt.onRender(() => countTerm('renders'))

  // Compares before resizing, so a fit that changes nothing can't set off another (no feedback loop).
  const fitNow = (): void => {
    if (!host.isConnected || host.offsetParent === null) return
    try {
      const d = fit.proposeDimensions()
      countTerm('fits')
      if (!d || !(d.cols > 0 && d.rows > 0)) return
      fitted = true
      if (d.cols !== xt.cols || d.rows !== xt.rows) xt.resize(d.cols, d.rows)
      else send()
    } catch {
      /* not laid out yet */
    }
  }
  fitNow()
  // Opening isn't a drag: the process hears its size straight away (main drops it if it already has it),
  // and the terminal shows once the process has redrawn at that size, or after REVEAL_MS.
  const opening = fitted
  if (opening) sendNow()
  else send()

  // Output that arrives before the attach reply is already part of the replayed buffer.
  let attached = false
  let revealed = false
  const reveal = (): void => {
    if (revealed) return
    revealed = true
    clearTimeout(revealTimer)
    host.style.visibility = ''
  }
  const revealTimer = setTimeout(reveal, REVEAL_MS)
  const off = api.on('pty:data', (id, data) => {
    if (id === term.termId && attached) xt.write(data, revealed ? undefined : reveal)
  })
  void api.attach(term.termId).then((buf) => {
    attached = true
    if (opening) xt.write(buf)
    else if (buf) xt.write(buf, reveal)
    else reveal()
  })

  // a focused terminal counts as open, so a finished agent being typed to is never closed (#70)
  let focused = false
  const focus = (on: boolean) => (): void => {
    if (focused !== on) showing(term.termId, (focused = on))
  }
  const onFocus = focus(true)
  const onBlur = focus(false)
  xt.textarea?.addEventListener('focus', onFocus)
  xt.textarea?.addEventListener('blur', onBlur)

  const dataSub = xt.onData((d) => api.input(term.termId, d))
  let frame = 0
  const refit = (): void => {
    frame ||= requestAnimationFrame(() => {
      frame = 0
      fitNow()
    })
  }
  const ro = new ResizeObserver(refit)
  ro.observe(host)

  return {
    xt,
    fit,
    refit,
    dispose: () => {
      cancelAnimationFrame(frame)
      clearTimeout(sendTimer)
      clearTimeout(revealTimer)
      off()
      dataSub.dispose()
      resizeSub.dispose()
      renderSub.dispose()
      ro.disconnect()
      xt.textarea?.removeEventListener('focus', onFocus)
      xt.textarea?.removeEventListener('blur', onBlur)
      onBlur()
      byHost.delete(host)
      xt.dispose()
    }
  }
}
