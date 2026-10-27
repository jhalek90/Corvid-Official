// Tests for #143's setup: a fresh clone of a fake public repo (a temp folder) becomes the user's own repository with
// a fetch-only `upstream` and no origin, a later merge of upstream/main works without unrelated-histories trouble,
// a push to the public repo can't happen, and anything that isn't a fresh clone (a dev checkout with work in it, a
// worktree) is refused. Also the push rule Corvid itself uses (canPushTo), setup's message for each deploy exit code
// (deployOutcome) and `npm run setup -- --help`.
// Nothing here touches the network, Corvid's data folder or ~/.claude.
//
//   npm run test-setup

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { classifyRepo, convertRepo, deployOutcome } from './setup-git.mjs'
import { lockfileRefusal, npmSupport } from './setup-npm.mjs'

const root = join(import.meta.dirname, '..')
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function load(u, c, next) {
      return u.split('?')[0].endsWith('.ts') ?next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
const { canPushTo } = await import(pathToFileURL(join(root, 'src', 'shared', 'gitRemote.ts')).href)

const tmp = mkdtempSync(join(tmpdir(), 'corvid-setup-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (dir, file, text, msg) => {
  writeFileSync(join(dir, file), text)
  git(dir, 'add', file)
  git(dir, 'commit', '-q', '-m', msg)
}

// the "public repo": a bare repository with main, fed from a working copy
const pub = join(tmp, 'public.git')
const pubWork = join(tmp, 'public-work')
git(tmp, 'init', '-q', '--bare', '-b', 'main', pub)
git(tmp, 'clone', '-q', pub, pubWork)
git(pubWork, 'checkout', '-q', '-b', 'main')
commit(pubWork, 'a.txt', 'one\n', 'first')
git(pubWork, 'push', '-q', 'origin', 'main')
const clone = (name) => {
  const dir = join(tmp, name)
  git(tmp, 'clone', '-q', pub, dir)
  return dir
}

test('a fresh clone is converted: upstream fetch-only, no origin, main tracks nothing', () => {
  const dir = clone('install')
  const before = classifyRepo(dir)
  assert.equal(before.kind, 'fresh-clone')
  convertRepo(dir)
  assert.deepEqual(git(dir, 'remote').split(/\r?\n/), ['upstream'])
  assert.equal(git(dir, 'remote', 'get-url', '--push', 'upstream'), 'DISABLED')
  assert.equal(git(dir, 'remote', 'get-url', 'upstream'), pub)
  assert.throws(() => git(dir, 'rev-parse', '--abbrev-ref', 'main@{upstream}'))
  assert.equal(git(dir, 'config', 'corvid.installedFrom'), before.commit)
  // history kept: same commit as the public main
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(pubWork, 'rev-parse', 'HEAD'))
  // running setup again recognises it and changes nothing
  assert.equal(classifyRepo(dir).kind, 'installed')
})

test('a push to the public repo fails, and the public repo is unchanged', () => {
  const dir = join(tmp, 'install')
  commit(dir, 'mine.txt', 'local\n', 'my change')
  assert.throws(() => git(dir, 'push', 'upstream', 'main'))
  assert.notEqual(git(pub, 'rev-parse', 'main'), git(dir, 'rev-parse', 'HEAD'))
  // and Corvid's own rule agrees there's nowhere to push
  assert.equal(canPushTo(git(dir, 'remote', 'get-url', '--push', 'upstream')), false)
  // with no tracking branch, status reports nothing ahead (no "unpushed commits")
  assert.doesNotMatch(git(dir, 'status', '-sb'), /ahead/)
})

test('merging upstream/main into the local main works (shared history, no unrelated-histories error)', () => {
  const dir = join(tmp, 'install')
  commit(pubWork, 'b.txt', 'two\n', 'public update')
  git(pubWork, 'push', '-q', 'origin', 'main')
  git(dir, 'fetch', '-q', 'upstream')
  assert.equal(git(dir, 'rev-list', '--count', 'main..upstream/main'), '1')
  git(dir, 'merge', '--no-edit', '-q', 'upstream/main')
  assert.equal(git(dir, 'rev-list', '--count', 'main..upstream/main'), '0')
  assert.equal(classifyRepo(dir).kind, 'installed')
})

test('a checkout with work in it, a worktree, or extra remotes is refused', () => {
  const dev = clone('dev')
  commit(dev, 'x.txt', 'dev\n', 'dev work')
  assert.equal(classifyRepo(dev).kind, 'refuse')

  // worked in and put back exactly as cloned: HEAD's reflog still shows it
  const used = clone('used')
  git(used, 'checkout', '-q', '-b', 'tmp')
  git(used, 'checkout', '-q', 'main')
  git(used, 'branch', '-q', '-D', 'tmp')
  assert.equal(classifyRepo(used).kind, 'refuse')

  const extra = clone('extra')
  git(extra, 'remote', 'add', 'fork', pub)
  assert.equal(classifyRepo(extra).kind, 'refuse')

  const wtBase = clone('wtbase')
  const wt = join(tmp, 'wt')
  git(wtBase, 'worktree', 'add', '-q', '-b', 'side', wt)
  assert.equal(classifyRepo(wt).kind, 'refuse')

  const plain = join(tmp, 'plain')
  git(tmp, 'init', '-q', '-b', 'main', plain)
  assert.equal(classifyRepo(plain).kind, 'refuse') // no remote
  assert.equal(classifyRepo(tmp).kind, 'not-a-repo')

  const pushable = clone('pushable')
  git(pushable, 'remote', 'rename', 'origin', 'upstream')
  assert.equal(classifyRepo(pushable).kind, 'refuse') // upstream that can push isn't an install
})

test('a fresh clone reached through a link is still a fresh clone (git names the real path)', () => {
  // the same mismatch as a CI runner's 8.3 TEMP (C:\Users\RUNNER~1\...) or macOS's /var -> /private/var
  const dir = clone('linked')
  const link = join(tmp, 'link-to-linked')
  symlinkSync(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(classifyRepo(link).kind, 'fresh-clone')
})

test('canPushTo', () => {
  assert.equal(canPushTo('https://example.invalid/r.git'), true)
  assert.equal(canPushTo('DISABLED'), false)
  assert.equal(canPushTo('no_push'), false)
  assert.equal(canPushTo(''), false)
  assert.equal(canPushTo(undefined), false)
})

test('setup --help prints usage and changes nothing', () => {
  const out = execFileSync(process.execPath, [join(root, 'scripts', 'setup.mjs'), '--help'], { encoding: 'utf8' })
  assert.match(out, /--keep-git/)
  assert.match(out, /--check/)
})

test("deployOutcome: setup's message for each deploy.mjs exit code", () => {
  assert.equal(deployOutcome(0), null)
  const slow = deployOutcome(3) // installed, but not healthy in time
  assert.match(slow.title, /installed, but it didn't report that it started/)
  assert.ok(slow.fixes.some((f) => f.includes('deploy.log')))
  assert.ok(slow.fixes.some((f) => f.includes('npm run setup')))
  assert.ok(slow.fixes.some((f) => f.includes('%LOCALAPPDATA%\\Programs\\Corvid\\Corvid.exe')))
  for (const status of [1, 2, null]) {
    const o = deployOutcome(status) // null: killed by a signal
    assert.equal(o.title, 'Building or installing Corvid failed (see above).')
    assert.ok(o.fixes.length > 0)
  }
  // macOS and Linux (#163): setup passes its own places, and no Windows path leaks into the message
  const linux = deployOutcome(3, { exe: '~/.local/share/corvid/app/corvid', data: '~/.config/Corvid' })
  assert.ok(linux.fixes.some((f) => f.includes('~/.local/share/corvid/app/corvid')))
  assert.ok(linux.fixes.some((f) => f.includes('~/.config/Corvid')))
  assert.ok(!linux.fixes.some((f) => f.includes('%')))
  assert.ok(deployOutcome(1, { exe: 'x', data: '~/Library/Application Support/Corvid' }).fixes.some((f) => f.includes('~/Library/Application Support/Corvid')))
})

// #183: npm 11.6.2+ refused npm ci on a lockfile without @electron/windows-sign's optional entries
test('npmSupport: npm 10 and 11 are supported, others get a note', () => {
  assert.equal(npmSupport('10.9.9'), 'supported')
  assert.equal(npmSupport('11.21.1'), 'supported')
  assert.equal(npmSupport('9.8.1'), 'older')
  assert.equal(npmSupport('12.2.1'), 'newer')
  assert.equal(npmSupport(undefined), undefined)
  assert.equal(npmSupport('not a version'), undefined)
})

test("lockfileRefusal: spots npm ci's out-of-sync refusal and names the packages", () => {
  // npm 11.21.1's output on the old lockfile, trimmed
  const npm11 = [
    'npm error code EUSAGE',
    'npm error',
    'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
    'npm error',
    'npm error Missing: @electron/windows-sign@1.2.2 from lock file',
    'npm error Missing: cross-dirname@0.1.0 from lock file',
    'npm error Missing: postject@1.0.0-alpha.6 from lock file',
    'npm error',
    'npm error Clean install a project'
  ].join('\n')
  assert.deepEqual(lockfileRefusal(npm11), ['@electron/windows-sign@1.2.2', 'cross-dirname@0.1.0', 'postject@1.0.0-alpha.6'])
  assert.deepEqual(lockfileRefusal("npm error Invalid: lock file's foo@1.0.0 does not satisfy foo@^2.0.0"), ['foo@1.0.0'])
  assert.deepEqual(lockfileRefusal('npm ERR! `npm ci` can only install packages when your package.json and package-lock.json are in sync.'), [])
  assert.equal(lockfileRefusal('npm error code ECONNRESET\nnpm error network aborted'), undefined)
  assert.equal(lockfileRefusal(undefined), undefined)
})
