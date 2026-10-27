import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { userInfo } from 'node:os'
import { platformOf } from './shared.mjs'

// The GUI PATH fix (#152, N78 items 1 and 3). A macOS app started from the Dock or Finder gets launchd's minimal
// PATH (/usr/bin:/bin:/usr/sbin:/sbin), so the agents and terminals it spawns can't find git, node, npm, brew
// tools or claude. Like VS Code, Corvid asks the user's login shell once at startup what its environment is and
// merges the PATH from it into process.env, which every spawn inherits. Only PATH is taken (and LANG when the
// app has none): nothing else from the shell, so no tokens or secrets set in a profile leak into Corvid.
// The command is fixed, the output is only ever parsed as text, and a shell that hangs is killed after a timeout.
// Nothing happens on Windows. Linux desktops usually pass a usable PATH already; merging it again is harmless.

const TIMEOUT_MS = 5_000
const MAX_OUTPUT = 1024 * 1024

/**
 * The variables printed by `env` between two marker lines, so whatever a profile echoes before or after (a
 * banner, a fortune, "Last login: …") is ignored. A line that doesn't start NAME= continues the value above it
 * (a multiline value). Missing markers give an empty result.
 */
export function parseEnvOutput(text: string, mark: string): Record<string, string> {
  const lines = text.split(/\r?\n/)
  const start = lines.indexOf(mark)
  const end = start < 0 ? -1 : lines.indexOf(mark, start + 1)
  if (end < 0) return {}
  const out: Record<string, string> = {}
  let last: string | undefined
  for (const line of lines.slice(start + 1, end)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (m) {
      last = m[1]
      out[last] = m[2]
    } else if (last !== undefined) {
      out[last] += '\n' + line
    }
  }
  return out
}

/** The login shell's PATH first, then the app's own entries it doesn't have. Relative and empty entries are dropped. */
export function mergePath(login: string | undefined, current: string | undefined): string | undefined {
  const usable = (p: string | undefined): string[] => (p ?? '').split(':').filter((d) => d.startsWith('/') && !/[\0\n]/.test(d))
  const merged = [...new Set([...usable(login), ...usable(current)])]
  return merged.length ? merged.join(':') : current
}

/** What to set in the app's environment from the login shell's: PATH, and LANG when the app has none. */
export function loginEnvChanges(login: Record<string, string>, current: NodeJS.ProcessEnv): Record<string, string> {
  const changes: Record<string, string> = {}
  const path = mergePath(login.PATH, current.PATH)
  if (path && path !== current.PATH) changes.PATH = path
  // macOS GUI apps often start with no LANG, which garbles UTF-8 in zsh and in claude's output
  if (!current.LANG) changes.LANG = /^[A-Za-z0-9_.@-]+$/.test(login.LANG ?? '') ? login.LANG : 'en_US.UTF-8'
  return changes
}

/** The shell to ask: $SHELL, else the account's shell, else /bin/sh. Only an absolute path. */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  let account = ''
  try {
    account = userInfo().shell ?? ''
  } catch {
    /* no passwd entry */
  }
  return [env.SHELL, account].find((s) => s && s.startsWith('/')) ?? '/bin/sh'
}

/** Runs `<shell> -i -l -c` with a fixed command that prints `env` between markers. Resolves {} on any failure. */
export function readLoginShellEnv(shell: string, timeoutMs: number = TIMEOUT_MS): Promise<Record<string, string>> {
  const mark = `__CORVID_ENV_${randomBytes(8).toString('hex')}__`
  // printf and env are in every shell Corvid supports (sh, bash, zsh, fish); the marker is hex only
  const command = `printf '\\n%s\\n' ${mark}; env; printf '%s\\n' ${mark}`
  return new Promise((resolve) => {
    try {
      execFile(
        shell,
        ['-i', '-l', '-c', command],
        { timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_OUTPUT, encoding: 'utf8', windowsHide: true, env: { ...process.env, CORVID_RESOLVING_ENVIRONMENT: '1' } },
        (_err, stdout) => resolve(parseEnvOutput(stdout ?? '', mark))
      ).stdin?.end()
    } catch {
      resolve({})
    }
  })
}

let applied: Record<string, string> = {}
let ready: Promise<void> | null = null

/** Starts reading the login shell's environment (once) and merges it into process.env when it arrives. */
export function loadLoginEnv(platform: string = process.platform): Promise<void> {
  if (ready) return ready
  if (platformOf(platform) === 'win32') return (ready = Promise.resolve())
  ready = readLoginShellEnv(loginShell())
    .then((login) => {
      applied = loginEnvChanges(login, process.env)
      Object.assign(process.env, applied)
      if (applied.PATH) console.log('[loginEnv] merged the login shell PATH')
    })
    .catch((e) => console.error('[loginEnv] could not read the login shell environment', e))
  return ready
}

/** Resolves once the login environment has been merged (or skipped); starts the read if nobody has. */
export const loginEnvReady = (): Promise<void> => loadLoginEnv()

/** What was merged into process.env from the login shell ({} on Windows, or before it arrived). */
export const loginEnvApplied = (): Record<string, string> => ({ ...applied })
