import { app } from 'electron'
import { createHash, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, win32 } from 'node:path'
import {
  compareVersions,
  MAX_BYTES,
  validateCorvid,
  type ExtensionCost,
  type ExtensionDetail,
  type ExtensionRecord,
  type ExtensionsFile,
  type ImportOutcome,
  type ParsedExtension
} from '@shared/extensions'

// The extensions ledger (#95): extensions.json in the data folder, one record per extension, and the canonical
// text of each in extensions/<key>.corvid. Both are in the backups (#85) and hold no secrets. Importing only
// validates and stores text: nothing here runs, evaluates or builds anything, and no agent tool reaches it.

const dataDir = (): string => app.getPath('userData')
const file = (): string => join(dataDir(), 'extensions.json')
export const extensionsDir = (): string => join(dataDir(), 'extensions')
const textFile = (key: string): string => join(extensionsDir(), `${key}.corvid`)

let data: ExtensionsFile = { version: 1, extensions: [] }
let emit: (list: ExtensionRecord[]) => void = () => {}

export const hashOf = (canonical: string): string => createHash('sha256').update(canonical, 'utf8').digest('hex')

function load(): void {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as ExtensionsFile
    data = { version: 1, extensions: Array.isArray(raw.extensions) ? raw.extensions.filter((r) => r && typeof r.key === 'string') : [] }
  } catch {
    /* first run, or no extensions yet */
  }
}

function save(): void {
  const tmp = file() + '.tmp'
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, file())
  emit(list())
}

export function initExtensions(onChange: (list: ExtensionRecord[]) => void): void {
  emit = onChange
  load()
}

export const list = (): ExtensionRecord[] => [...data.extensions].sort((a, b) => b.updatedAt - a.updatedAt)

export function detail(key: string): ExtensionDetail | null {
  const record = data.extensions.find((r) => r.key === key)
  if (!record) return null
  let text: string | null = null
  try {
    text = readFileSync(textFile(key), 'utf8')
  } catch {
    /* the text went missing: the page still shows the header */
  }
  const v = text === null ? null : validateCorvid(text)
  return { record, text, sections: v?.ok ? v.ext.sections : null }
}

/** Removes a record and its text. Only an extension that isn't installed can be deleted here (#99 adds Remove). */
export function remove(key: string): { ok: true } | { error: string } {
  const r = data.extensions.find((x) => x.key === key)
  if (!r) return { error: 'That extension is no longer in the list.' }
  if (r.status !== 'not-installed' && r.status !== 'failed' && r.status !== 'removed')
    return { error: `"${r.name}" is ${r.status}; only an extension that isn't installed can be deleted.` }
  data.extensions = data.extensions.filter((x) => x.key !== key)
  rmSync(textFile(key), { force: true })
  save()
  return { ok: true }
}

/** The cost part of a record (#97), changed by extensionBudget.ts only. */
export function setCost(key: string, change: (c: ExtensionCost) => ExtensionCost): void {
  const r = data.extensions.find((x) => x.key === key)
  if (!r) return
  r.cost = change(r.cost ?? {})
  save()
}

// ---------- import ----------

type Via = 'drop' | 'picker' | 'paste'
/** Imports waiting on the user's choice (replace or keep both), by token. Kept in memory only. */
const pending = new Map<string, { ext: ParsedExtension; hash: string; name: string; via: Via; replaceKey: string; canReplace: boolean }>()

function add(ext: ParsedExtension, hash: string, name: string, via: Via, replace?: string, source: ExtensionRecord['source'] = { kind: 'imported', fileName: name, via }): string {
  const h = ext.header
  let key = `${h.id}-${hash.slice(0, 12)}`
  while (data.extensions.some((r) => r.key === key && r.key !== replace)) key += 'x'
  const now = Date.now()
  const old = replace ? data.extensions.find((r) => r.key === replace) : undefined
  const record: ExtensionRecord = {
    key,
    id: h.id,
    name: h.name,
    version: h.version,
    hash,
    source,
    status: 'not-installed',
    createdAt: old?.createdAt ?? now,
    updatedAt: now,
    header: h,
    // a new version is unverified (#101), but the hashes of files shared from the old one stay in the history
    ...(old?.shares?.length && { shares: old.shares })
  }
  mkdirSync(extensionsDir(), { recursive: true })
  const tmp = textFile(key) + '.tmp'
  writeFileSync(tmp, ext.canonical)
  renameSync(tmp, textFile(key))
  if (old) {
    data.extensions = data.extensions.filter((r) => r.key !== old.key)
    if (old.key !== key) rmSync(textFile(old.key), { force: true })
  }
  data.extensions.push(record)
  save()
  return key
}

