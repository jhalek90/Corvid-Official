// Tests for #98, the install pipeline (src/main/extensionInstall.ts), on a THROWAWAY git repository standing in for
// Corvid's source and a ledger in a temporary folder (a stand-in for electron, like test-cost.mjs). The build agent is
// faked: the test commits what an agent would and calls its submit_build_report tool. Covered: the checks before an
// install (requirements in order, a missing one, a conflict, tier 3), the deny rules a build agent gets, a tier-1 and
// a tier-2 build through review to a merge with the trailer and the ledger record, a blocked diff scan that can't be
// merged, a stale review, Send back, Discard, and the failures (no report, the cap's Stop, a restart mid-build).
// No real agent runs and nothing is pushed or deployed.
//
//   npm run test-install

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['DASH_DATA_DIR', 'DASH_TEST_INSTANCE']) delete process.env[k]
const tmp = mkdtempSync(join(tmpdir(), 'corvid-install-'))
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
after(() => rmSync(tmp, { recursive: true, force: true }))

// ---------- a throwaway "Corvid source" ----------

const repo = join(tmp, 'corvid')
mkdirSync(join(repo, 'scripts'), { recursive: true })
mkdirSync(join(repo, 'src', 'extensions'), { recursive: true })
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }).trim()
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'Test')
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'corvid', scripts: { build: 'x' }, dependencies: {} }, null, 2) + '\n')
writeFileSync(join(repo, 'scripts', 'deploy.mjs'), '// deploy\n')
writeFileSync(join(repo, 'src', 'extensions', 'windowExtensions.ts'), 'export const WINDOW_EXTENSIONS: ExtensionModule<WindowSockets>[] = []\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'base')

// ---------- fakes for the app around the pipeline ----------

let nextTask = 100
let lastWatch
const tasks = new Map()
const running = new Set()
const log = []
const deps = {
  corvid: () => ({ projectId: 'corvid', folder: repo }),
  setup: async () => [{ name: 'Git', ok: true }],
  agentsIn: () => [],
  createTask: (t) => {
    const id = nextTask++
    tasks.set(id, t)
    return { id }
  },
  removeTask: (id) => tasks.delete(id),
  // what workers.ts does for a task: a task branch in its own worktree, from main
  startWorker: async (taskId) => {
    const branch = `task-${taskId}-install-extension`
    const tree = join(tmp, 'corvid-worktrees', branch)
    try {
      git(repo, 'worktree', 'add', '-q', '-b', branch, tree, 'main')
    } catch {
      /* resumed: the branch and worktree are there */
    }
    running.add(taskId)
    return { worker: { id: `w${taskId}`, branch, worktree: tree } }
  },
  resumeWorker: async (taskId, message) => {
    log.push({ resumed: taskId, message })
    running.add(taskId)
    return { worker: { id: `w${taskId}b` } }
  },
  stopWorker: (id) => {
    for (const t of running) if (id.startsWith(`w${t}`)) running.delete(t)
  },
  workerRunning: (taskId) => running.has(taskId),
  outputTokens: () => 1000,
  watch: (o) => {
    lastWatch = o
    return { finish: (outcome) => log.push({ finish: outcome, key: o.key }) }
  },
  notice: (text) => log.push({ notice: text }),
  gitChanged: () => {},
  buildCommit: () => 'dev'
}
install.initInstall(deps)

const corvid = (id, { tier = 2, areas = 'ui', requires = '', conflicts = '', version = '1.0.0' } = {}) => `---
format: 1
id: ${id}
name: Sample ${id.replace(/-/g, ' ')}
version: ${version}
description: A sample extension for the install tests.
built_on: 0.1.0 @ 15be862
effort: small
${requires ? `requires: ${requires}\n` : ''}${conflicts ? `conflicts: ${conflicts}\n` : ''}capabilities.tier: ${tier}
${areas ? `capabilities.core_areas: ${areas}\n` : ''}capabilities.rebuild: yes
---

## Summary

A sample.

## What it does

Adds a line of text to the About box.

## Seed prompt

Add the line "Built with extensions" to the About box.

## Acceptance checks

1. The About box shows the line.
`
const add = (text) => {
  const r = ledger.saveCreated(text)
  assert.ok(r.ok, JSON.stringify(r))
  // the scan's own tests are #96's; here a skipped scan lets the build go ahead
  ledger.setScan(r.key, { state: 'failed', at: Date.now(), findings: [], skipped: { at: Date.now(), phrase: 'review without scan' } })
  return r.key
}
const rec = (key) => ledger.list().find((r) => r.key === key)
const EST = { tokens: { low: 1000, likely: 2000, high: 4000 }, effort: 'small', model: 'test', minutes: { likely: 5 } }
const report = (extra = {}) => ({ summary: 'Added the line.', files: ['x'], tests: [{ name: 'typecheck', result: 'pass' }], acceptance: [{ check: 1, result: 'pass' }], ...extra })
const tool = (taskId) => install.buildAccess(taskId, undefined).tools.find((t) => t.name === 'submit_build_report')
/** What a build agent would do: write files in its worktree and commit them. */
const agentCommits = (key, files) => {
  const tree = rec(key).build.worktree
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(tree, p, '..'), { recursive: true })
    writeFileSync(join(tree, p), text)
  }
  git(tree, 'add', '-A')
  git(tree, 'commit', '-qm', 'build')
}

