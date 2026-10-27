import { useSyncExternalStore } from 'react'
import { WINDOW_EXTENSIONS } from '../../extensions/windowExtensions'
import { THEME_EXTENSIONS } from '../../extensions/themeExtensions'
import { loadExtensions, type LoadResult } from '../../extensions/sockets/load'
import { clearWindowSockets, windowHost } from '../../extensions/sockets/window'
import { loadThemeExtensions, type ThemeRejection } from '../../extensions/sockets/theme'
import { getState, reshowTheme, subscribe, toast } from './store'
import { api } from './api'

// The window's side of the extension sockets (#102): loads src/extensions/windowExtensions.ts into the window's sockets
// once the config is in, and again whenever the per-extension flags change. A failure is logged to crash.log and
// shown once as a quiet toast; the window carries on without that extension.

let results: LoadResult[] = []
let themeResults: LoadResult[] = []
let themeRejected: ThemeRejection[] = []
let loadedFor: string | undefined
const listeners = new Set<() => void>()

function load(disabled: string[], quiet: boolean): void {
  clearWindowSockets()
  results = loadExtensions(WINDOW_EXTENSIONS, windowHost, { enabled: (id) => !disabled.includes(id), log: (what, details) => api.reportError(what, details) })
  // themes (#114): main loads the same index and logs and reports what it skipped, so this load stays quiet
  const themes = loadThemeExtensions(THEME_EXTENSIONS, { enabled: (id) => !disabled.includes(id), log: () => {} })
  themeResults = themes.results
  themeRejected = themes.rejected
  reshowTheme()
  for (const l of listeners) l()
  const bad = results.filter((r) => r.state === 'failed' || r.state === 'skipped')
  if (bad.length && !quiet)
    toast(`Skipped in the window: ${bad.map((r) => `${r.name} (${r.reason})`).join('; ')}`, 'error', { label: 'Open crash.log', run: () => void api.openCrashLog() })
}

/** Starts the window's extensions and follows their flags. Called once after boot. */
export function startWindowExtensions(): void {
  const sync = (): void => {
    const config = getState().config
    if (!config) return
    const disabled = config.disabledExtensions ?? []
    const key = JSON.stringify(disabled)
    if (key === loadedFor) return
    const first = loadedFor === undefined
    loadedFor = key
    load(disabled, !first)
  }
  sync()
  subscribe(sync)
}

const subscribeResults = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => void listeners.delete(cb)
}

/** The window's load results; re-renders after a reload. */
export const useWindowExtensions = (): LoadResult[] => useSyncExternalStore(subscribeResults, () => results)

/** The theme extensions' load results and the themes they had turned away (#114); re-renders after a reload. */
export const useThemeExtensions = (): { results: LoadResult[]; rejected: ThemeRejection[] } =>
  useSyncExternalStore(subscribeResults, () => themeSnapshot)
let themeSnapshot = { results: themeResults, rejected: themeRejected }
subscribeResults(() => (themeSnapshot = { results: themeResults, rejected: themeRejected }))

/** Why an extension theme isn't available right now, in a few words; for the fallback notice. */
export function themeGoneReason(themeId: string): string {
  const owner = themeId.split('.')[0]
  if ((getState().config?.disabledExtensions ?? []).includes(owner)) return 'its extension is switched off'
  const r = themeResults.find((x) => x.id === owner)
  if (r && (r.state === 'failed' || r.state === 'skipped')) return 'its extension failed to load'
  if (themeRejected.some((x) => `${x.owner}.${x.theme}` === themeId)) return "it didn't pass the theme checks"
  if (r) return 'its extension no longer has it'
  return "its extension isn't installed any more"
}
