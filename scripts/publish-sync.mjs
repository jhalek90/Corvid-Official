// Publish sync, for the maintainer: makes private main's tree one new commit on top of the public repo's main
// (Corvid-Official). The public repo shares no history with the private one, so each update is a single commit
// with the exact tree, deleted files included. It never pushes: it prints the push command for the maintainer.
//
//   node scripts/publish-sync.mjs              make the commit in the public working copy
//   node scripts/publish-sync.mjs --dry-run    every check and the summary, but no commit
//
// Options: --dir <path> (the public working copy; default ../Corvid-Official next to the private checkout),
// --source <ref> (default main), --allow-same-version (sync without a version bump), --accept-public <sha> (the
// public head, when it holds commits made outside the sync, such as edits on GitHub, that are now in private main).
//
// It refuses when the public main has commits it didn't make, the secret scan finds anything, a tracked file holds
// the private git email, or the version wasn't bumped. CONTRIBUTING.md, "Publishing to the public repo", has the steps.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PUBLIC_IDENTITY, changeLines, checkPublicHistory, commitMessage, summarizeNameStatus } from './publish-sync-lib.mjs'

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const allowSameVersion = argv.includes('--allow-same-version')
const opt = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}

const scripts = dirname(fileURLToPath(import.meta.url))

function git(cwd, args, { input, env } = {}) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1 << 30,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  }).trim()
}

function refuse(why) {
  console.error(`publish-sync: refused. ${why}`)
  process.exit(1)
}

// The private repository: its shared .git folder's parent, so a run from a task worktree finds the same repo.
const privateRepo = dirname(resolve(git(scripts, ['rev-parse', '--path-format=absolute', '--git-common-dir'])))
const source = opt('--source') ?? 'main'
const privateSha = git(privateRepo, ['rev-parse', '--verify', `${source}^{commit}`])
const privateTree = git(privateRepo, ['rev-parse', `${privateSha}^{tree}`])
const pkg = JSON.parse(git(privateRepo, ['show', `${privateSha}:package.json`]))
const remote = pkg.repository?.url
if (!remote) refuse('package.json at the source commit has no repository.url to publish to.')
const dir = resolve(opt('--dir') ?? join(privateRepo, '..', 'Corvid-Official'))
if (resolve(dir) === privateRepo) refuse('the public working copy must not be the private checkout.')

// The public working copy: cloned once, then only fetched. It must point at the public remote and hold no work.
if (!existsSync(dir)) {
  console.log(`publish-sync: cloning ${remote} into ${dir}`)
  execFileSync('git', ['clone', '--quiet', remote, dir], { stdio: 'inherit' })
}
let copyTop
try {
  copyTop = resolve(git(dir, ['rev-parse', '--show-toplevel']))
} catch {
  refuse(`${dir} exists but isn't a git working copy.`)
}
if (copyTop !== resolve(dir)) refuse(`${dir} is inside another repository (${copyTop}), not its own clone.`)
if (git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']) === git(privateRepo, ['rev-parse', '--path-format=absolute', '--git-common-dir']))
  refuse(`${dir} shares its .git folder with the private repo.`)
const origin = git(dir, ['remote', 'get-url', 'origin'])
if (origin.replace(/\.git$/, '') !== remote.replace(/\.git$/, '')) refuse(`${dir}'s origin is ${origin}, not ${remote}.`)
if (git(dir, ['status', '--porcelain'])) refuse(`${dir} has uncommitted changes. Clean it up first.`)

git(dir, ['fetch', '--quiet', 'origin', 'main'])
const publicHead = git(dir, ['rev-parse', 'origin/main'])
const branch = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])
if (branch !== 'main') refuse(`${dir} is on ${branch}, not main.`)
const localHead = git(dir, ['rev-parse', 'HEAD'])
if (localHead !== publicHead) {
  const ahead = git(dir, ['rev-list', '--count', `${publicHead}..${localHead}`])
  if (ahead !== '0')
    refuse(`${dir}'s main has ${ahead} commit(s) not on the public main (an unpushed earlier sync?). Push them, or drop them with: git -C "${dir}" reset --hard origin/main`)
  git(dir, ['merge', '--ff-only', '--quiet', 'origin/main'])
}

