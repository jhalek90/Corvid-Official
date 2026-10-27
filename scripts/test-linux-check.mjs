// Tests for #164: the Linux check script (scripts/linux-check.mjs). The report, the argument parsing and the
// per-check error handling are pure and run anywhere; the last test runs the whole script with --json, which on
// Windows and macOS runs the Linux-shaped checks with made-up paths and skips the POSIX/Linux-only ones, and on
// Linux runs all of them. It works in its own temp folder and must leave nothing behind.
//
//   npm run test-linux-check

import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as L from './linux-check.mjs'

test('arguments', () => {
  assert.deepEqual(L.parseArgs([]), { json: false, help: false })
  assert.deepEqual(L.parseArgs(['--json']), { json: true, help: false })
  assert.equal(L.parseArgs(['-h']).help, true)
  assert.equal(L.parseArgs(['--help', '--json']).json, true)
  assert.match(L.parseArgs(['--verbose']).error, /unknown option --verbose/)
})

test('Node versions that can load the TypeScript platform layer', () => {
  for (const v of ['22.7.0', '22.18.0', '23.0.0', '24.5.0', '26.1.0']) assert.equal(L.nodeOk(v), true, v)
  for (const v of ['18.19.1', '20.11.0', '22.6.0']) assert.equal(L.nodeOk(v), false, v)
})

test('redact: one line, the home folder as ~, length capped', () => {
  assert.equal(L.redact('failed at /home/alice/x\nstack…', '/home/alice'), 'failed at ~/x')
  assert.equal(L.redact('\n\n  second line  ', '/home/a'), 'second line')
  assert.equal(L.redact(undefined, '/home/a'), '')
  assert.equal(L.redact('/', '/'), '/', 'a home of / is not replaced')
  const long = L.redact('x'.repeat(500), '/home/a', 50)
  assert.equal(long.length, 50)
  assert.ok(long.endsWith('…'))
})

test('a failing check is reported and the others still run', async () => {
  const checks = [
    { name: 'ok', run: async () => L.pass('fine') },
    { name: 'boom', run: async () => { throw new Error('broke in /home/bob/thing\nmore') } },
    { name: 'skipped', run: async () => L.skip('not here') },
    { name: 'nothing returned', run: async () => {} },
    { name: 'odd', run: async () => ({ status: 'MAYBE' }) },
    { name: 'last', run: async (ctx) => L.pass(ctx.word) }
  ]
  const r = await L.runChecks(checks, { word: 'reached' }, '/home/bob')
  assert.deepEqual(
    r.map((x) => [x.name, x.status, x.detail]),
    [
      ['ok', 'PASS', 'fine'],
      ['boom', 'FAIL', 'broke in ~/thing'],
      ['skipped', 'SKIP', 'not here'],
      ['nothing returned', 'PASS', ''],
      ['odd', 'FAIL', 'bad check result: {"status":"MAYBE"}'],
      ['last', 'PASS', 'reached']
    ]
  )
  assert.deepEqual(L.counts(r), { PASS: 3, FAIL: 2, SKIP: 1 })
  assert.equal(L.exitCode(r), 1)
  assert.equal(L.exitCode(r.filter((x) => x.status !== 'FAIL')), 0)
})

test('the report: header, one line per check, a count', () => {
  const info = { os: 'Ubuntu 24.04 LTS', kernel: 'Linux 6.8.0 x64', node: 'v22.18.0', git: '2.43.0', temp: 'corvid-linux-check-abc123', tempDeleted: true }
  const results = [
    { name: 'deny-rule paths', status: 'PASS', detail: '7 pinned paths match', ms: 1 },
    { name: 'shells', status: 'FAIL', detail: 'no shell found', ms: 1 },
    { name: 'keyring', status: 'SKIP', detail: 'later', ms: 0 }
  ]
  const text = L.formatReport(info, results)
  const lines = text.split('\n')
  assert.equal(lines[0], 'Corvid Linux check (#164)')
  assert.ok(text.includes('OS:     Ubuntu 24.04 LTS'))
  assert.ok(text.includes('Temp:   corvid-linux-check-abc123 (deleted: yes)'))
  assert.ok(lines.includes('PASS  deny-rule paths  7 pinned paths match'))
  assert.ok(lines.includes('FAIL  shells           no shell found'))
  assert.equal(lines.at(-1), '1 passed, 1 failed, 1 skipped')
  assert.match(L.formatReport({ ...info, tempDeleted: false }, results), /deleted: NO/)
  const json = JSON.parse(L.formatJson(info, results))
  assert.deepEqual(json.counts, { PASS: 1, FAIL: 1, SKIP: 1 })
  assert.equal(json.checks[1].detail, 'no shell found')
})

