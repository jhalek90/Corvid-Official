// Tests for the pure parts of scripts/publish-sync.mjs (in publish-sync-lib.mjs): the changelog lines from private
// main's subjects, the #NNN stripping, the Synced-from trailer and the check that the public main holds only sync
// commits.
//
//   npm run test-publish-sync

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BASELINE,
  PUBLIC_IDENTITY,
  changeLine,
  changeLines,
  checkPublicHistory,
  commitMessage,
  stripTaskNumbers,
  summarizeNameStatus,
  syncedFrom
} from './publish-sync-lib.mjs'

const sha = (c) => c.repeat(40)

test('stripTaskNumbers drops private task numbers and keeps other #', () => {
  assert.equal(stripTaskNumbers('#244 CI: fix the UI smoke step'), 'CI: fix the UI smoke step')
  assert.equal(stripTaskNumbers('Board: fix scroll (#183)'), 'Board: fix scroll')
  assert.equal(stripTaskNumbers('Fix tags (#12, #13) on cards'), 'Fix tags on cards')
  assert.equal(stripTaskNumbers('Follow-up to #231: tidy'), 'Follow-up to tidy')
  assert.equal(stripTaskNumbers('Use C# style and #fff colours'), 'Use C# style and #fff colours')
})

test('changeLine takes the text after a task merge and skips noise', () => {
  assert.equal(
    changeLine('Merge task-244-ci-fix-the-ui-smoke-step: #244 CI: fix the UI smoke step on Linux (smoke: command not found)'),
    'CI: fix the UI smoke step on Linux (smoke: command not found)'
  )
  assert.equal(changeLine("Merge branch 'main' into task-12-x"), null)
  assert.equal(changeLine("Merge remote-tracking branch 'origin/main'"), null)
  assert.equal(changeLine('Merge pull request 3 from someone/branch'), null)
  assert.equal(changeLine('Bump version to 0.1.1'), null)
  assert.equal(changeLine('README: fix a typo'), 'README: fix a typo')
})

test('changeLines keeps order and drops repeats', () => {
  assert.deepEqual(changeLines(['Merge t-1: #1 A thing', 'Merge t-2: #2 a thing', "Merge branch 'main'", 'Merge t-3: #3 B thing']), [
    'A thing',
    'B thing'
  ])
})

test('commitMessage has the version, the list and the trailer last', () => {
  const msg = commitMessage({ version: '0.1.1', lines: ['A thing', 'B thing'], privateSha: sha('a') })
  assert.equal(msg, `Corvid v0.1.1\n\n- A thing\n- B thing\n\nSynced-from: ${sha('a')}\n`)
  assert.equal(syncedFrom(msg), sha('a'))
  assert.match(commitMessage({ version: '1.0.0', lines: [], privateSha: sha('b') }), /- Maintenance changes\./)
})

test('syncedFrom finds only a full sha on its own line', () => {
  assert.equal(syncedFrom('Corvid v1\n\nSynced-from: abc\n'), null)
  assert.equal(syncedFrom('no trailer'), null)
  assert.equal(syncedFrom(`x\n\nSynced-from: ${sha('C')}`), sha('c'))
})

const id = PUBLIC_IDENTITY.email
const base = { sha: BASELINE.public, authorEmail: id, committerEmail: id, message: 'Corvid\n' }
const sync = (c, from) => ({ sha: sha(c), authorEmail: id, committerEmail: id, message: commitMessage({ version: '0.1.1', lines: [], privateSha: from }) })

const web = { sha: sha('9'), authorEmail: id, committerEmail: 'noreply@github.com', message: 'Update README.md\n' }

test('checkPublicHistory accepts the baseline alone and names its private commit', () => {
  assert.deepEqual(checkPublicHistory([base]), { ok: true, lastSynced: BASELINE.private, trusted: BASELINE.public, outside: [] })
})

test('checkPublicHistory accepts sync commits on the baseline and returns the newest trailer', () => {
  assert.deepEqual(checkPublicHistory([sync('2', sha('e')), sync('1', sha('d')), base]), {
    ok: true,
    lastSynced: sha('e'),
    trusted: sha('2'),
    outside: []
  })
})

test('checkPublicHistory refuses commits the sync did not make', () => {
  assert.match(checkPublicHistory([web, base]).reason, /1 commit\(s\) on the public main weren't made by publish-sync .*"Update README.md".*--accept-public 9{40}/)
  const forged = { ...sync('8', sha('d')), authorEmail: 'someone@example.com' }
  assert.equal(checkPublicHistory([forged, base]).ok, false)
  assert.equal(checkPublicHistory([web, sync('2', sha('e')), base]).ok, false)
})

test('checkPublicHistory takes outside commits only when --accept-public names the head', () => {
  assert.deepEqual(checkPublicHistory([web, sync('2', sha('e')), base], { accept: sha('9') }), {
    ok: true,
    lastSynced: sha('e'),
    trusted: sha('2'),
    outside: [sha('9')]
  })
  assert.match(checkPublicHistory([web, base], { accept: sha('1') }).reason, /names 111111111111, but the public main is at 999999999999/)
})

test('checkPublicHistory trusts a sync commit made on top of accepted outside commits', () => {
  assert.deepEqual(checkPublicHistory([sync('3', sha('f')), web, base]), { ok: true, lastSynced: sha('f'), trusted: sha('3'), outside: [] })
})

test('checkPublicHistory refuses another root or an empty repo', () => {
  assert.match(checkPublicHistory([{ ...base, sha: sha('7') }]).reason, /first commit/)
  assert.equal(checkPublicHistory([]).ok, false)
})

test('summarizeNameStatus sorts paths into added, changed and removed', () => {
  assert.deepEqual(summarizeNameStatus('A\tnew.txt\nM\tsrc/a.ts\nD\told.md\nR100\tx.md\ty.md\n'), {
    added: ['new.txt'],
    changed: ['src/a.ts', 'x.md -> y.md'],
    removed: ['old.md']
  })
})
