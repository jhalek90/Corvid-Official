// Tests for #119, the extension page's layout (src/shared/extensionPage.ts): the status label, the buttons in the top
// row with one primary action, and the panels kept open at the top, for an extension in every state. Pure functions on
// sample records; no ledger, no app and no real extension is touched.
//
//   npm run test-extension-page

import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
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
const { pageLayout, scanGlance, shortText } = await import(src + 'shared/extensionPage.ts')
const { CLASSIFIER_VERSION } = await import(src + 'shared/extensionScan.ts')

const HASH = 'a'.repeat(64)
const report = (verdict, flags = 0) => ({ hash: HASH, verdict, classifierVersion: CLASSIFIER_VERSION, flags: Array.from({ length: flags }, () => ({})) })
function rec(over = {}) {
  return {
    key: 'demo-aaaa',
    id: 'demo',
    name: 'Demo',
    version: '1.0.0',
    hash: HASH,
    status: 'not-installed',
    source: { kind: 'imported' },
    header: { capabilities: { tier: 1, coreAreas: [], packages: [], hosts: [], rebuild: false } },
    ...over
  }
}
const ids = (l) => l.buttons.map((b) => b.id)
const primaries = (l) => l.buttons.filter((b) => b.kind === 'primary').map((b) => b.id)

test('not scanned yet: Scan… (in the scan panel) is the primary, Install is not', () => {
  const l = pageLayout(rec())
  assert.deepEqual(primaries(l), [])
  assert.equal(l.primary, 'Scan…')
  assert.equal(pageLayout(rec({ scan: { state: 'done', report: report('warn', 2) } })).primary, 'Install…')
})

test('not installed: Install is the one primary, Delete is quiet, the checks and scan stay at the top', () => {
  const l = pageLayout(rec({ scan: { state: 'done', report: report('clear') } }))
  assert.equal(l.status, 'Not installed yet')
  assert.deepEqual(ids(l), ['install', 'delete'])
  assert.deepEqual(primaries(l), ['install'])
  assert.equal(l.buttons.find((b) => b.id === 'delete').kind, 'quiet')
  assert.deepEqual(l.top, ['install-checks'], 'a clear scan leaves the top: its chip shows the verdict')
  assert.deepEqual(pageLayout(rec()).top, ['install-checks', 'scan'])
  assert.equal(l.primary, 'Install…')
  assert.equal(l.tier, 'adds files')
})

test('scanning shows "Scanning"; the verdict glance follows the report', () => {
  assert.equal(pageLayout(rec({ scan: { state: 'scanning' } })).status, 'Scanning')
  assert.deepEqual(scanGlance(rec()), { word: 'Not scanned', tone: 'muted', flags: 0 })
  assert.deepEqual(scanGlance(rec({ scan: { state: 'done', report: report('clear') } })), { word: 'Clear', tone: 'ok', flags: 0 })
  assert.deepEqual(scanGlance(rec({ scan: { state: 'done', report: report('warn', 3) } })), { word: 'Warning', tone: 'warn', flags: 3 })
  assert.deepEqual(scanGlance(rec({ scan: { state: 'done', report: report('block', 1) } })), { word: 'Blocked', tone: 'bad', flags: 1 })
  assert.equal(scanGlance(rec({ scan: { state: 'failed' } })).word, 'Scan failed')
  assert.equal(scanGlance(rec({ scan: { state: 'done', report: { ...report('clear'), hash: 'b'.repeat(64) } } })).word, 'Not scanned')
  assert.equal(scanGlance(rec({ scan: { state: 'done', report: { ...report('clear'), classifierVersion: -1 } } })).word, 'Clear, out of date')
})

test('ready to review keeps Install primary', () => {
  const l = pageLayout(rec({ status: 'ready', scan: { state: 'done', report: report('clear') } }))
  assert.equal(l.status, 'Ready to review')
  assert.deepEqual(primaries(l), ['install'])
})

test('building: no Install or Delete; the progress and build panels are at the top', () => {
  const l = pageLayout(rec({ status: 'building', build: { state: 'building' } }))
  assert.equal(l.status, 'Building')
  assert.deepEqual(ids(l), [])
  assert.deepEqual(l.top, ['progress', 'build'])
})

test('needs review: the build panel is at the top and Approve and merge is the primary', () => {
  const l = pageLayout(rec({ status: 'needs-review', build: { state: 'needs-review', tip: 'abc' } }))
  assert.equal(l.status, 'Needs review')
  assert.deepEqual(primaries(l), [])
  assert.deepEqual(l.top, ['build'])
  assert.equal(l.primary, 'Approve and merge')
})