test('only its own temp folder is ever deleted', () => {
  assert.equal(L.isOurTemp('/tmp/corvid-linux-check-x1', '/tmp'), true)
  assert.equal(L.isOurTemp('/tmp', '/tmp'), false)
  assert.equal(L.isOurTemp('/home/u/corvid-linux-check-x1', '/tmp'), false)
  assert.equal(L.isOurTemp('/tmp/other', '/tmp'), false)
  assert.equal(L.isOurTemp(undefined, '/tmp'), false)
})

test('stillRunning ignores zombies and pids that are gone', () => {
  const list = [
    { pid: 10, ppid: 1, pgid: 10, zombie: true },
    { pid: 11, ppid: 1, pgid: 10, zombie: false }
  ]
  assert.deepEqual(L.stillRunning([10, 11, 12], list), [11])
})

test('the deploy check stand-in: a copy of Node with an idle -e script, not a name-dispatching binary', () => {
  const app = L.standInApp('/opt/node/bin/node', 1500.4)
  assert.equal(app.source, '/opt/node/bin/node')
  assert.deepEqual(app.args, ['-e', 'setTimeout(() => {}, 1500)'])
  assert.doesNotThrow(() => new Function(app.args[1]), 'the -e script is valid JavaScript')
  assert.equal(L.standInApp('/x/node').args[1], 'setTimeout(() => {}, 300000)', 'idles 5 minutes by default')
  // the script keeps Node alive for its time and then exits cleanly, whatever the binary is called
  const { args } = L.standInApp(process.execPath, 400)
  const t = Date.now()
  execFileSync(process.execPath, args, { timeout: 10_000 })
  assert.ok(Date.now() - t >= 350, 'it stayed up instead of exiting at once')
})

test('every check has a unique name and a run function', () => {
  const names = L.CHECKS.map((c) => c.name)
  assert.equal(new Set(names).size, names.length)
  for (const c of L.CHECKS) assert.equal(typeof c.run, 'function', c.name)
  for (const n of ['deny-rule paths', 'path keys and toNative', 'git worktree + node_modules link', 'Claude CLI lookup', 'shells', 'login-shell PATH merge'])
    assert.ok(names.includes(n), n)
  assert.ok(names.some((n) => n.startsWith('killTree')))
})

test('the whole script: no failures, its temp folder gone, no home path in the output', () => {
  const ours = () => readdirSync(tmpdir()).filter((n) => n.startsWith('corvid-linux-check-'))
  const before = ours()
  // a failing run still prints its report: read it, so the assertion below names the failed check
  let out
  let status = 0
  try {
    out = execFileSync(process.execPath, [join(import.meta.dirname, 'linux-check.mjs'), '--json'], { encoding: 'utf8', timeout: 60_000 })
  } catch (e) {
    if (!e.stdout) throw e
    out = e.stdout
    status = e.status
  }
  const r = JSON.parse(out)
  assert.deepEqual(
    r.checks.filter((c) => c.status === 'FAIL'),
    []
  )
  assert.equal(status, 0, 'exit code')
  assert.deepEqual(r.checks.map((c) => c.name), L.CHECKS.map((c) => c.name))
  assert.equal(r.tempDeleted, true)
  assert.deepEqual(ours(), before, 'no corvid-linux-check-* folder left behind')
  if (homedir().length > 1) assert.ok(!out.includes(homedir()), 'the home folder is shown as ~')
  // the pure checks run on every OS
  for (const n of ['platform layer loaded', 'deny-rule paths', 'path keys and toNative']) assert.equal(r.checks.find((c) => c.name === n).status, 'PASS', n)
})

test('keyring on the session bus: Secret Service or KWallet from dbus-send output (#159)', () => {
  const out = `method return time=1 sender=org.freedesktop.DBus -> destination=:1.9 serial=3 reply_serial=2
   array [
      string "org.freedesktop.DBus"
      string ":1.9"
      string "org.freedesktop.secrets"
   ]`
  assert.deepEqual(L.busNames(out), ['org.freedesktop.DBus', ':1.9', 'org.freedesktop.secrets'])
  assert.match(L.keyringOnBus(L.busNames(out)), /Secret Service/)
  assert.equal(L.keyringOnBus(['org.kde.kwalletd6']), 'KWallet')
  assert.equal(L.keyringOnBus(['org.kde.kwalletd']), 'KWallet')
  assert.equal(L.keyringOnBus(['org.freedesktop.DBus', 'org.kde.kwalletmanager']), null)
  assert.deepEqual(L.USES.keyring, ['secretStorageStatus', 'NO_KEYRING'])
})
