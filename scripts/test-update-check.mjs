// Tests for #143's launch-time update check, against a fake public repo in a temporary folder: no update, an update
// available, an offline or failed fetch, Dismiss, the update task not being made twice, and a local change that
// conflicts with upstream (the check still only counts; it never merges). The main-process side runs as a test copy
// forced on with CORVID_UPDATE_TEST and pointed at the fake install with CORVID_UPDATE_REPO, through a stand-in for
// electron like test-task-done.mjs. Nothing is started and nothing leaves the temporary folder.
//
//   npm run test-update-check

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-update-check-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: () => globalThis.__userData, getAppPath: () => globalThis.__userData, isPackaged: false, getVersion: () => "0.0.0" }')
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: fake, shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

// ---------- a fake public repo, and an install of it the way npm run setup leaves one ----------

const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const commit = (cwd, file, text, msg) => {
  writeFileSync(join(cwd, file), text)
  git(cwd, 'add', file)
  git(cwd, 'commit', '-q', '-m', msg)
}

const upstreamDir = join(tmp, 'public')
const install = join(tmp, 'install')
mkdirSync(upstreamDir)
git(upstreamDir, 'init', '-q', '-b', 'main')
commit(upstreamDir, 'README.md', 'one\n', 'first')
git(tmp, 'clone', '-q', upstreamDir, install)
git(install, 'remote', 'rename', 'origin', 'upstream')
git(install, 'remote', 'set-url', '--push', 'upstream', 'DISABLED')
git(install, 'branch', '--unset-upstream')

// the built-in Corvid project, as the app keeps it
writeFileSync(
  join(globalThis.__userData, 'projects.json'),
  JSON.stringify({ version: 1, nextId: 2, importOffered: true, projects: [{ id: 'p1', name: 'Corvid', pinned: true, archived: false, createdAt: 1, folders: [{ path: install, primary: true, pastPaths: [] }], remotes: [], builtin: 'corvid' }] })
)

process.env.DASH_TEST_INSTANCE = 'test-update-check'
process.env.CORVID_UPDATE_TEST = '1'
process.env.CORVID_UPDATE_REPO = install

const shared = await import(src + 'shared/updateCheck.ts')
const { checkRepo } = await import(src + 'main/updateGit.ts')
const tasks = await import(src + 'main/tasks.ts')
tasks.initTasks(() => {}, { resolve: (q) => (q === 'p1' ? { id: 'p1', folder: install } : undefined), forPath: () => undefined, folder: () => undefined })
const projectStore = await import(src + 'main/projectStore.ts')
projectStore.initProjectStore?.({ onChange: () => {} })
const update = await import(src + 'main/updateCheck.ts')
const views = []
update.startUpdateCheck((v) => views.push(v), 1e9)

after(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 })
  // the tasks.json watcher would keep the test running
  setTimeout(() => process.exit(0), 50)
})

test('no upstream remote (a maintainer checkout): nothing to check, and nothing fetched', async () => {
  const dev = join(tmp, 'dev')
  git(tmp, 'clone', '-q', upstreamDir, dev)
  const r = await checkRepo(dev)
  assert.equal(r.status, 'not-install')
  assert.equal(shared.bannerCount(r, undefined), undefined)
})

test('no update: up to date, no banner', async () => {
  const v = await update.runUpdateCheck(true).then(() => update.updateView())
  assert.equal(v.state.status, 'up-to-date')
  assert.equal(v.state.count, 0)
  assert.equal(shared.bannerCount(v.state, v.dismissed), undefined)
})

test('update available: counts the new commits on upstream/main, and merges nothing', async () => {
  const before = git(install, 'rev-parse', 'HEAD')
  commit(upstreamDir, 'a.txt', 'a\n', 'second')
  commit(upstreamDir, 'b.txt', 'b\n', 'third')
  await update.runUpdateCheck(false)
  const v = update.updateView()
  assert.equal(v.state.status, 'available')
  assert.equal(v.state.count, 2)
  assert.equal(v.state.upstream, git(upstreamDir, 'rev-parse', 'HEAD'))
  assert.equal(shared.bannerCount(v.state, v.dismissed), 2)
  assert.equal(shared.bannerText(2), 'A Corvid update is available (2 new changes)')
  assert.equal(git(install, 'rev-parse', 'HEAD'), before, 'the check must never move the local branch')
  assert.ok(views.some((x) => x.state?.status === 'available'), 'the window is told')
})

