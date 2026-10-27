// Tests for #117, "Resolve with an agent" for a Remove or Disable whose revert conflicts (src/main/extensionResolve.ts),
// on a THROWAWAY git repository standing in for Corvid's source and a ledger in a temporary folder (a stand-in for
// electron, like test-lifecycle.mjs). The Dracula case: an extension adds an entry to a data file, a later commit edits
// the same region (the theme socket), then Remove. No agent runs: the worker is a stand-in that gets the real branch
// setup (#45), and "the agent" is this script editing, staging and committing in the held worktree. Covered: the held
// conflict, the estimate and the one-time Confirm, the build task, Corvid's own checks (good and bad results), review,
// Approve and merge with the text kept or deleted, Disable, Retry, a protected path, a restart, Leave it and Discard.
// Nothing is pushed or deployed.
//
//   npm run test-resolve

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

for (const k of ['DASH_DATA_DIR', 'DASH_TEST_INSTANCE']) delete process.env[k]
const tmp = mkdtempSync(join(tmpdir(), 'corvid-resolve-'))
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
const life = await import(src + 'main/extensionLifecycle.ts')
const resolve = await import(src + 'main/extensionResolve.ts')
const agentGit = await import(src + 'main/agentGit.ts')
after(() => rmSync(tmp, { recursive: true, force: true }))

// ---------- a throwaway "Corvid source", with a typecheck that fails when src/bad.ts exists ----------

const repo = join(tmp, 'corvid')
mkdirSync(join(repo, 'src', 'shared'), { recursive: true })
mkdirSync(join(repo, 'node_modules'), { recursive: true })
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'core.autocrlf=false', ...a], { encoding: 'utf8' }).trim()
git(repo, 'init', '-q', '-b', 'main')
git(repo, 'config', 'user.email', 'test@example.com')
git(repo, 'config', 'user.name', 'Test')
git(repo, 'config', 'core.autocrlf', 'false')
const THEMES = (extra = '', socket = '') => `export const themes = [\n  { id: 'dark' },\n  { id: 'light' },${extra}\n]\n${socket}`
writeFileSync(join(repo, 'src', 'shared', 'themes.ts'), THEMES())
writeFileSync(join(repo, '.gitignore'), 'node_modules\n')
writeFileSync(join(repo, 'tsconfig.json'), '{}\n')
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'corvid', version: '0.1.0', scripts: { typecheck: 'node -e "process.exit(require(\'fs\').existsSync(\'src/bad.ts\') ? 1 : 0)"' } }, null, 2) + '\n')
git(repo, 'add', '-A')
git(repo, 'commit', '-qm', 'base')

const tasks = new Map()
let nextTask = 200
const started = []
const stopped = []
let startError = null
const notices = []
const initDeps = () =>
  resolve.initResolve({
    createTask: (t) => {
      const id = nextTask++
      tasks.set(id, { id, ...t })
      return { id }
    },
    removeTask: (id) => tasks.delete(id),
    taskExists: (id) => tasks.has(id),
    corvidProjectId: () => 'corvid',
    // the real branch setup a worker gets (#45): it must find and reuse the held branch and worktree
    startWorker: async (taskId, instructions) => {
      if (startError) return { error: startError }
      const plan = await agentGit.prepareBranch(repo, taskId, tasks.get(taskId).title)
      started.push({ taskId, instructions, plan })
      return plan.kind === 'branch' ? { worker: { id: `w${taskId}`, branch: plan.b.branch, worktree: plan.b.worktree } } : { error: plan.reason }
    },
    resumeWorker: async () => ({ error: 'no session' }),
    stopWorker: (id, why) => stopped.push({ id, why }),
    workerRunning: () => false,
    estimate: (tier, chars) => ({ label: 'test', model: 'opus', tokens: { low: 10_000, likely: 20_000, high: 40_000 }, minutes: { low: 2, likely: 5, high: 10 }, share: { fiveHour: { low: 0, likely: 1, high: 2 }, week: { low: 0, likely: 0, high: 1 } }, confidence: 'low', samples: 0, basis: `${tier}/${chars}`, effort: 'small', author: {} }),
    prompt: (e) => ({ estimate: e, capMultiple: 2, capTokens: e.tokens.likely * 2, usage: overLimit ? { block: blockOver, text: 'over the limit' } : undefined }),
    watch: () => ({ finish: () => {} }),
    notice: (t) => notices.push(t),
    gitChanged: () => {},
    dataDir: () => globalThis.__userData
  })
