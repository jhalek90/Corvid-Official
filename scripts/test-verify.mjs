// Tests for #101, Verify and Share (src/main/extensionVerify.ts, src/shared/extensionVerify.ts), on a THROWAWAY git
// repository standing in for Corvid's source, where the user's own feature is already merged on main, and a ledger in a
// temporary folder (a stand-in for electron, like test-install.mjs). The verify agent is faked: the test commits what an
// agent would in the throwaway worktree and calls its submit_build_report tool. Covered: the clean base (never the
// feature, never the user's main when it has it), the estimate and the confirmation, the usage block, a passing verify
// recorded with real effort and cleaned up with main untouched, a failing one with reasons and the findings for Edit,
// the hash binding, Share (blocked unverified, the file, Copy as text, the leak check), importing a shared file as a
// claim, one build at a time, and a restart mid-verify. No real agent runs and nothing is pushed, merged or uploaded.
//
//   npm run test-verify

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['DASH_DATA_DIR', 'DASH_TEST_INSTANCE']) delete process.env[k]
const tmp = mkdtempSync(join(tmpdir(), 'corvid-verify-'))
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
const verify = await import(src + 'main/extensionVerify.ts')
const shared = await import(src + 'shared/extensionVerify.ts')
const { validateCorvid } = await import(src + 'shared/extensions.ts')
after(() => rmSync(tmp, { recursive: true, force: true }))

// ---------- a throwaway "Corvid source": a base, then the user's own feature merged on main ----------

const repo = join(tmp, 'corvid')
mkdirSync(join(repo, 'src', 'extensions'), { recursive: true })
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }).trim()
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'Test')
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'corvid', version: '0.1.0', dependencies: {} }, null, 2) + '\n')
writeFileSync(join(repo, 'src', 'extensions', 'windowExtensions.ts'), 'export const WINDOW_EXTENSIONS = []\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'base')
const base = git(repo, 'rev-parse', 'HEAD')
git(repo, 'checkout', '-q', '-b', 'task-1-about-line')
mkdirSync(join(repo, 'src', 'extensions', 'about-line'), { recursive: true })
writeFileSync(join(repo, 'src', 'extensions', 'about-line', 'index.ts'), 'export const line = "the user\'s own feature"\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'the feature')
git(repo, 'checkout', '-q', 'main')
git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge the feature', 'task-1-about-line')
const feature = git(repo, 'rev-parse', 'HEAD')
const mainBefore = feature

// ---------- fakes for the app around the pipeline ----------

let nextTask = 200
const tasks = new Map()
const running = new Set()
const log = []
let usage
let saveTo
let copied
const tokensUsed = { n: 30_000 }
const deps = {
  corvid: () => ({ projectId: 'corvid', folder: repo }),
  estimateFor: () => ({ tokens: { low: 10_000, likely: 20_000, high: 40_000 }, effort: 'small', model: 'test-model', minutes: { low: 5, likely: 10, high: 20 }, share: {}, author: {} }),
  usageWarning: () => usage,
  capMultiple: () => 2,
  createTask: (t) => {
    const id = nextTask++
    tasks.set(id, t)
    return { id }
  },
  removeTask: (id) => tasks.delete(id),
  // what workers.ts does (prepareBranch, #45): reuse the task's existing branch in a new worktree
  startWorker: async (taskId) => {
    const branch = git(repo, 'branch', '--list', `task-${taskId}-*`, '--format=%(refname:short)')
    assert.ok(branch, 'the verify made the task branch before the worker started')
    const tree = join(tmp, 'corvid-worktrees', branch)
    git(repo, 'worktree', 'add', '-q', tree, branch)
    running.add(taskId)
    return { worker: { id: `w${taskId}`, branch, worktree: tree } }
  },
  stopWorker: (id) => {
    for (const t of running) if (id === `w${t}`) running.delete(t)
  },
  workerRunning: (taskId) => running.has(taskId),
  watch: (o) => ({ finish: (outcome) => (log.push({ finish: outcome, key: o.key }), { actual: { tokens: tokensUsed.n, minutes: 7 }, model: 'test-model' }) }),
  notice: (text) => log.push({ notice: text }),
  leaks: () => ({ words: ['secret-project'], hosts: ['intranet.example.org'] }),
  savePath: async () => saveTo,
  copy: (t) => (copied = t)
}
verify.initVerify(deps)

const corvid = (id, { builtOn = feature.slice(0, 12), notes = '', checks = ['The About box shows the line.'] } = {}) => `---
format: 1
id: ${id}
name: Sample ${id.replace(/-/g, ' ')}
version: 1.0.0
author: Sample Author
description: A sample extension for the verify tests.
built_on: 0.1.0 @ ${builtOn}
effort: medium
effort.minutes: 99
capabilities.tier: 1
capabilities.rebuild: yes
---

## Summary

A sample.

## What it does

Adds a line of text to the About box.

## Seed prompt

Add the line "Built with extensions" to the About box, as an extension in its own folder.

## Acceptance checks

${checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}
${notes ? `\n## Notes\n\n${notes}\n` : ''}`
const add = (text, features = [feature]) => {
  const r = ledger.saveCreated(text, undefined, features)
  assert.ok(r.ok, JSON.stringify(r))
  // the scan's own tests are #96's; a skipped scan lets the build go ahead
  ledger.setScan(r.key, { state: 'failed', at: Date.now(), findings: [], skipped: { at: Date.now(), phrase: 'review without scan' } })
  return r.key
}
const rec = (key) => ledger.list().find((r) => r.key === key)
const tool = (taskId) => verify.verifyAccess(taskId, undefined).tools.find((t) => t.name === 'submit_build_report')
const report = (acceptance = [{ check: 1, result: 'pass' }]) => ({ summary: 'Added the line.', files: ['src/extensions/x/index.ts'], tests: [{ name: 'typecheck', result: 'pass' }], acceptance })
const agentCommits = (key, files) => {
  const tree = rec(key).verify.worktree
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(tree, p, '..'), { recursive: true })
    writeFileSync(join(tree, p), text)
  }
  git(tree, 'add', '-A')
  git(tree, 'commit', '-qm', 'verify build')
}
const start = async (key, base = 'built-on') => {
  const p = await verify.prepareVerify(key, base)
  assert.ok(!('error' in p), JSON.stringify(p))
  const r = await verify.confirmVerify(key, p.token)
  assert.ok(r.ok, JSON.stringify(r))
  return r.taskId
}

