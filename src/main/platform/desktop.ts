import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix } from 'node:path'
import { autostartEntryPath, desktopEntryText, platformOf } from './shared.mjs'

// Linux desktop integration (#158): open at login through ~/.config/autostart, what closing the window does when
// there's no tray to come back from, and the Wayland hotkey portal. Windows and macOS keep what they did.

type Env = Record<string, string | undefined>

/** The files the autostart helpers touch, so tests can use a temp HOME or a fake. */
export type AutostartFs = {
  exists: (p: string) => boolean
  read: (p: string) => string
  write: (p: string, text: string) => void
  remove: (p: string) => void
}

const realFs: AutostartFs = {
  exists: existsSync,
  read: (p) => readFileSync(p, 'utf8'),
  write: (p, text) => {
    mkdirSync(posix.dirname(p), { recursive: true })
    writeFileSync(p, text)
  },
  remove: (p) => rmSync(p, { force: true })
}

/** Linux "open at login": writes ~/.config/autostart/corvid.desktop (Exec "<app>" --hidden) when `on`, removes it
 *  when not. The icon deploy copies beside the install (<data>/corvid/icon.png) is used when it's there. Writes only
 *  when the text changed. */
export function applyAutostart(
  on: boolean,
  executable: string,
  env: Env = process.env,
  home: string = homedir(),
  fs: AutostartFs = realFs
): 'written' | 'removed' | 'unchanged' {
  const file = autostartEntryPath(env, home)
  if (!on) {
    if (!fs.exists(file)) return 'unchanged'
    fs.remove(file)
    return 'removed'
  }
  const icon = posix.join(posix.dirname(posix.dirname(executable)), 'icon.png')
  const text = desktopEntryText(executable, fs.exists(icon) ? icon : undefined, { autostart: true })
  if (fs.exists(file) && fs.read(file) === text) return 'unchanged'
  fs.write(file, text)
  return 'written'
}

/** Whether a Wayland session is running (Electron then talks Wayland natively, and global hotkeys need a portal). */
export const isWayland = (platform: string = process.platform, env: Env = process.env): boolean =>
  platformOf(platform) === 'linux' && (env.XDG_SESSION_TYPE === 'wayland' || !!env.WAYLAND_DISPLAY)

/** The Chromium feature that routes globalShortcut through the desktop's GlobalShortcuts portal, turned on under
 *  Wayland only (null elsewhere). */
export const hotkeyFeature = (platform: string = process.platform, env: Env = process.env): string | null =>
  isWayland(platform, env) ? 'GlobalShortcutsPortal' : null

/** `NameHasOwner` output from gdbus ("(true,)") or dbus-send ("boolean true"); undefined when it's neither. */
export function parseHasOwner(out: string): boolean | undefined {
  if (/\btrue\b/.test(out)) return true
  if (/\bfalse\b/.test(out)) return false
  return undefined
}

type Run = (cmd: string, args: string[]) => Promise<string>
const run: Run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { timeout: 3000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout)))))

const WATCHER = 'org.kde.StatusNotifierWatcher'

/** Whether the desktop has a tray. Windows and macOS always do. Linux: Electron's tray is a StatusNotifierItem,
 *  which shows only when something owns org.kde.StatusNotifierWatcher on the session bus (KDE, most others; GNOME
 *  only with the AppIndicator extension). Asked through gdbus, then dbus-send; if neither answers, no tray. */
export async function hasTray(platform: string = process.platform, exec: Run = run): Promise<boolean> {
  if (platformOf(platform) !== 'linux') return true
  const tries: [string, string[]][] = [
    ['gdbus', ['call', '--session', '--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.NameHasOwner', WATCHER]],
    ['dbus-send', ['--session', '--print-reply', '--dest=org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus.NameHasOwner', `string:${WATCHER}`]]
  ]
  for (const [cmd, args] of tries) {
    try {
      const owned = parseHasOwner(await exec(cmd, args))
      if (owned !== undefined) return owned
    } catch {
      /* not installed, or no session bus: try the next */
    }
  }
  return false
}

/** What closing the window does. With a tray (Windows, macOS's Dock, Linux with a StatusNotifier host) it hides,
 *  as before. Linux with no tray: Corvid would become an invisible app nobody can bring back, so it quits like any
 *  other app when nothing runs in it, and asks (minimise or quit) while terminals or agents are running. */
export function closeAction(trayShown: boolean, running: number, platform: string = process.platform): 'hide' | 'quit' | 'ask' {
  if (platformOf(platform) !== 'linux' || trayShown) return 'hide'
  return running > 0 ? 'ask' : 'quit'
}

/** At a --hidden start (open at login): stay hidden only where a tray can bring the window back, else minimised. */
export const hiddenStartAction = (trayShown: boolean, platform: string = process.platform): 'hide' | 'minimize' =>
  platformOf(platform) === 'linux' && !trayShown ? 'minimize' : 'hide'

/** Whether a tray icon click can be relied on: on Linux, GNOME's AppIndicator only opens the menu (KDE may send the
 *  click too), so the menu has to carry every action. */
export const trayClicks = (platform: string = process.platform): boolean => platformOf(platform) !== 'linux'
