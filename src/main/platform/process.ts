// Process control (#149, #153). Windows: taskkill /PID <pid> /T /F, by pid only, never by name. POSIX: signal the
// process tree from one ps snapshot and the groups it leads, SIGTERM then SIGKILL (shared.mjs, so the scripts use
// the same code).

export { killTree, killTreeCommand, listProcessesCommand, parseProcessList, psTreeCommand, parsePsTree, treeOf, posixKillPlan } from './shared.mjs'
export type { PsEntry, KillTreeDeps } from './shared.mjs'
