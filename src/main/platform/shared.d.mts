// Types for shared.mjs (the part of the platform layer the scripts import as plain JavaScript).

export type Platform = 'win32' | 'darwin' | 'linux'
type Env = Record<string, string | undefined>

export declare const PLATFORMS: Platform[]
export declare function notYet(what: string, platform: string): Error
export declare function platformOf(platform?: string): Platform
export declare function pathsOf(platform?: string): typeof import('node:path').win32

export declare function appDataDir(platform?: string, env?: Env, home?: string): string | undefined
export declare function dataDirCandidates(appData: string, platform?: string): string[]
export declare function realDataDir(appData: string, exists: (p: string) => boolean, platform?: string): string

export declare function killTreeCommand(pid: number, platform?: string, env?: Env): { file: string; args: string[] }
export interface PsEntry {
  pid: number
  ppid: number
  pgid: number
  zombie: boolean
}
export declare const psTreeCommand: { file: string; args: string[] }
export declare function parsePsTree(out: string): PsEntry[]
export declare function treeOf(pid: number, list: PsEntry[]): number[]
export declare function posixKillPlan(pid: number, list: PsEntry[], self?: number): { pids: number[]; groups: number[] }
export interface KillTreeDeps {
  ps: () => Promise<string | null>
  signal: (target: number, sig: NodeJS.Signals) => void
  alive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
  self: number
}
export declare function killTree(pid: number, opts?: { timeoutMs?: number; graceMs?: number; rootFirstMs?: number }, platform?: string, deps?: Partial<KillTreeDeps>): Promise<Error | null>
export declare function listProcessesCommand(platform?: string): string
export declare function parseProcessList(out: string, platform?: string): { pid: number; ppid: number; path: string }[]

export interface InstallProfile {
  builderArgs: string[]
  builtDir: string
  installDir: string
  previousDir: string
  exeName: string
  executable: (dir: string) => string
  resources: (dir: string) => string
  pathDelimiter: string
  legacyInstallDir: string | null
  legacyExeName: string | null
  desktopEntry: string | null
  shownPath: string
}
export declare function installProfile(root: string, platform?: string, env?: Env, home?: string): InstallProfile

export declare function toNative(p: string, platform?: string): string
export declare function insideDir(path: string, dir: string, platform?: string): boolean
export declare function desktopEntryText(executable: string, icon?: string, opts?: { autostart?: boolean }): string
export declare function autostartEntryPath(env?: Env, home?: string): string
export declare function installOf(exe: string, platform?: string, env?: Env, home?: string): { dir: string; previousDir: string }
export declare function nativeDeps(platform?: string, arch?: string): { pty: string; electron: string }
export declare const ELECTRON_INSTALLER: string
export declare function electronBinaryPresent(nodeModules: string, platform?: string, exists?: (path: string) => boolean): boolean
export declare function electronNeedsDownload(nodeModules: string, platform?: string, exists?: (path: string) => boolean): boolean
export declare function gitInstallHint(platform?: string): string