test('failed: Retry is primary, the failed build panel (reason, Send back, Open the branch, Discard) is at the top', () => {
  const l = pageLayout(rec({ status: 'failed', scan: { state: 'done', report: report('clear') }, build: { state: 'failed', error: 'typecheck failed' } }))
  assert.equal(l.status, 'Failed')
  assert.deepEqual(ids(l), ['retry', 'delete'])
  assert.deepEqual(primaries(l), ['retry'])
  assert.ok(l.top.includes('build'))
  assert.ok(!l.top.includes('scan') || l.top.indexOf('scan') < l.top.indexOf('build'))
})

test('installed: the lifecycle and verify panels are at the top, no Delete, no Install', () => {
  const l = pageLayout(rec({ status: 'installed', build: { state: 'merged', mergeCommit: 'm1' } }))
  assert.equal(l.status, 'Installed')
  assert.deepEqual(ids(l), [])
  assert.deepEqual(l.top, ['lifecycle', 'verify'])
})

test('disabled: Enable (in the lifecycle panel) is the primary', () => {
  const l = pageLayout(rec({ status: 'disabled', build: { state: 'merged', mergeCommit: 'm1' } }))
  assert.equal(l.status, 'Disabled')
  assert.equal(l.primary, 'Enable')
  assert.ok(l.top.includes('lifecycle'))
})

test('verified installed: Verified shows and the verify panel holds Share', () => {
  const l = pageLayout(rec({ status: 'installed', build: { state: 'merged', mergeCommit: 'm1' }, verification: { hash: HASH } }))
  assert.equal(l.verified, true)
  assert.ok(l.top.includes('verify'))
  // a verification of other text doesn't count
  assert.equal(pageLayout(rec({ verification: { hash: 'b'.repeat(64) } })).verified, false)
})

test('update available: an Update button next to the lifecycle panel', () => {
  const old = rec({ status: 'installed', build: { state: 'merged', mergeCommit: 'm1' } })
  const neu = rec({ key: 'demo-bbbb', version: '1.1.0', hash: 'b'.repeat(64) })
  assert.deepEqual(ids(pageLayout(old, [old, neu])), ['update'])
  assert.deepEqual(ids(pageLayout(old, [old])), [])
})

test('created here: Edit and the verify panel, even before an install', () => {
  const l = pageLayout(rec({ source: { kind: 'created' } }))
  assert.deepEqual(ids(l), ['install', 'edit', 'delete'])
  assert.ok(l.top.includes('verify'))
  // an imported one keeps Verify in a collapsed section
  assert.ok(!pageLayout(rec()).top.includes('verify'))
})

test('a failed verify brings the verify panel to the top', () => {
  assert.ok(pageLayout(rec({ verify: { hash: HASH, state: 'failed' } })).top.includes('verify'))
})

test('a conflict or a change waiting for review keeps the lifecycle panel at the top with its primary', () => {
  const base = { status: 'installed', build: { state: 'merged', mergeCommit: 'm1' } }
  assert.equal(pageLayout(rec({ ...base, lifecycle: { conflict: { state: 'held' } } })).primary, 'Resolve with an agent')
  assert.equal(pageLayout(rec({ ...base, lifecycle: { pending: { op: 'remove' } } })).primary, 'Approve and merge')
  const removedKept = pageLayout(rec({ build: { state: 'merged', mergeCommit: 'm1' } }))
  assert.ok(removedKept.top.includes('lifecycle'), 'removed with the text kept offers Re-apply the stored build')
})

test('never more than one primary in the row, in any state', () => {
  const states = ['not-installed', 'scanning', 'ready', 'building', 'needs-review', 'installed', 'disabled', 'failed', 'removed']
  for (const status of states)
    for (const kind of ['imported', 'created'])
      for (const verification of [undefined, { hash: HASH }]) {
        const l = pageLayout(rec({ status, source: { kind }, verification, build: status === 'failed' ? { state: 'failed' } : undefined }))
        assert.ok(primaries(l).length <= 1, `${status} ${kind}`)
      }
})

test('shortText keeps two or three sentences and says when there is more', () => {
  assert.deepEqual(shortText('One. Two.'), { short: 'One. Two.', more: false })
  const t = shortText('One. Two. Three. Four.')
  assert.equal(t.short, 'One. Two. Three.')
  assert.equal(t.more, true)
  const long = shortText('word '.repeat(200))
  assert.ok(long.short.length <= 361 && long.more)
})
