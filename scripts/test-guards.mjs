// Unit tests for #85's guards: a test copy refuses the real data folder however it's spelled, and backups rotate,
// skip secrets and restore. Runs on Node 24's own TypeScript support with a stand-in for electron; every "real"
// folder here is a fake one in a temp directory.
//
//   npm run test-guards

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-guards-'))
globalThis.__userData = join(tmp, 'data')
// electron's app, as far as backups.ts uses it; the sources load as the ES modules they are
register(
  'data:text/javascript,' +
    encodeURIComponent(`export async function resolve(s, c, next) {
      if (s === 'electron') return { url: 'data:text/javascript,export const app = { getPath: () => globalThis.__userData }', shortCircuit: true }
      return next(s, c)
    }
    export async function load(u, c, next) {
      // the package is CommonJS, the sources are ES modules
      return u.endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
const { defaultDataDir, isRealDataDir, resolveDataDir } = await import('../src/main/dataDir.ts')
const backups = await import('../src/main/backups.ts')

test('a test copy refuses the real data folder however it is spelled', () => {
  const appData = join(tmp, 'Roaming')
  const real = join(appData, 'Claude Dashboard')
  mkdirSync(real, { recursive: true })
  const env = (dir) => ({ DASH_DATA_DIR: dir, DASH_TEST_INSTANCE: 'unit' })
  const variants = [real, real.toUpperCase(), real + '\\', real + '\\\\', real.replace(/\\/g, '/'), join(real, '..', 'Claude Dashboard'), join(appData, 'Corvid')]
  // 8.3 short name, where the volume has them
  try {
    const short = execFileSync('cmd', ['/d', '/s', '/c', `"for %I in ("${real}") do @echo %~sI"`], { encoding: 'utf8', windowsVerbatimArguments: true }).trim()
    if (short && short !== real) variants.push(short)
  } catch {
    /* no short names here */
  }
  const junction = join(tmp, 'junction-to-real')
  try {
    execFileSync('cmd', ['/c', 'mklink', '/J', junction, real], { stdio: 'ignore' })
    variants.push(junction, junction + '\\')
  } catch {
    /* can't make junctions here */
  }
  const link = join(tmp, 'symlink-to-real')
  try {
    symlinkSync(real, link, 'dir')
    variants.push(link)
  } catch {
    /* symlinks need developer mode */
  }
  for (const v of variants) {
    const r = resolveDataDir(appData, join(appData, 'Corvid'), env(v))
    assert.ok('error' in r, `should refuse ${v}`)
  }
  // a folder of its own, and the same folder as the real app's default (which is under Roaming\Corvid)
  const own = join(tmp, 'test-copy-data')
  assert.deepEqual(resolveDataDir(appData, join(appData, 'Corvid'), env(own)), { dir: own, test: true })
  assert.ok('error' in resolveDataDir(appData, join(appData, 'Corvid'), { DASH_TEST_INSTANCE: 'unit' }), 'the test flag without a folder')
  assert.ok(isRealDataDir(join(real, 'x', '..'), [real]))
  assert.ok(!isRealDataDir(join(real, 'sub'), [real]))
  // the real app (no test flag) keeps its folder as before: the pre-rename one only on Windows, where it existed (#154)
  const realApp = process.platform === 'win32' ? real : join(appData, 'Corvid')
  assert.deepEqual(resolveDataDir(appData, join(appData, 'Corvid'), {}), { dir: realApp, test: false })
})

test("a test copy never asks electron for userData, which would create the real folder (#178)", () => {
  const appData = join(tmpdir(), 'made-up-appdata')
  let asked = 0
  const userData = () => (asked++, join(appData, 'Corvid'))
  for (const env of [{ DASH_DATA_DIR: join(tmpdir(), 'x') }, { DASH_TEST_INSTANCE: 'unit' }]) {
    assert.equal(defaultDataDir(appData, 'Corvid', userData, env), join(appData, 'Corvid'))
    assert.equal(asked, 0, 'electron was asked for userData')
  }
  // the real app still takes electron's answer
  assert.equal(defaultDataDir(appData, 'Corvid', () => 'from electron', {}), 'from electron')
  // and the refusal still covers the default folder worked out from the name
  assert.ok('error' in resolveDataDir(appData, defaultDataDir(appData, 'Corvid', userData, { DASH_DATA_DIR: join(appData, 'Corvid') }), { DASH_DATA_DIR: join(appData, 'Corvid') }))
})

test('backups are taken, skip unchanged files and secrets, and rotate', () => {
  const data = globalThis.__userData
  mkdirSync(join(data, 'notes'), { recursive: true })
  writeFileSync(join(data, 'config.json'), '{"v":1}')
  writeFileSync(join(data, 'secrets.json'), '{"key":"never copied"}')
  writeFileSync(join(data, 'notes', 'n1.json'), '{}')
  assert.ok(backups.backupNow('config.json'))
  assert.equal(backups.backupNow('config.json'), null, 'unchanged: no new backup')
  assert.ok(backups.backupNow('notes'))
  assert.ok(!existsSync(join(data, 'backups', 'secrets.json')))
  assert.ok(!backups.BACKUP_ITEMS.includes('secrets.json'))
  for (let i = 2; i <= 14; i++) {
    writeFileSync(join(data, 'config.json'), `{"v":${i}}`)
    backups.backupNow('config.json')
  }
  assert.equal(backups.listBackups('config.json').length, 10, 'the last ten')
  // one a day for a week, beyond the last ten
  const day = (d, t) => `202610${String(d).padStart(2, '0')}-${t}-000`
  const names = [...Array(10)].map((_, i) => day(21, `1200${String(i).padStart(2, '0')}`)).concat([day(20, '090000'), day(20, '080000'), day(18, '090000'), day(1, '090000')])
  const pruned = backups.toPrune(names, new Date(2026, 9, 21, 13))
  assert.deepEqual(pruned.sort(), [day(1, '090000'), day(20, '080000')].sort())
})

test('restore puts a backup back after backing up the current version', () => {
  const data = globalThis.__userData
  const oldest = backups.listBackups('config.json').at(-1)
  const before = readFileSync(join(data, 'config.json'), 'utf8')
  const wanted = readFileSync(join(data, 'backups', 'config.json', oldest), 'utf8')
  // with ten kept, the safety backup rotates the chosen (oldest) one out: the restore must still work
  const r = backups.restoreBackup('config.json', oldest)
  assert.ok('ok' in r, JSON.stringify(r))
  assert.equal(readFileSync(join(data, 'config.json'), 'utf8'), wanted)
  assert.equal(readFileSync(join(data, 'backups', 'config.json', r.saved), 'utf8'), before, 'the current version was kept first')
  writeFileSync(join(data, 'notes', 'n2.json'), '{}')
  const [notesBackup] = backups.listBackups('notes').slice(-1)
  assert.ok('ok' in backups.restoreBackup('notes', notesBackup))
  assert.deepEqual(readdirSync(join(data, 'notes')), ['n1.json'])
  assert.ok('error' in backups.restoreBackup('secrets.json', notesBackup))
  assert.ok('error' in backups.restoreBackup('config.json', '../../secrets.json'))
})

test.after(() => rmSync(tmp, { recursive: true, force: true }))
