// The active theme's tokens are written as CSS variables into one <style> on :root, and its id and
// kind go on <html> as data-theme and data-theme-kind. The themes themselves are data in
// @shared/themes. Main passes the theme to show in the URL so the first paint is already right,
// and the store re-applies it whenever config or the OS's light/dark setting changes. The choice
// itself lives in config.json. Extension themes (#114) come from src/extensions/themeExtensions.ts: before the config
// is in, only the extension whose theme main put in the URL is loaded (main already checked its flag), so the first
// paint is right; extensionSockets.ts reloads them all with their flags once the config arrives.

import type { AppConfig } from '@shared/types'
import { DEFAULT_DARK, isExtensionThemeId, isThemeId, resolveTheme, themeDef, themeTokens, type ThemeId } from '@shared/themes'
import { formatColours } from '@shared/boardFormat'
import { THEME_EXTENSIONS } from '../../extensions/themeExtensions'
import { loadThemeExtensions } from '../../extensions/sockets/theme'

const osDarkQuery = matchMedia('(prefers-color-scheme: dark)')

export const osDark = (): boolean => osDarkQuery.matches

/** Follow the OS's light/dark switch; returns an unsubscribe. */
export function onOsThemeChange(fn: () => void): () => void {
  osDarkQuery.addEventListener('change', fn)
  return () => osDarkQuery.removeEventListener('change', fn)
}

/** The theme config asks for right now, given the OS's light/dark setting. */
export const activeTheme = (config: AppConfig): ThemeId => resolveTheme(config, osDark())

let applied: string | undefined

export function applyTheme(id: ThemeId): void {
  // the same id can carry other colours after a reload (an extension's theme), so compare what is written
  const key = `${id}
${JSON.stringify(themeTokens(id))}`
  if (key === applied) return
  applied = key
  const def = themeDef(id)
  let el = document.getElementById('theme-tokens') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'theme-tokens'
    document.head.prepend(el)
  }
  // the board's highlight colours (#126) are worked out from the tokens, so every theme's read at 4.5:1
  const tokens = themeTokens(id)
  const vars = Object.entries({ ...tokens, ...formatColours(tokens) }).map(([k, v]) => `  --${k}: ${v};`)
  el.textContent = `:root {\n  color-scheme: ${def.kind};\n${vars.join('\n')}\n}`
  document.documentElement.dataset.theme = def.id
  document.documentElement.dataset.themeKind = def.kind
}

const fromUrl = new URLSearchParams(location.search).get('theme')
if (isExtensionThemeId(fromUrl)) {
  try {
    loadThemeExtensions(THEME_EXTENSIONS, { enabled: (id) => fromUrl.startsWith(`${id}.`), log: () => {} })
  } catch {
    /* never: the loader doesn't throw, and the default theme below still paints */
  }
}
applyTheme(isThemeId(fromUrl) ? fromUrl : DEFAULT_DARK)