/** One file's text (already read, at most MAX_BYTES). */
function importOne(bytes: Uint8Array | string, name: string, via: Via): ImportOutcome {
  const v = validateCorvid(bytes)
  if (!v.ok) return { name, ok: false, errors: v.errors }
  const hash = hashOf(v.ext.canonical)
  const same = data.extensions.find((r) => r.hash === hash)
  if (same) return { name, ok: false, errors: [`This is the same extension as "${same.name}" ${same.version}, which is already in the list.`] }
  const sameId = data.extensions.filter((r) => r.id === v.ext.header.id).sort((a, b) => compareVersions(b.version, a.version))[0]
  if (sameId) {
    const token = randomUUID()
    const canReplace = compareVersions(v.ext.header.version, sameId.version) > 0
    pending.set(token, { ext: v.ext, hash, name, via, replaceKey: sameId.key, canReplace })
    return { name, ok: false, conflict: { token, existing: { key: sameId.key, version: sameId.version }, incoming: { version: v.ext.header.version, hash }, canReplace } }
  }
  return { name, ok: true, key: add(v.ext, hash, name, via) }
}

/** Files dropped on the window or picked: each is checked for its name and size before it is read. */
export function importFiles(paths: string[], via: 'drop' | 'picker'): ImportOutcome[] {
  return paths.map((p): ImportOutcome => {
    const name = basename(p)
    if (!/\.corvid$/i.test(name)) return { name, ok: false, errors: ["This isn't a .corvid file, so it was left alone. Only .corvid extension files can be imported."] }
    try {
      const st = statSync(p)
      if (!st.isFile()) return { name, ok: false, errors: ['This is a folder, not a .corvid file.'] }
      if (st.size > MAX_BYTES) return { name, ok: false, errors: [`The file is ${Math.ceil(st.size / 1024)} KB; a .corvid file can be at most ${MAX_BYTES / 1024} KB.`] }
      return importOne(readFileSync(p), name, via)
    } catch (e) {
      return { name, ok: false, errors: [`The file couldn't be read: ${(e as Error).message}`] }
    }
  })
}

/** Files dropped on the window, read there: a name and the bytes (none when the window found it isn't a .corvid
 *  file or is too big, so it never read it). */
export function importDropped(items: unknown): ImportOutcome[] {
  if (!Array.isArray(items)) return []
  return items.slice(0, 50).map((it): ImportOutcome => {
    // the window's name is only shown, never used as a path: drop any folder part, \ or /, on every platform
    const name = typeof it?.name === 'string' ? win32.basename(it.name) : 'A dropped file'
    const size = typeof it?.size === 'number' ? it.size : 0
    if (!/\.corvid$/i.test(name)) return { name, ok: false, errors: ["This isn't a .corvid file, so it was left alone. Only .corvid extension files can be imported."] }
    if (size > MAX_BYTES) return { name, ok: false, errors: [`The file is ${Math.ceil(size / 1024)} KB; a .corvid file can be at most ${MAX_BYTES / 1024} KB.`] }
    if (!(it?.bytes instanceof Uint8Array)) return { name, ok: false, errors: ["The file couldn't be read."] }
    return importOne(it.bytes, name, 'drop')
  })
}

/** Text pasted in the Extensions tab. */
export function importText(text: unknown): ImportOutcome {
  if (typeof text !== 'string') return { name: 'Pasted text', ok: false, errors: ['There was no text on the clipboard.'] }
  if (text.length > MAX_BYTES * 4) return { name: 'Pasted text', ok: false, errors: [`The pasted text is over ${MAX_BYTES / 1024} KB.`] }
  return importOne(text, 'Pasted text', 'paste')
}

/** The user's answer to a same-id import: replace the older one (only when the new version is newer), keep both
 *  (the hashes differ by construction), or skip it. */
export function resolveImport(token: unknown, choice: unknown): ImportOutcome {
  const p = typeof token === 'string' ? pending.get(token) : undefined
  if (!p) return { name: 'Import', ok: false, errors: ['That import is no longer waiting. Import the file again.'] }
  pending.delete(token as string)
  if (choice === 'skip') return { name: p.name, ok: false, errors: ['Skipped: nothing was added.'] }
  if (data.extensions.some((r) => r.hash === p.hash)) return { name: p.name, ok: false, errors: ['This exact extension is already in the list.'] }
  if (choice === 'replace') {
    const old = data.extensions.find((r) => r.key === p.replaceKey)
    if (!p.canReplace || !old) return { name: p.name, ok: false, errors: ['Only a newer version can replace the one in the list.'] }
    if (old.status !== 'not-installed' && old.status !== 'failed' && old.status !== 'removed')
      return { name: p.name, ok: false, errors: [`"${old.name}" is ${old.status}; updating an installed extension comes with #99.`] }
    return { name: p.name, ok: true, key: add(p.ext, p.hash, p.name, p.via, old.key), replaced: true }
  }
  if (choice === 'keep') return { name: p.name, ok: true, key: add(p.ext, p.hash, p.name, p.via) }
  return { name: p.name, ok: false, errors: ['Unknown choice.'] }
}

