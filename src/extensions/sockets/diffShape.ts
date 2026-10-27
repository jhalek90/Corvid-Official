// The mechanical tier-1 check (#102): a build that only adds or edits files in its own folder, src/extensions/<id>/,
// plus its import and entry in the registration indexes (main, window and themes), is tier 1 ("adds files"), the lowest-risk shape. Anything
// else is listed as outside, for the install pipeline's diff scan (#98) to hold against what the extension declared.
// Text only: it reads paths and changed lines, never runs anything.

export const SOCKETS_DIR = 'src/extensions'
export const REGISTRATION_FILES = ['src/extensions/mainExtensions.ts', 'src/extensions/windowExtensions.ts', 'src/extensions/themeExtensions.ts']

export interface ChangedFile {
  path: string
  /** A added, M modified, D deleted, R renamed (path is the new name, from the old one) */
  status: 'A' | 'M' | 'D' | 'R'
  from?: string
  /** the added and removed lines, needed for the registration files */
  added?: string[]
  removed?: string[]
}

export interface DiffShape {
  tier1: boolean
  /** files outside the extension's folder and its registration lines */
  outside: string[]
  /** why each outside file is outside, in plain words */
  reasons: string[]
}

const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether one changed line in a registration index only registers extension `id`. */
export function isRegistrationLine(line: string, id: string): boolean {
  const l = line.trim()
  if (!l) return true
  if (new RegExp(`^import\\s+[A-Za-z_$][\\w$]*\\s+from\\s+'\\./${esc(id)}/[\\w./-]+'$`).test(l)) return true
  // the list itself: the line that names the array, holding identifiers only
  return /^export const (MAIN_EXTENSIONS: ExtensionModule<MainSockets>|WINDOW_EXTENSIONS: ExtensionModule<WindowSockets>|THEME_EXTENSIONS: ExtensionModule<ThemeSockets>)\[\] = \[[\w$, ]*\]$/.test(l)
}

export function diffShape(id: string, files: ChangedFile[]): DiffShape {
  const own = `${SOCKETS_DIR}/${id}/`
  const outside: string[] = []
  const reasons: string[] = []
  const out = (path: string, why: string): void => {
    outside.push(path)
    reasons.push(`${path}: ${why}`)
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id === 'sockets') return { tier1: false, outside: files.map((f) => norm(f.path)), reasons: [`"${id}" isn't an extension id.`] }
  for (const f of files) {
    const path = norm(f.path)
    if (path.includes('/../') || path.startsWith('../')) {
      out(path, 'the path leaves the repository folder.')
      continue
    }
    if (f.status === 'R' && f.from && !norm(f.from).startsWith(own)) {
      out(path, `renamed from ${norm(f.from)}, outside the extension's folder.`)
      continue
    }
    if (path.startsWith(own)) continue
    if (REGISTRATION_FILES.includes(path)) {
      if (f.status !== 'M') out(path, 'a registration index may only be edited, not added, removed or renamed.')
      else if (!f.added || !f.removed) out(path, "the changed lines weren't given, so the registration can't be checked.")
      else {
        const added = f.added
        const bad = [...added, ...f.removed].filter((l) => !isRegistrationLine(l, id))
        // the list may gain this extension's entry, never lose another's
        const names = (lines: string[]): string[] => lines.flatMap((l) => /= \[([\w$, ]*)\]$/.exec(l.trim())?.[1].split(',').map((s) => s.trim()).filter(Boolean) ?? [])
        const kept = names(f.removed).every((n) => names(added).includes(n))
        if (bad.length) out(path, `changes more than this extension's registration (${bad.length} other line${bad.length === 1 ? '' : 's'}).`)
        else if (!kept) out(path, "removes another extension's registration.")
      }
      continue
    }
    out(path, "outside the extension's folder.")
  }
  return { tier1: outside.length === 0 && files.length > 0, outside, reasons }
}
