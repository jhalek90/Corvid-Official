import { homedir } from 'node:os'
import { pathsOf, platformOf } from './shared.mjs'

// Where the Claude Code CLI may be installed (#149), and how the newest usable one is picked (#152, used by
// main/claudeBin.ts resolveClaude). The Windows list and choice are what claudeBin.ts did before.

export interface ClaudeLocations {
  /** the executable's file name */
  binary: string
  /** the VS Code extensions folder; each anthropic.claude-code-<version> in it has extensionBinary inside */
  extensionsRoot: string
  extensionBinary: string[]
  /** fixed places, in no particular order (the newest version wins) */
  fixed: { path: string; source: string }[]
  /** whether `claude` on PATH may be used. Never on Windows: there it is ~/bin/claude.bat, a WSL wrapper. */
  usePath: boolean
}

export function claudeLocations(platform: string = process.platform, home: string = homedir()): ClaudeLocations {
  const os = platformOf(platform)
  const { join } = pathsOf(os)
  const binary = os === 'win32' ? 'claude.exe' : 'claude'
  const base = { binary, extensionsRoot: join(home, '.vscode', 'extensions'), extensionBinary: ['resources', 'native-binary', binary] }
  if (os === 'win32') return { ...base, fixed: [{ path: join(home, '.local', 'bin', 'claude.exe'), source: '~/.local/bin' }], usePath: false }
  // N78 item 1; still to be checked on a real Mac and Linux box (docs/PLATFORM.md checklist)
  const fixed = [
    { path: join(home, '.local', 'bin', 'claude'), source: '~/.local/bin' },
    { path: join(home, '.claude', 'local', 'claude'), source: '~/.claude/local' }
  ]
  if (os === 'darwin') fixed.push({ path: '/opt/homebrew/bin/claude', source: 'Homebrew' }, { path: '/usr/local/bin/claude', source: '/usr/local/bin' })
  return { ...base, fixed, usePath: true }
}

/** What findClaude asks of the machine, so the tests can hand it a fake file layout. */
export interface ClaudeProbe {
  /** a file that is there (and, off Windows, can be run) */
  exists(path: string): boolean
  /** the names in a folder; throws when there is no such folder */
  readdir(dir: string): string[]
  /** the x.y.z that `<path> --version` prints, or null when it prints none (it doesn't run) */
  version(path: string): Promise<string | null>
}

export interface FoundClaude {
  path: string
  version: string
  source: string
}

export function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d) return d
  }
  return 0
}

/**
 * The newest Claude Code CLI on this machine (#152), or null.
 * Windows, as before: the VS Code extension's claude.exe (version from its folder name, not run) and
 * ~/.local/bin/claude.exe, never `claude` on PATH. macOS and Linux: the fixed places, the VS Code extension's
 * native-binary/claude, then `claude` on PATH; each one must answer `--version` to count. Ties keep that order.
 */
export async function findClaude(probe: ClaudeProbe, platform: string = process.platform, home: string = homedir(), env: NodeJS.ProcessEnv = process.env): Promise<FoundClaude | null> {
  const os = platformOf(platform)
  const { join } = pathsOf(os)
  const l = claudeLocations(os, home)
  const extension: FoundClaude[] = []
  try {
    for (const name of probe.readdir(l.extensionsRoot)) {
      const m = /^anthropic\.claude-code-(\d+\.\d+\.\d+)/.exec(name)
      if (!m) continue
      const p = join(l.extensionsRoot, name, ...l.extensionBinary)
      if (probe.exists(p)) extension.push({ path: p, version: m[1], source: 'VS Code extension' })
    }
  } catch {
    /* no extensions dir */
  }

  let candidates: FoundClaude[]
  if (os === 'win32') {
    candidates = extension
    for (const f of l.fixed) if (probe.exists(f.path)) candidates.push({ ...f, version: (await probe.version(f.path)) ?? '0.0.0' })
  } else {
    const places = [...l.fixed.filter((f) => probe.exists(f.path)), ...extension]
    const onPath = l.usePath ? pathLookup(l.binary, env, probe.exists, os) : undefined
    if (onPath) places.push({ path: onPath, source: 'PATH' })
    const unique = places.filter((p, i) => places.findIndex((q) => q.path === p.path) === i)
    const versions = await Promise.all(unique.map((p) => probe.version(p.path)))
    candidates = unique.flatMap((p, i) => (versions[i] ? [{ path: p.path, source: p.source, version: versions[i] }] : []))
  }
  candidates.sort((a, b) => cmpVersion(b.version, a.version))
  return candidates[0] ?? null
}

function pathLookup(exe: string, env: NodeJS.ProcessEnv, exists: (p: string) => boolean, platform: string): string | undefined {
  const { join } = pathsOf(platform)
  for (const dir of (env.PATH ?? '').split(':')) {
    if (dir.startsWith('/') && exists(join(dir, exe))) return join(dir, exe)
  }
  return undefined
}