// ---------- the pure part ----------

test('the pass rule: every check reported and passed, a passing typecheck, the diff matching the declared capabilities', () => {
  const scan = { verdict: 'clear', flags: [], areas: [], tier1Shape: true, files: ['src/extensions/x/index.ts'], at: 0 }
  assert.equal(shared.verifyOutcome(report(), scan, 1, 1).pass, true)
  const two = shared.verifyOutcome(report([{ check: 1, result: 'pass' }]), scan, 2, 1)
  assert.ok(two.reasons.some((r) => /check 2 wasn't reported/.test(r)))
  assert.ok(shared.verifyOutcome({ ...report(), tests: [] }, scan, 1, 1).reasons.some((r) => /typecheck/.test(r)))
  const dep = { ...scan, verdict: 'flag', flags: [{ rule: 'dependency', severity: 'flag', file: 'package.json', text: 'A new package left-pad' }] }
  assert.ok(shared.verifyOutcome(report(), dep, 1, 1).reasons.some((r) => /declared capabilities: A new package/.test(r)))
  const net = { ...scan, verdict: 'flag', flags: [{ rule: 'network-code', severity: 'flag', file: 'a.ts', line: 3, text: 'fetch' }] }
  const n = shared.verifyOutcome(report(), net, 1, 1)
  assert.equal(n.pass, true, 'other flags are notes, not failures')
  assert.deepEqual(n.notes, ['fetch (a.ts:3)'])
  assert.ok(!shared.verifyOutcome(report(), { ...scan, tier1Shape: false }, 1, 1).pass, 'tier 1 must keep its shape')
  assert.equal(shared.effortFromTokens(30_000), 'small')
  assert.equal(shared.effortFromTokens(150_000), 'medium')
})

// ---------- the clean base ----------

test("the clean base never has the user's own feature, and the user's main can't be used when it has it", async () => {
  const k = add(corvid('about-line'))
  const b = await verify.resolveBase(rec(k), repo, 'built-on')
  assert.equal(b.kind, 'before-feature', 'built_on holds the feature: the commit before it')
  assert.equal(b.commit, base)
  const m = await verify.resolveBase(rec(k), repo, 'main')
  assert.match(m.error, /main can't be the clean copy: it contains your own feature/)
  assert.match((await verify.prepareVerify(k, 'main')).error, /can't be the clean copy/)
  const c = await verify.verifyCheck(k)
  assert.equal(c.ok, true, JSON.stringify(c.blockers))
  // an extension built on an older commit that isn't the author's: built_on as is; main fine without the feature
  const k2 = add(corvid('other-line', { builtOn: base.slice(0, 12) }), [])
  assert.equal((await verify.resolveBase(rec(k2), repo, 'built-on')).kind, 'built-on')
  assert.equal((await verify.resolveBase(rec(k2), repo, 'main')).commit, feature)
  // a merge of an install of this extension (#98's trailer) also counts as the feature
  assert.match(await verify.featureIn(repo, feature, { ...rec(k2), id: 'nothing-here', source: { kind: 'imported' } }) ?? 'none', /none/)
  ledger.remove(k2)
  ledger.remove(k)
})

test('the confirmation: the estimate with the 2x cap, and a usage block refuses', async () => {
  const k = add(corvid('cap-line'))
  const p = await verify.prepareVerify(k, 'built-on')
  assert.equal(p.capTokens, 40_000)
  assert.equal(p.base.commit, base)
  usage = { block: true, text: 'over' }
  assert.match((await verify.confirmVerify(k, p.token)).error, /usage limit/)
  usage = undefined
  assert.match((await verify.confirmVerify(k, p.token)).error, /expired/, 'a token is used once')
  ledger.remove(k)
})

// ---------- a passing verify ----------

let good
test('a passing verify: on the clean base without the feature, recorded with the real effort, cleaned up, main untouched', async () => {
  good = add(corvid('about-line'))
  const t = await start(good)
  const v = rec(good).verify
  assert.equal(v.state, 'building')
  assert.equal(git(v.worktree, 'rev-parse', 'HEAD'), base, 'the throwaway worktree is at the clean base')
  assert.ok(!existsSync(join(v.worktree, 'src', 'extensions', 'about-line')), "the user's own feature is not in the clean copy")
  assert.ok(verify.isVerifyTask(t))
  assert.ok(verify.verifyDeny(t, v.worktree, repo).some((r) => r.endsWith('/corvid/**)')), 'the deny rules of an install build')
  assert.match(verify.verifyAccess(t).prompt, /Never merge, push/)
  assert.ok(!verify.verifyAccess(t).allowed.includes('merge_task_branch'))
  // one build at a time
  const other = add(corvid('second-line'))
  assert.ok((await verify.verifyCheck(other)).blockers.some((b) => /one extension build at a time/.test(b)))

  agentCommits(good, { 'src/extensions/about-line/index.ts': 'export const line = "Built with extensions"\n', 'scripts/test-about-line.mjs': '// test\n' })
  const said = await tool(t).run(report())
  assert.match(said, /passed/)
  const r = rec(good)
  assert.equal(r.verify.state, 'passed')
  assert.ok(shared.isVerified(r))
  assert.equal(r.verification.hash, r.hash)
  assert.equal(r.verification.baseCommit, base)
  assert.equal(r.verification.baseKind, 'before-feature')
  assert.equal(r.verification.tokens, 30_000)
  assert.equal(r.verification.minutes, 7)
  assert.equal(r.verification.effort, 'small', "the real effort replaces the author's medium")
  assert.equal(r.verification.files, 2)

  running.delete(t)
  verify.verifyEnded(t, 'done')
  await verify.cleanUp(good)
  const after = rec(good).verify
  assert.equal(after.cleaned, true, after.cleanupNote)
  assert.ok(!existsSync(v.worktree), 'the worktree is removed')
  assert.equal(git(repo, 'branch', '--list', v.branch), '', 'the branch is removed')
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore, 'main untouched')
  assert.ok(!tasks.has(t), 'the task is removed')
  assert.ok(after.report && after.diffScan, 'the build report is kept')
  ledger.remove(other)
})

// ---------- share ----------

test('Share: a valid .corvid file with the verification block; Copy as text; recorded; nothing uploaded', async () => {
  const p = verify.sharePreview(good)
  assert.deepEqual(p.leaks, [])
  const v = validateCorvid(p.text)
  assert.ok(v.ok, JSON.stringify(v.errors))
  assert.equal(v.ext.header.verified.commit, base.slice(0, 12))
  assert.equal(v.ext.header.effort.class, 'small')
  assert.equal(v.ext.header.effort.observed.minutes, 7)
  assert.equal(v.ext.header.effort.observed.model, 'test-model')
  saveTo = join(tmp, 'out', 'about-line.corvid')
  mkdirSync(join(tmp, 'out'), { recursive: true })
  assert.ok((await verify.share(good, 'file', false)).ok)
  assert.equal(readFileSync(saveTo, 'utf8'), p.text)
  saveTo = undefined
  assert.ok((await verify.share(good, 'file', false)).cancelled, 'a cancelled dialog writes nothing')
  assert.ok((await verify.share(good, 'copy', false)).ok)
  assert.equal(copied, p.text)
  assert.deepEqual(rec(good).shares.map((s) => s.where), [join(tmp, 'out', 'about-line.corvid'), 'the clipboard'])
})

test('the final leak check catches a planted local path; the author field is left out', async () => {
  const k = add(corvid('leaky-line', { notes: 'Tested in C:\\Users\\someone\\secret-project\\notes.txt on intranet.example.org.' }))
  ledger.updateVerify(k, (r) => ({ verification: { ...rec(good).verification, hash: r.hash } }))
  const p = verify.sharePreview(k)
  assert.ok(p.leaks.some((l) => /Windows file path/.test(l)), JSON.stringify(p.leaks))
  assert.ok(p.leaks.some((l) => /secret-project/.test(l)))
  assert.ok(p.leaks.some((l) => /intranet\.example\.org/.test(l)))
  assert.match((await verify.share(k, 'copy', false)).error, /leak check/)
  assert.deepEqual(shared.shareLeaks('---\nauthor: secret-project\n---\n', { words: ['secret-project'], hosts: [] }, []), [], 'the author is what the user chose')
  ledger.remove(k)
})

test('the hash binding: an unverified extension can\'t be shared, and an edit resets the verification but keeps the share history', async () => {
  const k = add(corvid('plain-line'))
  assert.match(verify.sharePreview(k).error, /Only a verified extension/)
  assert.match((await verify.share(k, 'copy', true)).error, /Only a verified extension/)
  ledger.remove(k)
  const edited = ledger.saveCreated(corvid('about-line').replace('Adds a line', 'Adds one line'), good)
  assert.ok(edited.ok)
  const r = rec(edited.key)
  assert.equal(shared.isVerified(r), false)
  assert.equal(r.verification, undefined)
  assert.equal(r.shares.length, 2, "the shared files' hashes stay in the history")
  assert.deepEqual(r.source.features, [feature], 'the feature is remembered across revisions')
  // a verification for another hash never counts
  assert.equal(shared.isVerified({ hash: 'b', verification: { hash: 'a' } }), false)
  good = edited.key
})

// ---------- a failing verify ----------

test('a failing verify: the reasons, nothing recorded as verified, cleaned up; the findings go to Edit', async () => {
  const k = add(corvid('two-checks', { checks: ['The About box shows the line.', 'The line survives a restart.'] }))
  const t = await start(k)
  agentCommits(k, { 'src/extensions/two-checks/index.ts': 'export const x = 1\n' })
  const said = await tool(t).run(report([{ check: 1, result: 'pass' }, { check: 2, result: 'fail', how: 'the text never says where to store it' }]))
  assert.match(said, /failed/)
  const r = rec(k)
  assert.equal(r.verify.state, 'failed')
  assert.ok(r.verify.reasons.some((x) => /check 2 failed: the text never says where to store it/.test(x)))
  assert.equal(r.verification, undefined)
  running.delete(t)
  verify.verifyEnded(t, 'done')
  await verify.cleanUp(k)
  assert.equal(rec(k).verify.cleaned, true)
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore)
  ledger.remove(k)
})

test('a verify that ends without a report fails, and one running at a restart fails with the reason', async () => {
  const k = add(corvid('silent-line'))
  const t = await start(k)
  running.delete(t)
  verify.verifyEnded(t, 'exited')
  assert.match(rec(k).verify.reasons[0], /without a build report/)
  await verify.cleanUp(k)
  const k2 = add(corvid('restart-line'))
  const t2 = await start(k2)
  verify.initVerify(deps)
  assert.equal(rec(k2).verify.state, 'failed')
  assert.match(rec(k2).verify.reasons[0], /restarted/)
  running.delete(t2)
  await verify.cleanUp(k2)
  assert.equal(git(repo, 'rev-parse', 'main'), mainBefore)
  ledger.remove(k)
  ledger.remove(k2)
})

// ---------- importing a shared file ----------

test("an imported shared file shows the author's verification as a claim and still needs its own scan", async () => {
  const text = readFileSync(join(tmp, 'out', 'about-line.corvid'), 'utf8')
  ledger.remove(good)
  const out = ledger.importText(text.replace('id: about-line', 'id: about-line-shared'))
  assert.ok(out.ok, JSON.stringify(out))
  const r = rec(out.key)
  assert.match(shared.claimText(r.header), /^The author says it was verified on Corvid commit [0-9a-f]{7} at .*a claim by the author/)
  assert.equal(shared.isVerified(r), false, "someone else's verification block is not Corvid's")
  assert.equal(r.scan, undefined, 'nothing skips the scan')
  assert.ok((await verify.verifyCheck(out.key)).blockers.some((b) => /Scan it first/.test(b)))
})
