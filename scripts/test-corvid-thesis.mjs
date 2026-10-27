// Tests for #202, what Corvid is for agents: the docs page is the one source (the main entry bundles it; the folded
// prompt text matches the page), the two doses (full page for the Corvid project, Corvid itself, the extension wizard
// and /discuss; three sentences plus the suggest rule elsewhere; nothing for the neutral prompts), the Settings switch
// changing the rule, the config accepting the key, and the collector appending "Corvid could:" lines and skipping
// duplicates. No claude, no Corvid, nothing started.
//
//   npm run test-corvid-thesis

import { register } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, test } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-thesis-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      export const app = { getPath: () => globalThis.__userData, isPackaged: false }
      export const safeStorage = { isEncryptionAvailable: () => false }\`)
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: fake, shortCircuit: true }
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

const thesis = await import(src + 'shared/corvidThesis.ts')
const discussion = await import(src + 'shared/discussion.ts')
const suggestions = await import(src + 'main/suggestions.ts')
const config = await import(src + 'main/config.ts')
const { CLASSIFIER_PROMPTS } = await import(src + 'shared/extensionScan.ts')

const page = readFileSync(join(root, thesis.THESIS_DOC), 'utf8')
thesis.setThesisText(page)
const read = (f) => readFileSync(join(root, f), 'utf8')
// words only, so Markdown markers and line breaks don't count
const words = (s) => s.replace(/[#*`\-_>]/g, ' ').replace(/\s+/g, ' ').trim()

after(() => rmSync(tmp, { recursive: true, force: true }))

test('the docs page is the one source: the main entry bundles it and registers it before anything else', () => {
  const index = read('src/main/index.ts')
  assert.match(index, new RegExp(`from '\\.\\./\\.\\./${thesis.THESIS_DOC.replace(/\//g, '\\/')}\\?raw'`), 'a Vite ?raw import of the page')
  assert.match(index, /^setThesisText\(whatCorvidIs\)$/m, 'registered at the top level')
  // no module types the thesis in by hand: the only sentence of it in src is the file name
  for (const f of ['src/main/workers.ts', 'src/main/assistant.ts', 'src/main/discussion.ts', 'src/main/packager.ts', 'src/main/newProject.ts', 'src/shared/corvidThesis.ts'])
    assert.doesNotMatch(read(f), /personal development environment for one software engineer/, `${f} carries no copy`)
})