test('dismiss hides it for this upstream commit; a new upstream commit brings it back', async () => {
  const v = update.dismissUpdate()
  assert.equal(v.dismissed, v.state.upstream)
  assert.equal(shared.bannerCount(v.state, v.dismissed), undefined)
  assert.equal(JSON.parse(readFileSync(join(globalThis.__userData, 'config.json'), 'utf8')).updateDismissed, v.state.upstream)
  await update.runUpdateCheck(false)
  assert.equal(shared.bannerCount(update.updateView().state, update.updateView().dismissed), undefined, 'same upstream: still dismissed')
  commit(upstreamDir, 'c.txt', 'c\n', 'fourth')
  await update.runUpdateCheck(false)
  const w = update.updateView()
  assert.equal(shared.bannerCount(w.state, w.dismissed), 3)
})

test('the update task: made once in Up next of the Corvid project, then the open one is returned', () => {
  const first = update.createUpdateTask()
  assert.ok(first.task && !first.existed)
  assert.equal(first.task.title, 'Update Corvid from the public repo')
  assert.equal(first.task.column, 'next')
  assert.equal(first.task.projectId, 'p1')
  for (const must of ['git fetch upstream', 'never push', 'Never rebase', 'npm run typecheck', 'npm run deploy', 'ends during the deploy', 'ask the user on the board'])
    assert.ok(first.task.notes.includes(must), `notes mention ${must}`)
  const again = update.createUpdateTask()
  assert.equal(again.existed, true)
  assert.equal(again.task.id, first.task.id)
  assert.equal(tasks.listTasks().filter((t) => t.title === shared.UPDATE_TASK_TITLE).length, 1)
  // while it's open the banner isn't needed
  assert.equal(update.updateView().state.openTask, first.task.id)
  assert.equal(shared.bannerCount(update.updateView().state, undefined), undefined)
  // once it's Done, a later update can make a new one
  tasks.updateTask(first.task.id, { column: 'done' })
  assert.equal(shared.openUpdateTask(tasks.listTasks(), 'p1'), undefined)
  const next = update.createUpdateTask()
  assert.notEqual(next.task.id, first.task.id)
})

test('offline or failed fetch: status failed, no banner, nothing thrown', async () => {
  git(install, 'remote', 'set-url', 'upstream', join(tmp, 'gone'))
  await update.runUpdateCheck(false)
  const v = update.updateView()
  assert.equal(v.state.status, 'failed')
  assert.ok(v.state.detail)
  assert.equal(shared.bannerCount(v.state, undefined), undefined)
  assert.match(shared.checkSummary(v.state), /Couldn't reach the public repo/)
  git(install, 'remote', 'set-url', 'upstream', upstreamDir)
  git(install, 'remote', 'set-url', '--push', 'upstream', 'DISABLED')
})

test('a local change that conflicts with upstream: the check still only counts, and a merge would conflict', async () => {
  commit(install, 'README.md', 'mine\n', 'local edit')
  commit(upstreamDir, 'README.md', 'theirs\n', 'upstream edit')
  const head = git(install, 'rev-parse', 'HEAD')
  const r = await checkRepo(install)
  assert.equal(r.status, 'available')
  assert.equal(r.count, 4)
  assert.equal(git(install, 'rev-parse', 'HEAD'), head)
  assert.equal(git(install, 'status', '--porcelain'), '', 'nothing merged into the working tree')
  // what the update task's worker would meet: shared history (no unrelated-histories error), and a real conflict
  assert.ok(git(install, 'merge-base', 'HEAD', 'upstream/main'))
  assert.throws(() => git(install, 'merge', '--no-ff', '--no-edit', 'upstream/main'))
  assert.equal(git(install, 'diff', '--name-only', '--diff-filter=U'), 'README.md')
  git(install, 'merge', '--abort')
  assert.equal(git(install, 'rev-parse', 'HEAD'), head)
})

test('the push URL stays disabled: a push to upstream fails', () => {
  assert.equal(git(install, 'remote', 'get-url', '--push', 'upstream'), 'DISABLED')
  assert.throws(() => git(install, 'push', 'upstream', 'main'))
  assert.equal(git(upstreamDir, 'log', '-1', '--format=%s'), 'upstream edit')
})

test('a test copy without CORVID_UPDATE_TEST checks nothing', async () => {
  delete process.env.CORVID_UPDATE_TEST
  const r = await update.runUpdateCheck(true)
  assert.equal(r.status, 'not-install')
  process.env.CORVID_UPDATE_TEST = '1'
})
