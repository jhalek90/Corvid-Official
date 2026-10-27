import { existsSync } from 'node:fs'
import { delimiter } from 'node:path'
import { pathsOf, platformOf } from './shared.mjs'
import { loginEnvApplied } from './loginEnv'

// Shells per platform (#149, #153). The Windows list and default are main/pty.ts's, moved unchanged. pty.ts uses
// shellList for the side terminals and projectShell for a project's terminal (launchShell).

export interface ShellDef {
  id: string
  label: string
  file: string
  args: string[]
}

/** Where `exe` is on the PATH, if anywhere. */
export function onPath(exe: string, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync, sep: string = delimiter, platform: string = process.platform): string | undefined {
  const { join } = pathsOf(platform)
  for (const dir of (env.PATH ?? '').split(sep)) {
    if (dir && exists(join(dir, exe))) return join(dir, exe)
  }
  return undefined
}

/** Where POSIX shells are looked for besides the PATH: a macOS GUI app's PATH is only /usr/bin:/bin:/usr/sbin:/sbin. */
const SHELL_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin']
const POSIX_SHELLS: { id: string; label: string; args: string[] }[] = [
  { id: 'zsh', label: 'zsh', args: ['-l'] },
  { id: 'bash', label: 'bash', args: ['-l'] },
  { id: 'fish', label: 'fish', args: ['-l'] },
  { id: 'sh', label: 'sh', args: ['-l'] },
  { id: 'pwsh', label: 'PowerShell 7', args: ['-NoLogo'] }
]

/** The shells this machine may have, best default first, `file` empty for one that isn't installed.
 *  Windows: PowerShell 7, Windows PowerShell, Command Prompt, Git Bash, WSL. Elsewhere: the user's $SHELL as a
 *  login shell, then zsh, bash, fish, sh and pwsh, each once. */
export function shellCandidates(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): ShellDef[] {
  if (platformOf(platform) === 'win32') {
    const { join } = pathsOf('win32')
    const sys = join(env.SystemRoot ?? 'C:\\Windows', 'System32')
    const programFiles = env.ProgramFiles ?? 'C:\\Program Files'
    const found = (paths: (string | undefined)[]): string | undefined => paths.find((p) => p && exists(p))
    return [
      { id: 'pwsh', label: 'PowerShell 7', args: ['-NoLogo'], file: found([join(programFiles, 'PowerShell', '7', 'pwsh.exe'), onPath('pwsh.exe', env, exists, ';', 'win32')]) ?? '' },
      { id: 'powershell', label: 'PowerShell', args: ['-NoLogo'], file: found([join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe')]) ?? '' },
      { id: 'cmd', label: 'Command Prompt', args: [], file: found([env.ComSpec, join(sys, 'cmd.exe')]) ?? '' },
      { id: 'gitbash', label: 'Git Bash', args: ['--login', '-i'], file: found([join(programFiles, 'Git', 'bin', 'bash.exe')]) ?? '' },
      { id: 'wsl', label: 'WSL', args: [], file: found([join(sys, 'wsl.exe')]) ?? '' }
    ]
  }
  const { basename, join } = pathsOf(platform)
  const find = (exe: string): string => onPath(exe, env, exists, ':', platform) ?? SHELL_DIRS.map((d) => join(d, exe)).find((p) => exists(p)) ?? ''
  const list: ShellDef[] = POSIX_SHELLS.map((s) => ({ ...s, args: [...s.args], file: find(s.id) }))
  const login = env.SHELL && exists(env.SHELL) ? env.SHELL : ''
  if (!login) return list
  const name = basename(login)
  const known = POSIX_SHELLS.find((s) => s.id === name)
  // pwsh takes -Login (or -l) only as its first argument, which this is
  const own: ShellDef = { id: known?.id ?? name, label: known?.label ?? name, args: ['-l'], file: login }
  return [own, ...list.filter((s) => s.id !== own.id)]
}

/** The installed shells, best default first. */
export function shellList(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): ShellDef[] {
  return shellCandidates(platform, env, exists).filter((c) => c.file)
}

/** The shell a project's terminal runs. Windows: powershell.exe -NoLogo, as main/pty.ts launchShell always has.
 *  Elsewhere: the first of shellList (the user's login shell), else /bin/sh -l. */
export function projectShell(platform: string = process.platform, env: NodeJS.ProcessEnv = process.env, exists: (p: string) => boolean = existsSync): { file: string; args: string[] } {
  if (platformOf(platform) === 'win32') return { file: 'powershell.exe', args: ['-NoLogo'] }
  const def = shellList(platform, env, exists)[0]
  return def ? { file: def.file, args: def.args } : { file: '/bin/sh', args: ['-l'] }
}

/** Extra environment a GUI app needs for its shells: on macOS the login shell's PATH (#152). Nothing on Windows.
 *  loginEnv.ts has already merged it into process.env once it arrived; this is what it merged. */
export function loginEnv(platform: string = process.platform): Record<string, string> {
  if (platformOf(platform) === 'win32') return {}
  return loginEnvApplied()
}
