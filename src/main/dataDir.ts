import { existsSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathsOf } from './platform/shared.mjs'

// The one place Corvid's data folder is decided (#85). Everything else asks app.getPath('userData'), which
// index.ts sets from resolveDataDir() before anything reads it.
//
// A test copy is any run with DASH_DATA_DIR or DASH_TEST_INSTANCE set. It must never run on the real data
// folder, however the path is spelled, and it stays away from everything outside its own folder (see testCopy.ts).

/** Set for agents' test copies of Corvid (scripts/test-instance.mjs sets both). */
export const isTestCopy = (env: NodeJS.ProcessEnv = process.env): boolean => !!(env.DASH_DATA_DIR || env.DASH_TEST_INSTANCE)

/** The real app's data folders: the one in use and the other name it has had, joined the way `platform` joins paths
 *  (on the machine's own platform that is node:path; the tests pass another platform's paths). */
export const realDataDirs = (appData: string, platform: string = process.platform): string[] => {
  const at = pathsOf(platform).join
  return [at(appData, 'Claude Dashboard'), at(appData, 'Corvid')]
}

/** A path as Windows sees it: junctions, symlinks and 8.3 short names resolved where it exists, then case and
 *  trailing separators ignored. A folder that doesn't exist yet is compared through its nearest existing parent.
 *  Case is folded on every platform, Linux too (#151): two folders that differ only by case then count as the
 *  same, which only ever over-matches, the safe direction for refusing the real data folder. */
export function canonicalPath(p: string): string {
  let full = resolve(p)
  let rest = ''
  for (;;) {
    try {
      full = realpathSync.native(full)
      break
    } catch {
      const parent = resolve(full, '..')
      if (parent === full) break
      rest = join(full.slice(parent.length).replace(/^[\\/]+/, ''), rest)
      full = parent
    }
  }
  return join(full, rest).replace(/[\\/]+$/, '').toLowerCase()
}

/** Whether `dir` is one of `realDirs`, whatever way it's spelled. */
export const isRealDataDir = (dir: string, realDirs: string[]): boolean => {
  const c = canonicalPath(dir)
  return realDirs.some((r) => canonicalPath(r) === c)
}

/** Electron's default userData folder (<appData>/<app name>), without creating it. Electron makes that folder the
 *  first time anything asks for app.getPath('userData'), even right before setPath moves it, which is how a test copy
 *  left an empty ~/.config/Corvid behind on Linux (#178). So a test copy works the path out from the app's name and
 *  never asks; the real app asks electron as before. */
export const defaultDataDir = (appData: string, appName: string, userData: () => string, env: NodeJS.ProcessEnv = process.env): string =>
  isTestCopy(env) ? join(appData, appName) : userData()

export type DataDirChoice = { dir: string; test: boolean } | { error: string }

/** Picks the data folder. The real app keeps the "Claude Dashboard" folder where one exists (the assistant's
 *  conversation is tied to that path); a test copy gets DASH_DATA_DIR and is refused one of the real folders. */
export function resolveDataDir(appData: string, defaultDir: string, env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): DataDirChoice {
  if (!isTestCopy(env)) {
    // the pre-rename folder only ever existed on Windows (#154); elsewhere it's electron's userData from the start
    if (platform !== 'win32') return { dir: defaultDir, test: false }
    const legacy = join(appData, 'Claude Dashboard')
    return { dir: existsSync(legacy) ? legacy : defaultDir, test: false }
  }
  const dir = env.DASH_DATA_DIR
  if (!dir) return { error: 'DASH_TEST_INSTANCE is set without DASH_DATA_DIR: a test copy needs its own data folder.' }
  if (isRealDataDir(dir, [...realDataDirs(appData, platform), defaultDir]))
    return { error: `Refusing to start a test copy on the real data folder (${dir} is ${canonicalPath(defaultDir)} or another of Corvid's own folders).` }
  return { dir: resolve(dir), test: true }
}
