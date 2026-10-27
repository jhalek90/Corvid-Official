import { createRoot } from 'react-dom/client'
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import './styles.css'
import './corvid.css'
import './explorer.css'
import './crow.css'
import './agents.css'
import './board.css'
import './security.css'
import './switcher.css'
import './connections.css'
import './layout'
import './motion'
import './theme'
import { App } from './App'
import { api } from './api'
import { boot, getState, newSession, setState, toast } from './store'
import { sampleAgents } from './agents'
import { setScope } from './scope'
import { ErrorBoundary, catchWindowErrors } from './components/ErrorBoundary'
import { startWindowExtensions } from './extensionSockets'

// debug hooks, for screenshots and trying things from the devtools; sampleAgents fakes agents for the birds and cards
;(window as unknown as { __dash: unknown }).__dash = { getState, setState, newSession, sampleAgents, setScope }

catchWindowErrors()

void boot().then(() => {
  // the extensions under src/extensions, before the first render so their sections are there (#102)
  startWindowExtensions()
  // the outer boundary is the last line before a blank window; each area has its own inside App (#83)
  createRoot(document.getElementById('root')!).render(
    <ErrorBoundary area="Corvid">
      <App />
    </ErrorBoundary>
  )
  // after a crash and reload, say so once (#83)
  void api.crashNotice().then((n) => n && toast(n, 'error', { label: 'Open crash.log', run: () => void api.openCrashLog() }))
  // closed unexpectedly last time, settings repaired, a taken hotkey: each once, quietly (#85)
  void api.startupNotices().then((list) => {
    // one toast shows at a time, so they go together
    if (list.length) toast(list.map((n) => n.text).join(' '), 'info', list.some((n) => n.log) ? { label: 'Open crash.log', run: () => void api.openCrashLog() } : undefined)
  })
  // a test copy says so on screen, not only in its window title (#85)
  void api.testOwner().then((who) => {
    if (!who) return
    const badge = document.createElement('div')
    badge.className = 'test-copy-badge'
    badge.textContent = `TEST · ${who}`
    document.body.appendChild(badge)
  })
  // the heartbeat a fresh deploy waits for before it calls this build healthy (#78)
  setTimeout(() => void api.corvidReady(), 1000)
})
