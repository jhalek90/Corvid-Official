import { readFileSync, realpathSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { denyDefaultsFor, nameMatches, SECRET_RULES } from '@shared/secretRules'
import { pathKey, within } from '@shared/pathKeys'
import { absRule } from '../platform/paths'

// The ssh connector's upload operation (#168): one local file to one path on the server, over SFTP. The bytes go from
// disk to the server and never through the agent. What may be sent matters more than the transfer, so a file must be
// inside the calling worker's own worktree or session scratchpad (after symlinks and junctions are resolved), must
// not be something the deny rules (agentDeny.ts, #91/#150) keep agents from reading, must be a plain file under the
// size cap, and must not look like a key or hold a secret. The file is read once here: what was checked and hashed
// is exactly what is sent.

/** The cap when a manifest doesn't set limits.maxUploadBytes. */
export const DEFAULT_MAX_UPLOAD = 50 * 1024 * 1024

/** Folders an agent may upload from: its worktree (or project folder) and its session scratchpad. */
export type UploadRoots = () => string[]

export interface UploadPlan {
  /** the real path that was checked and read */
  local: string
  remote: string
  size: number
  sha256: string
  overwrite: boolean
  mode?: number
  data: Buffer
}

/** Claude Code's scratchpad for a session: <temp>/claude/<cwd with every non-alphanumeric as ->/<session>/scratchpad. */
export function scratchpadDir(cwd: string, sessionId: string, tmp: string = tmpdir()): string | undefined {
  if (!/^[\w-]+$/.test(sessionId)) return undefined
  return join(tmp, 'claude', cwd.replace(/[^a-zA-Z0-9]/g, '-'), sessionId, 'scratchpad')
}

// ---------- deny rules ----------

/** A Claude Code permission glob as a regular expression over a /-separated absolute path. \x is a literal x (absRule escapes). */
function globRe(glob: string, fold: boolean): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]
    if (ch === '\\' && i + 1 < glob.length) re += glob[++i].replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
    else if (glob.startsWith('**/', i)) (re += '(?:.*/)?'), (i += 2)
    else if (glob.startsWith('/**', i) && i + 3 === glob.length) (re += '(?:/.*)?'), (i += 2)
    else if (glob.startsWith('**', i)) (re += '.*'), (i += 1)
    else if (ch === '*') re += '[^/]*'
    else if (ch === '?') re += '[^/]'
    else re += ch.replace(/[.+^${}()|[\]\\/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`, fold ? 'i' : '')
}

const slashes = (p: string): string => p.replace(/\\/g, '/')

/**
 * Whether one deny rule's path (the x of Read(x)) covers `file`: //abs is from the filesystem root (//c/... is C:\ on
 * Windows), ~/ is the home folder, ./ and plain relative paths are under `cwd`, and **\/ matches in any folder.
 */
export function ruleCovers(pattern: string, file: string, ctx: { home: string; cwd: string; platform?: string }): boolean {
  const platform = ctx.platform ?? process.platform
  const win = platform === 'win32'
  const fold = win || platform === 'darwin'
  let glob: string
  if (pattern.startsWith('//')) glob = win ? pattern.slice(2).replace(/^([A-Za-z])\//, '$1:/') : pattern.slice(1)
  else if (pattern.startsWith('~/')) glob = `${slashes(ctx.home).replace(/\/$/, '')}/${pattern.slice(2)}`
  else if (pattern.startsWith('**/')) glob = pattern
  else glob = `${slashes(ctx.cwd).replace(/\/$/, '')}/${pattern.replace(/^\.\//, '')}`
  return globRe(glob, fold).test(slashes(file))
}

/** A path with 8.3 short names, junctions and symlinks resolved, through its nearest existing folder. */
function realPath(p: string): string {
  let full = resolve(p)
  let rest = ''
  for (;;) {
    try {
      return join(realpathSync.native(full), rest)
    } catch {
      const parent = resolve(full, '..')
      if (parent === full) return join(full, rest)
      rest = join(full.slice(parent.length).replace(/^[\\/]+/, ''), rest)
      full = parent
    }
  }
}

/**
 * An absolute rule with its fixed folders spelled as the real path (absRule's form), or null when it is already
 * spelled that way. The rules keep the spelling they were made with (C:\Users\RUNNER~1\..., macOS's /var), while
 * planUpload checks a file's real path, so it checks both spellings: that can only refuse more.
 */
function realRule(pattern: string, platform: string): string | null {
  if (!pattern.startsWith('//') || platform !== process.platform) return null
  const parts = (platform === 'win32' ? pattern.slice(2).replace(/^([A-Za-z])\//, '$1:/') : pattern.slice(1)).split('/')
  const glob = parts.findIndex((s) => /[*?\\]/.test(s))
  const fixed = parts.slice(0, glob < 0 ? parts.length : glob).join('/')
  if (!/[\\/][^\\/]/.test(fixed)) return null
  const rest = glob < 0 ? [] : parts.slice(glob)
  const real = [absRule(realPath(fixed), platform), ...rest].join('/')
  return real === pattern ? null : real
}

/** The first Read(...) rule in `rules` (agentDeny's denyRules output) that covers `file`, or null. */
export function deniedBy(rules: string[], file: string, ctx: { home: string; cwd: string; platform?: string }): string | null {
  for (const r of rules) {
    const m = /^Read\((.*)\)$/.exec(r)
    if (m && ruleCovers(m[1], file, ctx)) return m[1]
  }
  return null
}

// ---------- secrets ----------

/** The names the deny defaults treat as key or credential files (.env, *.pem, id_rsa, credentials.json, …). */
const keyFileKind = (name: string, platform: string): string | null =>
  denyDefaultsFor(platform).find((d) => d.project && nameMatches(d.pattern, name))?.label ?? null

/** File names inside a tar (plain or gzipped), from the 512-byte headers; best effort, stops at anything odd. */
function tarNames(tar: Buffer): string[] {
  const names: string[] = []
  for (let at = 0; at + 512 <= tar.length && names.length < 100_000; ) {
    const h = tar.subarray(at, at + 512)
    if (h.every((b) => b === 0)) break
    if (h.subarray(257, 262).toString('latin1') !== 'ustar' && !/^[0-7 \0]+$/.test(h.subarray(124, 136).toString('latin1'))) break
    const str = (a: number, b: number): string => h.subarray(a, b).toString('utf8').replace(/\0.*$/s, '')
    const prefix = str(345, 500)
    names.push(prefix ? `${prefix}/${str(0, 100)}` : str(0, 100))
    const size = parseInt(str(124, 136).trim() || '0', 8)
    if (!Number.isFinite(size) || size < 0) break
    at += 512 + Math.ceil(size / 512) * 512
  }
  return names
}

/**
 * Why this content must not leave the machine, or null: a secret the commit scan would catch (lines marked
 * "secret-scan: allow" are skipped, as there), a stored server or connection secret, or, in a tar or tar.gz, a member
 * named like a key or credentials file.
 */
export function secretReason(data: Buffer, hasKnownSecret: (text: string) => boolean, platform: string = process.platform): string | null {
  let body = data
  if (data[0] === 0x1f && data[1] === 0x8b) {
    try {
      body = gunzipSync(data, { maxOutputLength: 256 * 1024 * 1024 })
    } catch {
      return 'it is gzip-compressed and Corvid could not unpack it to check for secrets'
    }
  }
  for (const n of tarNames(body)) {
    const kind = keyFileKind(n.split('/').pop() ?? '', platform)
    if (kind) return `the archive holds ${n}, which is one of the ${kind}`
  }
  const text = body.toString('latin1')
  if (hasKnownSecret(text)) return 'it holds a password or key saved in Corvid'
  for (const line of text.split(/\r?\n/)) {
    if (line.includes('secret-scan: allow')) continue
    const kind = FILE_RULES.find(([, re]) => re.test(line))?.[0]
    if (kind) return `it looks like it holds ${kind}`
  }
  return null
}

// The shared rules, but for passwords the commit scan's own rule (scripts/secret-scan.mjs), which wants a quoted
// value: the plain "password: x" rule is meant for notes and trips on ordinary source and docs ("token: ...").
const FILE_RULES: [string, RegExp][] = [
  ...SECRET_RULES.filter(([kind]) => kind !== 'a password'),
  ['a hard-coded password', /\b(pass(word|wd|phrase)?|secret|api[_-]?key|token)\b["']?\s*[:=]\s*["'][^"'\s]{6,}["']/i]
]

// ---------- planning ----------

export const fmtSize = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} bytes`

/** The line the user sees in the Approve-writes and Strict dialogs. */
export const shownUpload = (p: Pick<UploadPlan, 'local' | 'remote' | 'size' | 'sha256' | 'overwrite' | 'mode'>): string =>
  `upload ${p.local} (${fmtSize(p.size)}, sha256 ${p.sha256.slice(0, 12)}) to ${p.remote}` +
  (p.mode !== undefined ? `, mode ${p.mode.toString(8).padStart(4, '0')}` : '') +
  (p.overwrite ? ', replacing it if it exists' : '')

/** The audit line: path, size and the whole hash, never the content. */
export const auditUpload = (p: UploadPlan): string => `upload ${p.local} (${p.size} bytes, sha256 ${p.sha256}) to ${p.remote}${p.overwrite ? ' (overwrite)' : ''}`

/** On top of the deny rules: Claude Code's own folder and the key stores. */
const ALWAYS_REFUSED = ['~/.claude/**', '~/.ssh/**', '~/.gnupg/**', '~/.local/share/keyrings/**', '~/Library/Keychains/**']

export interface UploadContext {
  roots: string[]
  /** agentDeny's rules for this agent, Read(...) and Edit(...) */
  rules: string[]
  /** the folder project-relative rules are relative to (the worktree) */
  cwd: string
  maxBytes: number
  hasKnownSecret: (text: string) => boolean
  home?: string
  platform?: string
}

/** Checks one upload and reads the file. Throws, saying why, for anything that must not be sent. */
export function planUpload(args: Record<string, unknown>, ctx: UploadContext): UploadPlan {
  const platform = ctx.platform ?? process.platform
  const home = ctx.home ?? homedir()
  const nothing = 'Nothing was sent.'
  const localArg = typeof args.local_path === 'string' ? args.local_path.trim() : ''
  const remote = typeof args.remote_path === 'string' ? args.remote_path.trim() : ''
  if (!localArg) throw new Error('local_path is required: the file to send, inside your worktree or scratchpad.')
  if (!remote) throw new Error('remote_path is required: the absolute path on the server, including the file name.')
  if (!remote.startsWith('/') || remote.endsWith('/') || remote.length > 4096 || /[\0\r\n]/.test(remote) || remote.split('/').includes('..'))
    throw new Error(`remote_path must be an absolute path on the server that names a file, like /tmp/upload/app.tar.gz, without "..". ${nothing}`)
  if (args.overwrite !== undefined && typeof args.overwrite !== 'boolean') throw new Error('overwrite must be true or false.')
  let mode: number | undefined
  if (args.mode !== undefined && args.mode !== null && args.mode !== '') {
    const s = String(args.mode)
    if (!/^0?[0-7]{3}$/.test(s)) throw new Error(`mode must be three octal digits like "0644" (no setuid, setgid or sticky bits). ${nothing}`)
    mode = parseInt(s, 8)
  }
  const roots = ctx.roots
    .map((r) => {
      try {
        return realpathSync.native(r)
      } catch {
        return ''
      }
    })
    .filter(Boolean)
  if (!roots.length) throw new Error(`Upload sends files from your own worktree or session scratchpad, and Corvid knows neither for this agent. ${nothing}`)
  let local: string
  try {
    local = realpathSync.native(isAbsolute(localArg) ? localArg : resolve(ctx.roots[0], localArg))
  } catch {
    throw new Error(`${localArg} does not exist or can't be read. ${nothing}`)
  }
  const key = pathKey(local, platform)
  if (!roots.some((r) => within(key, pathKey(r, platform), platform)))
    throw new Error(`${local} is outside your worktree and scratchpad (after following links), so it can't be uploaded. Copy it into your scratchpad first if it is yours to send. ${nothing}`)
  // `local` is a real path; the rules, home and cwd are checked as given and as real paths too
  const here = platform === process.platform
  const places = [{ home, cwd: ctx.cwd, platform }, ...(here ? [{ home: realPath(home), cwd: realPath(ctx.cwd), platform }] : [])]
  const rules = ctx.rules.flatMap((r) => {
    const m = /^Read\((.*)\)$/.exec(r)
    const real = m && realRule(m[1], platform)
    return real ? [r, `Read(${real})`] : [r]
  })
  // the deny defaults can be switched off in Settings; these never leave the machine through an upload
  const always = ALWAYS_REFUSED.find((p) => places.some((c) => ruleCovers(p, local, c)))
  if (always) throw new Error(`${local} is under ${always.replace(/\/\*\*$/, '')}, which is never uploaded. ${nothing}`)
  const denied = places.reduce<string | null>((d, c) => d ?? deniedBy(rules, local, c), null)
  if (denied) throw new Error(`${local} is covered by the deny rule ${denied}, which keeps agents away from it, so it can't be uploaded either. ${nothing}`)
  const kind = keyFileKind(local.split(/[\\/]/).pop() ?? '', platform)
  if (kind) throw new Error(`${local} is named like one of the ${kind}, so it can't be uploaded. ${nothing}`)
  const st = statSync(local)
  if (!st.isFile()) throw new Error(`${local} is not a plain file. Upload sends one file; pack a folder with tar first. ${nothing}`)
  if (st.size > ctx.maxBytes) throw new Error(`${local} is ${fmtSize(st.size)}, over the ${fmtSize(ctx.maxBytes)} upload limit. ${nothing}`)
  const data = readFileSync(local)
  if (data.length > ctx.maxBytes) throw new Error(`${local} grew past the ${fmtSize(ctx.maxBytes)} upload limit. ${nothing}`)
  const why = secretReason(data, ctx.hasKnownSecret, platform)
  if (why) throw new Error(`${local} was not uploaded: ${why}. Agents must not send secrets anywhere. ${nothing}`)
  return { local, remote, size: data.length, sha256: createHash('sha256').update(data).digest('hex'), overwrite: args.overwrite === true, mode, data }
}
