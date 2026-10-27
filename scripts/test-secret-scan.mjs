// Tests for scripts/secret-scan.mjs, the pre-commit scan: in a throwaway repository, staged files that belong in
// .gitignore (node_modules, build output, OS junk), key and .env files (binary ones too) and files over 5 MB are
// blocked, while ordinary source passes (#184).
//
//   npm run test-secret-scan

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const scanner = join(import.meta.dirname, 'secret-scan.mjs')
const tmp = mkdtempSync(join(tmpdir(), 'corvid-secretscan-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

let n = 0
// A fresh repository with `files` staged; returns the scan's exit code and output.
function scanStaged(files) {
  const repo = join(tmp, `r${n++}`)
  mkdirSync(repo)
  execFileSync('git', ['init', '-q'], { cwd: repo })
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true })
    writeFileSync(join(repo, path), body)
  }
  execFileSync('git', ['-c', 'core.autocrlf=false', 'add', '-f', '.'], { cwd: repo })
  const r = spawnSync(process.execPath, [scanner], { cwd: repo, encoding: 'utf8' })
  return { status: r.status, out: r.stdout + r.stderr }
}

test('ordinary source and docs pass', () => {
  const r = scanStaged({ 'src/a.ts': 'export const a = 1\n', 'docs/images/x.png': Buffer.alloc(1024, 1) })
  assert.equal(r.status, 0, r.out)
})

test('node_modules, build output and OS files are blocked', () => {
  for (const path of ['node_modules/left-pad/index.js', 'out/main/index.js', 'dist/win-unpacked/x.txt', 'app.asar', 'docs/.DS_Store', 'Thumbs.db']) {
    const r = scanStaged({ [path]: 'x\n' })
    assert.equal(r.status, 1, path)
    assert.match(r.out, /belongs in \.gitignore/, path)
  }
})

test('.env and key files are blocked, binary ones too', () => {
  for (const [path, body] of [['.env', 'A=1\n'], ['config/.env.local', 'A=1\n'], ['certs/client.p12', Buffer.from([0, 1, 2, 0, 255])], ['server.key', 'x\n']]) {
    const r = scanStaged({ [path]: body })
    assert.equal(r.status, 1, path)
    assert.match(r.out, /file that must not be committed/, path)
  }
})

test('files over 5 MB are blocked', () => {
  const r = scanStaged({ 'resources/huge.png': Buffer.alloc(5 * 1024 * 1024 + 1, 7) })
  assert.equal(r.status, 1, r.out)
  assert.match(r.out, /file over 5 MB.* in resources\/huge\.png/)
})
