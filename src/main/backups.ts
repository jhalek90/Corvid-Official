import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'

// Rolling backups of Corvid's important files (#85), in backups/ inside the data folder: one at start-up, then one
// when a file changes, at most every ten minutes per file. Each keeps its last ten, plus the newest of each day for
// a week. secrets.json, connections and the remote folder are never backed up, so secrets aren't multiplied.

export const BACKUP_ITEMS = ['config.json', 'tasks.json', 'projects.json', 'agents.json', 'notes', 'board', 'extensions.json', 'extensions'] as const
export type BackupItem = (typeof BACKUP_ITEMS)[number]
/** Items that are folders, copied whole and watched for changes inside. */
const FOLDERS: BackupItem[] = ['notes', 'board', 'extensions']
const EVERY_MS = 10 * 60_000
const KEEP = 10
const DAYS = 7

const dataDir = (): string => app.getPath('userData')
const backupRoot = (): string => join(dataDir(), 'backups')
const itemDir = (item: BackupItem): string => join(backupRoot(), item)
const isItem = (x: unknown): x is BackupItem => BACKUP_ITEMS.includes(x as BackupItem)

const stamp = (d = new Date()): string => {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
}
const dayOf = (s: string): string => s.slice(0, 8)

/** Newest first. */
export function listBackups(item: BackupItem): string[] {
  try {
    return readdirSync(itemDir(item)).filter((n) => /^\d{8}-\d{6}-\d{3}$/.test(n)).sort().reverse()
  } catch {
    return []
  }
}

/** Which backups to drop: past the last KEEP, all but the newest of each of the last DAYS days. */
export function toPrune(names: string[], now = new Date()): string[] {
  const newest = [...names].sort().reverse()
  const keep = new Set(newest.slice(0, KEEP))
  const cutoff = stamp(new Date(now.getTime() - DAYS * 86_400_000)).slice(0, 8)
  const seenDay = new Set<string>()
  for (const n of newest) {
    const day = dayOf(n)
    if (day < cutoff || seenDay.has(day)) continue
    seenDay.add(day)
    keep.add(n)
  }
  return newest.filter((n) => !keep.has(n))
}

const lastAt = new Map<BackupItem, number>()
const timers = new Map<BackupItem, NodeJS.Timeout>()

const sameAsNewest = (item: BackupItem, src: string): boolean => {
  if (FOLDERS.includes(item)) return false
  const [newest] = listBackups(item)
  try {
    return !!newest && readFileSync(join(itemDir(item), newest)).equals(readFileSync(src))
  } catch {
    return false
  }
}

/** Copies one item now (a folder whole). Skips a missing item or a file unchanged since its newest backup. */
export function backupNow(item: BackupItem, force = false): string | null {
  const src = join(dataDir(), item)
  if (!existsSync(src) || (!force && sameAsNewest(item, src))) return null
  lastAt.set(item, Date.now())
  try {
    mkdirSync(itemDir(item), { recursive: true })
    let name = stamp()
    // two in the same millisecond (a restore right after a backup): the next one
    while (existsSync(join(itemDir(item), name))) name = stamp()
    // copy beside it, then rename: a half-written backup never shows up in the list
    const tmp = join(itemDir(item), name + '.tmp')
    cpSync(src, tmp, { recursive: true })
    renameSync(tmp, join(itemDir(item), name))
    for (const old of toPrune(listBackups(item))) rmSync(join(itemDir(item), old), { recursive: true, force: true })
    return name
  } catch (e) {
    console.error(`[backup] ${item} failed`, e)
    return null
  }
}

/** A change to an item: back it up now, or once its ten minutes are up. */
function changed(item: BackupItem): void {
  if (timers.has(item)) return
  const wait = (lastAt.get(item) ?? 0) + EVERY_MS - Date.now()
  if (wait <= 0) return void backupNow(item)
  timers.set(
    item,
    setTimeout(() => {
      timers.delete(item)
      backupNow(item)
    }, wait)
  )
}

