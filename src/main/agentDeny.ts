import { app } from 'electron'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, join, relative } from 'node:path'
import type { AppConfig } from '@shared/types'
import { cleanDenyPattern, denyDefaultsFor, nameMatches } from '@shared/secretRules'
import { normKey } from '@shared/projectList'
import { getConfig } from './config'
import { absRule, customClaudeDir, dataDirCandidates } from './platform'

// Files agents may not read or edit (#91). Every worker and Corvid's assistant gets a generated Claude
// Code settings file with deny rules, passed with --settings. That flag adds a settings layer on top of
// the user's own (user, project and local settings all still load, and permission rules from every
// layer combine), so Corvid never writes or overwrites ~/.claude/settings.json.
//
// Claude Code checks deny rules before allow rules, so an allow rule can't make an exception to a
// denied glob. "Allow this one" therefore drops the glob for that project and denies each other
// matching file in it by its exact path instead (found when the agent starts).

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', 'coverage', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.cache', '.turbo'])
const MAX_FILES = 20_000

// Claude Code's absolute-path form of a path, from the platform layer: //c/Users/... on Windows, //Users/... elsewhere (#150)
export { absRule }

/** The rules for this copy's data folder and the real app's (every name it has had on `platform`), which a test
 *  copy's agents mustn't read either: %APPDATA%\Corvid, ~/Library/Application Support/Corvid or ~/.config/Corvid. */
export const dataFolderRules = (userData: string, appData: string, platform: string = process.platform): string[] => [
  ...new Set([userData, ...dataDirCandidates(appData, platform)].map((d) => `${absRule(d, platform)}/**`))
]

/** Corvid's own data folder (this copy's: a test copy has its own). */
export const dataFolderPattern = (): string => `${absRule(app.getPath('userData'))}/**`

/** This copy's data folder and the real app's. */
export const dataFolders = (): string[] => dataFolderRules(app.getPath('userData'), app.getPath('appData'))

/** The Claude Code login when CLAUDE_CONFIG_DIR moves it out of ~/.claude, which the default already covers. */
export const claudeConfigRules = (env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string[] =>
  env.CLAUDE_CONFIG_DIR ? [`${absRule(env.CLAUDE_CONFIG_DIR, platform)}/.credentials.json`] : []

/** The Claude Code config folder for sessions on the user's own models (#314): one per copy, outside its data folder. */
export const customConfigDir = (): string => customClaudeDir(basename(app.getPath('userData')))

/** The login file there, which should never exist (Corvid puts none in it), denied anyway once there are custom models. */
export const customConfigRules = (c: AppConfig, platform: string = process.platform): string[] =>
  c.models?.length ? [`${absRule(customConfigDir(), platform)}/.credentials.json`] : []

/** The patterns in force, before any per-project exception: the defaults left on, the data folder, the user's own. */
export function denyPatterns(c: AppConfig = getConfig(), platform: string = process.platform): { home: string[]; project: string[] } {
  const off = new Set(c.agentDenyOff ?? [])
  const on = denyDefaultsFor(platform).filter((d) => !off.has(d.pattern))
  const extra = (c.agentDenyExtra ?? []).map(cleanDenyPattern).filter((p): p is string => !!p)
  const login = off.has('~/.claude/.credentials.json') ? [] : claudeConfigRules(process.env, platform)
  // the custom models' folder isn't the user's login, so switching that default off doesn't open it
  const custom = customConfigRules(c, platform)
  return {
    // the data folder holds the secrets, connections and backups: it can't be switched off
    home: [...dataFolderRules(app.getPath('userData'), app.getPath('appData'), platform), ...on.filter((d) => !d.project).map((d) => d.pattern), ...login, ...custom, ...extra.filter((p) => !p.startsWith('**/'))],
    project: [...on.filter((d) => d.project).map((d) => d.pattern), ...extra.filter((p) => p.startsWith('**/'))]
  }
}

/** Files under `root` whose name matches `pattern`, as ./relative paths, skipping dependency and build folders. */
function filesNamed(root: string, pattern: string): string[] {
  const out: string[] = []
  let seen = 0
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (++seen > MAX_FILES) return
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(dir, e.name))
      } else if (nameMatches(pattern, e.name)) out.push(relative(root, join(dir, e.name)).replace(/\\/g, '/'))
    }
  }
  walk(root)
  return out
}

/**
 * The deny rules for an agent working on `project` (in `cwd`, its worktree when it has one). `roots` are
 * other folders the project patterns also cover by absolute path: the assistant runs in Corvid's data
 * folder but reads the user's projects, so it gets every project folder.
 */
export function denyRules(project?: string, cwd = project, roots: string[] = [], platform: string = process.platform): string[] {
  const c = getConfig()
  const { home, project: inProject } = denyPatterns(c, platform)
  const allowed = project ? (c.agentDenyAllow ?? []).filter((a) => normKey(a.project) === normKey(project)).map((a) => a.file) : []
  const paths: string[] = [...home]
  for (const pattern of inProject) {
    const excepted = allowed.filter((f) => nameMatches(pattern, f.split('/').pop() ?? ''))
    for (const r of roots) paths.push(`${absRule(r, platform)}/${pattern}`)
    if (!excepted.length || !cwd) {
      paths.push(pattern)
      continue
    }
    // the exception: every other matching file in the project, by its exact path
    for (const f of filesNamed(cwd, pattern)) if (!excepted.includes(f)) paths.push(`./${f}`)
  }
  return paths.flatMap((p) => [`Read(${p})`, `Edit(${p})`])
}

/**
 * Write the settings file for one agent and return the --settings arguments. Files are named by their
 * contents, so agents with the same rules share one, and an agent that's running keeps the file it
 * started with even after the rules change in Settings.
 */
export function agentSettingsArgs(project?: string, cwd?: string, roots?: string[], extra: string[] = []): string[] {
  try {
    // `extra`: whole rules on top, such as an extension build's protected paths (#98)
    const json = JSON.stringify({ permissions: { deny: [...denyRules(project, cwd, roots), ...extra] } }, null, 1)
    const dir = join(app.getPath('userData'), 'agent-settings')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, `deny-${createHash('sha256').update(json).digest('hex').slice(0, 16)}.json`)
    writeFileSync(file, json)
    return ['--settings', file]
  } catch (e) {
    // never stop an agent from starting over this; say so in the log
    console.error('[agentDeny] could not write the agent settings file', e)
    return []
  }
}
