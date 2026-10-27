// Fake data for a test copy's Lineage view (#203, grown for #205): npm run test-instance -- start ... --seed writes
// lineage events, board messages and notes into the copy's data folder, so the 3D graph has about 150 nodes across
// eight tasks on first open. The times are relative to now and spread over the last 25 days, so the default 30-day
// window shows all of it and the time fade has something to fade. A fixed random seed keeps it the same each run.
// The tasks sit in two projects (#213), and workers read notes from both, so the project filter has crossings to
// show. Nothing here is real data.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const H = 3_600_000
const D = 24 * H

/** a small deterministic random source (mulberry32), so the seed looks the same on every run */
function rng(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** The two fake projects (#213): the first six tasks live in one, the last two in the other. */
export const SEED_PROJECTS = ['D:\\projects\\example', 'D:\\projects\\sidecar']
const TASKS = [
  [41, 'Settings page: tidy the System tab', 0],
  [42, 'Export button fails on empty boards', 0],
  [43, 'Sidebar build falls over on Linux', 0],
  [44, 'Rename the tabs so people find things', 0],
  [45, 'Clock drifts in the Usage view', 0],
  [46, 'Flock check-ins on the board', 0],
  [47, 'Notes search: match on names too', 1],
  [48, 'Docs lint: catch the banned words', 1]
]
const NAMES = [
  'Interim Button Architect',
  'Regional Release Wrangler',
  'Head Docstring Tamer',
  'Principal Directory Consultant',
  'Chief Sidebar Whisperer',
  'Senior Clock Winder',
  'Deputy Tab Namer',
  'Acting Notes Librarian',
  'Junior Lint Picker',
  'Visiting Export Fixer',
  'Second Sidebar Whisperer',
  'Relief Release Wrangler',
  'Night Shift Clock Winder',
  'Assistant Docs Linter',
  'Weekend Export Fixer',
  'Substitute Tab Namer'
]

/** Everything the seed produces: lineage events, board messages and notes, each ready to write. */
export function lineageSeedAll(now = Date.now()) {
  const r = rng(205)
  const pick = (xs) => xs[Math.floor(r() * xs.length)]
  const events = []
  const messages = []
  const notes = []
  let nextMsg = 1
  let nextNote = 1
  const corvid = { kind: 'assistant' }
  const post = (ts, who, text, extra = {}) => {
    const id = nextMsg++
    const m = { id, ts, text, ...(who === 'user' ? { author: 'user' } : who.kind === 'assistant' ? { author: 'assistant' } : { author: 'agent', agentName: who.agentName, taskId: who.taskId }), ...extra }
    messages.push(m)
    if (who !== 'user') events.push({ kind: 'board-post', ts, actor: who, messageId: id, ...(extra.done ? { done: true } : {}) })
    return id
  }
  const note = (ts, who, name, text) => {
    const id = `N${nextNote++}`
    notes.push({ id, name, text, ts, who })
    if (who !== 'user') events.push({ kind: 'note-written', ts, actor: who, noteId: id, action: 'created' })
    return id
  }

  // three notes of the user's own, read by workers later
  const t0 = now - 25 * D
  const userNotes = [note(t0, 'user', 'Ideas for the sidebar', 'Narrower rail, icons with labels on hover.'), note(t0 + 2 * H, 'user', 'Release checklist', 'Typecheck, tests, docs lint, then deploy.'), note(t0 + 5 * H, 'user', 'Board voice', 'Casual, warm, a bit dry. One crow-ism per post.')]
  post(t0 + 6 * H, 'user', 'Morning, flock. Tasks are on the board.')

  // twelve workers across eight tasks, one every two days or so
  const agentNotes = []
  const workerOf = []
  NAMES.forEach((agentName, i) => {
    const [taskId, title, projectIndex] = TASKS[i % TASKS.length]
    const project = SEED_PROJECTS[projectIndex]
    const actor = { kind: 'agent', agentName, taskId }
    const start = t0 + 8 * H + i * 2 * D + r() * 12 * H
    const workerId = `seed${i + 1}`
    const inputs = [
      { kind: 'task', origin: `task #${taskId}`, chars: 300 + Math.floor(r() * 900) },
      ...(r() < 0.4 ? [{ kind: 'files', origin: `files attached to #${taskId}`, chars: 800 + Math.floor(r() * 3000) }] : []),
      { kind: 'claude-md', origin: `${project}\\CLAUDE.md`, chars: 620 },
      { kind: 'rules', origin: 'Corvid (workers.ts and the tool prompts)', chars: 11800 },
      { kind: 'thesis', origin: 'docs/getting-started/what-corvid-is.md', chars: 4900 },
      ...(r() < 0.35 ? [{ kind: 'extra', origin: `instructions typed at start for #${taskId}`, chars: 120 + Math.floor(r() * 400) }] : [])
    ]
    events.push({ kind: 'worker-started', ts: start, workerId, agentName, taskId, project, inputs })
    workerOf.push({ actor, workerId, start, taskId, title })
    // reads the board, then says hello
    const recent = messages.slice(-6).map((m) => m.id)
    events.push({ kind: 'board-read', ts: start + 20_000, actor, messageIds: recent })
    post(start + 40_000, actor, `#${taskId} is mine: ${title.toLowerCase()}. Off to peck at it.`)
    if (inputs.some((x) => x.kind === 'files')) events.push({ kind: 'task-file-read', ts: start + 60_000, actor, taskId, file: 'mockup.png' })
    // reads a few earlier notes: the user's and other workers', and the first worker of the second project always
    // reads the newest note from the first, so the project view has a crossing to show whatever the dice say
    const pool = [...userNotes, ...agentNotes]
    const reads = new Set()
    if (projectIndex === 1 && i < TASKS.length && agentNotes.length) reads.add(agentNotes[agentNotes.length - 1])
    for (let k = 0; k < 1 + Math.floor(r() * 3) && pool.length; k++) reads.add(pick(pool))
    let t = start + 5 * 60_000
    for (const id of reads) {
      events.push({ kind: 'note-read', ts: t, actor, noteId: id })
      t += 60_000
    }
    // a finding, a question now and then, one or two notes
    post(t + 10 * 60_000, actor, `Finding on #${taskId}: the old code was doing it twice. Made it once.`)
    if (r() < 0.6) post(t + 12 * 60_000, actor, `Decision on #${taskId}, made on a guess: kept the old file name.`)
    if (r() < 0.4) post(t + 14 * 60_000, actor, `Quick one, @Robin: keep the old name or drop it? Carrying on with drop.`, { question: true, addressedTo: 'user' })
    const n1 = note(t + 20 * 60_000, actor, `#${taskId} ${title}: findings`, `What changed for #${taskId} and why. Written by ${agentName}.`)
    agentNotes.push(n1)
    if (r() < 0.5) agentNotes.push(note(t + 25 * 60_000, actor, `#${taskId} follow-ups`, `What is left after #${taskId}.`))
    // an append to a note read earlier, sometimes
    if (r() < 0.4 && reads.size) events.push({ kind: 'note-written', ts: t + 28 * 60_000, actor, noteId: [...reads][0], action: 'appended' })
    // merge and done
    const merged = r() < 0.8
    if (merged) events.push({ kind: 'worker-merged', ts: t + 35 * 60_000, workerId, taskId, project })
    post(t + 36 * 60_000, actor, merged ? `#${taskId}'s merged into main, not deployed. Typecheck and tests pass; needs a rebuild to land.` : `Stopping on #${taskId}: ran out of time, branch left for the user. Details in ${n1}.`, { done: true, addressedTo: 'user' })
    events.push({ kind: 'worker-ended', ts: t + 37 * 60_000, workerId, taskId, reason: merged ? 'finished' : 'time limit' })
    // Corvid reads the note and the done post and answers; the user chimes in now and then
    events.push({ kind: 'note-read', ts: t + 50 * 60_000, actor: corvid, noteId: n1 })
    events.push({ kind: 'board-read', ts: t + 51 * 60_000, actor: corvid, messageIds: messages.slice(-4).map((m) => m.id) })
    const reply = post(t + 52 * 60_000, corvid, `Noted: #${taskId} ${merged ? 'landed' : 'is parked'}. ${n1} has the details.`)
    if (r() < 0.5) post(t + 60 * 60_000, 'user', 'go', { replyTo: reply })
  })
  // a worker pinged while it ran, and one woken after it finished
  const a = workerOf[4]
  const b = workerOf[2]
  const pingPost = post(a.start + 15 * 60_000, b.actor, `@${a.actor.agentName} heads up, we both touch the sidebar css.`)
  events.push({ kind: 'ping', ts: a.start + 15 * 60_000 + 1000, from: b.actor.agentName, to: a.actor.agentName, messageId: pingPost, wake: false })
  const wakePost = post(now - 3 * H, 'user', `@${b.actor.agentName} one more thing on the sidebar.`)
  events.push({ kind: 'ping', ts: now - 3 * H + 1000, from: 'user', to: b.actor.agentName, messageId: wakePost, wake: true })
  // Corvid's own note, read by the last few workers
  const cn = note(now - 10 * D, corvid, 'Corvid could: suggestions collected', 'Suggestions from done posts, one line each.')
  for (const w of workerOf.slice(-3)) events.push({ kind: 'note-read', ts: w.start + 3 * 60_000, actor: w.actor, noteId: cn })
  events.sort((x, y) => x.ts - y.ts)
  messages.sort((x, y) => x.ts - y.ts)
  return { events, messages, notes }
}

/** The lineage events alone, for the tests and for anyone who only wants the log. */
export function lineageSeed(now = Date.now()) {
  return lineageSeedAll(now).events
}

/** Write the seed into a test copy's data folder: lineage.jsonl, the board's messages and the notes. */
export function writeLineageSeed(dataDir, now = Date.now()) {
  const { events, messages, notes } = lineageSeedAll(now)
  writeFileSync(join(dataDir, 'lineage.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n')
  const board = join(dataDir, 'board')
  mkdirSync(board, { recursive: true })
  writeFileSync(join(board, 'messages.jsonl'), messages.map((m) => JSON.stringify(m)).join('\n') + '\n')
  writeFileSync(join(board, 'board.json'), JSON.stringify({ nextId: messages.length + 1, seenUpTo: 0, channelSeen: {} }))
  const dir = join(dataDir, 'notes')
  mkdirSync(dir, { recursive: true })
  for (const n of notes) {
    const who = n.who === 'user' ? 'user' : n.who.kind === 'assistant' ? 'assistant' : 'agent'
    const head = [`id: ${n.id}`, `name: ${n.name}`, `author: ${who}`, ...(who === 'agent' ? [`agent: ${n.who.agentName}`, `task: ${n.who.taskId}`] : []), `created: ${new Date(n.ts).toISOString()}`, `updated: ${new Date(n.ts).toISOString()}`]
    writeFileSync(join(dir, `${n.id}.md`), `---\n${head.join('\n')}\n---\n\n${n.text}\n`)
  }
  writeFileSync(join(dir, '.notes.json'), JSON.stringify({ nextId: notes.length + 1, unread: [] }))
  return { events: events.length, messages: messages.length, notes: notes.length }
}
