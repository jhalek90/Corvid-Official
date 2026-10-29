// The Claude Code permission mode new workers start in (#306). Corvid's own session never gets one.

/**
 * The modes a worker can be given: 'default' passes nothing, so the project's own .claude/settings.json and Claude
 * Code decide; 'acceptEdits' lets file edits through without asking, while commands still ask. Bypassing every check
 * is never offered, and never accepted from a hand-edited config.json.
 */
export const WORKER_PERMISSION_MODES = ['default', 'acceptEdits'] as const
export type WorkerPermissionMode = (typeof WORKER_PERMISSION_MODES)[number]

export const isWorkerPermissionMode = (m: unknown): m is WorkerPermissionMode =>
  typeof m === 'string' && (WORKER_PERMISSION_MODES as readonly string[]).includes(m)

/** What goes on the claude command line: '--permission-mode acceptEdits' for accept edits, nothing for anything else. */
export const permissionArgs = (m: unknown): string[] => (m === 'acceptEdits' ? ['--permission-mode', 'acceptEdits'] : [])

const LABEL: Record<WorkerPermissionMode, string> = { default: 'Claude Code default', acceptEdits: 'Accept edits' }
/** "Claude Code default" or "Accept edits": the name the selector and the notice show. */
export const permissionModeLabel = (m: WorkerPermissionMode): string => LABEL[m]