let overLimit = false
let blockOver = false
life.initLifecycle({
  corvid: () => ({ projectId: 'corvid', folder: repo }),
  agentsIn: () => [],
  disabledIds: () => [],
  setDisabledIds: () => {},
  dataDir: () => globalThis.__userData,
  gitChanged: () => {}
})
initDeps()

const corvid = (id) => `---
format: 1
id: ${id}
name: Theme ${id}
version: 1.0.0
description: A theme that adds an entry to the theme list.
built_on: 0.1.0 @ 15be862
effort: small
capabilities.tier: 2
capabilities.core_areas: ui
capabilities.rebuild: yes
---

## Summary

A theme.

## What it does

Adds a theme.

## Seed prompt

Add the theme.

## Acceptance checks

1. The theme is listed.
`
const rec = (key) => ledger.list().find((r) => r.key === key)
const LIGHT = /  \{ id: 'light'(?:, socket: \d+)? \},/
/** What #98 leaves behind: an entry added to the data file and a file of its own, merged with --no-ff. */
function installed(id) {
  const r = ledger.saveCreated(corvid(id))
  assert.ok(r.ok, JSON.stringify(r))
  const branch = `task-9${id.length}-install-${id}`
  const baseCommit = git(repo, 'rev-parse', 'main')
  git(repo, 'checkout', '-q', '-b', branch)
  const cur = readFileSync(join(repo, 'src', 'shared', 'themes.ts'), 'utf8')
  writeFileSync(join(repo, 'src', 'shared', 'themes.ts'), cur.replace(LIGHT, (m) => `${m}\n  { id: '${id}' },`))
  writeFileSync(join(repo, 'src', 'shared', `${id}.ts`), `export const ${id.replace(/-/g, '')} = '#282a36'\n`)
  git(repo, 'add', '-A')
  git(repo, 'commit', '-qm', `build ${id}`)
  const tip = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'checkout', '-q', 'main')
  git(repo, 'merge', '-q', '--no-ff', '-m', `Merge ${branch}: extension ${id}`, branch)
  git(repo, 'branch', '-q', '-d', branch)
  const mergeCommit = git(repo, 'rev-parse', 'main')
  ledger.updateInstall(r.key, () => ({
    status: 'installed',
    build: { state: 'merged', repo, base: 'main', baseCommit, tip, mergeCommit, filesTouched: ['src/shared/themes.ts', `src/shared/${id}.ts`], mergedAt: Date.now(), needsDeploy: false, pushed: false, report: { at: 0, summary: '', files: [], tests: [], acceptance: [] } }
  }))
  return r.key
}
/** A later change to Corvid that edits the same region (the theme socket, #114). */
let socketN = 0
const laterEdit = () => {
  const p = join(repo, 'src', 'shared', 'themes.ts')
  const cur = readFileSync(p, 'utf8')
  writeFileSync(p, cur.replace(LIGHT, `  { id: 'light', socket: ${++socketN} },`))
  git(repo, 'commit', '-qam', `theme socket ${socketN}`)
}
/** What a good agent does: take the extension's line out, keep the newer one, stage, commit with the trailers. */
function agentResolves(key, { extra, subject } = {}) {
  const r = rec(key)
  const h = r.lifecycle.conflict
  const p = join(h.worktree, 'src', 'shared', 'themes.ts')
  const text = readFileSync(p, 'utf8')
  // keep "ours" (main's newer side) without the extension's entry
  const fixed = text.replace(/<<<<<<< [^\n]*\n([\s\S]*?)=======\n[\s\S]*?>>>>>>> [^\n]*\n/g, (_, ours) => ours.replace(new RegExp(`\\s*\\{ id: '${r.id}' \\},`), ''))
  writeFileSync(p, fixed)
  if (extra) for (const [f, t] of Object.entries(extra)) {
    mkdirSync(join(h.worktree, f, '..'), { recursive: true })
    writeFileSync(join(h.worktree, f), t)
  }
  git(h.worktree, 'add', '-A')
  const s = { disable: 'Disable', remove: 'Remove' }[h.op]
  git(h.worktree, 'commit', '-q', '-m', subject ?? `${s} extension ${r.id} ${r.version}`, '-m', `Corvid-Extension-${s}: ${r.id} ${r.version}\nCorvid-Extension-Hash: ${r.hash}`)
}
const confirm = async (key, prot = false) => {
  const p = await resolve.prepareResolve(key)
  assert.ok(p.token, JSON.stringify(p))
  return resolve.confirmResolve(key, p.token, prot)
}

