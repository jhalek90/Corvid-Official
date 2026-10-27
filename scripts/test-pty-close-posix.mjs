// The macOS and Linux twin of test-pty-close.mjs (#153): closing a terminal must not leave its programs running.
// A real login shell (pty.ts launchShell, the user's $SHELL) starts two small node programs that ignore SIGHUP, the
// hang-up a closed terminal sends: one in the background and one in the foreground, each in its own process group
// as an interactive shell makes them. Then the tab is closed or killed, and both must be gone within a few seconds
// (the platform killTree: SIGTERM to the tree and its groups, SIGKILL after a grace period). Also checked: closing
// doesn't stall the event loop, and a killed terminal stays listed with its exit code. Only processes this test
// started are looked at. POSIX only; skipped on Windows, where test-pty-close.mjs covers it.
//
//   npm run test-pty-close-posix

import { register } from 'node:module'
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

const posix = process.platform !== 'win32'
const tmp = mkdtempSync(join(tmpdir(), 'corvid-pty-close-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const child = join(tmp, 'stubborn.js')
writeFileSync(child, "process.on('SIGHUP', () => {})\nsetInterval(() => {}, 1000)\nconsole.log('ready ' + process.argv[2] + ' ' + process.pid)\n")

const pty = posix ? await import(src + 'main/pty.ts') : undefined
pty?.initPty(() => {})

const alive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
const wait = async (ok, ms) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (ok()) return true
  return ok()
}

/** A login shell running the stubborn program twice, in the background and in the foreground; resolves with the
 *  terminal id and both pids. */
async function stubborn(title) {
  const info = pty.launchShell(tmp, title)
  await new Promise((r) => setTimeout(r, 1500))
  pty.write(info.termId, `"${process.execPath}" "${child}" bg &\r`)
  pty.write(info.termId, `"${process.execPath}" "${child}" fg\r`)
  const pids = {}
  const found = () => {
    for (const m of pty.attach(info.termId).matchAll(/ready (bg|fg) (\d+)/g)) pids[m[1]] = Number(m[2])
    return pids.bg && pids.fg
  }
  assert.ok(await wait(found, 15000), `both programs started; the terminal shows:\n${pty.attach(info.termId)}`)
  return { termId: info.termId, pids: [pids.bg, pids.fg] }
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

test('a project terminal starts (the login shell)', { skip: !posix && 'macOS and Linux only (test-pty-close.mjs is the Windows twin)' }, () => {
  const info = pty.launchShell(tmp, 'which shell')
  assert.ok(pty.listTerminals().some((t) => t.termId === info.termId))
  pty.close(info.termId)
})

test('closing a terminal ends its SIGHUP-ignoring programs shortly after, without blocking', { skip: !posix && 'macOS and Linux only (test-pty-close.mjs is the Windows twin)' }, async () => {
  const { termId, pids } = await stubborn('close test')
  const worst = await stall(() => pty.close(termId), 500)
  assert.ok(worst < 1000, `main thread stalled ${worst} ms`)
  assert.ok(!pty.listTerminals().some((t) => t.termId === termId), 'the tab is gone at once')
  assert.ok(await wait(() => !pids.some(alive), 6000), `still running: ${pids.filter(alive).join(', ')}`)
})

test('killing a terminal (stopping a worker) ends its programs and keeps the tab with its exit code', { skip: !posix && 'macOS and Linux only (test-pty-close.mjs is the Windows twin)' }, async () => {
  const { termId, pids } = await stubborn('kill test')
  const worst = await stall(() => pty.kill(termId), 500)
  assert.ok(worst < 1000, `main thread stalled ${worst} ms`)
  assert.ok(await wait(() => !pids.some(alive), 6000), `still running: ${pids.filter(alive).join(', ')}`)
  assert.ok(await wait(() => pty.listTerminals().find((t) => t.termId === termId)?.exited !== undefined, 5000), 'the tab stays and shows it exited')
  pty.close(termId)
})

test('closing an idle shell and an exited one is quick too', { skip: !posix && 'macOS and Linux only (test-pty-close.mjs is the Windows twin)' }, async () => {
  const idle = pty.launchShell(tmp, 'idle')
  await new Promise((r) => setTimeout(r, 1500))
  assert.ok((await stall(() => pty.close(idle.termId), 500)) < 1000)
  const done = pty.launchShell(tmp, 'exits')
  await new Promise((r) => setTimeout(r, 1500))
  pty.write(done.termId, 'exit\r')
  assert.ok(await wait(() => pty.listTerminals().find((t) => t.termId === done.termId)?.exited !== undefined, 8000), 'the shell exited')
  assert.ok((await stall(() => pty.close(done.termId), 500)) < 1000)
})