/** One backup of each item at start-up, then watch for changes. */
export function initBackups(): void {
  for (const item of BACKUP_ITEMS) backupNow(item)
  const watchDir = (dir: string, onName: (name: string | null) => void): void => {
    try {
      if (existsSync(dir)) watch(dir, (_e, name) => onName(name)).on('error', () => {})
    } catch (e) {
      console.warn('[backup] cannot watch', dir, e)
    }
  }
  watchDir(dataDir(), (name) => {
    // config.json.tmp → config.json: the rename at the end of an atomic write
    const base = name?.replace(/\.tmp$/, '')
    if (isItem(base) && !FOLDERS.includes(base)) changed(base)
    // the extensions folder may not exist yet at start-up; the ledger changes with it, so it follows the ledger
    if (base === 'extensions.json') changed('extensions')
  })
  for (const f of FOLDERS) watchDir(join(dataDir(), f), () => changed(f))
}

export const backupsSummary = (): { item: BackupItem; backups: { name: string; at: number; size: number }[] }[] =>
  BACKUP_ITEMS.map((item) => ({
    item,
    backups: listBackups(item).map((name) => {
      let size = 0
      try {
        size = statSync(join(itemDir(item), name)).size
      } catch {
        /* gone meanwhile */
      }
      const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(name)!
      return { name, at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(), size }
    })
  }))

const pendingFile = (): string => join(backupRoot(), 'restore-pending.json')

/** Asks for a restore at the next start, before anything is loaded: done now, a save on the way out (an agent's
 *  record as its terminal closes) could write the old state back over it. The caller restarts Corvid. */
export function scheduleRestore(item: unknown, name: unknown): { ok: true } | { error: string } {
  if (!isItem(item) || typeof name !== 'string' || !listBackups(item).includes(name)) return { error: 'That backup no longer exists.' }
  mkdirSync(backupRoot(), { recursive: true })
  writeFileSync(pendingFile(), JSON.stringify({ item, name }))
  return { ok: true }
}

/** A restore asked for before the restart: done first thing at start-up. Returns the notice to show. */
export function applyPendingRestore(): string | null {
  let pending: { item: unknown; name: unknown }
  try {
    pending = JSON.parse(readFileSync(pendingFile(), 'utf8'))
  } catch {
    return null
  }
  rmSync(pendingFile(), { force: true })
  const r = restoreBackup(pending.item, pending.name)
  return 'error' in r ? r.error : `Restored ${pending.item} from its backup. The version before is kept in its backups too.`
}

/** Puts one backup back, after backing up what's there now. */
export function restoreBackup(item: unknown, name: unknown): { ok: true; saved: string | null } | { error: string } {
  if (!isItem(item) || typeof name !== 'string' || !listBackups(item).includes(name)) return { error: 'That backup no longer exists.' }
  const dest = join(dataDir(), item)
  const tmp = dest + '.restore'
  let saved: string | null = null
  try {
    // copied out before the current version is backed up: that backup's rotation could drop the chosen one
    rmSync(tmp, { recursive: true, force: true })
    cpSync(join(itemDir(item), name), tmp, { recursive: true })
    saved = backupNow(item, true)
    if (statSync(tmp).isDirectory()) {
      // a folder can't be renamed over another: move the current one aside first
      const old = dest + '.old'
      rmSync(old, { recursive: true, force: true })
      if (existsSync(dest)) renameSync(dest, old)
      renameSync(tmp, dest)
      rmSync(old, { recursive: true, force: true })
    } else renameSync(tmp, dest)
    console.warn(`[backup] restored ${item} from ${name} (the version before is backup ${saved ?? 'none: it was missing'})`)
    return { ok: true, saved }
  } catch (e) {
    return { error: `Restoring ${item} failed: ${(e as Error).message}` }
  }
}
