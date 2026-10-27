import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ClaudeBinary } from '@shared/types'
import { findClaude, type ClaudeProbe } from './platform/claude'
import { loginEnvReady } from './platform/loginEnv'

/** Where the app sends people who don't have Claude Code yet (scripts/setup.mjs says the same). */
export const CLAUDE_INSTALL_URL = 'https://code.claude.com/docs/en/overview'

/** The x.y.z that `<path> --version` prints, or null when it prints none. */
function versionOf(path: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(path, ['--version'], { timeout: 15_000, windowsHide: true }, (_err, stdout) => {
      resolve(/(\d+\.\d+\.\d+)/.exec(stdout ?? '')?.[1] ?? null)
    })
  })
}

/** A file that is there and, off Windows, can be run. */
function runnable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false
    if (process.platform !== 'win32') accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

const probe: ClaudeProbe = { exists: runnable, readdir: (dir) => readdirSync(dir), version: versionOf }

/** What every "can't run claude" message says, on every platform (#152). */
export const CLAUDE_NOT_FOUND = `Claude Code (claude) not found. Install it from ${CLAUDE_INSTALL_URL}, or choose it in Settings → System → Claude Code path.`

let cached: { at: number; bin: ClaudeBinary | null } | null = null

/** Settings changed the Claude path (#194): the next lookup looks again instead of using the last minute's answer. */
export function forgetClaude(): void {
  cached = null
}

/**
 * The newest Claude Code CLI (platform/claude.ts findClaude has the places per platform). On Windows never
 * `claude` on PATH: on this machine that's ~/bin/claude.bat, a WSL wrapper. Elsewhere PATH counts, after the
 * login shell's PATH has been merged in (loginEnv.ts), since a macOS GUI app starts with a minimal one.
 */
export async function resolveClaude(override?: string): Promise<ClaudeBinary | null> {
  if (override && existsSync(override)) {
    return { path: override, version: (await versionOf(override)) ?? '0.0.0', source: 'config' }
  }
  if (cached && Date.now() - cached.at < 60_000) return cached.bin

  await loginEnvReady()
  const bin = await findClaude(probe)
  cached = { at: Date.now(), bin }
  return bin
}

/** The model Claude Code uses when none is passed, from ~/.claude/settings.json (e.g. "opus[1m]"). */
export function claudeDefaultModel(): string | undefined {
  try {
    const s = JSON.parse(readFileSync(join(homedir(), '.claude', 'settings.json'), 'utf8'))
    return typeof s.model === 'string' ? s.model : undefined
  } catch {
    return undefined
  }
}
