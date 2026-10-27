import { execFile } from 'node:child_process'
import { promises as fsp } from 'node:fs'
import { basename, join } from 'node:path'
import { unmergedTaskBranches } from './agentGit'
import { toNative } from './platform'
import { canPushTo } from '@shared/gitRemote'
import { samePath } from '@shared/pathKeys'
import type { GitCommit, GitDetail, GitGraph, GitInfo, GraphCommit, GraphRef } from '@shared/types'

const US = '\x1f'
const RS = '\x1e'
const COMMIT_FORMAT = `--format=%H${US}%s${US}%ct${US}%an${RS}`
const GRAPH_FORMAT = `--format=%H${US}%P${US}%s${US}%ct${US}%an${US}%D${RS}`
export const GRAPH_MAX = 2000
const SKIP_DIRS = new Set(['node_modules', '.git', '.vs', '.vscode', '.idea', 'dist', 'build', 'out', 'bin', 'obj', 'venv', '.venv'])

function git(cwd: string, args: string[], timeout = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { windowsHide: true, timeout, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim().split('\n')[0]))
      else resolve(stdout)
    })
  })
}

/** A path git printed, as the OS writes it: / to \ on Windows, unchanged elsewhere (#151). */
const nativePath = (p: string, platform: string = process.platform): string => toNative(p.trim(), platform)

/** Repo containing `path`, or failing that the closest repo in a subfolder (up to 3 levels). */
export async function findRepo(path: string): Promise<{ root: string; nested: boolean } | null> {
  try {
    return { root: nativePath(await git(path, ['rev-parse', '--show-toplevel'], 8000)), nested: false }
  } catch {
    /* not inside a repo */
  }
  let level = [path]
  for (let depth = 0; depth < 3 && level.length; depth++) {
    const next: string[] = []
    for (const dir of level) {
      const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        if (!e.isDirectory() || SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
        const child = join(dir, e.name)
        if (await fsp.stat(join(child, '.git')).then(() => true, () => false)) return { root: child, nested: true }
        next.push(child)
      }
    }
    level = next
  }
  return null
}

export function webUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined
  const m = /^(?:https?:\/\/|git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remote.trim())
  return m ? `https://${m[1]}/${m[2]}` : undefined
}

function parseCommits(out: string): GitCommit[] {
  return out
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, ct, author] = r.split(US)
      return { hash, subject, ts: Number(ct) * 1000, author }
    })
}

export async function gitInfo(path: string): Promise<GitInfo | null> {
  const repo = await findRepo(path)
  if (!repo) return null
  const info: GitInfo = {
    path,
    repoRoot: repo.root,
    nested: repo.nested,
    branch: '',
    ahead: 0,
    behind: 0,
    changed: 0,
    untracked: 0,
    conflicts: 0,
    checkedAt: Date.now()
  }
  try {
    const status = await git(repo.root, ['status', '--porcelain=v2', '--branch'])
    for (const line of status.split('\n')) {
      if (line.startsWith('# branch.head ')) info.branch = line.slice(14).trim()
      else if (line.startsWith('# branch.upstream ')) info.upstream = line.slice(18).trim()
      else if (line.startsWith('# branch.ab ')) {
        const m = /\+(\d+) -(\d+)/.exec(line)
        if (m) [info.ahead, info.behind] = [Number(m[1]), Number(m[2])]
      } else if (line.startsWith('1 ') || line.startsWith('2 ')) info.changed++
      else if (line.startsWith('u ')) info.conflicts++
      else if (line.startsWith('? ')) info.untracked++
    }
  } catch (e) {
    info.error = (e as Error).message
    return info
  }
  // commits ahead of a remote that takes no pushes (an install's public repo, #143) aren't "unpushed"
  if (info.ahead && info.upstream) {
    const remote = (await git(repo.root, ['config', '--get', `branch.${info.branch}.remote`]).catch(() => '')).trim()
    const pushUrl = remote ? await git(repo.root, ['remote', 'get-url', '--push', remote]).catch(() => '') : ''
    if (!canPushTo(pushUrl)) info.ahead = 0
  }
  const [log, remote] = await Promise.all([
    git(repo.root, ['log', '-1', COMMIT_FORMAT]).catch(() => ''),
    git(repo.root, ['remote', 'get-url', 'origin']).catch(async () => {
      const first = (await git(repo.root, ['remote']).catch(() => '')).split('\n')[0]?.trim()
      return first ? git(repo.root, ['remote', 'get-url', first]).catch(() => '') : ''
    })
  ])
  info.lastCommit = parseCommits(log)[0]
  const unmerged = await unmergedTaskBranches(repo.root).catch(() => [])
  if (unmerged.length) info.agentBranches = unmerged
  info.remoteUrl = remote.trim() || undefined
  info.webUrl = webUrl(info.remoteUrl)
  return info
}

export async function gitDetail(repoRoot: string): Promise<GitDetail> {
  const [log, status] = await Promise.all([
    git(repoRoot, ['log', '-20', COMMIT_FORMAT]).catch(() => ''),
    git(repoRoot, ['status', '--porcelain']).catch(() => '')
  ])
  const changes = status
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 300)
    .map((l) => ({ status: l.slice(0, 2).trim() || '?', path: l.slice(3).replace(/^"|"$/g, '') }))
  return { commits: parseCommits(log), changes }
}