// ---------- tests ----------

test('the checks before an install: ready; requirements in order, missing, conflicts; tier 3 needs the confirmation', async () => {
  const k = add(corvid('about-line', { tier: 1, areas: '' }))
  const p = await install.preflight(k)
  assert.equal(p.ok, true, JSON.stringify(p.blockers))
  assert.equal(p.push, false)

  const base = add(corvid('base-lib', { tier: 1, areas: '' }))
  const mid = add(corvid('mid-lib', { tier: 1, areas: '', requires: 'base-lib ^1.0.0' }))
  const top = add(corvid('top-feature', { requires: 'mid-lib ^1.0.0, gone-lib' }))
  const q = await install.preflight(top)
  assert.equal(q.ok, false)
  assert.deepEqual(q.requires.map((r) => [r.id, r.state]), [['base-lib', 'available'], ['mid-lib', 'available'], ['gone-lib', 'missing']], 'deepest first')
  assert.ok(q.blockers.some((b) => /install mid-lib 1\.0\.0 first/.test(b)))
  assert.ok(q.blockers.some((b) => /"gone-lib".*isn't in your list/.test(b)))

  ledger.updateInstall(base, () => ({ status: 'installed' }))
  const clash = add(corvid('clashing', { tier: 1, areas: '', conflicts: 'base-lib' }))
  assert.ok((await install.preflight(clash)).blockers.some((b) => /can't be installed with/.test(b)))
  // and the other way round: an installed extension that declares the conflict
  const quiet = add(corvid('quiet-one', { tier: 1, areas: '' }))
  assert.equal((await install.preflight(quiet)).blockers.length, 0)
  for (const x of [base, mid, top, clash, quiet]) ledger.updateInstall(x, () => ({ status: 'removed' }))

  const t3 = add(corvid('conn-tweak', { tier: 3, areas: 'connectors' }))
  const a = await install.preflight(t3)
  assert.equal(a.tier3Confirmed, false)
  assert.ok(a.blockers.some((b) => /protected parts/.test(b)))
  assert.ok('error' in install.confirmTier3(t3, []), 'every area must be ticked')
  assert.ok(install.confirmTier3(t3, ['connectors']).ok)
  assert.equal((await install.preflight(t3)).tier3Confirmed, true)
  ledger.updateInstall(t3, () => ({ status: 'removed' }))
})

test('the build agent is denied the protected paths and the main checkout by its settings, not only told', () => {
  const k = add(corvid('deny-check'))
  const r = rec(k)
  // the rules use this machine's absolute paths: //d/w/... for D:\w on Windows, //w/... for /w elsewhere
  const [tree, checkout, at] = process.platform === 'win32' ? ['D:\\w\\tree', 'D:\\w\\corvid', '//d/w'] : ['/w/tree', '/w/corvid', '//w']
  const rules = install.buildDenyRules(r, tree, checkout)
  assert.ok(rules.includes('Edit(./scripts/deploy.mjs)'))
  assert.ok(rules.includes(`Edit(${at}/tree/scripts/deploy.mjs)`))
  assert.ok(rules.includes('Edit(./src/main/connectors/**)'))
  assert.ok(rules.includes('Edit(./.claude/**)'))
  assert.ok(rules.includes(`Edit(${at}/corvid/**)`), 'the user checkout')
  ledger.updateInstall(k, () => ({ status: 'removed' }))
  // a confirmed tier 3 opens only its own areas
  const t3 = add(corvid('conn-open', { tier: 3, areas: 'connectors' }))
  install.confirmTier3(t3, ['connectors'])
  const open = install.buildDenyRules(rec(t3), 'D:\\w\\tree')
  assert.ok(!open.includes('Edit(./src/main/connectors/**)'))
  assert.ok(open.includes('Edit(./src/main/connectors/store.ts)'), 'the secret store inside connectors stays denied: it is the secrets area too')
  assert.ok(open.includes('Edit(./scripts/deploy.mjs)'))
  ledger.updateInstall(t3, () => ({ status: 'removed' }))
})

test('the build instructions mark the text untrusted, include the whole seed prompt and checks, and forbid merging', () => {
  const k = add(corvid('instr'))
  const d = ledger.detail(k)
  const t = install.buildInstructions(d.record, d.sections.seedPrompt, d.sections.checks)
  assert.match(t, /SHARED EXTENSION/)
  assert.match(t, /untrusted/)
  assert.match(t, /Built with extensions/)
  assert.match(t, /1\. The About box shows the line\./)
  assert.match(t, /Do NOT merge, push or deploy/)
  assert.match(t, /never add install scripts/)
  ledger.updateInstall(k, () => ({ status: 'removed' }))
})

test('a tier-1 build: build, report, review, merge with the trailer, ledger updated, nothing pushed', async () => {
  const k = add(corvid('about-tier1', { tier: 1, areas: '' }))
  const s = await install.startBuild(k, EST)
  assert.ok(s.ok, JSON.stringify(s))
  assert.equal(rec(k).status, 'building')
  assert.ok(tasks.has(s.taskId), 'a build task in the Corvid project')
  assert.equal(install.isBuildTask(s.taskId), true)
  const access = install.buildAccess(s.taskId)
  assert.deepEqual(access.allowed, ['submit_build_report'], 'no merge tool')
  agentCommits(k, {
    'src/extensions/about-tier1/window.tsx': "export default { id: 'about-tier1', api: 1, register: () => {} }\n",
    'scripts/test-about-tier1.mjs': "import assert from 'node:assert'\n"
  })
  const said = await tool(s.taskId).run(report())
  assert.match(said, /waiting for the user's review/)
  const r = rec(k)
  assert.equal(r.status, 'needs-review')
  assert.equal(r.build.diffScan.verdict, 'clear', JSON.stringify(r.build.diffScan.flags))
  assert.equal(r.build.diffScan.tier1Shape, true)
  // a stale tip is refused and scanned again
  assert.ok('error' in (await install.merge(k, { tip: 'deadbeef', flagsRead: false })))
  const m = await install.merge(k, { tip: r.build.tip, flagsRead: false })
  assert.ok(m.ok, JSON.stringify(m))
  const body = git(repo, 'log', '-1', '--format=%B', 'main')
  assert.match(body, /Corvid-Extension: about-tier1 1\.0\.0/)
  assert.match(body, new RegExp(`Corvid-Extension-Hash: ${r.hash}`))
  assert.equal(git(repo, 'rev-list', '--parents', '-n', '1', 'main').split(' ').length, 3, 'a merge commit')
  const done = rec(k)
  assert.equal(done.status, 'installed')
  assert.equal(done.build.state, 'merged')
  assert.equal(done.build.mergeCommit, git(repo, 'rev-parse', 'main'))
  assert.equal(done.build.tip, r.build.tip, 'the original tip is kept for re-applying')
  assert.equal(done.build.needsDeploy, true)
  assert.equal(done.build.pushed, false)
  assert.deepEqual(done.build.filesTouched.sort(), ['scripts/test-about-tier1.mjs', 'src/extensions/about-tier1/window.tsx'])
  assert.ok(!tasks.has(s.taskId), 'the build task is closed after the merge')
})

test('a tier-2 build with Send back, then a merge', async () => {
  const k = add(corvid('about-tier2', { tier: 2, areas: 'ui' }))
  const s = await install.startBuild(k, EST)
  agentCommits(k, { 'src/renderer/src/About.tsx': 'export const line = "Built with extensions"\n' })
  await tool(s.taskId).run(report())
  assert.equal(rec(k).status, 'needs-review')
  const sb = await install.sendBack(k, 'Put the line under the version number.')
  assert.ok(sb.ok)
  assert.equal(rec(k).status, 'building')
  assert.match(log.findLast((x) => x.resumed === s.taskId).message, /Put the line under the version number/)
  agentCommits(k, { 'src/renderer/src/About.tsx': 'export const line = "Built with extensions" // under the version\n' })
  await tool(s.taskId).run(report())
  const r = rec(k)
  assert.equal(r.build.sendBacks.length, 1)
  const m = await install.merge(k, { tip: r.build.tip, flagsRead: false })
  assert.ok(m.ok, JSON.stringify(m))
})

test('a build that edits a protected path is blocked and can never be merged; Discard puts it back', async () => {
  const k = add(corvid('sneaky', { tier: 2, areas: 'ui' }))
  const s = await install.startBuild(k, EST)
  agentCommits(k, { 'scripts/deploy.mjs': '// deploy, changed\n' })
  await tool(s.taskId).run(report())
  const r = rec(k)
  assert.equal(r.build.diffScan.verdict, 'block')
  assert.ok(r.build.diffScan.flags.some((f) => f.rule === 'protected-path' && f.file === 'scripts/deploy.mjs'))
  const m = await install.merge(k, { tip: r.build.tip, flagsRead: true })
  assert.match(m.error, /blocked/)
  assert.equal(git(repo, 'show', 'main:scripts/deploy.mjs'), '// deploy')
  const d = install.discard(k)
  assert.ok(d.ok)
  assert.equal(rec(k).status, 'not-installed')
  assert.match(d.message, /is kept/)
})

test('a flagged build needs "I\'ve read the flags"', async () => {
  const k = add(corvid('flagged', { tier: 2, areas: 'ui' }))
  const s = await install.startBuild(k, EST)
  agentCommits(k, { 'src/renderer/src/Fetcher.ts': "export const go = () => fetch('https://undeclared.example.net/x')\n" })
  await tool(s.taskId).run(report())
  const r = rec(k)
  assert.equal(r.build.diffScan.verdict, 'flag')
  assert.match((await install.merge(k, { tip: r.build.tip, flagsRead: false })).error, /read the flags/)
  install.discard(k)
})

test('failures: tests fail, the agent ends without a report, the cap is hit and Stop, Corvid restarts mid-build', async () => {
  const before = git(repo, 'rev-parse', 'main')
  const a = add(corvid('fails-tests'))
  const sa = await install.startBuild(a, EST)
  agentCommits(a, { 'src/renderer/src/A.tsx': 'export {}\n' })
  await tool(sa.taskId).run(report({ acceptance: [{ check: 1, result: 'fail' }] }))
  assert.equal(rec(a).status, 'failed')
  assert.ok(rec(a).build.branch, 'the branch is kept')

  const b = add(corvid('ends-early'))
  const sb = await install.startBuild(b, EST)
  install.workerEnded(sb.taskId, 'Exited with code 1')
  assert.equal(rec(b).status, 'failed')
  assert.match(rec(b).build.error, /without a build report/)

  const c = add(corvid('cap-hit'))
  const sc = await install.startBuild(c, EST)
  // the cap's Stop: what watchBuild calls when the user chooses Stop, then the worker ends
  lastWatch.stop()
  assert.ok(!running.has(sc.taskId), 'the agent was stopped')
  install.workerEnded(sc.taskId, 'Stopped at the budget cap')
  assert.equal(rec(c).status, 'failed')
  assert.match(rec(c).build.error, /budget cap/)
  assert.equal(log.findLast((x) => x.key === c && x.finish).finish, 'cancelled')

  const d = add(corvid('restarted'))
  const sd = await install.startBuild(d, EST)
  assert.equal(rec(d).status, 'building')
  // a new Corvid: nothing is running, so a "building" record can't be followed any more
  const fresh = await import(src + 'main/extensionInstall.ts?restart')
  fresh.initInstall(deps)
  assert.equal(rec(d).status, 'failed')
  assert.match(rec(d).build.error, /restarted during the build/)
  assert.equal(git(repo, 'rev-parse', 'main'), before, 'main is never touched by a failed build')
  void sd
})

test('one build at a time', async () => {
  const k = add(corvid('first-one'))
  await install.startBuild(k, EST)
  const k2 = add(corvid('second-one'))
  const p = await install.preflight(k2)
  assert.ok(p.blockers.some((b) => /one extension at a time/.test(b)))
  install.discard(k)
})
