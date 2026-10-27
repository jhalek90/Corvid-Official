import { execFile } from 'node:child_process'
import { accessSync, constants, realpathSync, statSync } from 'node:fs'
import { isAbsolute, posix, win32 } from 'node:path'
import type { ClaudePathCheck } from '@shared/types'

// The Claude Code path the user picks in Settings → System (#194). Only Settings sets it (config:claudePath in
// index.ts checks the sender and asks in Corvid's own dialog); applyConfig drops the key from every other patch.

/** Longer than this is not a path anyone picked. */
export const CLAUDE_PATH_MAX = 1024

/** Windows script wrappers: on some machines `claude.bat` runs Claude inside WSL (#152), and none of them run without a shell. */
const WINDOWS_SCRIPTS = /\.(bat|cmd|ps1|vbs|js|sh)$/i

/**
 * The text checks, no disk: a string, not too long, no control characters or newlines, absolute (a relative path is
 * refused, not resolved: relative to what would be a guess), and on Windows a .exe (a .bat, .cmd or .ps1 is refused).
 */
export function checkClaudePathText(raw: unknown, platform: string = process.platform): { path: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'The Claude Code path must be text.' }
  // a newline or tab anywhere, even at the end, is refused rather than trimmed off; spaces around the path are trimmed
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { error: 'That path has a newline or another control character in it.' }
  const path = raw.trim()
  if (!path) return { error: 'Choose the Claude Code program first.' }
  if (path.length > CLAUDE_PATH_MAX) return { error: `That path is longer than ${CLAUDE_PATH_MAX} characters.` }
  const win = platform === 'win32'
  const absolute = win ? /^[a-zA-Z]:[\\/]|^\\\\[^\\]/.test(path) : isAbsolute(path)
  if (!absolute) return { error: 'Use the full path, starting from the drive or /. A relative path is refused.' }
  if (win && WINDOWS_SCRIPTS.test(path))
    return {
      error:
        "That's a script, not Claude Code itself. On some computers claude.bat or claude.cmd runs Claude inside WSL, so Corvid doesn't use them. Pick claude.exe: the native installer puts it in .local\\bin in your user folder."
    }
  if (win && !/\.exe$/i.test(path)) return { error: 'On Windows, pick claude.exe.' }
  // C:/x/claude.exe is saved as C:\x\claude.exe, and /a/../b as /b
  return { path: (win ? win32 : posix).normalize(path) }
}

/** What the check asks of the machine, so the tests can hand it fakes. */
export interface ClaudePathProbe {
  /** 'file', 'dir', or null when nothing is there */
  kind(path: string): 'file' | 'dir' | null
  executable(path: string): boolean
  realpath(path: string): string
  /** runs `<path> --version` and nothing else */
  version(path: string): Promise<{ stdout: string; timedOut: boolean; failed: boolean }>
}

/** How long Check waits for `--version`, and how much of its output is kept. */
export const VERSION_TIMEOUT_MS = 5_000
const VERSION_MAX_BYTES = 16 * 1024

/** `<path> --version`, no shell, args as an array, a short timeout and capped output. */
export function runVersion(path: string, timeoutMs: number = VERSION_TIMEOUT_MS): Promise<{ stdout: string; timedOut: boolean; failed: boolean }> {
  return runCapped(path, ['--version'], timeoutMs)
}

/** runVersion's run, exported only so the tests can start a fake script through node on Windows (no shell there either). */
export function runCapped(file: string, args: string[], timeoutMs: number): Promise<{ stdout: string; timedOut: boolean; failed: boolean }> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: VERSION_MAX_BYTES, windowsHide: true, shell: false, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout) => {
      const e = err as (NodeJS.ErrnoException & { killed?: boolean; signal?: string }) | null
      resolve({ stdout: String(stdout ?? '').slice(0, VERSION_MAX_BYTES), timedOut: !!e && e.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && (e.killed === true || e.signal === 'SIGTERM'), failed: !!e })
    })
  })
}

export const realProbe: ClaudePathProbe = {
  kind: (p) => {
    try {
      const s = statSync(p)
      return s.isDirectory() ? 'dir' : s.isFile() ? 'file' : null
    } catch {
      return null
    }
  },
  executable: (p) => {
    if (process.platform === 'win32') return true
    try {
      accessSync(p, constants.X_OK)
      return true
    } catch {
      return false
    }
  },
  realpath: (p) => realpathSync(p),
  version: (p) => runVersion(p)
}

/**
 * Settings' Check (#194): the text checks, then the file (there, not a folder, can be run), then `--version` once. It
 * passes only when the answer has a version and says Claude Code. A symlink is fine; `resolved` is where it points.
 */
export async function checkClaudePath(raw: unknown, probe: ClaudePathProbe = realProbe, platform: string = process.platform): Promise<ClaudePathCheck> {
  const t = checkClaudePathText(raw, platform)
  if ('error' in t) return { ok: false, error: t.error }
  const kind = probe.kind(t.path)
  if (kind === null) return { ok: false, error: 'Not found: there is no file at that path.' }
  if (kind === 'dir') return { ok: false, error: "That's a folder. Pick the claude program inside it." }
  if (!probe.executable(t.path)) return { ok: false, error: "Not executable: that file can't be run (check its permissions)." }
  let resolved: string | undefined
  try {
    const r = probe.realpath(t.path)
    if (platform === 'win32' ? r.toLowerCase() !== t.path.toLowerCase() : r !== t.path) resolved = r
  } catch {
    /* the path itself is used */
  }
  const out = await probe.version(t.path)
  if (out.timedOut) return { ok: false, error: `It didn't answer: --version took longer than ${VERSION_TIMEOUT_MS / 1000} seconds.` }
  const version = /(\d+\.\d+\.\d+)/.exec(out.stdout)?.[1]
  if (!version || !/claude code/i.test(out.stdout))
    return { ok: false, error: out.failed && !out.stdout.trim() ? "Not executable: it didn't start, or stopped with an error." : "That doesn't look like Claude Code: --version didn't print a Claude Code version." }
  return { ok: true, path: t.path, resolved, version }
}