test('the three sentences are three sentences, and the folded doses match the page word for word', () => {
  const three = thesis.threeSentences()
  assert.equal(three.split(/(?<=[.!?])\s+(?=[A-Z"])/).length, 3, three)
  assert.equal(words(three), words(thesis.section(page, '## Corvid in three sentences')))
  const full = thesis.fullDose()
  const body = words(thesis.pageBody(page))
  for (const heading of ['What Corvid is', 'How it is designed to be used', 'What this means for agents', 'What Corvid is not', 'Who says so', 'How agents should use this page'])
    assert.ok(full.includes(`${heading}.`), heading)
  // every paragraph and bullet of the page is in the full dose, in the page's words
  for (const block of thesis.pageBody(page).split(/\n\s*\n/)) {
    const w = words(block)
    if (w && !/^#/.test(block.trim())) assert.ok(words(full).includes(w), `in the full dose: ${w.slice(0, 50)}`)
  }
  assert.ok(body.length > 0)
  assert.doesNotMatch(full, /<!--/, 'comments dropped')
  assert.doesNotMatch(full, /^---/, 'front matter dropped')
})

test('two doses: full for the Corvid project, short with the rule elsewhere, nothing for a neutral prompt', () => {
  const full = thesis.thesisDose('full')
  const short = thesis.thesisDose('short', true)
  assert.ok(full.includes('How it is designed to be used.'))
  assert.ok(full.startsWith(`What Corvid is (${thesis.THESIS_DOC}`))
  assert.ok(short.includes(thesis.threeSentences()))
  assert.ok(short.includes('Corvid is the environment you run in, not the subject of your task'))
  assert.ok(short.includes('Suggest a Corvid change only when you hit it yourself during the task'))
  assert.ok(short.includes('one line that starts with "Corvid could:"'))
  assert.ok(short.includes('At most one suggestion per task'))
  assert.ok(!short.includes('How it is designed to be used'), 'the short dose has no full page')
  assert.equal(thesis.thesisDose('none'), '')
  // nothing registered (a module imported in a test): no half dose, just nothing
  assert.equal(thesis.thesisDose('full', true, ''), '')
  assert.equal(thesis.thesisDose('short', true, ''), '')
})

test('the Settings switch changes the rule: off means "do not suggest"', () => {
  const on = thesis.shortDose(true)
  const off = thesis.shortDose(false)
  assert.ok(on.includes('Suggest a Corvid change only when'))
  assert.ok(off.includes('The user has turned Corvid suggestions off in Settings: do not suggest Corvid changes.'))
  assert.ok(!off.includes('Suggest a Corvid change only when'))
  assert.ok(off.includes(thesis.threeSentences()), 'the three sentences stay')
})

test('each prompt builder asks for its dose', () => {
  const workers = read('src/main/workers.ts')
  assert.match(workers, /thesisDose\(builtinProject\(\)\?\.id === task\.projectId \? 'full' : 'short', getConfig\(\)\.agentSuggestions !== false\)\.replace\(\/\\n\/g, ' '\)/, 'workers: by project, with the switch, on one line for the command line')
  assert.match(read('src/main/assistant.ts'), /thesisDose\('full'\)/, 'Corvid: the full page')
  assert.match(read('src/main/assistant.ts'), /Raise a suggestion only when the user asks, or when the same one has come from more than one task; never turn one into a task on your own/, 'Corvid: the collector role')
  assert.match(read('src/main/packager.ts'), /thesisDose\('full'\)/, 'the extension wizard: the full page')
  assert.match(read('src/main/newProject.ts'), /threeSentences\(\)/, 'the new-project agent: the three sentences')
  assert.doesNotMatch(read('src/main/newProject.ts'), /suggestRule|shortDose/, 'and no suggest rule: it has no done post')
  assert.match(read('src/main/discussion.ts'), /thesis: thesisDose\(dp\.corvidTopic\?\.\(r\.channel\) \?\? true \? 'full' : 'short', false\)/, 'the panel')
  assert.match(read('src/main/discussion.ts'), /summaryPrompt\(r\.topic, r\.transcript, thesisDose\(/, 'the summary')
  // the neutral prompts: the scan classifier and the usage parser carry nothing about what Corvid is
  for (const p of CLASSIFIER_PROMPTS) assert.doesNotMatch(p, /personal development environment|Corvid builds Corvid/)
  for (const f of ['src/main/extensionScan.ts', 'src/shared/extensionScan.ts', 'src/main/usage.ts', 'src/main/agentPing.ts', 'src/main/wake.ts'])
    assert.doesNotMatch(read(f), /corvidThesis/, `${f} stays neutral`)
})

test('/discuss: the panel and the summary carry the thesis they are given, and work without one', () => {
  const base = { topic: 'Should the self-build be the headline?', me: 'A', angle: discussion.ANGLES[0], others: ['B'], turn: 1, turns: 1, transcript: [], files: false }
  const full = discussion.panelPrompt({ ...base, thesis: thesis.thesisDose('full') })
  assert.ok(full.startsWith(`What Corvid is (${thesis.THESIS_DOC}`))
  assert.ok(full.includes('Topic: Should the self-build be the headline?'))
  const short = discussion.panelPrompt({ ...base, thesis: thesis.thesisDose('short', false) })
  assert.ok(short.includes(thesis.threeSentences()))
  assert.ok(!short.includes('How it is designed to be used.'))
  const none = discussion.panelPrompt(base)
  assert.ok(none.startsWith('You are A, one of 2 panelists'))
  assert.ok(discussion.summaryPrompt('t', [], thesis.thesisDose('full')).includes('Who says so.'))
  assert.ok(discussion.summaryPrompt('t', []).startsWith('You are Corvid, moderating'))
})

test('config: the switch is accepted, old configs load as on, junk is dropped', () => {
  const file = join(globalThis.__userData, 'config.json')
  writeFileSync(file, JSON.stringify({ assistantMode: 'ask' }))
  assert.equal(config.getConfig().agentSuggestions, undefined, 'an old config: absent, which counts as on')
  config.setConfig({ agentSuggestions: false })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).agentSuggestions, false)
  config.setConfig({ agentSuggestions: 'yes' })
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).agentSuggestions, undefined, 'not a boolean: dropped')
  config.setConfig({ agentSuggestions: true })
  assert.equal(config.getConfig().agentSuggestions, true)
})

test('the collector: a "Corvid could:" line is appended once with task, project and date; duplicates are skipped', () => {
  const store = new Map()
  let n = 0
  const notes = {
    find: (name) => [...store.values()].find((x) => x.name === name),
    create: (name, text) => {
      const id = `N${++n}`
      store.set(id, { id, name, text })
      return { id }
    },
    append: (id, text) => {
      store.get(id).text += `\n${text}`
    }
  }
  const date = new Date('2026-10-22T20:00:00Z')
  assert.equal(suggestions.collectSuggestion({ text: "#7's done, all green.", taskId: 7, project: 'Site', date }, notes), 'none')
  assert.equal(store.size, 0, 'no note for a post without a suggestion')
  const post = "#7's done, merged. Corvid could: show the task's branch name on its card.\nNothing else."
  assert.equal(suggestions.collectSuggestion({ text: post, taskId: 7, project: 'Site', date }, notes), 'added')
  const note = notes.find(thesis.SUGGESTIONS_NOTE)
  assert.ok(note, 'the note is created with the fixed name')
  assert.ok(note.text.startsWith(suggestions.SUGGESTIONS_HEADER))
  assert.ok(note.text.includes("- 2026-10-22 · #7 · Site · Corvid could: show the task's branch name on its card."))
  // the same suggestion from another task, with different spacing and case: skipped
  assert.equal(suggestions.collectSuggestion({ text: "Done. corvid could:  Show the task's  branch name on its card", taskId: 9, project: 'Other', date }, notes), 'duplicate')
  assert.equal(suggestions.existingSuggestions(note.text).length, 1)
  // a different one is appended; no project becomes "no project"
  assert.equal(suggestions.collectSuggestion({ text: 'Corvid could: let a note be pinned.', taskId: 9, date }, notes), 'added')
  assert.equal(suggestions.existingSuggestions(note.text).length, 2)
  assert.ok(note.text.includes('- 2026-10-22 · #9 · no project · Corvid could: let a note be pinned.'))
  assert.equal(store.size, 1, 'one note, ever')
  // the bare prefix is not a suggestion
  assert.equal(thesis.suggestionLine('Corvid could:'), undefined)
  assert.equal(thesis.suggestionLine('x'.repeat(10) + '\nCorvid could: ' + 'y'.repeat(600)).length, 500)
})