// The expected-commit check: only sync commits on top of the baseline, and the head's tree is the tree of the
// private commit it names.
const log = git(dir, ['log', '--format=%H%x00%ae%x00%ce%x00%B%x1e', publicHead])
const commits = log.split('\x1e').map((r) => r.replace(/^\n/, '')).filter((r) => r.trim()).map((r) => {
  const [sha, authorEmail, committerEmail, message] = r.split('\x00')
  return { sha, authorEmail, committerEmail, message }
})
const history = checkPublicHistory(commits, { accept: opt('--accept-public') })
if (!history.ok) refuse(`${history.reason}. Nothing was changed.`)
const { lastSynced, trusted, outside } = history
try {
  git(privateRepo, ['merge-base', '--is-ancestor', lastSynced, privateSha])
} catch {
  refuse(`the last synced private commit ${lastSynced.slice(0, 12)} isn't an ancestor of ${source} (${privateSha.slice(0, 12)}).`)
}
if (git(dir, ['rev-parse', `${trusted}^{tree}`]) !== git(privateRepo, ['rev-parse', `${lastSynced}^{tree}`]))
  refuse(`the tree of public ${trusted.slice(0, 12)} differs from the tree of ${lastSynced.slice(0, 12)}, the private commit it says it came from.`)
if (privateTree === git(dir, ['rev-parse', `${publicHead}^{tree}`])) refuse(`nothing to sync: ${source}'s tree is already on the public main.`)

const publicPkg = JSON.parse(git(dir, ['show', `${publicHead}:package.json`]))
if (publicPkg.version === pkg.version && !allowSameVersion)
  refuse(`package.json is still at ${pkg.version}, the public version. Bump it (and add a CHANGELOG.md entry) on private main first, or pass --allow-same-version.`)

// Copy only the tree's objects (trees and blobs, no private commits) into the public copy.
// ls-tree lines are "<mode> <type> <object>\t<path>" (git 2.31 has no --object-only); submodule commits are skipped.
const objects = git(privateRepo, ['ls-tree', '-r', '-t', privateTree])
  .split('\n')
  .map((l) => l.split(/\s+/))
  .filter((f) => f[1] === 'tree' || f[1] === 'blob')
  .map((f) => f[2])
  .join('\n')
const pack = execFileSync('git', ['pack-objects', '--stdout', '-q'], { cwd: privateRepo, input: `${privateTree}\n${objects}\n`, maxBuffer: 1 << 30 })
execFileSync('git', ['unpack-objects', '-q'], { cwd: dir, input: pack })

// Accepted outside commits: every file they touched must be the same in the private tree, or the sync would undo them.
if (outside.length) {
  const blob = (tree, path) => git(dir, ['ls-tree', tree, '--', path]).split(/\s+/)[2] ?? ''
  const touched = git(dir, ['diff', '--name-only', '--no-renames', trusted, publicHead]).split('\n').filter(Boolean)
  const lost = touched.filter((p) => blob(publicHead, p) !== blob(privateTree, p))
  if (lost.length) refuse(`the accepted public commits changed files that differ in private ${source}:\n${lost.map((p) => `  ${p}`).join('\n')}\nCopy those changes into private main first.`)
  console.log(`publish-sync: accepted ${outside.length} public commit(s) not made by the sync; their ${touched.length} file(s) match private ${source}.`)
}

// The changelog: private main's first-parent subjects since the last sync, without private task numbers.
const subjects = git(privateRepo, ['log', '--first-parent', '--reverse', '--format=%s', `${lastSynced}..${privateSha}`]).split('\n').filter(Boolean)
const lines = changeLines(subjects)
const message = commitMessage({ version: pkg.version, lines, privateSha })

