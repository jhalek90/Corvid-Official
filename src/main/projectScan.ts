import { execFile } from 'node:child_process'
import { open, readdir, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { DENY_DEFAULTS, nameMatches, SECRET_RULES, type SecretFinding, type SecretScan } from '@shared/secretRules'
import { normKey } from '@shared/projectList'
import { projectKey } from '@shared/projects'
import { getConfig } from './config'
import { denyPatterns } from './agentDeny'

// "Scan for secrets" on a project (#91). Runs locally on the project's own folder only, reads files
// below a size limit, and returns file, line and kind: never a value, at most its first and last two
// characters. Git history isn't scanned (the repo's own pre-commit scan does that for Corvid); a file git
// tracks is flagged instead, since what's in it may already be in history.

const SKIP = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', '.nuxt', 'coverage', 'target', 'vendor', '.venv', 'venv', '__pycache__', '.cache', '.turbo', '.idea', '.vs'])
const MAX_FILES = 5000
const MAX_BYTES = 512 * 1024
const MAX_PER_FILE = 20

// files that hold secrets by their nature, whatever is in them
const SECRET_FILES = DENY_DEFAULTS.filter((d) => d.project && d.pattern !== '**/secrets.*').map((d) => d.pattern)
// a template that's meant to be committed
const TEMPLATE = /\.(example|sample|template|dist)$/i

function hintFor(match: string): string | undefined {
  // the value part of "password = value"; a key or URL as it is
  const v = (/[:=]\s*["']?([^"'\s]+)/.exec(match)?.[1] ?? match).trim()
  return v.length >= 12 ? `${v.slice(0, 2)}…${v.slice(-2)}` : undefined
}

function tracked(root: string): Promise<Set<string>> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 64 << 20, windowsHide: true, timeout: 15_000 }, (err, out) =>
      resolve(err ? new Set() : new Set(String(out).split('\0').filter(Boolean)))
    )
  })
}

async function readText(path: string): Promise<string | null> {
  const s = await stat(path)
  if (s.size > MAX_BYTES) return null
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(s.size)
    await fh.read(buf, 0, s.size, 0)
    // a NUL byte in the first part: a binary file
    if (buf.subarray(0, 8000).includes(0)) return null
    return buf.toString('utf8')
  } finally {
    await fh.close()
  }
}

export async function scanProject(root: string): Promise<SecretScan> {
  const c = getConfig()
  const { project: denied } = denyPatterns(c)
  const allowed = new Set((c.agentDenyAllow ?? []).filter((a) => normKey(a.project) === normKey(root)).map((a) => a.file))
  const ignored = new Set(c.secretIgnore?.[projectKey(root)] ?? [])
  // "Block for agents" adds a file by its exact ./path
  const blocked = new Set((c.agentDenyExtra ?? []).filter((p) => p.startsWith('./')).map((p) => p.slice(2)))
  const git = await tracked(root)
  const findings: SecretFinding[] = []
  let files = 0
  let partial = false

  const add = (file: string, line: number, kind: string, hint?: string): void => {
    if (ignored.has(`${file}|${kind}`)) return
    const name = file.split('/').pop() ?? ''
    const readable = !blocked.has(file) && (allowed.has(file) || !denied.some((p) => nameMatches(p, name)))
    findings.push({ file, line, kind, ...(hint && { hint }), readable, tracked: git.has(file) })
  }

  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (files >= MAX_FILES) {
        partial = true
        return
      }
      const path = join(dir, e.name)
      // symlinks are skipped, so the scan never leaves the project folder
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) await walk(path)
        continue
      }
      if (!e.isFile()) continue
      files++
      const rel = relative(root, path).replace(/\\/g, '/')
      if (!TEMPLATE.test(e.name) && SECRET_FILES.some((p) => nameMatches(p, e.name))) add(rel, 0, 'a secret file')
      let text: string | null = null
      try {
        text = await readText(path)
      } catch {
        /* unreadable: skip */
      }
      if (!text) continue
      let n = 0
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length && n < MAX_PER_FILE; i++) {
        const l = lines[i]
        if (l.length > 4000 || l.includes('secret-scan: allow')) continue
        for (const [kind, re] of SECRET_RULES) {
          const m = re.exec(l)
          if (!m) continue
          add(rel, i + 1, kind, kind === 'a private key' || kind === 'a password in a URL' ? undefined : hintFor(m[0]))
          n++
          break
        }
      }
    }
  }
  await walk(root)
  return { project: root, at: Date.now(), findings, files, partial }
}
