// Tests for #140, closing a terminal without freezing the app (src/main/pty.ts). On Windows, node-pty's kill() closes
// the pseudoconsole on the main thread and waits while each process in it handles the close, so a program that ignores
// it held the whole app for 5 s or more. A real PowerShell runs a small node program that ignores SIGHUP (the console
// close), then the terminal is closed or killed while an event loop probe measures how long the main thread stalls.
// Also checked: the program is gone afterwards (no orphan) and a killed terminal stays listed with its exit code.
// Windows only; skipped elsewhere (test-pty-close-posix.mjs is the macOS and Linux twin). Nothing else is started.
//
// It must never hang the suite (#233): a terminal left open keeps this process alive for good, so every test has a
// timeout and after() closes whatever is still open, and a watchdog process ends this file's own process tree (by
// pid: its shells, programs and conhosts) with the last step it reached if the file runs past WATCHDOG_MS.
//
//   npm run test-pty-close

import { register } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      // pty.ts imports ./platform (#149)
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

const win = process.platform === 'win32'
/** How long a shell may take to start a program or exit: PowerShell took over a minute to start under a busy machine. */
const START_MS = 45_000
const TEST_MS = 90_000
const WATCHDOG_MS = 300_000
const tmp = mkdtempSync(join(tmpdir(), 'corvid-pty-close-'))
const stepFile = join(tmpdir(), `corvid-pty-close-step-${process.pid}.txt`)
/** What the file is doing now; the watchdog reports it, so a hang names the step (a test's wait, or pty.ts itself). */
const step = (s) => writeFileSync(stepFile, s)
step('starting')

// Ends this process's tree if the file runs too long, even when the main thread is blocked (a native call that never
// returns). It quits by itself when this process ends, as its stdin pipe closes.
if (win) {
  const dog = spawn(
    process.execPath,
    [
      '-e',
      `const [pid, ms, file] = process.argv.slice(1)
      process.stdin.on('end', () => process.exit()).resume()
      setTimeout(() => {
        let last = '?'
        try { last = require('fs').readFileSync(file, 'utf8') } catch {}
        process.stderr.write('test-pty-close: still running after ' + ms / 1000 + ' s, stuck at: ' + last + '. Ending its process tree (pid ' + pid + ').\\n')
        try { require('fs').rmSync(file, { force: true }) } catch {}
        try { require('child_process').execFileSync('taskkill', ['/PID', pid, '/T', '/F'], { stdio: 'ignore', timeout: 20000 }) } catch {}
        try { process.kill(Number(pid)) } catch {}
        process.exit()
      }, Number(ms))`,
      String(process.pid),
      String(WATCHDOG_MS),
      stepFile
    ],
    { stdio: ['pipe', 'ignore', 'inherit'], windowsHide: true }
  )
  dog.unref()
  dog.stdin.unref()
}

/** Terminals this file opened and the programs it started, for after() to end whatever a failed test left. */
const opened = new Set()
const programs = new Set()
after(async () => {
  step('after(): closing what is left')
  for (const t of pty.listTerminals()) if (opened.has(t.termId)) pty.close(t.termId)
  // only programs never seen ending: Windows reuses pids
  for (const pid of programs) {
    try {
      process.kill(pid)
    } catch {
      /* already gone */
    }
  }
  rmSync(tmp, { recursive: true, force: true })
  rmSync(stepFile, { force: true })
})
const child = join(tmp, 'stubborn.js')
writeFileSync(child, "process.on('SIGHUP', () => {})\nsetInterval(() => {}, 1000)\nconsole.log('ready ' + process.pid)\n")

const pty = await import(src + 'main/pty.ts')
const events = []
pty.initPty((channel, ...args) => events.push([channel, ...args]))

/** Signal 0 only asks Windows whether the process is still running; no tasklist, which can stall for minutes under load. */
const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
/** True once the program has ended; after() then leaves its pid alone. */
const gone = (pid) => {
  if (alive(pid)) return false
  programs.delete(pid)
  return true
}
/** pty.launchShell, remembered for after(). */
const launch = (title) => {
  step(`starting the shell "${title}"`)
  const info = pty.launchShell(tmp, title)
  opened.add(info.termId)
  return info
}
const wait = async (ok, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return true
  return ok()
}

