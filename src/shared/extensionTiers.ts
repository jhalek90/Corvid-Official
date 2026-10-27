// Extension tiers and the protected core (#95). The one place they are defined: the .corvid validator checks a
// file's declared tier against its declared core areas, and the install pipeline (#98) will use the paths below
// to hold a build to what it declared. Keep docs/EXTENSIONS.md in step with this file.

export type ExtensionTier = 1 | 2 | 3

export const TIER_WORDS: Record<ExtensionTier, string> = {
  1: 'adds files',
  2: 'changes core',
  3: 'changes protected core'
}

export const TIER_DETAIL: Record<ExtensionTier, string> = {
  1: 'Adds new files and registers them (a view, a tool, a setting). Changes nothing that is already there beyond the registration lines.',
  2: 'Changes non-sensitive core: the interface, the board, tasks, notes, settings or projects.',
  3: 'Changes protected core: safety, secrets, connectors, limits, backups, deploys or the extension machinery itself.'
}

export interface CoreArea {
  id: string
  label: string
  /** a change here makes an extension tier 3 */
  protected: boolean
  /** repo-relative paths or globs (a trailing / is a whole folder) */
  paths: string[]
}

/** The areas of core an extension can declare it changes. Tier 2 areas first, then the protected ones. */
export const CORE_AREAS: CoreArea[] = [
  { id: 'ui', label: 'Interface (views, styles, layout)', protected: false, paths: ['src/renderer/'] },
  { id: 'board', label: 'Message board', protected: false, paths: ['src/main/board.ts', 'src/main/boardTools.ts', 'src/shared/board.ts', 'src/shared/boardVoice.ts'] },
  { id: 'tasks', label: 'Tasks', protected: false, paths: ['src/main/tasks.ts', 'src/shared/blockers.ts'] },
  { id: 'notes', label: 'Notes', protected: false, paths: ['src/main/notes.ts', 'src/main/noteTools.ts', 'src/shared/notes.ts'] },
  { id: 'settings', label: 'Settings', protected: false, paths: ['src/main/config.ts'] },
  { id: 'projects', label: 'Projects', protected: false, paths: ['src/main/projects.ts', 'src/main/projectStore.ts', 'src/main/projectScan.ts', 'src/main/projectMerge.ts', 'src/shared/projects.ts', 'src/shared/projectModel.ts'] },
  { id: 'agents', label: 'Agents and terminals (not their limits)', protected: false, paths: ['src/main/pty.ts', 'src/main/liveRegistry.ts', 'src/main/assistant.ts', 'src/main/assistantTools.ts'] },
  { id: 'connectors', label: 'Connectors and their approvals', protected: true, paths: ['src/main/connectors/', 'docs/CONNECTORS.md'] },
  { id: 'remote', label: 'Remote systems', protected: true, paths: ['src/main/remote/'] },
  { id: 'secrets', label: 'Secrets and encryption', protected: true, paths: ['src/main/remote/store.ts', 'src/main/connectors/store.ts', 'src/main/remote/scrub.ts'] },
  { id: 'deny-rules', label: 'Deny rules and secret scanning', protected: true, paths: ['src/main/agentDeny.ts', 'src/main/agentAccess.ts', 'src/shared/secretRules.ts', 'scripts/secret-scan.mjs', 'scripts/install-hooks.mjs', 'docs/SECURITY.md'] },
  { id: 'limits', label: 'Usage gates and worker limits', protected: true, paths: ['src/shared/workerLimits.ts', 'src/main/workers.ts', 'src/main/usage.ts', 'src/shared/workerClock.ts'] },
  { id: 'backups', label: 'Backups and the test-copy guards', protected: true, paths: ['src/main/backups.ts', 'src/main/dataDir.ts', 'src/main/testCopy.ts', 'scripts/test-instance.mjs', 'scripts/test-guards.mjs'] },
  { id: 'crash', label: 'Crash handling', protected: true, paths: ['src/main/crashLog.ts', 'src/renderer/src/components/ErrorBoundary.tsx'] },
  { id: 'deploy', label: 'The deploy script and rollback', protected: true, paths: ['scripts/deploy.mjs', 'scripts/ev.mjs', 'package.json', 'package-lock.json'] },
  { id: 'extensions', label: 'The extension machinery', protected: true, paths: ['src/shared/extensions.ts', 'src/shared/extensionTiers.ts', 'src/main/extensions.ts', 'docs/EXTENSIONS.md'] }
]

export const PROTECTED_PATHS: string[] = CORE_AREAS.filter((a) => a.protected).flatMap((a) => a.paths)

export const coreArea = (id: string): CoreArea | undefined => CORE_AREAS.find((a) => a.id === id)

/** The lowest tier a set of declared core areas allows. */
export const minimumTier = (areas: string[]): ExtensionTier =>
  areas.some((a) => coreArea(a)?.protected) ? 3 : areas.length ? 2 : 1

/** Whether a repo-relative path (forward slashes) falls under the protected core. */
export const isProtectedPath = (path: string): boolean => {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return PROTECTED_PATHS.some((q) => (q.endsWith('/') ? p.startsWith(q) : p === q))
}
