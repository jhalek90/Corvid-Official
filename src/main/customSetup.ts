// Settings → Models' Set up button (#316, step 4 of the plan in N175, section 3): one interactive Claude Code terminal on
// the entry's server and in the custom-model config folder, so the user answers Claude Code's first-run questions and
// its "trust this folder" prompt themselves. Corvid never writes Claude Code's own .claude.json to skip them.
// This file only works out where that terminal opens; index.ts starts it.

import { posix, win32 } from 'node:path'

export interface SetupFolder {
  /** where the terminal opens: the deepest folder above every project folder and its <folder>-worktrees */
  folder: string
  /** project folders on another drive or root, which this folder doesn't cover */
  left: string[]
}

/**
 * The common parent of the project folders and Corvid's worktree roots. A worktree root is <folder>-worktrees next to
 * its folder, so each folder's parent covers both. Folders on several drives have no common parent: the drive with
 * the most folders wins, and the others are listed in `left`. Null when there are no folders.
 */
export function setupFolder(folders: readonly string[], platform: NodeJS.Platform = process.platform): SetupFolder | null {
  const p = platform === 'win32' ? win32 : posix
  const key = (s: string): string => (platform === 'win32' || platform === 'darwin' ? s.toLowerCase() : s)
  const parents = [...new Set(folders.filter(Boolean).map((f) => p.dirname(p.resolve(f))))]
  if (!parents.length) return null
  const byRoot = new Map<string, string[]>()
  for (const d of parents) {
    const r = key(p.parse(d).root)
    byRoot.set(r, [...(byRoot.get(r) ?? []), d])
  }
  const [, group] = [...byRoot.entries()].sort((a, b) => b[1].length - a[1].length)[0]
  const split = (d: string): string[] => d.slice(p.parse(d).root.length).split(p.sep).filter(Boolean)
  let common = split(group[0])
  for (const d of group.slice(1)) {
    const parts = split(d)
    let i = 0
    while (i < common.length && i < parts.length && key(common[i]) === key(parts[i])) i++
    common = common.slice(0, i)
  }
  const root = p.parse(group[0]).root
  const inGroup = new Set(group.map(key))
  return {
    folder: common.length ? p.join(root, ...common) : root,
    left: folders.filter((f) => f && !inGroup.has(key(p.dirname(p.resolve(f)))))
  }
}
