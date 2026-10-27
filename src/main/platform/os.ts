import { existsSync } from 'node:fs'
import { platformOf } from './shared.mjs'
import { onPath } from './shells'
import type { VoiceStatus } from '@shared/types'

// OS integration (#149): what main/index.ts and main/launch.ts do on Windows today, described per platform.
// The call sites still do it themselves; #155 (macOS window, Dock, badge, tray), #157 (launchers) and #158
// (Linux desktop) switch them and fill in darwin and linux.

/** How "open at login" is set: electron's login item settings on Windows and macOS, an autostart .desktop on Linux. */
export function loginItemKind(platform: string = process.platform): 'electron' | 'autostart-desktop' {
  return platformOf(platform) === 'linux' ? 'autostart-desktop' : 'electron'
}

/** How "a session needs you" shows on the app's icon: the taskbar overlay dot on Windows (setOverlayIcon). */
export function badgeKind(platform: string = process.platform): 'overlay' | 'dock' | 'count' {
  const os = platformOf(platform)
  return os === 'win32' ? 'overlay' : os === 'darwin' ? 'dock' : 'count'
}

/** The tray icon files in resources/: macOS wants a monochrome template image (planned, not made yet). */
export function trayImage(platform: string = process.platform): { normal: string; alert: string } {
  return platformOf(platform) === 'darwin' ? { normal: 'trayTemplate.png', alert: 'tray-alertTemplate.png' } : { normal: 'tray.png', alert: 'tray-alert.png' }
}

/** Single-quotes `s` for a POSIX shell script: everything inside '…' is literal (spaces, ", $, backticks, \,
 *  newlines), and a ' becomes '\''. A NUL byte can't be in a path or an argument, so it's refused. */
