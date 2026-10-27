// The read-only platform facts the window gets from the preload (#149): which OS, and how to name the
// modifier key. Pure, so the preload, the window and the tests can all use it. The window's shortcuts and
// their labels go through src/renderer/src/keys.ts, which binds these helpers to window.api.platform (#156).

export type OsName = 'win32' | 'darwin' | 'linux'

export interface PlatformInfo {
  os: OsName
  isMac: boolean
  /** the KeyboardEvent flag shortcuts use: metaKey (Cmd) on macOS, ctrlKey elsewhere */
  modKey: 'metaKey' | 'ctrlKey'
  /** how the modifier is written in labels: ⌘ on macOS, Ctrl elsewhere */
  modLabel: string
  /** the separator between keys in a label: none on macOS (⌘J), + elsewhere (Ctrl+J) */
  keySep: string
}

export function platformInfo(platform: string): PlatformInfo {
  const os: OsName = platform === 'win32' || platform === 'darwin' ? platform : 'linux'
  const isMac = os === 'darwin'
  return Object.freeze({ os, isMac, modKey: isMac ? 'metaKey' : 'ctrlKey', modLabel: isMac ? '⌘' : 'Ctrl', keySep: isMac ? '' : '+' })
}

// macOS writes modifiers as symbols in a fixed order (⌃⌥⇧⌘) with no separator, Windows and Linux as words with +.
const MAC_MODS: Record<string, string> = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Mod: '⌘' }
const MAC_ORDER = ['Ctrl', 'Alt', 'Shift', 'Mod']

/** A label from parts like 'Ctrl+Shift+`' ('Mod' is the platform's modifier): words with + elsewhere, ⌃⌥⇧⌘ on macOS. */
function label(info: PlatformInfo, parts: string[]): string {
  if (!info.isMac) return parts.map((p) => (p === 'Mod' ? info.modLabel : p)).join('+')
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1)
  return MAC_ORDER.filter((m) => mods.includes(m)).map((m) => MAC_MODS[m]).join('') + key
}

/**
 * A shortcut's label with the platform's modifier: shortcutLabel(info, 'J') is Ctrl+J, or ⌘J on macOS;
 * shortcutLabel(info, 'Shift+Z') is Ctrl+Shift+Z, or ⇧⌘Z.
 */
export const shortcutLabel = (info: PlatformInfo, key: string): string => label(info, ['Mod', ...key.split('+')])

/** A label for a shortcut that is Ctrl on every platform (the terminal's Ctrl+`): Ctrl+` here, ⌃` on macOS. */
export const ctrlLabel = (info: PlatformInfo, key: string): string => label(info, ['Ctrl', ...key.split('+')])

/** How a modifier-click is written: Ctrl+click here, ⌘-click on macOS (where Ctrl+click is a right click). */
export const modClickLabel = (info: PlatformInfo): string => (info.isMac ? '⌘-click' : 'Ctrl+click')

type Mods = { ctrlKey: boolean; metaKey: boolean }

/** True when the platform's shortcut modifier is down: Cmd on macOS, Ctrl elsewhere. */
export const modDown = (info: PlatformInfo, e: Mods): boolean => e[info.modKey]

/** True when the other one is down (Ctrl on macOS, the Windows/Super key elsewhere). */
export const otherModDown = (info: PlatformInfo, e: Mods): boolean => (info.isMac ? e.ctrlKey : e.metaKey)

/**
 * The global hotkey a fresh install gets (Electron accelerator syntax). Windows and Linux keep Control+Alt+Space;
 * macOS gets Command+Shift+Space. A saved hotkey is never replaced by this.
 */
export const defaultHotkey = (platform: string): string => (platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Alt+Space')

/** The start-up notice when the global hotkey couldn't be registered. Under Wayland, Electron needs a portal for it. */
export function hotkeyFailText(hotkey: string, platform: string, env: Record<string, string | undefined>): string {
  const base = `The hotkey ${hotkey} couldn't be registered (another app may have it). Pick another in Settings.`
  const wayland = platform === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY)
  return wayland
    ? `${base} ${WAYLAND_HOTKEY}`
    : base
}

/** Under Wayland the hotkey goes through the desktop's portal, which Corvid turns on there (#158). */
export const WAYLAND_HOTKEY =
  "Under Wayland, global hotkeys go through the desktop's GlobalShortcuts portal: the desktop may ask you to allow it, and some don't offer the portal yet (it needs a recent GNOME or KDE Plasma)."

/** The "open at login" row in Settings: Windows keeps its label and tip; Linux says where the entry lives and what
 *  a login start does without a tray (#158). */
export function loginItemText(os: string, tray: boolean): { label: string; tip: string } {
  if (os === 'win32') return { label: 'Start with Windows', tip: 'Launch hidden in the tray when you log in (installed app only).' }
  if (os === 'darwin') return { label: 'Open at login', tip: 'Launch hidden when you log in (installed app only); click the Dock icon to show it.' }
  return {
    label: 'Open at login',
    tip: `Launch ${tray ? 'hidden in the tray' : 'minimised'} when you log in, through ~/.config/autostart/corvid.desktop (installed app only).`
  }
}

/** Shown in Settings when the desktop has no tray (Linux only): what closing the window does instead. */
export function noTrayText(os: string, tray: boolean): string | null {
  if (os !== 'linux' || tray) return null
  return "No system tray was found (GNOME shows one only with the AppIndicator extension), so Corvid can't run hidden: closing its window quits it, or asks to minimise while terminals or agents are running."
}

/** The window's title bar (#155): the overlay buttons top right (Windows, Linux), the macOS traffic lights top left
 *  ('inset'), or the desktop's own frame (the Linux fallback). Main passes it to the preload as an argument, and the
 *  preload puts `titlebar-<kind>` on the page's root element so the top row can make room. */
export type TitleBarKind = 'overlay' | 'inset' | 'frame'

const TITLEBAR_ARG = '--corvid-titlebar='
export const titleBarArg = (kind: TitleBarKind): string => TITLEBAR_ARG + kind

/** The kind main passed in `argv`; without one (or an unknown one), what the platform uses by default. */
export function titleBarFromArgv(argv: readonly string[] | undefined, platform: string): TitleBarKind {
  const v = argv?.find((a) => a.startsWith(TITLEBAR_ARG))?.slice(TITLEBAR_ARG.length)
  if (v === 'overlay' || v === 'inset' || v === 'frame') return v
  return platform === 'darwin' ? 'inset' : 'overlay'
}

/** What the mic button says where dictation is off (#160: voice stays Windows-only, decision m597). */
export const VOICE_UNAVAILABLE = "Voice input isn't available on this platform yet"