// ---------- tests ----------

test('Remove conflicts with a later edit: held, explained, estimated; nothing starts without the Confirm', async () => {
  const k = installed('dracula')
  laterEdit()
  const before = git(repo, 'rev-parse', 'main')
  const c = await life.remove(k, false)
  assert.deepEqual(c.conflict, ['src/shared/themes.ts'])
  assert.equal(c.resolvable, true)
  assert.match(c.error, /Corvid changed this file after the extension was installed/)
  const h = rec(k).lifecycle.conflict
  assert.equal(h.state, 'held')
  assert.equal(h.op, 'remove')
  assert.deepEqual(h.extFiles.sort(), ['src/shared/dracula.ts', 'src/shared/themes.ts'])
  assert.ok(existsSync(h.worktree))
  assert.match(git(h.worktree, 'diff', '--name-only', '--diff-filter=U'), /themes\.ts/, 'the revert is left conflicted')
  assert.equal(git(repo, 'rev-parse', 'main'), before, 'main untouched')
  // the estimate and a token; declining (no confirm, or a bad or reused token) starts nothing
  const p = await resolve.prepareResolve(k)
  assert.equal(p.estimate.tokens.likely, 20_000)
  assert.equal(p.capTokens, 40_000)
  assert.ok((await resolve.confirmResolve(k, 'made-up', false)).error)
  assert.equal(started.length, 0)
  assert.equal(tasks.size, 0)
  // over the limit with Settings blocking: refused; a second Remove is refused while it waits
  overLimit = blockOver = true
  assert.match((await resolve.confirmResolve(k, p.token, false)).error, /usage limit/)
  overLimit = blockOver = false
  assert.ok((await resolve.confirmResolve(k, p.token, false)).error, 'a token is used once')
  assert.match((await life.remove(k, false)).error, /conflicted remove is waiting/)
})

