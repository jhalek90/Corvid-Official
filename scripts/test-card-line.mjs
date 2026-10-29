// Tests for #327, the tidier agent card: the activity line's shortening (the tool and its first command, without pipes,
// separators and redirections; the whole label for the tooltip) and the context chip's exact numbers ("86k of 1M, 9%").
//
//   npm run test-card-line

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
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) return next(s + '.ts', c)
      return next(s, c)
    }
    export async function load(u, c, next) {
      return u.split('?')[0].endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const { activityLine, firstCommand } = await import('../src/shared/activityLine.ts')
const { corvidWindow, ringShort, ringUse } = await import('../src/shared/context.ts')

test('the first command drops pipes, separators and redirections', () => {
  assert.equal(firstCommand('npm run typecheck 2>&1 | tail -4; npm run docs:lint 2>&1 | tail…'), 'npm run typecheck')
  assert.equal(firstCommand('npm test && npm run build'), 'npm test')
  assert.equal(firstCommand('npm test || echo failed'), 'npm test')
  assert.equal(firstCommand('git log --oneline > out.txt'), 'git log --oneline')
  assert.equal(firstCommand('node build.mjs < input.txt'), 'node build.mjs')
  assert.equal(firstCommand('Get-ChildItem src | Select-Object -First 5'), 'Get-ChildItem src')
  assert.equal(firstCommand('git status\ngit diff'), 'git status')
})

test('a leading cd and an opening bracket are skipped', () => {
  assert.equal(firstCommand('cd "D:/projects/x" && npm run typecheck 2>&1 | tail -5'), 'npm run typecheck')
  assert.equal(firstCommand('cd src; ls'), 'ls')
  assert.equal(firstCommand('(npm run typecheck 2>&1 | tail -4; npm run docs:lint)'), 'npm run typecheck')
  // a lone cd is still something to show
  assert.equal(firstCommand('cd D:/projects/x'), 'cd D:/projects/x')
})

test('quoted pipes and separators stay in the command', () => {
  assert.equal(firstCommand('grep -n "a|b; c" file.ts | head'), 'grep -n "a|b; c" file.ts')
  assert.equal(firstCommand("git commit -m 'one; two && three' && git log"), "git commit -m 'one; two && three'")
  assert.equal(firstCommand('echo hi > "a b.txt"; ls'), 'echo hi')
})

test('a description or a plain command comes back as it is', () => {
  assert.equal(firstCommand('Run the typecheck'), 'Run the typecheck')
  assert.equal(firstCommand('npm run typecheck'), 'npm run typecheck')
  assert.equal(firstCommand('  npm test  '), 'npm test')
})

test('the activity line: tool and first command, the whole label for the tooltip', () => {
  const bash = activityLine('Bash', 'npm run typecheck 2>&1 | tail -4')
  assert.deepEqual(bash, { who: 'Bash', what: 'npm run typecheck', full: 'Bash: npm run typecheck 2>&1 | tail -4' })
  assert.equal(activityLine('PowerShell', 'npm test; npm run build').what, 'npm test')
  // other tools keep their label: a file name or a pattern is already short
  assert.deepEqual(activityLine('Edit', 'AgentsView.tsx'), { who: 'Edit', what: 'AgentsView.tsx', full: 'Edit: AgentsView.tsx' })
  assert.equal(activityLine('Grep', '“a | b” in *.ts').what, '“a | b” in *.ts')
  // a subagent's line names the subagent
  const sub = activityLine('Bash', 'npm test | tail', 'Run the tests')
  assert.equal(sub.who, 'Run the tests')
  assert.equal(sub.what, 'npm test')
  assert.equal(sub.full, 'Run the tests: npm test | tail')
  assert.deepEqual(activityLine(undefined, 'something'), { who: '', what: 'something', full: 'something' })
})

test('the context chip: "86k of 1M, 9%", a custom model by its own window', () => {
  assert.equal(ringShort(ringUse(86_000, corvidWindow('opus', []))), '86k of 1M, 9%')
  assert.equal(ringShort(ringUse(214_000, corvidWindow(undefined, undefined))), '214k of 1M, 21%')
  const models = [{ id: 'qwen', label: 'Qwen', contextTokens: 32_768 }]
  const u = ringUse(16_000, corvidWindow('custom:qwen', models))
  assert.equal(ringShort(u), '16k of 33k, 49%')
})
