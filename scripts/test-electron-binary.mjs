// Tests for #175: Electron 44's binary is opt-in, so setup, the postinstall and Corvid's "Install dependencies" run
// Electron's own installer when node_modules/electron has no dist/<executable> or path.txt, and never when it has.
// Fake node_modules folders in a temp folder; the installer is stubbed, so nothing is downloaded.
//
//   npm run test-electron-binary

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { ELECTRON_INSTALLER, electronBinaryPresent, electronNeedsDownload, nativeDeps } from '../src/main/platform/shared.mjs'
import { ensureElectronBinary } from './electron-binary.mjs'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-electron-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

let n = 0
/** A source folder with node_modules/electron as npm ci leaves it, plus whichever binary parts are asked for. */
function fakeRoot({ pkg = true, dist = false, pathTxt = false } = {}) {
  const root = join(tmp, String(n++))
  const el = join(root, 'node_modules', 'electron')
  mkdirSync(el, { recursive: true })
  if (pkg) writeFileSync(join(el, 'install.js'), '')
  if (dist) {
    const exe = join(root, 'node_modules', nativeDeps().electron)
    mkdirSync(join(exe, '..'), { recursive: true })
    writeFileSync(exe, '')
  }
  if (pathTxt) writeFileSync(join(el, 'path.txt'), nativeDeps().electron.replace('electron/dist/', ''))
  return root
}
const nm = (root) => join(root, 'node_modules')

function stub(result = { ok: true }) {
  const calls = []
  return { calls, run: (installer, opts) => (calls.push({ installer, opts }), result) }
}

test('the binary counts as present only with dist/<executable> and path.txt', () => {
  assert.equal(electronBinaryPresent(nm(fakeRoot({ dist: true, pathTxt: true }))), true)
  assert.equal(electronBinaryPresent(nm(fakeRoot())), false, 'a fresh npm ci: no dist/, no path.txt')
  assert.equal(electronBinaryPresent(nm(fakeRoot({ dist: true }))), false, 'no path.txt: electron-vite fails with "Electron uninstall"')
  assert.equal(electronBinaryPresent(nm(fakeRoot({ pathTxt: true }))), false, 'path.txt but no executable')
})

test('the installer runs only when the package is there and its binary is not', () => {
  assert.equal(electronNeedsDownload(nm(fakeRoot())), true)
  assert.equal(electronNeedsDownload(nm(fakeRoot({ dist: true }))), true)
  assert.equal(electronNeedsDownload(nm(fakeRoot({ dist: true, pathTxt: true }))), false)
  assert.equal(electronNeedsDownload(nm(fakeRoot({ pkg: false }))), false, 'npm ci --omit=dev: no electron package, nothing to download')
  // per platform, with the paths each one checks
  const seen = []
  const exists = (p) => (seen.push(p.replace(/\\/g, '/')), true)
  assert.equal(electronNeedsDownload('/n', 'darwin', exists), false)
  assert.deepEqual(seen, ['/n/electron/install.js', '/n/electron/dist/Electron.app/Contents/MacOS/Electron', '/n/electron/path.txt'])
  seen.length = 0
  assert.equal(electronNeedsDownload('C:\\n', 'win32', (p) => (seen.push(p), !p.endsWith('path.txt'))), true)
  assert.deepEqual(seen, ['C:\\n\\electron\\install.js', 'C:\\n\\electron\\dist\\electron.exe', 'C:\\n\\electron\\path.txt'])
  assert.equal(ELECTRON_INSTALLER, 'electron/install.js')
})

test('nothing is downloaded, and nothing printed, when the binary is present (an existing Windows checkout)', () => {
  const s = stub()
  const logs = []
  for (const postinstall of [true, false]) {
    assert.deepEqual(ensureElectronBinary(fakeRoot({ dist: true, pathTxt: true }), { postinstall, run: s.run, log: (m) => logs.push(m) }), { ran: false })
  }
  assert.equal(s.calls.length, 0)
  assert.equal(logs.length, 0)
})

test("a fresh install runs Electron's own installer from node_modules, with its output shown", () => {
  const root = fakeRoot()
  const s = stub()
  const r = ensureElectronBinary(root, { run: s.run, log: () => {} })
  assert.deepEqual(r, { ran: true, ok: true })
  assert.deepEqual(s.calls, [{ installer: join(root, 'node_modules', 'electron', 'install.js'), opts: { quiet: false } }])
})

test('as postinstall, a failed download is a one-line note and not a failed npm ci; setup sees the failure', () => {
  const logs = []
  const fail = stub({ ok: false, error: 'RequestError: getaddrinfo ENOTFOUND github.com' })
  const r = ensureElectronBinary(fakeRoot(), { postinstall: true, run: fail.run, log: (m) => logs.push(m) })
  assert.equal(r.ok, false)
  assert.deepEqual(fail.calls[0].opts, { quiet: true }, "the installer's stack trace is kept off the npm ci output")
  assert.equal(logs.length, 2)
  assert.match(logs[1], /ENOTFOUND github\.com.*node node_modules\/electron\/install\.js/)
  // setup (not postinstall) prints no note of its own: it stops with its own message after the check
  const quiet = []
  assert.equal(ensureElectronBinary(fakeRoot(), { run: fail.run, log: (m) => quiet.push(m) }).ok, false)
  assert.equal(quiet.length, 1)
})

test('ELECTRON_SKIP_BINARY_DOWNLOAD skips the postinstall only; setup still downloads', () => {
  const env = { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' }
  const s = stub()
  assert.deepEqual(ensureElectronBinary(fakeRoot(), { postinstall: true, env, run: s.run, log: () => {} }), { ran: false, skipped: true })
  assert.equal(s.calls.length, 0)
  assert.equal(ensureElectronBinary(fakeRoot(), { env, run: s.run, log: () => {} }).ran, true)
})