/** "HEAD -> refs/heads/main, refs/remotes/origin/main, tag: refs/tags/v1" from %D with --decorate=full */
function parseRefs(decoration: string): GraphRef[] {
  const refs: GraphRef[] = []
  for (let d of decoration.split(', ')) {
    d = d.trim()
    if (!d) continue
    let current = false
    if (d === 'HEAD') {
      refs.push({ kind: 'head', name: 'HEAD' })
      continue
    }
    if (d.startsWith('HEAD -> ')) {
      current = true
      d = d.slice(8)
    }
    if (d.startsWith('tag: refs/tags/')) refs.push({ kind: 'tag', name: d.slice(15) })
    else if (d.startsWith('refs/heads/')) refs.push({ kind: 'branch', name: d.slice(11), current })
    else if (d.startsWith('refs/remotes/') && !d.endsWith('/HEAD')) refs.push({ kind: 'remote', name: d.slice(13) })
  }
  return refs
}

/**
 * Recent history across all branches, remotes and tags, with parents and labels, for the commit graph.
 * Read-only and offline: git log, rev-parse and worktree list only. Stashes and notes are left out.
 */
export async function gitGraph(repoRoot: string, limit = 200): Promise<GitGraph> {
  const n = Math.max(1, Math.min(GRAPH_MAX, Math.floor(limit)))
  const [head, worktrees] = await Promise.all([
    git(repoRoot, ['rev-parse', '--verify', '-q', 'HEAD'], 8000).then((s) => s.trim(), () => ''),
    git(repoRoot, ['worktree', 'list', '--porcelain'], 8000).catch(() => '')
  ])
  let out: string
  try {
    const revs = ['--branches', '--remotes', '--tags', ...(head ? ['HEAD'] : [])]
    out = await git(repoRoot, ['log', '--topo-order', '--decorate=full', '--no-color', `-n${n + 1}`, GRAPH_FORMAT, ...revs, '--'], 30_000)
  } catch (e) {
    return { commits: [], truncated: false, head: head || undefined, error: (e as Error).message }
  }
  const commits: GraphCommit[] = out
    .split(RS)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => {
      const [hash, parents, subject, ct, author, deco] = r.split(US)
      return { hash, subject, ts: Number(ct) * 1000, author, parents: parents ? parents.split(' ') : [], refs: parseRefs(deco ?? '') }
    })
  const truncated = commits.length > n
  if (truncated) commits.length = n

  // Other worktrees: tag the branch each one has checked out, or its commit if it's detached.
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  for (const block of worktrees.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9)
    if (!path || samePath(path, repoRoot) || lines.includes('bare')) continue
    const branch = lines.find((l) => l.startsWith('branch refs/heads/'))?.slice(18)
    const sha = lines.find((l) => l.startsWith('HEAD '))?.slice(5)
    const c = sha ? byHash.get(sha) : undefined
    if (!c) continue
    const ref = branch && c.refs.find((r) => r.kind === 'branch' && r.name === branch)
    if (ref) ref.worktree = nativePath(path)
    else c.refs.push({ kind: 'worktree', name: basename(nativePath(path)), worktree: nativePath(path) })
  }
  return { commits, truncated, head: head || undefined }
}

export interface RepoFacts {
  /** the checkout's own top folder */
  top: string
  /** the main repo's folder, from the common git directory: for a worktree, the repo it belongs to */
  repo: string
  worktree: boolean
  remotes: string[]
  firstCommit?: string
  branch?: string
}

/** repoFacts' paths from what rev-parse printed: the checkout, the main repo (the common git dir's parent) and
 *  whether it's a linked worktree. Pure, with the platform as an argument for the tests (#151). */
export function repoPaths(top: string, common: string, own: string, platform: string = process.platform): Pick<RepoFacts, 'top' | 'repo' | 'worktree'> {
  const repo = /[\\/]\.git$/i.test(common) ? common.replace(/[\\/]\.git$/i, '') : top
  return { top: nativePath(top, platform), repo: nativePath(repo, platform), worktree: !samePath(common, own, platform) }
}

/** Identity of the repo at `path` (#73), or null when it isn't in one. Read-only. */
export async function repoFacts(path: string): Promise<RepoFacts | null> {
  let out: string
  try {
    out = await git(path, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir', '--abbrev-ref', 'HEAD'], 8000)
  } catch {
    return null
  }
  const [top, common, own, branch] = out.split('\n').map((l) => l.trim())
  if (!top || !common) return null
  const [remotes, roots] = await Promise.all([
    git(path, ['config', '--get-regexp', '^remote\\..*\\.url$'], 8000).catch(() => ''),
    git(path, ['rev-list', '--max-parents=0', 'HEAD'], 8000).catch(() => '')
  ])
  return {
    ...repoPaths(top, common, own),
    remotes: remotes.split('\n').map((l) => l.split(' ').slice(1).join(' ').trim()).filter(Boolean),
    // the oldest root commit; a repo with merged histories can have several
    firstCommit: roots.trim().split('\n').filter(Boolean).pop(),
    branch: branch && branch !== 'HEAD' ? branch : undefined
  }
}
