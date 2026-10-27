// Tests for #99, the lifecycle of an installed extension (src/main/extensionLifecycle.ts), on a THROWAWAY git repository
// standing in for Corvid's source and a ledger in a temporary folder (a stand-in for electron, like test-install.mjs).
// Installed extensions are set up the way #98 leaves them: a branch merged with --no-ff and a ledger record with the
// merge commit, the tip, the files touched and the report's flag. Covered: an instant disable and enable by the flag,
// disable by revert through review and merge, enable by re-applying the same commits, a conflicting re-apply that
// offers Re-install, Remove (no dependents, with one, a conflicting later merge, data left behind, with and without
// deleting the text), Re-apply after Remove, Rebuild (and a discarded rebuild keeping the old build), Update (text diff,
// replaced on merge), the history, the ledger check after a reset outside Corvid, and uncommitted changes on main.
// No agent runs and nothing is pushed or deployed.
//
//   npm run test-lifecycle

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['DASH_DATA_DIR', 'DASH_TEST_INSTANCE']) delete process.env[k]
const tmp = mkdtempSync(join(tmpdir(), 'corvid-lifecycle-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: (k) => k === "appData" ? globalThis.__userData + "/appdata" : globalThis.__userData, isPackaged: false, commandLine: { hasSwitch: () => false } }; export const BrowserWindow = class {}; export const powerMonitor = { on() {} }')
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: fake, shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
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
const ledger = await import(src + 'main/extensions.ts')
const install = await import(src + 'main/extensionInstall.ts')
const life = await import(src + 'main/extensionLifecycle.ts')
const shared = await import(src + 'shared/extensionLifecycle.ts')
after(() => rmSync(tmp, { recursive: true, force: true }))

// ---------- a throwaway "Corvid source" ----------

const repo = join(tmp, 'corvid')
mkdirSync(join(repo, 'src', 'extensions'), { recursive: true })
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }).trim()
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'Test')
git(repo, 'config', 'core.autocrlf', 'false')
writeFileSync(join(repo, 'src', 'core.ts'), 'export const a = 1\n\nexport const b = 2\n\nexport const c = 3\n')
writeFileSync(join(repo, 'src', 'extensions', 'index.ts'), '// registered extensions\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'base')
const show = (path) => git(repo, 'show', `main:${path}`)

let disabled = []
let agents = []
life.initLifecycle({
  corvid: () => ({ projectId: 'corvid', folder: repo }),
  agentsIn: () => agents,
  disabledIds: () => disabled,
  setDisabledIds: (ids) => (disabled = ids),
  dataDir: () => globalThis.__userData,
  gitChanged: () => {}
})
install.initInstall({
  corvid: () => ({ projectId: 'corvid', folder: repo }),
  setup: async () => [],
  agentsIn: () => [],
  createTask: () => ({ id: 1 }),
  removeTask: () => {},
  startWorker: async () => ({ error: 'no agents in this test' }),
  resumeWorker: async () => ({ error: 'no' }),
  stopWorker: () => {},
  workerRunning: () => false,
  outputTokens: () => 0,
  watch: () => ({ finish: () => {} }),
  notice: () => {},
  gitChanged: () => {},
  buildCommit: () => 'dev'
})

const corvid = (id, { version = '1.0.0', requires = '', prompt = 'Add the line.' } = {}) => `---
format: 1
id: ${id}
name: Sample ${id}
version: ${version}
description: A sample extension for the lifecycle tests.
built_on: 0.1.0 @ 15be862
effort: small
${requires ? `requires: ${requires}\n` : ''}capabilities.tier: 2
capabilities.core_areas: ui
capabilities.rebuild: yes
---

## Summary

A sample.

## What it does

Changes a line.

## Seed prompt

${prompt}

## Acceptance checks

1. The line is there.
`
const rec = (key) => ledger.list().find((r) => r.key === key)
const byId = (id) => ledger.list().find((r) => r.id === id).key
/** What #98 leaves behind: a build branch merged into main with --no-ff, and the record's build. */
function installed(text, files, flag) {
  const r = ledger.saveCreated(text)
  assert.ok(r.ok, JSON.stringify(r))
  const id = rec(r.key).id
  const branch = `task-${id}-install`
  const baseCommit = git(repo, 'rev-parse', 'main')
  git(repo, 'checkout', '-q', '-b', branch)
  for (const [p, t] of Object.entries(files)) {
    mkdirSync(join(repo, p, '..'), { recursive: true })
    writeFileSync(join(repo, p), t)
  }
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', `build ${id}`)
  const tip = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}: extension ${id}`, branch)
  git(repo, 'branch', '-q', '-d', branch)
  const mergeCommit = git(repo, 'rev-parse', 'main')
  ledger.updateInstall(r.key, () => ({
    status: 'installed',
    build: {
      state: 'merged',
      repo,
      base: 'main',
      baseCommit,
      tip,
      mergeCommit,
      filesTouched: Object.keys(files),
      mergedAt: Date.now(),
      needsDeploy: false,
      pushed: false,
      report: { at: 0, summary: '', files: [], tests: [], acceptance: [], ...(flag ? { flag } : {}) }
    }
  }))
  return r.key
}
const commitOnMain = (path, text, msg) => {
  writeFileSync(join(repo, path), text)
  git(repo, 'commit', '-qam', msg)
}
const approve = async (key) => {
  const p = rec(key).lifecycle?.pending
  assert.ok(p, 'a change waits for review')
  const r = await life.approve(key, p.tip)
  assert.ok(r.ok, JSON.stringify(r))
  return r
}

// ---------- tests ----------

test('a flagged extension: Disable is instant when the code reads the flag, and Enable turns it back on', async () => {
  const k = installed(corvid('pins'), { 'src/extensions/pins/window.ts': "export default { id: 'pins', api: 1 }\n" }, 'pins')
  const i = await life.info(k)
  assert.deepEqual(i.flag, { name: 'pins', readInCode: true })
  assert.equal(i.disableMode, 'instant')
  const before = git(repo, 'rev-parse', 'main')
  const d = await life.disable(k)
  assert.ok(d.ok, JSON.stringify(d))
  assert.deepEqual(disabled, ['pins'])
  assert.equal(rec(k).status, 'disabled')
  assert.equal(git(repo, 'rev-parse', 'main'), before, 'no git change, no rebuild')
  const e = await life.enable(k)
  assert.ok(e.ok)
  assert.deepEqual(disabled, [])
  assert.equal(rec(k).status, 'installed')
  assert.deepEqual(
    rec(k).lifecycle.history.map((h) => h.what),
    ['Disabled (flag pins off)', 'Enabled (flag pins on)']
  )
  // a flag named in the report that nothing reads: Disable needs a rebuild
  const k2 = installed(corvid('ghost-flag'), { 'src/other.ts': 'export const o = 1\n' }, 'ghost-flag-flag')
  assert.equal((await life.info(k2)).disableMode, 'rebuild')
})

test('an unflagged core change: disable by revert, review, merge; enable re-applies the same commits; no agent', async () => {
  const k = installed(corvid('core-a'), { 'src/core.ts': 'export const a = 100\n\nexport const b = 2\n\nexport const c = 3\n' })
  assert.equal((await life.info(k)).disableMode, 'rebuild')
  const d = await life.disable(k)
  assert.ok(d.ok, JSON.stringify(d))
  assert.match(d.pending.branch, /^ext-disable-core-a-/)
  assert.deepEqual(d.pending.files, ['src/core.ts'])
  assert.match(show('src/core.ts'), /a = 100/, 'main is untouched until the user approves')
  assert.equal(shared.lifecycleState(rec(k)), 'pending-review')
  assert.match((await life.pendingDiff(k)).text, /-export const a = 100/)
  assert.ok('error' in (await life.disable(k)), 'one change at a time')
  const m = await approve(k)
  assert.match(m.message, /not pushed/)
  assert.match(show('src/core.ts'), /a = 1\n/)
  assert.equal(rec(k).status, 'disabled')
  assert.equal(rec(k).lifecycle.disabledBy, 'revert')
  assert.match(git(repo, 'log', '-1', '--format=%B', 'main'), /Corvid-Extension-disable: core-a 1\.0\.0/)
  assert.equal(git(repo, 'branch', '--list', 'ext-disable-*'), '', 'the merged branch is cleaned up')
  const e = await life.enable(k)
  assert.ok(e.ok, JSON.stringify(e))
  await approve(k)
  assert.match(show('src/core.ts'), /a = 100/)
  assert.equal(rec(k).status, 'installed')
  assert.equal(rec(k).build.needsDeploy, true, 'installed, needs deploy')
  assert.equal(shared.lifecycleState(rec(k)), 'installed-needs-deploy')
  // and once more: disable after the enable reverts the enable's merge
  assert.ok((await life.disable(k)).ok)
  await approve(k)
  assert.match(show('src/core.ts'), /a = 1\n/)
  const h = rec(k).lifecycle.history
  assert.ok(h.every((x) => x.at && x.who), 'timestamps and who')
  assert.ok(h.some((x) => x.what === 'Disabled (merged)' && x.commits.length === 2))
})

test('a re-apply that conflicts because Corvid changed since offers Re-install, and changes nothing', async () => {
  const k = byId('core-a')
  commitOnMain('src/core.ts', 'export const a = 7\n\nexport const b = 2\n\nexport const c = 3\n', 'later change to a')
  const before = git(repo, 'rev-parse', 'main')
  const e = await life.enable(k)
  assert.ok('error' in e)
  assert.deepEqual(e.conflict, ['src/core.ts'])
  assert.equal(e.offerReinstall, true)
  assert.match(e.error, /Rebuild from the text/)
  assert.equal(git(repo, 'rev-parse', 'main'), before)
  assert.equal(git(repo, 'branch', '--list', 'ext-enable-*'), '', 'the conflicted branch is gone')
  assert.ok(!rec(k).lifecycle.pending)
  // removing a disabled-by-revert extension only changes the record
  const r = await life.remove(k, false)
  assert.ok(r.ok)
  assert.equal(rec(k).status, 'not-installed')
})

test('remove: a dependent (refused, stacked order), data left, with and without deleting the text, a conflicting later merge', async () => {
  const base = installed(corvid('base-x'), { 'src/base-x.ts': 'export const x = 1\n' })
  const dep = installed(corvid('dep-y', { requires: 'base-x ^1.0.0' }), { 'src/dep-y.ts': 'export const y = 1\n' })
  writeFileSync(join(globalThis.__userData, 'base-x-data.json'), '{}')
  const i = await life.info(base)
  assert.deepEqual(i.dependents.map((d) => d.key), [dep])
  assert.deepEqual(i.removalOrder.map((d) => d.key), [dep, base], 'dependents first')
  assert.deepEqual(i.dataLeft, [join(globalThis.__userData, 'base-x-data.json')])
  const refused = await life.remove(base, false)
  assert.match(refused.error, /Remove what needs it first: "Sample dep-y"/)
  // the dependent first (no dependents of its own), keeping its text
  assert.ok((await life.remove(dep, false)).ok)
  await approve(dep)
  assert.equal(rec(dep).status, 'not-installed')
  assert.ok(ledger.textOf(dep), 'the text is kept')
  assert.equal(git(repo, 'ls-tree', '--name-only', 'main', 'src/dep-y.ts'), '')
  // then the base, deleting its text: Removed, kept as history
  assert.equal((await life.info(base)).dependents.length, 0)
  assert.ok((await life.remove(base, true)).ok)
  await approve(base)
  assert.equal(rec(base).status, 'removed')
  assert.equal(ledger.textOf(base), null)
  assert.ok(existsSync(join(globalThis.__userData, 'base-x-data.json')), 'data is never deleted automatically')
  // a later merge that conflicts with the revert: warned with the files, nothing changed
  const z = installed(corvid('zed'), { 'src/core.ts': 'export const a = 7\n\nexport const b = 2\n\nexport const c = 300\n' })
  commitOnMain('src/core.ts', 'export const a = 7\n\nexport const b = 2\n\nexport const c = 301\n', 'later change to c')
  const c = await life.remove(z, false)
  assert.deepEqual(c.conflict, ['src/core.ts'])
  assert.equal(c.offerReinstall, false)
  assert.match(c.error, /An agent can take it out by hand/)
  assert.equal(c.resolvable, true)
  assert.equal(rec(z).status, 'installed')
  // #117: the branch and worktree are kept, the revert left conflicted, until an agent resolves it or the user leaves it
  assert.equal(rec(z).lifecycle.conflict.state, 'held')
  assert.ok(existsSync(rec(z).lifecycle.conflict.worktree))
})

test('re-install: re-apply the stored build after Remove (free), and Rebuild from the text through the install pipeline', async () => {
  const dep = byId('dep-y')
  const ra = await life.reapply(dep)
  assert.ok(ra.ok, JSON.stringify(ra))
  await approve(dep)
  assert.equal(show('src/dep-y.ts'), 'export const y = 1')
  assert.equal(rec(dep).status, 'installed')
  // rebuild: Install is refused while installed, until Rebuild is asked for; the old build is kept meanwhile
  assert.ok((await install.preflight(dep)).blockers.some((b) => /can't be installed now/.test(b)))
  const before = rec(dep).build
  assert.ok(life.requestRebuild(dep).ok)
  assert.equal(shared.rebuilding(rec(dep)), true)
  const p = await install.preflight(dep)
  assert.ok(!p.blockers.some((b) => /can't be installed now/.test(b)), JSON.stringify(p.blockers))
  // the new build fails (here: no agents) and is discarded: the old merged build comes back
  ledger.updateInstall(dep, () => ({ status: 'failed', build: { state: 'failed', repo, error: 'no agent' } }))
  assert.ok(install.discard(dep).ok)
  life.afterDiscard(dep)
  assert.equal(rec(dep).status, 'installed')
  assert.equal(rec(dep).build.mergeCommit, before.mergeCommit)
  assert.equal(shared.rebuilding(rec(dep)), false)
})

test('update: a newer version shows Update available with a text diff; merging it replaces the old one', async () => {
  const old = installed(corvid('upd', { prompt: 'Add the line.' }), { 'src/upd.ts': 'export const u = 1\n' })
  const nw = ledger.saveCreated(corvid('upd', { version: '1.1.0', prompt: 'Add the line, in bold.' }))
  assert.ok(nw.ok, JSON.stringify(nw))
  assert.equal(shared.updateFor(rec(old), ledger.list()).key, nw.key)
  assert.equal((await life.info(old)).update.version, '1.1.0')
  const diff = shared
    .textDiff(ledger.textOf(old), ledger.textOf(nw.key))
    .filter((l) => l.kind !== ' ')
    .map((l) => l.kind + l.line)
  assert.deepEqual(diff, ['-version: 1.0.0', '+version: 1.1.0', '-Add the line.', '+Add the line, in bold.'])
  // the new version is merged by #98's pipeline: the old record is marked replaced
  ledger.updateInstall(nw.key, () => ({ status: 'installed', build: { state: 'merged', repo, mergeCommit: git(repo, 'rev-parse', 'main') } }))
  life.afterMerge(nw.key)
  assert.equal(rec(old).status, 'removed')
  assert.match(rec(old).lifecycle.history.at(-1).what, /Replaced by 1\.1\.0/)
  assert.equal(rec(old).build.mergeCommit.length, 40, 'the old build record is kept')
  ledger.updateInstall(nw.key, () => ({ status: 'removed' }))
})

test('the ledger check: a merge commit gone from main is marked changed outside Corvid, never dropped; re-apply fixes it', async () => {
  const k = installed(corvid('vanish'), { 'src/vanish.ts': 'export const v = 1\n' })
  const merge = rec(k).build.mergeCommit
  git(repo, 'reset', '-q', '--hard', `${merge}^1`) // the user's own reset outside Corvid (in the throwaway repo)
  await life.verifyLedger()
  assert.equal(rec(k).lifecycle.changedOutside, true)
  assert.equal(shared.lifecycleState(rec(k)), 'changed-outside')
  assert.equal(rec(k).status, 'installed', 'the record is kept')
  assert.ok((await life.reapply(k)).ok)
  await approve(k)
  await life.verifyLedger()
  assert.equal(shared.lifecycleState(rec(k)), 'installed-needs-deploy')
  // a record pointing at a repository that isn't there never throws
  ledger.updateInstall(k, (x) => ({ build: { ...x.build, repo: join(tmp, 'nowhere') } }))
  await life.verifyLedger()
  ledger.updateInstall(k, (x) => ({ build: { ...x.build, repo } }))
})

test('uncommitted changes on main or agents mid-task: refused without an explicit confirmation', async () => {
  const k = byId('vanish')
  writeFileSync(join(repo, 'src', 'core.ts'), readFileSync(join(repo, 'src', 'core.ts'), 'utf8') + '// wip\n')
  const r = await life.disable(k)
  assert.equal(r.needsConfirm, true)
  assert.match(r.error, /uncommitted changes/)
  assert.ok(!rec(k).lifecycle.pending)
  const ok = await life.disable(k, true)
  assert.ok(ok.ok, 'confirmed: the branch is prepared')
  const m = await life.approve(k, rec(k).lifecycle.pending.tip)
  assert.match(m.error, /uncommitted changes/, 'the merge itself still refuses')
  git(repo, 'checkout', '--', 'src/core.ts')
  assert.ok((await life.discardPending(k)).ok)
  agents = ['Some Agent']
  const a = await life.disable(k)
  assert.match(a.error, /Some Agent/)
  agents = []
})
