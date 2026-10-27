import { hostOs, pathKey } from './pathKeys'

/** Paths compare case-insensitively on Windows and macOS; trailing separators are noise. Windows keeps the
 *  separators as written (normKey unifies them); elsewhere this is pathKey (#151). */
export function projectKey(path: string): string {
  const os = hostOs()
  return os === 'win32' ? path.replace(/[\\/]+$/, '').toLowerCase() : pathKey(path, os)
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/**
 * The repo a worker's worktree belongs to: <repo>-worktrees\task-<id>-<slug> maps back to <repo>, so
 * sessions run there count under the real project (even after the worktree is gone). Null otherwise.
 */
export function worktreeRoot(path: string): string | null {
  const m = /^(.*[\\/])([^\\/]+)-worktrees[\\/]task-\d+-[^\\/]*[\\/]*$/i.exec(path)
  return m ? m[1] + m[2] : null
}

/** The project folder a session's cwd counts under. */
export const projectPath = (cwd: string): string => worktreeRoot(cwd) ?? cwd
