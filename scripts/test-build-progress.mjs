// Tests for #108, live build progress (src/shared/buildProgress.ts, src/main/buildProgress.ts and Stop build in
// src/main/extensionInstall.ts), on a THROWAWAY git repository standing in for Corvid's source and a ledger in a
// temporary folder, like test-install.mjs. Fake builds driven by this script walk every stage: queued, building, the
// agent's milestones, running tests, a failing test, the cap dialog, a question and a permission prompt (needs you),
// Stop build (the branch is kept), an agent that never reports (progress from its activity), reports from the wrong
// agent (ignored), a restart mid-build (interrupted), an agent that ends without a report, review, merge, deploy and
// done, and two builds side by side. No real agent runs and nothing is pushed or deployed.
//
//   npm run test-build-progress

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['DASH_DATA_DIR', 'DASH_TEST_INSTANCE']) delete process.env[k]
const tmp = mkdtempSync(join(tmpdir(), 'corvid-progress-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: (k) => k === "appData" ? globalThis.__userData + "/appdata" : globalThis.__userData, isPackaged: false, commandLine: { hasSwitch: () => false } }; export const BrowserWindow = class {}; export const powerMonitor = { on() {} }; export const safeStorage = { isEncryptionAvailable: () => false, encryptString: (s) => Buffer.from(s), decryptString: (b) => String(b) }')
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
const progress = await import(src + 'main/buildProgress.ts')
const shared = await import(src + 'shared/buildProgress.ts')
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
writeFileSync(join(repo, 'src', 'extensions', 'windowExtensions.ts'), 'export const WINDOW_EXTENSIONS = []\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'base')

// ---------- fakes for the app around the pipeline (as in test-install.mjs) ----------

let nextTask = 200
const tasks = new Map()
const running = new Set()
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
  startWorker: async (taskId) => {
    const branch = `task-${taskId}-build-extension`
    const tree = join(tmp, 'corvid-worktrees', branch)
    try {
      git(repo, 'worktree', 'add', '-q', '-b', branch, tree, 'main')
    } catch {
      /* resumed */
    }
    running.add(taskId)
    return { worker: { id: `w${taskId}`, branch, worktree: tree } }
  },
  resumeWorker: async (taskId) => (running.add(taskId), { worker: { id: `w${taskId}b` } }),
  // the real stopWorker ends the process, and workers.ts then calls workerEnded
  stopWorker: (id) => {
    for (const t of [...running])
      if (id.startsWith(`w${t}`)) {
        running.delete(t)
        install.workerEnded(t, 'stopped')
      }
  },
  workerRunning: (taskId) => running.has(taskId),
  outputTokens: () => 1000,
  watch: () => ({ finish: () => {} }),
  notice: () => {},
  gitChanged: () => {},
  buildCommit: () => 'dev'
}
install.initInstall(deps)

const corvid = (id) => `---
format: 1
id: ${id}
name: Tiny ${id.replace(/-/g, ' ')}
version: 1.0.0
description: A tiny harmless extension for the progress tests.
built_on: 0.1.0 @ 15be862
effort: small
capabilities.tier: 1
capabilities.rebuild: yes
---

## Summary

A sample.

## What it does

Adds a line of text to the About box.

## Seed prompt

Add the line "Built with extensions" to the About box.

## Acceptance checks

1. The About box shows the line.
2. The line is gated behind the extension's flag.
`
const add = (text) => {
  const r = ledger.saveCreated(text)
  assert.ok(r.ok, JSON.stringify(r))
  ledger.setScan(r.key, { state: 'failed', at: Date.now(), findings: [], skipped: { at: Date.now(), phrase: 'review without scan' } })
  ledger.setCost(r.key, (c) => ({ ...c, estimate: { low: 1000, likely: 2000, high: 4000, unit: 'output tokens', at: Date.now(), minutes: 10, confirmedAt: Date.now() } }))
  return r.key
}
const rec = (key) => ledger.list().find((r) => r.key === key)
const EST = { tokens: { low: 1000, likely: 2000, high: 4000 }, effort: 'small', model: 'test', minutes: { likely: 10 } }
const CHECKS = ['The About box shows the line.', "The line is gated behind the extension's flag."]
const view = (key, live = {}, now = Date.now()) => shared.buildProgress(rec(key), { state: 'running', status: 'busy', ...live }, now, 2, CHECKS)
const submit = (taskId, extra = {}) =>
  install
    .buildAccess(taskId)
    .tools.find((t) => t.name === 'submit_build_report')
    .run({ summary: 'Added the line.', files: ['x'], tests: [{ name: 'typecheck', result: 'pass' }], acceptance: [{ check: 1, result: 'pass' }, { check: 2, result: 'pass' }], ...extra })
const commit = (key, files) => {
  const tree = rec(key).build.worktree
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(join(tree, p, '..'), { recursive: true })
    writeFileSync(join(tree, p), text)
  }
  git(tree, 'add', '-A')
  git(tree, 'commit', '-qm', 'build')
}
const start = async (key) => {
  const s = await install.startBuild(key, EST)
  assert.ok(s.ok, JSON.stringify(s))
  return s.taskId
}
const stageOf = (p, id) => p.stages.find((s) => s.id === id)

