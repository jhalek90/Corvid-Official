import type { BrowserWindowConstructorOptions } from 'electron'
import { platformOf } from './shared.mjs'
import { badgeKind } from './os'
import type { TitleBarKind } from '@shared/platformInfo'

// The window's frame and how Corvid sits in the taskbar or Dock (#155). Windows keeps exactly what main/index.ts did
// before: a hidden title bar with a coloured Windows Controls Overlay, the overlay dot, the AppUserModelId and the
// Start Menu shortcut. macOS gets the inset traffic lights, a Dock badge and bounce. Linux keeps the overlay (Electron
// supports Window Controls Overlay on Linux, win32 and linux are the platforms of setTitleBarOverlay), with
// CORVID_NATIVE_FRAME=1 as the fallback to the desktop's own frame where the overlay looks wrong.

/** The title bar the window gets: 'overlay' (hidden title bar, native buttons drawn over the top right),
 *  'inset' (macOS traffic lights over the top left) or 'frame' (the desktop's normal frame, Linux fallback). */
export function titleBarKind(platform: string = process.platform, env: Record<string, string | undefined> = process.env): TitleBarKind {
  const os = platformOf(platform)
  if (os === 'darwin') return 'inset'
  if (os === 'linux' && env.CORVID_NATIVE_FRAME === '1') return 'frame'
  return 'overlay'
}

/** Corvid's top row is 40 px; the traffic lights (about 14 px tall) sit centred in it, left of the brand. */
export const TRAFFIC_LIGHTS = { x: 14, y: 13 }

/** The BrowserWindow options for the title bar, in the colours of the theme on screen (the overlay only). */
export function titleBarOptions(
  chrome: { bg: string; symbol: string },
  kind: TitleBarKind
): Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'> {
  if (kind === 'inset') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { ...TRAFFIC_LIGHTS } }
  if (kind === 'frame') return {}
  return { titleBarStyle: 'hidden', titleBarOverlay: { color: chrome.bg, symbolColor: chrome.symbol, height: 40 } }
}

/** Whether the overlay's colours can be changed after a theme switch (setTitleBarOverlay is win32 and linux only,
 *  and only on a window that has the overlay). */
export const restylesOverlay = (kind: TitleBarKind): boolean => kind === 'overlay'

/** What "a session needs you" does to the app's icon. Windows: the overlay dot on the taskbar button (as before).
 *  macOS: a dot badge on the Dock icon, plus one informational bounce when it turns on. Linux: a badge count of 1,
 *  where the desktop supports the LauncherEntry API (it must match the app's .desktop file). */
export type NeedsYouBadge =
  | { kind: 'overlay'; on: boolean; description: string }
  | { kind: 'dock'; text: string; bounce: boolean }
  | { kind: 'count'; count: number }

export function needsYouBadge(on: boolean, wasOn: boolean, platform: string = process.platform): NeedsYouBadge {
  switch (badgeKind(platform)) {
    case 'overlay':
      return { kind: 'overlay', on, description: on ? 'A session needs you' : '' }
    case 'dock':
      return { kind: 'dock', text: on ? '•' : '', bounce: on && !wasOn }
    default:
      return { kind: 'count', count: on ? 1 : 0 }
  }
}

/** The Windows-only shell integration: the AppUserModelId (toast name, taskbar grouping) and the Start Menu shortcut.
 *  The .app bundle (macOS) and the .desktop entry (Linux) do those jobs elsewhere. */
export const usesAppUserModelId = (platform: string = process.platform): boolean => platformOf(platform) === 'win32'