// Checks on the exact tree. The private email is read from the private repo's git config, so it never sits in a file.
let privateEmail = ''
try {
  privateEmail = git(privateRepo, ['config', 'user.email'])
} catch {}
if (privateEmail && privateEmail.toLowerCase() !== PUBLIC_IDENTITY.email) {
  const hit = spawnSync('git', ['grep', '-l', '-I', '-i', '-F', '-e', privateEmail, privateTree], { cwd: dir, encoding: 'utf8' })
  if (hit.status === 0) refuse(`the private git email is in tracked files:\n${hit.stdout.replace(new RegExp(`^${privateTree}:`, 'gm'), '  ')}`)
  if (hit.status !== 1) refuse(`git grep for the private email failed: ${hit.stderr.trim()}`)
  if (message.toLowerCase().includes(privateEmail.toLowerCase())) refuse('the commit message holds the private git email.')
  console.log('publish-sync: the private git email is in no tracked file.')
} else console.log('publish-sync: no private git email set, so the email check was skipped.')
if (/(^|\s)#\d+\b/.test(message)) refuse('the commit message still holds a private #NNN task number.')

// The secret scan sees the whole tree as staged in a throwaway repo that borrows the copy's objects, so it scans
// every file, not just the diff since the last sync. gitleaks runs too when it's installed (secret-scan.mjs does that).
const scanRepo = mkdtempSync(join(tmpdir(), 'corvid-publish-scan-'))
try {
  git(scanRepo, ['init', '-q'])
  writeFileSync(join(scanRepo, '.git', 'objects', 'info', 'alternates'), join(dir, '.git', 'objects').replace(/\\/g, '/') + '\n')
  git(scanRepo, ['read-tree', privateTree])
  const scan = spawnSync(process.execPath, [join(scripts, 'secret-scan.mjs')], { cwd: scanRepo, encoding: 'utf8' })
  process.stdout.write(scan.stdout)
  process.stderr.write(scan.stderr)
  if (scan.status !== 0) refuse('the secret scan found something in the tree (see above).')
} finally {
  rmSync(scanRepo, { recursive: true, force: true })
}

const fileCount = git(dir, ['ls-tree', '-r', '--name-only', privateTree]).split('\n').filter(Boolean).length
const diff = summarizeNameStatus(git(dir, ['diff', '--name-status', '-M', publicHead, privateTree]))
const author = `${PUBLIC_IDENTITY.name} <${PUBLIC_IDENTITY.email}>`

let newCommit = '(dry run: no commit made)'
if (!dryRun) {
  // The public identity, set in the public copy only; global config and the private repo's identity stay as they are.
  git(dir, ['config', '--local', 'user.name', PUBLIC_IDENTITY.name])
  git(dir, ['config', '--local', 'user.email', PUBLIC_IDENTITY.email])
  newCommit = git(dir, ['commit-tree', privateTree, '-p', publicHead, '-F', '-'], { input: message })
  git(dir, ['update-ref', '-m', `publish-sync from ${privateSha}`, 'refs/heads/main', newCommit, publicHead])
  git(dir, ['read-tree', '-u', '--reset', newCommit])
  if (git(dir, ['rev-parse', `${newCommit}^{tree}`]) !== privateTree) refuse('the new commit\'s tree differs from the private tree.')
}

const list = (paths) => (paths.length > 20 ? [...paths.slice(0, 20), `... and ${paths.length - 20} more`] : paths).map((p) => `    ${p}`).join('\n')
console.log(`
publish-sync${dryRun ? ' (dry run)' : ''}
  version:     ${pkg.version} (public was ${publicPkg.version})
  from:        private ${source} ${privateSha}
  on top of:   public main ${publicHead}
  new commit:  ${newCommit}
  files:       ${fileCount} tracked
  added ${diff.added.length}, changed ${diff.changed.length}, removed ${diff.removed.length}
${diff.added.length ? `  added:\n${list(diff.added)}\n` : ''}${diff.changed.length ? `  changed:\n${list(diff.changed)}\n` : ''}${diff.removed.length ? `  removed:\n${list(diff.removed)}\n` : ''}  author:      ${author}
  remote:      ${remote}
  copy:        ${dir}

Commit message:
${message.replace(/^/gm, '  ')}
${dryRun ? 'Run again without --dry-run to make the commit.' : `Nothing was pushed. After review, push with:\n  git -C "${dir}" push origin main`}`)