// ---------- tests ----------

test('the build task names the extension, and the record links the task, worker, branch and start time', async () => {
  const k = add(corvid('about-line'))
  const t = await start(k)
  assert.equal(tasks.get(t).title, 'Build extension: Tiny about line 1.0.0')
  const b = rec(k).build
  assert.equal(b.taskId, t)
  assert.equal(b.workerId, `w${t}`)
  assert.ok(b.branch && b.worktree && b.startedAt)
  const p = view(k)
  assert.equal(p.current, 'building')
  assert.equal(p.agent, 'working')
  assert.deepEqual(p.stages.slice(0, 4).map((s) => s.state), ['done', 'done', 'done', 'current'])
  assert.match(p.timeText, /in, estimated 5 to 20 minutes \(an estimate\)/)
  assert.deepEqual(p.tokens, { used: undefined, likely: 2000, cap: 4000 })
  assert.ok(!('percent' in p), 'no percentage')
  install.discard(k)
})

test('a fake build walks through the stages with its own milestones, then review, merge, deploy and done', async () => {
  const k = add(corvid('walker'))
  const t = await start(k)
  const w = rec(k).build.workerId
  const t0 = Date.now()
  // the tool is wired for build agents only
  assert.equal(progress.progressAccess(9999, 'nobody'), null)
  const tool = progress.progressAccess(t, w).tools[0]
  assert.equal(tool.name, 'report_progress')
  assert.match(await tool.run({ stage: 'planning', note: 'Plan: one new file and its registration line' }), /display only/)
  // too soon after the last one: rate limited, and counted
  assert.match(progress.takeReport(t, w, { stage: 'part', note: 'again' }, t0 + 1000), /Too soon/)
  assert.equal(rec(k).build.progress.dropped, 1)
  progress.takeReport(t, w, { stage: 'part', note: 'Writing src/extensions/walker/index.ts', files_touched: 2 }, t0 + 20_000)
  assert.equal(view(k, {}, t0 + 21_000).lines[0].source, 'agent')
  assert.equal(view(k).current, 'building')
  progress.takeReport(t, w, { stage: 'tests', note: 'npm run typecheck' }, t0 + 40_000)
  progress.takeReport(t, w, { stage: 'checks', checks_passed: 1, checks_total: 2, checks: [{ check: 1, result: 'pass' }] }, t0 + 60_000)
  let p = view(k, {}, t0 + 61_000)
  assert.equal(p.current, 'testing')
  assert.deepEqual(p.checks.map((c) => c.state), ['pass', 'pending'])
  assert.match(p.checksSummary, /1 of 2 passing so far \(the agent's count\)/)
  assert.ok(stageOf(p, 'building').ms > 0, 'a finished stage shows its time')
  // a report changes nothing about the build's state
  assert.equal(rec(k).status, 'building')
  progress.takeReport(t, w, { stage: 'finished', note: 'Done' }, t0 + 62_000)
  commit(k, { 'src/extensions/walker/index.ts': 'export default {}\n' })
  await submit(t)
  p = view(k, { status: 'idle' })
  assert.equal(p.current, 'review')
  assert.match(p.needsYou, /review/)
  assert.match(p.checksSummary, /2 of 2 passed/)
  const m = await install.merge(k, { tip: rec(k).build.tip, flagsRead: true })
  assert.ok(m.ok, JSON.stringify(m))
  p = view(k, { state: undefined })
  assert.equal(p.current, 'deploy')
  ledger.updateInstall(k, (x) => ({ build: { ...x.build, needsDeploy: false } }))
  p = view(k, { state: undefined })
  assert.equal(p.current, 'done')
  assert.equal(p.end, undefined)
  // the history is kept: the agent's milestones are still on the record after the merge
  assert.ok(rec(k).build.progress.reports.length >= 4)
})

test('needs you: the cap dialog, a question to the user and a permission prompt each show prominently', async () => {
  const k = add(corvid('needy'))
  await start(k)
  let p = view(k, { capAsking: true })
  assert.equal(p.end, 'needs-input')
  assert.match(p.needsYou, /budget cap/)
  p = view(k, { question: 'Should the line be bold?' })
  assert.match(p.needsYou, /asked you: "Should the line be bold\?"/)
  p = view(k, { status: 'blocked' })
  assert.match(p.needsYou, /permission prompt/)
  assert.equal(p.agent, 'needs-you')
  assert.equal(view(k, { status: 'waiting' }).agent, 'needs-you')
  assert.equal(view(k, { status: 'idle' }).needsYou, undefined)
  install.discard(k)
})

test('reports from the wrong agent are ignored; notes are scrubbed of secrets and capped', async () => {
  const k = add(corvid('guarded'))
  const t = await start(k)
  const w = rec(k).build.workerId
  assert.match(progress.takeReport(t, 'w-somebody-else', { stage: 'finished' }), /not your build/)
  assert.match(progress.takeReport(t + 50, w, { stage: 'finished' }), /no build of yours/)
  assert.equal(rec(k).build.progress, undefined)
  const key = 'sk-ant-' + 'a'.repeat(30)
  progress.takeReport(t, w, { stage: 'planning', note: `using ${key} ` + 'x'.repeat(500) })
  const note = rec(k).build.progress.reports[0].note
  assert.ok(!note.includes(key), 'secret masked')
  assert.match(note, /\[removed\]/)
  assert.ok(note.length <= shared.REPORT_LIMITS.noteChars)
  assert.ok('error' in shared.cleanReport({ stage: 'merge' }, [], 0), 'only the milestone stages')
  install.discard(k)
})

test('an agent that never reports: progress comes from its activity and worktree, labelled as such', async () => {
  const k = add(corvid('quiet'))
  await start(k)
  const now = Date.now() + 1000
  const events = [
    { ts: now - 500, kind: 'tool', tool: 'Write', label: 'Write src/extensions/quiet/index.ts' },
    { ts: now - 100, kind: 'tool', tool: 'Bash', label: 'Bash npm run typecheck' }
  ]
  const p = view(k, { events }, now)
  assert.equal(p.current, 'testing', 'a test run in the feed moves it to Running tests')
  assert.ok(p.lines.some((l) => l.source === 'inferred' && /typecheck/.test(l.text)))
  // files from the worktree: a committed new file, and an uncommitted edit of a protected path
  commit(k, { 'src/extensions/quiet/index.ts': 'export default {}\n' })
  writeFileSync(join(rec(k).build.worktree, 'scripts', 'deploy.mjs'), '// changed\n')
  const f = await progress.touchedFiles(k)
  const own = f.files.find((x) => x.path === 'src/extensions/quiet/index.ts')
  const dep = f.files.find((x) => x.path === 'scripts/deploy.mjs')
  assert.equal(own.committed, true)
  assert.equal(own.protected, false)
  assert.equal(dep.committed, false)
  assert.equal(dep.protected, true)
  assert.equal(dep.allowed, false, 'not a confirmed tier-3 build')
  const d = await progress.diffSoFar(k)
  assert.match(d.text, /deploy\.mjs/)
  install.discard(k)
})

test('a failing test: the build ends Failed at the result scan with the failing check shown', async () => {
  const k = add(corvid('failing'))
  const t = await start(k)
  commit(k, { 'src/extensions/failing/index.ts': 'export default {}\n' })
  await submit(t, { acceptance: [{ check: 1, result: 'pass' }, { check: 2, result: 'fail' }] })
  const p = view(k, { state: 'exited' })
  assert.equal(p.end, 'failed')
  assert.equal(p.current, 'result-scan')
  assert.deepEqual(p.checks.map((c) => c.state), ['pass', 'fail'])
  install.discard(k)
})

test('Stop build ends the agent and keeps the branch; it shows Stopped', async () => {
  const k = add(corvid('stopper'))
  const t = await start(k)
  const branch = rec(k).build.branch
  const s = install.stopBuild(k)
  assert.ok(s.ok, JSON.stringify(s))
  assert.equal(running.has(t), false)
  assert.equal(rec(k).status, 'failed')
  assert.match(rec(k).build.error, /^Stopped by you/)
  assert.equal(view(k, { state: 'stopped' }).end, 'stopped')
  assert.ok(git(repo, 'branch', '--list', branch).includes(branch), 'the branch is kept')
  assert.ok('error' in install.stopBuild(k), 'nothing left to stop')
  install.discard(k)
})

test('an agent that ends without a report, and a restart mid-build, each say so plainly', async () => {
  const k = add(corvid('ender'))
  const t = await start(k)
  running.delete(t)
  install.workerEnded(t, 'exited')
  assert.equal(view(k, { state: 'exited' }).end, 'no-report')
  install.discard(k)

  const r = add(corvid('restarted'))
  const t2 = await start(r)
  progress.takeReport(t2, rec(r).build.workerId, { stage: 'planning', note: 'Planned' })
  // Corvid restarts: a fresh copy of the pipeline has nothing running, and settles the ledger at start-up
  const fresh = await import(src + 'main/extensionInstall.ts?restart')
  fresh.initInstall({ ...deps, corvid: () => undefined })
  const p = view(r, { state: undefined })
  assert.equal(p.end, 'interrupted')
  assert.match(rec(r).build.error, /Corvid restarted during the build/)
  assert.ok(rec(r).build.branch, 'what was known is kept: the branch')
  assert.equal(rec(r).build.progress.reports.length, 1, 'and the milestones')
  assert.equal(rec(r).status, 'failed', "so #98's retry, discard and open-the-branch apply")
})

test('two builds side by side each get their own progress', async () => {
  const a = add(corvid('first'))
  const b = add(corvid('second'))
  await start(a)
  // the pipeline builds one at a time (#98); the second is put in the building state directly for the display
  ledger.updateInstall(b, () => ({ status: 'building', build: { state: 'building', taskId: 777, startedAt: Date.now() - 60_000 } }))
  const pa = view(a)
  const pb = shared.buildProgress(rec(b), {}, Date.now(), 2, CHECKS)
  assert.equal(pa.current, 'building')
  assert.equal(pb.current, 'queued', 'no worker yet: queued behind the worker limit or the usage prompt')
  assert.notEqual(pa.lines[0].text, pb.lines[0].text)
  install.discard(a)
})

test('the progress panel has no way to approve or merge, and the tool changes no status', () => {
  const ui = readFileSync(join(root, 'src/renderer/src/components/BuildProgress.tsx'), 'utf8')
  assert.ok(!/extensionMerge|extensionSendBack|confirmInstall|Approve/.test(ui))
  const main = readFileSync(join(root, 'src/main/buildProgress.ts'), 'utf8')
  assert.ok(!/mergeBranch|merge\(|status:/.test(main))
})