test('the agent resolves it on the held branch; Corvid checks it; review, Approve and merge; Not installed yet, text kept', async () => {
  const k = ledger.list().find((r) => r.id === 'dracula').key
  const s = await confirm(k)
  assert.ok(s.ok, JSON.stringify(s))
  const t = tasks.get(s.taskId)
  assert.equal(t.title, 'Remove extension Theme dracula 1.0.0: resolve the revert conflict')
  assert.equal(t.projectId, 'corvid')
  assert.equal(t.project, repo)
  assert.match(t.notes, /conflicted in src\/shared\/themes\.ts/)
  const h = rec(k).lifecycle.conflict
  assert.equal(h.state, 'resolving')
  assert.match(h.branch, new RegExp(`^task-${s.taskId}-`), 'the held branch was handed to the task')
  assert.equal(started.at(-1).plan.b.reused, true, "the worker reused the held worktree")
  assert.ok(resolve.isResolveTask(s.taskId))
  assert.match(started.at(-1).instructions, /EVERYTHING the extension added is removed/)
  assert.match(started.at(-1).instructions, /Corvid-Extension-Remove: dracula 1\.0\.0/)
  const deny = resolve.resolveDeny(s.taskId, h.worktree)
  assert.ok(deny.some((d) => d.includes('.claude/')), deny.join(' '))
  assert.ok(deny.filter((d) => d.endsWith('/**)')).length >= 3, 'the main checkout and the data folder are denied')
  // the agent's tool runs Corvid's checks
  agentResolves(k)
  const access = resolve.resolveAccess(s.taskId)
  assert.deepEqual(access.allowed, ['submit_resolution_report'])
  const said = await access.tools[0].run({ report: 'Took out the dracula entry and file, kept the socket.' })
  assert.match(said, /passed/)
  const p = rec(k).lifecycle.pending
  assert.ok(p && !rec(k).lifecycle.conflict)
  assert.equal(p.resolved.taskId, s.taskId)
  assert.equal(p.check.ok, true, 'the typecheck ran in the branch')
  assert.deepEqual(p.files.sort(), ['src/shared/dracula.ts', 'src/shared/themes.ts'])
  assert.match((await life.pendingDiff(k)).text, /-  \{ id: 'dracula' \},/)
  assert.equal(rec(k).status, 'installed', 'the ledger changes only after the merge')
  const a = await life.approve(k, p.tip)
  assert.ok(a.ok, JSON.stringify(a))
  resolve.afterApproved(p.resolved.taskId)
  assert.equal(rec(k).status, 'not-installed')
  assert.ok(ledger.textOf(k), 'the text is kept')
  const themes = git(repo, 'show', 'main:src/shared/themes.ts')
  assert.ok(!themes.includes('dracula') && themes.includes('socket: 1'), themes)
  assert.equal(git(repo, 'ls-tree', '--name-only', 'main', 'src/shared/dracula.ts'), '')
  assert.ok(!tasks.has(s.taskId), 'the task is finished')
  const h2 = rec(k).lifecycle.history.map((x) => x.what)
  assert.ok(h2.includes('remove conflicted') && h2.includes('Resolve with an agent: remove') && h2.includes('Remove resolved by an agent, ready for review') && h2.includes('Removed (can be installed again)'), h2.join(' | '))
})

test('Remove and delete the extension, and Disable, the same way', async () => {
  const k = installed('nord')
  laterEdit()
  const rm = await life.remove(k, true)
  assert.ok(rm.resolvable, JSON.stringify(rm))
  const s = await confirm(k)
  agentResolves(k)
  assert.match(await resolve.finishResolve(s.taskId, 'done'), /passed/)
  assert.ok((await life.approve(k, rec(k).lifecycle.pending.tip)).ok)
  assert.equal(rec(k).status, 'removed')
  assert.equal(ledger.textOf(k), null)

  const d = installed('solar')
  laterEdit()
  assert.ok((await life.disable(d)).resolvable)
  const s2 = await confirm(d)
  assert.match(tasks.get(s2.taskId).title, /^Disable extension Theme solar/)
  agentResolves(d)
  assert.match(await resolve.finishResolve(s2.taskId, 'done'), /passed/)
  assert.ok((await life.approve(d, rec(d).lifecycle.pending.tip)).ok)
  assert.equal(rec(d).status, 'disabled')
  assert.equal(rec(d).lifecycle.disabledBy, 'revert')
})