/** A shell running the stubborn program; resolves with its terminal id and the program's pid. */
async function stubborn(title) {
  const info = launch(title)
  await new Promise((r) => setTimeout(r, 1500))
  step(`waiting for the program in "${title}" to start`)
  pty.write(info.termId, `node "${child}"\r`)
  let pid
  assert.ok(await wait(() => (pid = /ready (\d+)/.exec(pty.attach(info.termId))?.[1]), START_MS), `the program started within ${START_MS / 1000} s`)
  programs.add(Number(pid))
  return { termId: info.termId, pid: Number(pid) }
}

/** Longest stall of the event loop while fn's work runs out, in ms. */
async function stall(fn, ms) {
  let worst = 0
  let last = Date.now()
  const probe = setInterval(() => {
    const now = Date.now()
    worst = Math.max(worst, now - last - 20)
    last = now
  }, 20)
  const at = Date.now()
  fn()
  worst = Math.max(worst, Date.now() - at)
  await new Promise((r) => setTimeout(r, ms))
  clearInterval(probe)
  return worst
}

test('closing a terminal whose program ignores the console close does not block, and leaves no process', { skip: !win && 'Windows only: ConPTY (test-pty-close-posix.mjs is the macOS and Linux twin)', timeout: TEST_MS }, async () => {
  const { termId, pid } = await stubborn('close test')
  step('closing "close test" (pty.close)')
  const worst = await stall(() => pty.close(termId), 3000)
  assert.ok(worst < 1000, `main thread stalled ${worst} ms`)
  assert.ok(!pty.listTerminals().some((t) => t.termId === termId), 'the tab is gone at once')
  step('waiting for the program in "close test" to end')
  assert.ok(await wait(() => gone(pid), 5000), 'the program was ended')
})

test('killing a terminal (stopping a worker) does not block, and keeps the tab with its exit code', { skip: !win && 'Windows only: ConPTY (test-pty-close-posix.mjs is the macOS and Linux twin)', timeout: TEST_MS }, async () => {
  const { termId, pid } = await stubborn('kill test')
  step('killing "kill test" (pty.kill)')
  const worst = await stall(() => pty.kill(termId), 3000)
  assert.ok(worst < 1000, `main thread stalled ${worst} ms`)
  step('waiting for the program in "kill test" to end')
  assert.ok(await wait(() => gone(pid), 5000), 'the program was ended')
  assert.ok(await wait(() => pty.listTerminals().find((t) => t.termId === termId)?.exited !== undefined, 5000), 'the tab stays and shows it exited')
  step('closing "kill test" (pty.close)')
  pty.close(termId)
})

test('closing an idle shell and an exited one is quick too', { skip: !win && 'Windows only: ConPTY (test-pty-close-posix.mjs is the macOS and Linux twin)', timeout: TEST_MS }, async () => {
  const idle = launch('idle')
  await new Promise((r) => setTimeout(r, 1500))
  step('closing "idle" (pty.close)')
  assert.ok((await stall(() => pty.close(idle.termId), 1500)) < 1000)
  const done = launch('exits')
  await new Promise((r) => setTimeout(r, 1500))
  step('waiting for "exits" to exit')
  pty.write(done.termId, 'exit\r')
  assert.ok(await wait(() => pty.listTerminals().find((t) => t.termId === done.termId)?.exited !== undefined, START_MS), 'the shell exited')
  step('closing "exits" (pty.close)')
  assert.ok((await stall(() => pty.close(done.termId), 500)) < 1000)
})

test('closing a shell before it printed anything ends it, with no taskkill of pid 0 (#233)', { skip: !win && 'Windows only: ConPTY (test-pty-close-posix.mjs is the macOS and Linux twin)', timeout: TEST_MS }, async () => {
  const warned = []
  const warn = console.warn
  console.warn = (...a) => warned.push(a.join(' '))
  try {
    step('closing "early" at once (pty.close)')
    const early = launch('early')
    assert.ok((await stall(() => pty.close(early.termId), 1500)) < 1000)
    await new Promise((r) => setTimeout(r, 3000))
  } finally {
    console.warn = warn
  }
  assert.deepEqual(warned.filter((w) => /taskkill|still running/.test(w)), [])
})