/** A draft the packaging wizard wrote (#100), saved as a created extension, "Not installed yet". It goes through the
 *  same validator as any import. `replaceKey` is the version it revises: replaced while that one isn't installed,
 *  otherwise both are kept. */
export function saveCreated(text: string, replaceKey?: string, features?: string[]): { ok: true; key: string } | { error: string } {
  const v = validateCorvid(text)
  if (!v.ok) return { error: v.errors.join(' ') }
  const hash = hashOf(v.ext.canonical)
  const same = data.extensions.find((r) => r.hash === hash)
  if (same) return { error: `This text is the same as "${same.name}" ${same.version}, which is already in the list.` }
  const old = replaceKey ? data.extensions.find((r) => r.key === replaceKey) : undefined
  const replace = old && (old.status === 'not-installed' || old.status === 'failed' || old.status === 'removed') ? old.key : undefined
  // the feature it was packaged from (#100), kept across revisions, so Verify (#101) can leave it out of the clean copy
  const from = features?.length ? features : old?.source.features
  return { ok: true, key: add(v.ext, hash, `${v.ext.header.id}.corvid`, 'paste', replace, { kind: 'created', ...(from?.length && { features: from }) }) }
}

// ---------- scanning (#96) ----------

/** A record's hash, stored text and scan, for the scan in extensionScan.ts. */
export function forScan(key: string): { hash: string; text: string | null; scan?: ExtensionRecord['scan'] } | null {
  const r = data.extensions.find((x) => x.key === key)
  if (!r) return null
  let text: string | null = null
  try {
    text = readFileSync(textFile(key), 'utf8')
  } catch {
    /* missing */
  }
  return { hash: r.hash, text, scan: r.scan }
}

/** Stores a scan's state on its record. The status stays as it is: a scan never installs or builds anything. */
export function setScan(key: string, scan: ExtensionRecord['scan']): void {
  const r = data.extensions.find((x) => x.key === key)
  if (!r) return
  r.scan = scan
  save()
}

// ---------- the install pipeline (#98) ----------

/** Changes a record's build, status or tier-3 confirmation. Only extensionInstall.ts calls this. */
export function updateInstall(key: string, change: (r: ExtensionRecord) => Partial<Pick<ExtensionRecord, 'status' | 'build' | 'tier3'>>): ExtensionRecord | undefined {
  const r = data.extensions.find((x) => x.key === key)
  if (!r) return undefined
  Object.assign(r, change(r), { updatedAt: Date.now() })
  save()
  return r
}

// ---------- verify and share (#101) ----------

/** Changes a record's verification, verify run or shares. Only extensionVerify.ts calls this. */
export function updateVerify(key: string, change: (r: ExtensionRecord) => Partial<Pick<ExtensionRecord, 'verification' | 'verify' | 'shares'>>): ExtensionRecord | undefined {
  const r = data.extensions.find((x) => x.key === key)
  if (!r) return undefined
  Object.assign(r, change(r), { updatedAt: Date.now() })
  save()
  return r
}

/** The stored canonical text of a record, or null when it went missing. */
export function textOf(key: string): string | null {
  try {
    return readFileSync(textFile(key), 'utf8')
  } catch {
    return null
  }
}

// ---------- the lifecycle (#99) ----------

/** Changes a record's status, build or lifecycle, appending to its history. Only extensionLifecycle.ts calls this. */
export function updateLifecycle(
  key: string,
  change: (r: ExtensionRecord) => Partial<Pick<ExtensionRecord, 'status' | 'build' | 'lifecycle'>>,
  event?: NonNullable<NonNullable<ExtensionRecord['lifecycle']>['history']>[number]
): ExtensionRecord | undefined {
  const r = data.extensions.find((x) => x.key === key)
  if (!r) return undefined
  Object.assign(r, change(r), { updatedAt: Date.now() })
  if (event) r.lifecycle = { ...r.lifecycle, history: [...(r.lifecycle?.history ?? []), event].slice(-200) }
  save()
  return r
}

/** Deletes only the stored text of a record ("Remove and delete the extension"); the record stays as history. */
export function deleteText(key: string): void {
  rmSync(textFile(key), { force: true })
}