test("bad results are caught by Corvid's checks: extra files, a failing typecheck, missing trailers; Retry starts from the conflict", async () => {
  const k = installed('mocha')
  laterEdit()
  await life.remove(k, false)
  let s = await confirm(k)
  agentResolves(k, { extra: { 'src/other.ts': 'export const o = 1\n' } })
  assert.match(await resolve.finishResolve(s.taskId, 'all good, trust me'), /failed/)
  let h = rec(k).lifecycle.conflict
  assert.equal(h.state, 'failed')
  assert.match(h.reasons.join(' '), /neither the extension's nor conflicted: src\/other\.ts/)
  assert.ok(existsSync(h.worktree), 'the branch is kept')
  assert.ok(!rec(k).lifecycle.pending)
  // Retry: back to the conflicted revert, a fresh task on the same worktree
  s = await confirm(k)
  assert.ok(s.ok, JSON.stringify(s))
  assert.match(git(rec(k).lifecycle.conflict.worktree, 'diff', '--name-only', '--diff-filter=U'), /themes\.ts/)
  agentResolves(k, { extra: { 'src/bad.ts': 'oops\n' } })
  await resolve.finishResolve(s.taskId, 'x')
  h = rec(k).lifecycle.conflict
  assert.match(h.reasons.join(' '), /typecheck failed/)
  // a protected path the extension never touched
  const tiers = await import(src + 'shared/extensionTiers.ts')
  const prot = tiers.PROTECTED_PATHS[0].endsWith('/') ? `${tiers.PROTECTED_PATHS[0]}x.ts` : tiers.PROTECTED_PATHS[0]
  s = await confirm(k)
  agentResolves(k, { extra: { [prot]: 'export {}\n' } })
  await resolve.finishResolve(s.taskId, 'x')
  assert.match(rec(k).lifecycle.conflict.reasons.join(' '), /protected paths the extension never touched/)
  s = await confirm(k)
  agentResolves(k, { subject: 'resolved stuff' })
  await resolve.finishResolve(s.taskId, 'x')
  assert.match(rec(k).lifecycle.conflict.reasons.join(' '), /subject is "resolved stuff"/)
  // the agent ends without a report, or doesn't start
  s = await confirm(k)
  resolve.workerEnded(s.taskId, 'exited')
  assert.match(rec(k).lifecycle.conflict.reasons[0], /without a report/)
  startError = 'Usage is over the limit and the user said no.'
  const no = await confirm(k)
  assert.match(no.error, /over the limit/)
  startError = null
  assert.equal(rec(k).lifecycle.conflict.state, 'failed')
})

test('a protected conflicted file needs the extra tick; a restart mid-resolution shows Resolution interrupted; Discard cleans up', async () => {
  const k = ledger.list().find((r) => r.id === 'mocha').key
  // pretend the conflict is in a protected path
  ledger.updateLifecycle(k, (x) => ({ lifecycle: { ...x.lifecycle, conflict: { ...x.lifecycle.conflict, protectedFiles: ['src/shared/themes.ts'] } } }))
  const p = await resolve.prepareResolve(k)
  assert.match((await resolve.confirmResolve(k, p.token, false)).error, /protected/)
  ledger.updateLifecycle(k, (x) => ({ lifecycle: { ...x.lifecycle, conflict: { ...x.lifecycle.conflict, protectedFiles: [] } } }))
  const s = await confirm(k)
  assert.equal(rec(k).lifecycle.conflict.state, 'resolving')
  // Corvid restarts: the module's memory is gone, the ledger says resolving
  const fresh = await import(src + 'main/extensionResolve.ts?restart')
  fresh.initResolve({ createTask: () => ({ id: 0 }), removeTask: (id) => tasks.delete(id), taskExists: (id) => tasks.has(id), corvidProjectId: () => 'corvid', startWorker: async () => ({}), resumeWorker: async () => ({}), stopWorker: () => {}, workerRunning: () => false, estimate: () => null, prompt: () => ({}), watch: () => ({ finish() {} }), notice: () => {}, gitChanged: () => {}, dataDir: () => '' })
  const h = rec(k).lifecycle.conflict
  assert.equal(h.state, 'interrupted')
  assert.match(h.reasons[0], /Corvid restarted/)
  const left = await fresh.leaveConflict(k)
  assert.ok(left.ok, JSON.stringify(left))
  assert.ok(!rec(k).lifecycle.conflict)
  assert.ok(!existsSync(h.worktree), 'the worktree is gone')
  assert.equal(git(repo, 'branch', '--list', h.branch), '', 'the branch is gone')
  assert.ok(!tasks.has(s.taskId))
  assert.equal(rec(k).status, 'installed', 'nothing changed')
})

test('Leave it as it is on a fresh conflict; Enable and Re-apply conflicts still point to Re-install', async () => {
  const k = installed('gruv')
  laterEdit()
  await life.remove(k, false)
  const h = rec(k).lifecycle.conflict
  assert.ok((await resolve.leaveConflict(k)).ok)
  assert.ok(!existsSync(h.worktree))
  assert.equal(git(repo, 'branch', '--list', 'ext-remove-*'), '')
  const r = await life.reapply(k)
  assert.equal(r.offerReinstall, true)
  assert.ok(!r.resolvable)
  assert.ok(!rec(k).lifecycle.conflict)
})
