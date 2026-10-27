// The git half of `npm run setup` (#143): turn a fresh clone of the public repo into the user's own repository.
//
// The clone's history is kept (so a later merge of upstream/main has a common ancestor and needs no
// --allow-unrelated-histories), and only the remotes change: `origin` is renamed to `upstream`, its push URL is
// set to DISABLED so a push there can't happen by accident, and main stops tracking it (so nothing reports
// "unpushed commits" and push-after-merge has nowhere to go). No remote called origin is left.
//
// The rule for "fresh clone" is strict on purpose, so a maintainer's dev checkout (or anyone's working repo) is
// never rewritten: the folder is the top of a normal (non-worktree) repository, its only remote is origin, it is on
// main with no other local branch, main is exactly origin/main, nothing is changed, and HEAD's reflog holds nothing
// but the clone itself. Anything else is refused with the reason.
import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

export const DISABLED = 'DISABLED'

const git = (dir, args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }).trim()
const tryGit = (dir, args) => {
  try {
    return git(dir, args)
  } catch {
    return undefined
  }
}
const lines = (s) => (s ? s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [])
// git reports real paths, so compare real paths: 8.3 short names (a CI runner's TEMP is C:\Users\RUNNER~1\...),
// junctions and symlinks (macOS's /var is /private/var) resolved
const real = (p) => {
  try {
    return realpathSync.native(p)
  } catch {
    return resolve(p)
  }
}
const samePath = (a, b) => real(a).toLowerCase() === real(b).toLowerCase()

/**
 * What the folder is, as { kind, reason?, upstreamUrl?, commit? }:
 * - 'installed': already the user's own repo (an upstream remote whose push is disabled, no origin)
 * - 'fresh-clone': safe to convert
 * - 'not-a-repo' | 'refuse': leave git alone; reason says why
 */
export function classifyRepo(dir) {
  const top = tryGit(dir, ['rev-parse', '--show-toplevel'])
  if (!top) return { kind: 'not-a-repo', reason: "This folder isn't a git repository." }
  if (!samePath(top, dir)) return { kind: 'refuse', reason: `This folder is inside another repository (${top}).` }
  const gitDir = tryGit(dir, ['rev-parse', '--absolute-git-dir'])
  const common = tryGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (gitDir && common && !samePath(gitDir, common)) return { kind: 'refuse', reason: 'This folder is a git worktree, not a clone.' }

  const remotes = lines(tryGit(dir, ['remote']))
  if (remotes.includes('upstream') && !remotes.includes('origin')) {
    const push = tryGit(dir, ['remote', 'get-url', '--push', 'upstream'])
    if (push === DISABLED) return { kind: 'installed', upstreamUrl: tryGit(dir, ['remote', 'get-url', 'upstream']) }
    return { kind: 'refuse', reason: `The upstream remote can push (to ${push}); an install made by setup has its push disabled.` }
  }
  if (remotes.length !== 1 || remotes[0] !== 'origin')
    return { kind: 'refuse', reason: remotes.length ? `It has the remotes ${remotes.join(', ')}; a fresh clone has only origin.` : 'It has no remote, so it was not cloned from the public repository.' }
  const branch = tryGit(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (branch !== 'main') return { kind: 'refuse', reason: `It is on ${branch ? `the branch ${branch}` : 'a detached HEAD'}, not main.` }
  const branches = lines(tryGit(dir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']))
  if (branches.length !== 1) {
    const others = branches.filter((b) => b !== 'main')
    return { kind: 'refuse', reason: `It has local branches besides main (${others.slice(0, 3).join(', ')}${others.length > 3 ? ` and ${others.length - 3} more` : ''}).` }
  }
  const head = tryGit(dir, ['rev-parse', 'HEAD'])
  const remoteMain = tryGit(dir, ['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'])
  if (!head || head !== remoteMain) return { kind: 'refuse', reason: 'Its main is not the same commit as origin/main (local commits, or not a clone of main).' }
  if (lines(tryGit(dir, ['status', '--porcelain'])).length) return { kind: 'refuse', reason: 'It has uncommitted changes.' }
  const reflog = lines(tryGit(dir, ['reflog', '--format=%gs', 'HEAD']))
  if (reflog.length !== 1 || !reflog[0].startsWith('clone:'))
    return { kind: 'refuse', reason: "It has been worked in since it was cloned (HEAD's history shows more than the clone)." }
  return { kind: 'fresh-clone', upstreamUrl: tryGit(dir, ['remote', 'get-url', 'origin']), commit: head }
}

/** Convert a fresh clone (classifyRepo said 'fresh-clone') into the user's own repository. Only remote config changes. */
export function convertRepo(dir) {
  git(dir, ['remote', 'rename', 'origin', 'upstream'])
  git(dir, ['remote', 'set-url', '--push', 'upstream', DISABLED])
  tryGit(dir, ['branch', '--unset-upstream', 'main'])
  // where this install started, for the update task and for anyone reading .git/config
  git(dir, ['config', 'corvid.installedFrom', git(dir, ['rev-parse', 'HEAD'])])
}

/** Where this platform keeps the installed app and Corvid's data, as setup's messages show them. */
export const WINDOWS_PLACES = { exe: '%LOCALAPPDATA%\\Programs\\Corvid\\Corvid.exe', data: '%APPDATA%\\Corvid' }

/**
 * What setup says when scripts/deploy.mjs exits with `status` (step 4): null for 0, otherwise { title, fixes } for
 * stop(). `places` is this platform's { exe, data } (Windows by default). Kept here, not in setup.mjs, so test-setup
 * can import it (setup runs when loaded).
 */
export function deployOutcome(status, places = WINDOWS_PLACES) {
  if (status === 0) return null
  // 3: installed and launched, but it didn't report healthy in time (a first install has nothing to roll back to)
  if (status === 3)
    return {
      title: "Corvid is installed, but it didn't report that it started within 30 seconds.",
      fixes: [
        'It may still be opening: give it a minute. If its window appears, setup is done.',
        `If it never opens, start it from ${places.exe} and look for an error.`,
        `deploy.log and crash.log in ${places.data} have the details; then run npm run setup again (safe to repeat).`
      ]
    }
  return {
    title: 'Building or installing Corvid failed (see above).',
    fixes: [
      'Run npm run setup again; it is safe to repeat.',
      `deploy.log in ${places.data} has the details of the install and launch.`,
      'More in Troubleshooting in INSTALL.md.'
    ]
  }
}
