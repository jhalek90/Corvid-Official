import { useEffect, useState, type ReactNode } from 'react'
import { InfoTip } from '../components/Tooltip'
import { Plug } from 'lucide-react'
import { MAIN_EXTENSIONS } from '../../../extensions/mainExtensions'
import { WINDOW_EXTENSIONS } from '../../../extensions/windowExtensions'
import { THEME_EXTENSIONS } from '../../../extensions/themeExtensions'
import { extensionThemes } from '@shared/themes'
import { extensionPages, settingsSections } from '../../../extensions/sockets/window'
import type { LoadResult } from '../../../extensions/sockets/load'
import { api, type SocketExtensionState } from '../api'
import { useStore } from '../store'
import { useThemeExtensions, useWindowExtensions } from '../extensionSockets'
import { ErrorBoundary } from '../components/ErrorBoundary'
import '../extensionSockets.css'

// What the extension sockets show (#102): the extensions built into this Corvid under src/extensions, each with its
// on/off flag and the pages it adds, at the foot of the Extensions tab; and their sections at the end of Settings.
// Nothing shows while no extension uses the sockets.

const STATE_WORDS: Record<LoadResult['state'], string> = { loaded: 'On', off: 'Off', skipped: 'Skipped', failed: 'Failed' }
const COUNT_WORDS: Record<string, [string, string]> = {
  commands: ['slash command', 'slash commands'],
  tools: ['tool', 'tools'],
  instructions: ['instruction', 'instructions'],
  connectors: ['connector', 'connectors'],
  settings: ['settings section', 'settings sections'],
  pages: ['page', 'pages'],
  themes: ['theme', 'themes']
}

function useMainStates(): SocketExtensionState[] {
  const [list, setList] = useState<SocketExtensionState[]>([])
  useEffect(() => {
    void api.extensionSockets().then(setList)
    return api.onExtensionSockets(setList)
  }, [])
  return list
}

/** Every socket extension by id, with the main and window results merged. */
function useSocketExtensions(): { id: string; name: string; state: LoadResult['state']; reason?: string; counts: Record<string, number> }[] {
  const main = useMainStates()
  // the window's own results, and the theme index's (#114), which the window loads too
  const win = [...useWindowExtensions(), ...useThemeExtensions().results]
  // re-render after a reload: the counts are read from the registries
  const pages = extensionPages()
  const sections = settingsSections()
  const ids = [...new Set([...main.map((r) => r.id), ...win.map((r) => r.id)])]
  const rank = { failed: 3, skipped: 2, off: 1, loaded: 0 }
  return ids.map((id) => {
    const m = main.find((r) => r.id === id)
    const worst = [m, ...win.filter((r) => r.id === id)].filter((x): x is LoadResult => !!x).sort((a, b) => rank[b.state] - rank[a.state])[0]
    return {
      id,
      name: worst.name,
      state: worst.state,
      reason: worst.reason,
      counts: {
        ...(m?.counts ?? {}),
        settings: sections.filter((s) => s.owner === id).length,
        pages: pages.filter((p) => p.owner === id).length,
        themes: extensionThemes().filter((t) => t.ext?.owner === id).length
      }
    }
  })
}

const countText = (counts: Record<string, number>): string =>
  Object.entries(counts)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} ${COUNT_WORDS[k]?.[n === 1 ? 0 : 1] ?? k}`)
    .join(' · ')

/** The Extensions tab's "Built into this Corvid" list. */
export function ExtensionSockets(): ReactNode {
  const config = useStore((s) => s.config)
  const list = useSocketExtensions()
  const [open, setOpen] = useState<string | undefined>()
  const themeLoad = useThemeExtensions()
  if (!config || (!MAIN_EXTENSIONS.length && !WINDOW_EXTENSIONS.length && !THEME_EXTENSIONS.length)) return null
  const disabled = config.disabledExtensions ?? []
  const toggle = (id: string): void =>
    void api.setConfig({ disabledExtensions: disabled.includes(id) ? disabled.filter((x) => x !== id) : [...disabled, id] })
  const pages = extensionPages()
  const page = pages.find((p) => p.key === open)
  return (
    <div className="ext-sockets">
      <div className="ext-sockets-head">
        <Plug size={13} />
        <b>Built into this Corvid</b>
        <InfoTip tip="Extensions under src/extensions that plug into Corvid's sockets. Switching one off removes everything it adds." />
      </div>
      {list.map((x) => (
        <div key={x.id} id={`ext-socket-${x.id}`} className="card ext-socket-row">
          <div className="ext-socket-main">
            <div className="ext-card-top">
              <span className="ext-name">{x.name}</span>
              <span className="ext-ver">{x.id}</span>
              <span className={`chip ext-socket-state s-${x.state}`}>{STATE_WORDS[x.state]}</span>
            </div>
            <div className="ext-desc">{x.reason ?? (countText(x.counts) || 'Adds nothing at the moment.')}</div>
            <ThemeNotes owner={x.id} rejected={themeLoad.rejected.filter((r) => r.owner === x.id)} />
            {pages.some((p) => p.owner === x.id) && (
              <div className="ext-buttons">
                {pages
                  .filter((p) => p.owner === x.id)
                  .map((p) => (
                    <button key={p.key} className={`btn sm${open === p.key ? ' primary' : ''}`} onClick={() => setOpen(open === p.key ? undefined : p.key)}>
                      {p.title}
                    </button>
                  ))}
              </div>
            )}
          </div>
          {x.state !== 'skipped' && (
            <div
              className={`toggle${disabled.includes(x.id) ? '' : ' on'}`}
              title={disabled.includes(x.id) ? 'Switch on' : 'Switch off'}
              role="switch"
              aria-checked={!disabled.includes(x.id)}
              onClick={() => toggle(x.id)}
            />
          )}
        </div>
      ))}
      {page && (
        <div className="card ext-socket-page">
          <ErrorBoundary area={`${page.title} (the ${page.owner} extension)`}>
            <page.Component />
          </ErrorBoundary>
        </div>
      )}
    </div>
  )
}

/** A theme extension's themes with their warnings, and the themes it had turned away and why (#114). */
function ThemeNotes({ owner, rejected }: { owner: string; rejected: { theme: string; reason: string }[] }): ReactNode {
  const themes = extensionThemes().filter((t) => t.ext?.owner === owner)
  const warned = themes.filter((t) => t.ext!.warnings.length)
  if (!warned.length && !rejected.length) return null
  return (
    <div className="ext-theme-notes">
      {warned.map((t) => (
        <details key={t.id}>
          <summary>
            <b>{t.name}</b>: {t.ext!.warnings.length} warning{t.ext!.warnings.length === 1 ? '' : 's'}
            {t.ext!.lowContrast ? ', including low contrast' : ''}
          </summary>
          <ul>
            {t.ext!.warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      ))}
      {rejected.map((r) => (
        <div key={r.theme} className="ext-theme-rejected">
          <b>{r.theme}</b> was not added: {r.reason}
        </div>
      ))}
    </div>
  )
}

/** The extensions' sections at the end of Settings. */
export function ExtensionSettings(): ReactNode {
  useWindowExtensions()
  const sections = settingsSections()
  if (!sections.length) return null
  return (
    <>
      {sections.map((s) => (
        <div key={s.key} className="ext-settings-section">
          <div className="muted ext-settings-head">{s.title}</div>
          <ErrorBoundary area={`${s.title} (the ${s.owner} extension)`}>
            <s.Component />
          </ErrorBoundary>
        </div>
      ))}
    </>
  )
}