export function shQuote(s: string): string {
  if (s.includes('\0')) throw new Error('A NUL byte cannot be passed to a shell')
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** How each Linux terminal takes a program to run, by executable name; any other gets `-e <script>`. The program
 *  is always Corvid's own script at a path with no spaces or quotes, so terminals that re-split the -e value as a
 *  string (xfce4-terminal's -e, some x-terminal-emulator wrappers) still get it whole. */
const LINUX_TERMINAL_FLAGS: Record<string, string[]> = {
  'gnome-terminal': ['--'],
  'xfce4-terminal': ['-x'],
  terminator: ['-x'],
  wezterm: ['start', '--'],
  kitty: [],
  foot: []
}
/** The fallbacks after $TERMINAL, in order (N78 item 2). */
export const LINUX_TERMINALS = ['x-terminal-emulator', 'gnome-terminal', 'konsole', 'xterm']

/** Where the external terminal is: Windows Terminal (wt.exe, as always), Terminal.app through `open` on macOS, and
 *  on Linux $TERMINAL (one word: a name on the PATH or an absolute path), then LINUX_TERMINALS. null if none. */
export function findTerminal(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): { name: string; file: string } | null {
  const os = platformOf(platform)
  if (os === 'win32') return { name: 'wt', file: 'wt.exe' }
  if (os === 'darwin') return { name: 'Terminal', file: '/usr/bin/open' }
  const own = (env.TERMINAL ?? '').trim()
  const names = /^[^\s'"`$;&|<>\\]+$/.test(own) ? [own, ...LINUX_TERMINALS] : LINUX_TERMINALS
  for (const n of names) {
    const file = n.startsWith('/') ? (exists(n) ? n : undefined) : n.includes('/') ? undefined : onPath(n, env, exists, ':', platform)
    if (file) return { name: n.slice(n.lastIndexOf('/') + 1), file }
  }
  return null
}

/** Whether "Resume in a terminal window" shows: always on Windows and macOS, on Linux when a terminal was found. */
export const terminalAvailable = (platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): boolean =>
  findTerminal(platform, env, exists) !== null

/** The script a macOS or Linux terminal window runs: it deletes itself (and its folder, once empty) first, goes to
 *  `cwd`, sets the window title and execs `bin args`. Every value is single-quoted by shQuote, and the title also
 *  loses control characters so it can't end the title escape early. */
export function terminalScript(script: string, cwd: string, bin: string, args: string[], title?: string): string {
  const dir = script.slice(0, script.lastIndexOf('/')) || '/'
  const lines = ['#!/bin/sh', '# Written by Corvid to resume a Claude Code session in a terminal window. It deletes itself.']
  lines.push(`rm -f -- ${shQuote(script)}`, `rmdir -- ${shQuote(dir)} 2>/dev/null`, `cd -- ${shQuote(cwd)} || exit 1`)
  const name = (title ?? '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').trim().slice(0, 120)
  if (name) lines.push(`printf '\\033]0;%s\\007' ${shQuote(name)}`)
  lines.push(['exec', ...[bin, ...args].map(shQuote)].join(' '))
  return lines.join('\n') + '\n'
}

/** The command that opens a new external terminal in `cwd` running `bin args`, or null when there's no terminal.
 *  Windows: a Windows Terminal tab, exactly as before (no script). macOS and Linux run `probe.script`, written
 *  first from terminalScript: macOS through `open -a Terminal` (so it must end in .command), Linux in the terminal
 *  findTerminal picks, with that terminal's argument form. */
export function externalTerminal(
  cwd: string,
  bin: string,
  args: string[],
  title?: string,
  platform: string = process.platform,
  probe: { script?: string; env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {}
): { file: string; args: string[] } | null {
  const os = platformOf(platform)
  if (os === 'win32') {
    const a = ['-w', 'new', 'new-tab', '-d', cwd]
    if (title) a.push('--title', title.replace(/;/g, ','))
    a.push(bin, ...args)
    return { file: 'wt.exe', args: a }
  }
  const script = probe.script ?? ''
  if (!/^\/[A-Za-z0-9._/-]+$/.test(script)) throw new Error(`Unsafe terminal script path: ${JSON.stringify(script)}`)
  if (os === 'darwin') {
    if (!script.endsWith('.command')) throw new Error('Terminal.app only runs a script that ends in .command')
    return { file: '/usr/bin/open', args: ['-a', 'Terminal', script] }
  }
  const t = findTerminal(platform, probe.env ?? process.env, probe.exists ?? existsSync)
  return t && { file: t.file, args: [...(LINUX_TERMINAL_FLAGS[t.name] ?? ['-e']), script] }
}

/** VS Code's bundle id, for `open -b` when `code` isn't on a macOS app's PATH. */
export const VSCODE_BUNDLE_ID = 'com.microsoft.VSCode'

/** The command that opens `targets` in VS Code, or null when only the vscode:// URI is left.
 *  Windows: `code` is a .cmd shim, so it runs through cmd.exe with verbatim arguments and the caller quotes the
 *  paths ("D:\p"), exactly as before. macOS and Linux: `targets` are plain absolute paths (and -r) passed as an
 *  args array with no shell, to `code` from the PATH (which has the login shell's PATH merged in, #152). On macOS
 *  without it, `open -b com.microsoft.VSCode <paths>`: that hands the paths to VS Code whether or not it's running
 *  (with --args they're dropped when it already is), and -r is left out because `open` would read it as its own. */
export function vscodeCommand(
  targets: string[],
  platform: string = process.platform,
  probe: { env?: NodeJS.ProcessEnv; exists?: (p: string) => boolean } = {}
): { file: string; args: string[]; verbatim: boolean } | null {
  const os = platformOf(platform)
  if (os === 'win32') return { file: 'cmd.exe', args: ['/d', '/s', '/c', 'code', ...targets], verbatim: true }
  for (const t of targets) {
    if (t.includes('\0') || !(t.startsWith('/') || t === '-r')) throw new Error(`Not an absolute path: ${JSON.stringify(t)}`)
  }
  const code = onPath('code', probe.env ?? process.env, probe.exists ?? existsSync, ':', platform)
  if (code) return { file: code, args: [...targets], verbatim: false }
  if (os === 'darwin') return { file: '/usr/bin/open', args: ['-b', VSCODE_BUNDLE_ID, ...targets.filter((t) => t !== '-r')], verbatim: false }
  return null
}

/** A vscode://file URI for an absolute POSIX path, each segment percent-encoded (so #, ? and spaces stay in the path). */
export const vscodeFileUri = (path: string): string => 'vscode://file' + path.split('/').map(encodeURIComponent).join('/')

/** Whether voice dictation runs here: Windows only (decision m597). Elsewhere it stays off, so there's no mic
 *  permission request, no read of Claude Code's credentials file and no Keychain lookup. */
export function voiceSupported(platform: string = process.platform): boolean {
  return platformOf(platform) === 'win32'
}

/** The dictation status the window gets. On Windows it's today's check: the OS mic setting, then the claude.ai
 *  login. Anywhere else neither probe is called. */
export function voiceStatusOf(probe: { micAccess: () => string; signedIn: () => boolean }, platform: string = process.platform): VoiceStatus {
  if (!voiceSupported(platform)) return { supported: false, enabled: false, micDenied: false, platform }
  let micDenied = false
  try {
    const s = probe.micAccess()
    micDenied = s === 'denied' || s === 'restricted'
  } catch {
    /* not supported on this platform */
  }
  return { supported: true, enabled: probe.signedIn(), micDenied, platform }
}
