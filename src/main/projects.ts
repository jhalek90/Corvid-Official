import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, parse } from 'node:path'
import type { ArchiveEntry, GitInfo } from '@shared/types'
import { projectKey } from '@shared/projects'
import { findRepo, gitInfo } from './git'

type Emit = (updates: { key: string; info: GitInfo | null }[]) => void

const tracked = new Map<string, string>() // key -> path
const cache = new Map<string, GitInfo | null>()
const inflight = new Map<string, Promise<void>>()
let emit: Emit = () => {}

export function initProjects(e: Emit): void {
  emit = e
  setInterval(() => void refreshAll(), 120_000)
}

async function refresh(key: string): Promise<void> {
  const path = tracked.get(key)
  if (!path) return
  const running = inflight.get(key)
  if (running) return running
  const p = gitInfo(path)
    .catch((e) => ({ path, error: String(e) }) as unknown as GitInfo)
    .then((info) => {
      cache.set(key, info)
      emit([{ key, info }])
    })
    .finally(() => inflight.delete(key))
  inflight.set(key, p)
  return p
}

/** Keep a few git processes in flight at once; some repos have thousands of changed files. */
async function refreshMany(keys: string[]): Promise<void> {
  const queue = [...keys]
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      while (queue.length) await refresh(queue.shift()!)
    })
  )
}

export function refreshAll(): Promise<void> {
  return refreshMany([...tracked.keys()])
}

export function refreshPath(path: string): Promise<void> {
  return refresh(projectKey(path))
}

/** Set the projects whose git status is kept fresh; returns what's cached already. */
export function track(paths: string[]): { key: string; info: GitInfo | null }[] {
  const fresh: string[] = []
  for (const p of paths) {
    const key = projectKey(p)
    if (!tracked.has(key)) fresh.push(key)
    tracked.set(key, p)
  }
  void refreshMany(fresh)
  return [...cache.entries()].filter(([k]) => tracked.has(k)).map(([key, info]) => ({ key, info }))
}

export function isTracked(path: string): boolean {
  return tracked.has(projectKey(path))
}

/** Folders that hold two or more of the projects you've used Claude in. */
export function deriveRoots(cwds: string[]): string[] {
  const counts = new Map<string, { path: string; n: number; kids: Set<string> }>()
  for (const cwd of cwds) {
    const parent = dirname(cwd)
    const key = projectKey(parent)
    const c = counts.get(key) ?? { path: parent, n: 0, kids: new Set() }
    c.kids.add(projectKey(cwd))
    counts.set(key, c)
  }
  return [...counts.values()].filter((c) => c.kids.size >= 2).map((c) => c.path)
}

export async function scanArchive(roots: string[]): Promise<ArchiveEntry[]> {
  const out: ArchiveEntry[] = []
  for (const root of roots) {
    const entries = await fsp.readdir(root, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith('$') || e.name.endsWith('-worktrees')) continue
      const path = join(root, e.name)
      const st = await fsp.stat(path).catch(() => null)
      if (!st) continue
      out.push({ path, name: e.name, root, mtime: st.mtimeMs, hasGit: await hasGitWithin(path) })
    }
  }
  return out
}

async function hasGitWithin(path: string): Promise<boolean> {
  if (await exists(join(path, '.git'))) return true
  const kids = await fsp.readdir(path, { withFileTypes: true }).catch(() => [])
  for (const k of kids) {
    if (!k.isDirectory() || k.name === 'node_modules' || k.name.startsWith('.')) continue
    const child = join(path, k.name)
    if (await exists(join(child, '.git'))) return true
    const grand = await fsp.readdir(child, { withFileTypes: true }).catch(() => [])
    for (const g of grand) if (g.isDirectory() && (await exists(join(child, g.name, '.git')))) return true
  }
  return false
}

const exists = (p: string): Promise<boolean> => fsp.stat(p).then(() => true, () => false)

export function gitCache(): Record<string, GitInfo | null> {
  return Object.fromEntries(cache)
}

/** Track these folders and wait (briefly) until each has a git result. */
export async function ensureTracked(paths: string[], timeoutMs = 10_000): Promise<void> {
  track(paths)
  const missing = paths.map(projectKey).filter((k) => !cache.has(k))
  await Promise.race([refreshMany(missing), new Promise((r) => setTimeout(r, timeoutMs))])
}

export type NewFolderCheck =
  | { kind: 'ok' }
  | { kind: 'refuse'; reason: string }
  /** has its own .git: already a project, leave it alone */
  | { kind: 'existing' }
  /** inside another repo, or holds repos in subfolders; git init here would nest repos */
  | { kind: 'nested'; repoRoot: string; inside: boolean }

/** What New project should do with a folder. Only looks; changes nothing. */
export async function checkNewFolder(path: string): Promise<NewFolderCheck> {
  const key = projectKey(path)
  if (key === projectKey(homedir())) return { kind: 'refuse', reason: "Your home folder can't be a project. Pick or make a folder inside it." }
  if (key === projectKey(parse(path).root)) return { kind: 'refuse', reason: "A whole drive can't be a project. Pick or make a folder on it." }
  if (!(await fsp.stat(path).then((s) => s.isDirectory(), () => false))) return { kind: 'refuse', reason: `${path} isn't a folder.` }
  // .git can be a file too (worktrees, submodules); either way it's a repo already
  if (await exists(join(path, '.git'))) return { kind: 'existing' }
  const repo = await findRepo(path)
  if (repo && !repo.nested && projectKey(repo.root) === key) return { kind: 'existing' }
  if (repo) return { kind: 'nested', repoRoot: repo.root, inside: !repo.nested }
  return { kind: 'ok' }
}
