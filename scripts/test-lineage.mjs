// Tests for #203, the lineage log and the Lineage view's graph: the reader on a file with bad lines and a Windows
// path in it, the append, and the graph derived from fixture events, notes, messages and tasks (never real data).
// src/main/lineage.ts needs no electron, so it loads with the TypeScript loader alone.
//
//   npm run test-lineage

import { register } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

const main = await import(pathToFileURL(join(root, 'src', 'main', 'lineage.ts')).href)
const shared = await import(pathToFileURL(join(root, 'src', 'shared', 'lineage.ts')).href)

const tmp = mkdtempSync(join(tmpdir(), 'corvid-lineage-'))
after(() => rmSync(tmp, { recursive: true, force: true }))

const NOW = Date.parse('2026-10-27T12:00:00Z')
const H = 3_600_000
const D = 24 * H
const WIN_PATH = 'D:\\projects\\dashboard\\CLAUDE.md'

const agent = { kind: 'agent', agentName: 'Interim Button Architect', taskId: 203 }
const corvid = { kind: 'assistant' }

const events = [
  {
    kind: 'worker-started',
    ts: NOW - 2 * H,
    workerId: 'w1',
    agentName: 'Interim Button Architect',
    taskId: 203,
    project: 'D:\\projects\\dashboard',
    inputs: [
      { kind: 'task', origin: 'task #203', chars: 1200 },
      { kind: 'claude-md', origin: WIN_PATH, chars: 480 },
      { kind: 'rules', origin: 'Corvid', chars: 9000 },
      { kind: 'thesis', origin: 'docs/getting-started/what-corvid-is.md', chars: 5000 }
    ]
  },
  { kind: 'note-read', ts: NOW - 2 * H + 60_000, actor: agent, noteId: 'N125' },
  { kind: 'board-read', ts: NOW - 2 * H + 70_000, actor: agent, messageIds: [900, 901] },
  { kind: 'board-post', ts: NOW - 2 * H + 80_000, actor: agent, messageId: 902 },
  { kind: 'note-written', ts: NOW - H, actor: agent, noteId: 'N130', action: 'created' },
  { kind: 'note-read', ts: NOW - H + 1000, actor: corvid, noteId: 'N130' },
  { kind: 'note-read', ts: NOW - H + 2000, actor: corvid, noteId: 'N99' },
  { kind: 'worker-merged', ts: NOW - 30 * 60_000, workerId: 'w1', taskId: 203, project: 'D:\\projects\\dashboard' },
  { kind: 'board-post', ts: NOW - 29 * 60_000, actor: agent, messageId: 903, done: true },
  { kind: 'worker-ended', ts: NOW - 20 * 60_000, workerId: 'w1', taskId: 203, reason: 'finished' },
  // an old worker on another task, outside a 7-day window
  { kind: 'worker-started', ts: NOW - 20 * D, workerId: 'w0', agentName: 'Old Crow', taskId: 7, project: 'D:\\projects\\other', inputs: [{ kind: 'task', origin: 'task #7', chars: 10 }] }
]
const notes = [
  { id: 'N125', name: 'thesis.md v5', text: 'x'.repeat(12000), author: 'assistant', created: NOW - 5 * H, updated: NOW - 5 * H, size: 12000, rev: '', file: '' },
  { id: 'N130', name: 'Lineage findings', text: 'y'.repeat(300), author: 'agent', agentName: 'Interim Button Architect', taskId: 203, created: NOW - H, updated: NOW - H, size: 300, rev: '', file: '' },
  { id: 'N1', name: 'Old note', text: 'z', author: 'user', created: NOW - 30 * D, updated: NOW - 30 * D, size: 1, rev: '', file: '' }
]
const messages = [
  { id: 900, ts: NOW - 3 * H, author: 'user', text: 'go' },
  { id: 901, ts: NOW - 3 * H + 1, author: 'agent', agentName: 'Old Crow', taskId: 7, text: 'done long ago', done: true },
  { id: 902, ts: NOW - 2 * H + 80_000, author: 'agent', agentName: 'Interim Button Architect', taskId: 203, text: 'starting #203' },
  { id: 903, ts: NOW - 29 * 60_000, author: 'agent', agentName: 'Interim Button Architect', taskId: 203, text: 'done with #203', done: true }
]
const tasks = [{ id: 203, title: 'Lineage tab prototype', notes: '', column: 'doing', order: 0, createdAt: 0, updatedAt: 0 }]

test('the reader skips bad lines and keeps a Windows path byte for byte', () => {
  const file = join(tmp, 'read.jsonl')
  writeFileSync(file, [JSON.stringify(events[0]), 'not json at all', JSON.stringify({ kind: 'something-else', ts: 1 }), JSON.stringify({ kind: 'note-read', ts: 'no' }), '', JSON.stringify(events[1])].join('\n') + '\n')
  const got = main.readLineage(file)
  assert.equal(got.length, 2)
  assert.equal(got[0].inputs[1].origin, WIN_PATH)
  assert.equal(got[1].kind, 'note-read')
  assert.deepEqual(main.readLineage(join(tmp, 'missing.jsonl')), [])
})

test('logLineage appends one line per event once the folder is set, and is a no-op before', () => {
  main.logLineage({ kind: 'ping', ts: 1, from: 'a', to: 'b', messageId: 1, wake: false })
  main.initLineage(tmp)
  main.workerEnded({ id: 'w9', taskId: 9, reason: 'stopped' })
  main.noteRead({ kind: 'agent', agentName: 'A', taskId: 9, request: () => 'closure dropped' }, 'N5')
  main.boardRead({ kind: 'agent', taskId: 9 }, [])
  const lines = readFileSync(join(tmp, main.LINEAGE_FILE), 'utf8').trim().split('\n')
  assert.equal(lines.length, 2)
  const e = JSON.parse(lines[1])
  assert.deepEqual(e.actor, { kind: 'agent', agentName: 'A', taskId: 9 })
  assert.equal(main.readLineage().length, 2)
})

test('the graph: three lanes, started edges with sizes, wrote, read and merged edges', () => {
  const g = shared.deriveLineage({ events, notes, messages, tasks, now: NOW }, { days: 7 })
  const ids = new Set(g.nodes.map((n) => n.id))
  const worker = shared.agentNodeId(agent)
  assert.ok(ids.has(worker))
  assert.ok(ids.has(shared.CORVID_NODE))
  assert.ok(ids.has('source:task:203') && ids.has('source:claude-md:d:\\projects\\dashboard') && ids.has('source:rules') && ids.has('source:thesis'))
  assert.ok(ids.has('note:N125') && ids.has('note:N130') && ids.has('post:902') && ids.has('post:903'))
  assert.ok(!ids.has('note:N1'), 'a user note outside the window is not shown')
  assert.ok(!ids.has('agent:7:old crow'), 'an old worker is outside the window')
  assert.ok(!ids.has('post:900'), "the user's post is not an agent's artifact")
  assert.equal(g.nodes.find((n) => n.id === 'post:903').type, 'done')
  assert.equal(g.nodes.find((n) => n.id === 'note:N99').gone, true, 'a deleted note that was read still shows')
  const started = g.edges.filter((e) => e.kind === 'started' && e.to === worker)
  assert.deepEqual(
    started.map((e) => [e.from, e.chars]),
    [
      ['source:task:203', 1200],
      ['source:claude-md:d:\\projects\\dashboard', 480],
      ['source:rules', 9000],
      ['source:thesis', 5000]
    ]
  )
  assert.ok(g.edges.some((e) => e.kind === 'wrote' && e.from === worker && e.to === 'note:N130'))
  assert.equal(g.edges.filter((e) => e.kind === 'wrote' && e.from === worker && e.to === 'note:N130').length, 1, 'the creation is one edge, not two')
  assert.ok(g.edges.some((e) => e.kind === 'read' && e.from === 'note:N125' && e.to === worker))
  assert.ok(g.edges.some((e) => e.kind === 'read' && e.from === 'note:N130' && e.to === shared.CORVID_NODE))
  assert.ok(g.edges.some((e) => e.kind === 'merged' && e.from === worker && e.to === shared.projectNodeId('D:\\projects\\dashboard')))
  assert.ok(!g.edges.some((e) => e.kind === 'read' && e.from === 'post:902' && e.to === worker), 'reading your own post is not a read edge')
  assert.equal(g.events, events.length)
  assert.equal(g.loggedSince, NOW - 20 * D)
  for (let i = 1; i < g.nodes.length; i++) assert.ok(g.nodes[i - 1].ts <= g.nodes[i].ts, 'nodes come in time order')
})

test('the receipt lists inputs with sizes, then reads and writes in time order', () => {
  const g = shared.deriveLineage({ events, notes, messages, tasks, now: NOW }, { days: 7 })
  const lines = shared.receiptOf(g, shared.agentNodeId(agent))
  assert.deepEqual(lines.slice(0, 4).map((l) => l.what), ['started with', 'started with', 'started with', 'started with'])
  assert.equal(lines[1].node.label, 'CLAUDE.md (dashboard)')
  assert.deepEqual(
    lines.slice(4).map((l) => `${l.what} ${l.node.id}`),
    ['read note:N125', 'read post:901', 'wrote post:902', 'wrote note:N130', 'merged into project:d:\\projects\\dashboard', 'wrote post:903']
  )
  const r = shared.readersOf(g, 'note:N130')
  assert.equal(r.by.id, shared.agentNodeId(agent))
  assert.deepEqual(
    r.readers.map((x) => x.node.id),
    [shared.CORVID_NODE]
  )
})

test('all time shows the old worker; one task keeps its agents, their artifacts and whoever touched them', () => {
  const all = shared.deriveLineage({ events, notes, messages, tasks, now: NOW }, { days: 0 })
  assert.ok(all.nodes.some((n) => n.id === 'agent:7:old crow'))
  assert.ok(all.nodes.some((n) => n.id === 'note:N1'))
  const one = shared.deriveLineage({ events, notes, messages, tasks, now: NOW }, { days: 7, taskId: 203 })
  const ids = new Set(one.nodes.map((n) => n.id))
  assert.ok(ids.has(shared.agentNodeId(agent)) && ids.has('note:N130') && ids.has('post:903'))
  assert.ok(ids.has('note:N125'), 'a note of another author that the task read comes along')
  assert.ok(ids.has(shared.CORVID_NODE), 'Corvid read the task note, so it comes along')
  assert.ok(!ids.has('note:N99'), "Corvid's other reads do not")
  assert.ok(!ids.has('agent:7:old crow'))
  const none = shared.deriveLineage({ events, notes, messages, tasks, now: NOW }, { days: 7, taskId: 999 })
  assert.equal(none.nodes.length, 0)
  assert.equal(none.events, events.length)
})

test('an empty log and no data is an empty graph with no loggedSince', () => {
  const g = shared.deriveLineage({ events: [], notes: [], messages: [], tasks: [] }, { days: 7 })
  assert.deepEqual(g, { nodes: [], edges: [], loggedSince: undefined, events: 0, projects: [] })
})

// ---------- the 3D view's helpers (#205) ----------

const helpers = await import(pathToFileURL(join(root, 'src', 'renderer', 'src', 'lineage', 'helpers.ts')).href)

test('the node cap keeps the newest nodes and only the edges between them, and says how many fell off', () => {
  const nodes = Array.from({ length: 10 }, (_, i) => ({ id: `n${i}`, lane: 'artifact', type: 'note', label: `n${i}`, ts: NOW - i * H }))
  const edges = [
    { from: 'n0', to: 'n1', kind: 'read', ts: NOW },
    { from: 'n0', to: 'n9', kind: 'read', ts: NOW },
    { from: 'n8', to: 'n9', kind: 'wrote', ts: NOW }
  ]
  const { graph, dropped } = helpers.capNodes({ nodes, edges, events: 0 }, 4)
  assert.equal(dropped, 6)
  assert.deepEqual(
    graph.nodes.map((n) => n.id),
    ['n0', 'n1', 'n2', 'n3']
  )
  assert.deepEqual(graph.edges, [edges[0]], 'edges to dropped nodes go with them')
  const same = helpers.capNodes({ nodes, edges, events: 0 }, 10)
  assert.equal(same.dropped, 0)
  assert.equal(same.graph.nodes, nodes, 'under the cap the graph is handed back as is')
})

test('the time fade: newest brightest, oldest at the floor, one node bright', () => {
  assert.equal(helpers.fadeOf(NOW, NOW - D, NOW), 1)
  assert.equal(helpers.fadeOf(NOW - D, NOW - D, NOW), 0.22)
  assert.ok(Math.abs(helpers.fadeOf(NOW - D / 2, NOW - D, NOW) - 0.61) < 1e-9)
  assert.equal(helpers.fadeOf(NOW, NOW, NOW), 1)
  assert.equal(helpers.fadeOf(NOW - 5 * D, NOW - D, NOW), 0.22, 'never below the floor')
  assert.deepEqual(helpers.timeSpan([{ ts: 5 }, { ts: 2 }, { ts: 9 }]), { oldest: 2, newest: 9 })
  assert.equal(helpers.timeSpan([]), undefined)
})

test('size by degree with a floor, and particles only on read and wrote edges, thinned past the cap', () => {
  assert.equal(helpers.radiusOf(0), 1.6)
  assert.ok(helpers.radiusOf(9) > helpers.radiusOf(1))
  assert.ok(helpers.radiusOf(1000) <= 6, 'a hub does not swallow the picture')
  assert.ok(helpers.radiusOf(0, true) >= 7, 'Corvid is large however few edges it has')
  const edges = Array.from({ length: 1200 }, (_, i) => ({ from: 'a', to: 'b', kind: i % 3 === 0 ? 'started' : 'read', ts: 0 }))
  const p = helpers.particleEdges(edges, 500)
  assert.ok(p.length <= 500 && p.length >= 250, `about the cap, got ${p.length}`)
  assert.ok(p.every((i) => edges[i].kind === 'read'))
  assert.deepEqual(helpers.particleEdges(edges.slice(0, 9), 500), [1, 2, 4, 5, 7, 8])
})

// #209: the pick's levels in the Context cloud, pinned so the contrast does not drift
const levels = await import(pathToFileURL(join(root, 'src', 'renderer', 'src', 'lineage', 'helpers.ts')).href)

test('levels: selected 100%, neighbours and their edges 90%, the rest 20%, nothing picked 100%', () => {
  const { LEVEL_OPACITY, levelOf, edgeLevelOf, brightnessOf } = levels
  assert.deepEqual(LEVEL_OPACITY, { none: 1, selected: 1, neighbour: 0.9, other: 0.2 })
  const near = new Set(['b'])
  assert.equal(levelOf('a', 'a', near), 'selected')
  assert.equal(levelOf('b', 'a', near), 'neighbour')
  assert.equal(levelOf('c', 'a', near), 'other')
  assert.equal(levelOf('c', undefined, near), 'none')
  assert.equal(edgeLevelOf('a', 'b', 'a'), 'neighbour')
  assert.equal(edgeLevelOf('b', 'a', 'a'), 'neighbour')
  assert.equal(edgeLevelOf('b', 'c', 'a'), 'other')
  assert.equal(edgeLevelOf('b', 'c', undefined), 'none')
  assert.equal(brightnessOf('selected', 0.3), 1, 'the picked node is at full brightness whatever its age')
  assert.equal(brightnessOf('neighbour', 1), 0.9)
  assert.equal(brightnessOf('other', 1), 0.2)
  assert.equal(brightnessOf('none', 1), 1)
})

test('levels: the time fade stays inside a level, so an old neighbour is below a new one and never above 90%', () => {
  const { brightnessOf, fadeOf } = levels
  const oldFade = fadeOf(0, 0, 100)
  const newFade = fadeOf(100, 0, 100)
  assert.ok(brightnessOf('neighbour', oldFade) < brightnessOf('neighbour', newFade))
  assert.ok(brightnessOf('neighbour', oldFade) <= 0.9)
  assert.ok(brightnessOf('other', newFade) <= 0.2)
  assert.equal(brightnessOf('none', oldFade), oldFade, 'with nothing picked the fade is the only dimming')
  assert.equal(brightnessOf('other', 2), 0.2, 'a fade above 1 is clamped')
})

test('levels: the linear gain keeps the order of the levels and maps 20% to a small linear factor', () => {
  const { linearGain } = levels
  assert.equal(linearGain('none'), 1)
  assert.equal(linearGain('selected'), 1)
  assert.ok(linearGain('neighbour') > linearGain('other'))
  assert.ok(linearGain('neighbour') > 0.75 && linearGain('neighbour') < 0.9)
  assert.ok(linearGain('other') > 0.02 && linearGain('other') < 0.05)
})

// ---------- #210: live updates ----------

test('live: the batcher sends events appended within a second together, in order, and a later one apart', async () => {
  const sent = []
  const b = main.createBatcher((evs) => sent.push(evs), 40)
  b.push({ kind: 'worker-ended', ts: 1, workerId: 'a', taskId: 1, reason: 'x' })
  b.push({ kind: 'worker-ended', ts: 2, workerId: 'b', taskId: 1, reason: 'x' })
  b.push({ kind: 'worker-ended', ts: 3, workerId: 'c', taskId: 1, reason: 'x' })
  assert.equal(sent.length, 0, 'nothing goes out before the timer')
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(sent.length, 1)
  assert.deepEqual(
    sent[0].map((e) => e.workerId),
    ['a', 'b', 'c']
  )
  b.push({ kind: 'worker-ended', ts: 4, workerId: 'd', taskId: 1, reason: 'x' })
  b.flush()
  assert.equal(sent.length, 2, 'flush sends at once')
  assert.equal(sent[1][0].workerId, 'd')
  b.flush()
  assert.equal(sent.length, 2, 'an empty flush sends nothing')
})

test('live: logLineage pushes each append to the sink, batched', async () => {
  // its own folder: the shared one is removed once the tests registered before the helpers import are done
  const dir = mkdtempSync(join(tmpdir(), 'corvid-lineage-live-'))
  const sent = []
  main.initLineage(dir)
  main.setLineageSink((evs) => sent.push(evs), 30)
  main.workerEnded({ id: 'w10', taskId: 10, reason: 'stopped' })
  main.noteRead({ kind: 'agent', agentName: 'A', taskId: 10 }, 'N6')
  await new Promise((r) => setTimeout(r, 70))
  main.setLineageSink(undefined)
  assert.equal(readFileSync(join(dir, main.LINEAGE_FILE), 'utf8').trim().split('\n').length, 2, 'both were written as well')
  rmSync(dir, { recursive: true, force: true })
  assert.equal(sent.length, 1)
  assert.deepEqual(
    sent[0].map((e) => e.kind),
    ['worker-ended', 'note-read']
  )
})

test('live: deriveLineage grows a seed graph by a batch and adds nothing twice', () => {
  const base = shared.deriveLineage({ events, notes, messages, tasks, now: NOW }, { days: 30 })
  const baseIds = base.nodes.map((n) => n.id).sort()
  const again = shared.deriveLineage({ events: [], notes, messages, tasks, now: NOW }, { days: 30 }, base)
  assert.equal(again.nodes.length, base.nodes.length, 'the notes and posts that exist add no second node')
  assert.equal(again.edges.length, base.edges.length, 'and no second wrote edge')
  assert.equal(again.events, base.events)
  assert.equal(again.loggedSince, base.loggedSince)
  const batch = [
    { kind: 'note-read', ts: NOW + 1000, actor: { kind: 'agent', agentName: 'New Crow', taskId: 204 }, noteId: 'N130' },
    { kind: 'worker-merged', ts: NOW + 2000, workerId: 'w1', taskId: 203, project: 'D:\\projects\\dashboard' }
  ]
  const grown = shared.deriveLineage({ events: batch, notes: [], messages: [], tasks, now: NOW }, { days: 30 }, base)
  assert.equal(grown.nodes.length, base.nodes.length + 1, 'one new agent node')
  const agentId = shared.agentNodeId(batch[0].actor)
  assert.ok(grown.nodes.some((n) => n.id === agentId))
  assert.ok(grown.edges.some((e) => e.from === 'note:N130' && e.to === agentId && e.kind === 'read'))
  // a merge without its worker-started in the batch finds the task's worker in the seed
  const merged = grown.edges.filter((e) => e.kind === 'merged')
  assert.equal(merged.length, 2, 'the new merge edge joins the old one, from the same worker')
  assert.equal(merged[0].from, merged[1].from)
  assert.deepEqual(base.nodes.map((n) => n.id).sort(), baseIds, 'the seed is untouched')
  assert.equal(grown.events, base.events + 2)
})

test('live: eventInFilter drops what the window or the task excludes and keeps the one-hop reads', () => {
  const g = shared.deriveLineage({ events, notes, messages, tasks, now: NOW }, { taskId: 203 })
  const other = { kind: 'note-read', ts: NOW, actor: { kind: 'agent', agentName: 'X', taskId: 9 }, noteId: 'N999' }
  const hop = { kind: 'note-read', ts: NOW, actor: { kind: 'agent', agentName: 'X', taskId: 9 }, noteId: 'N130' }
  const own = { kind: 'board-post', ts: NOW, actor: agent, messageId: 950 }
  assert.equal(shared.eventInFilter(other, { taskId: 203 }, g, NOW), false)
  assert.equal(shared.eventInFilter(hop, { taskId: 203 }, g, NOW), true, 'another agent reading the task note is one hop')
  assert.equal(shared.eventInFilter(own, { taskId: 203 }, g, NOW), true)
  assert.equal(shared.eventInFilter({ ...other, ts: NOW - 40 * D }, { days: 30 }, g, NOW), false, 'outside the day window')
  assert.equal(shared.eventInFilter(other, { days: 30 }, g, NOW), true)
  assert.equal(shared.eventInFilter(other, {}, g, NOW), true)
})

test('live: mergeIncoming places a new node next to its anchor, keeps the rest where it was, and respects the cap', () => {
  const { mergeIncoming } = levels
  const cur = {
    nodes: [
      { id: 'agent:corvid', lane: 'agent', type: 'corvid', label: 'Corvid', ts: 10 },
      { id: 'note:N1', lane: 'artifact', type: 'note', label: 'N1', ts: 20 }
    ],
    edges: [{ from: 'note:N1', to: 'agent:corvid', kind: 'read', ts: 20 }],
    events: 1
  }
  const pos = new Map([
    ['agent:corvid', [0, 0, 0]],
    ['note:N1', [50, 0, 0]]
  ])
  const incoming = {
    nodes: [...cur.nodes, { id: 'agent:5:crow', lane: 'agent', type: 'worker', label: 'crow (#5)', ts: 30, taskId: 5 }, { id: 'note:N2', lane: 'artifact', type: 'note', label: 'N2', ts: 40 }],
    edges: [...cur.edges, { from: 'note:N1', to: 'agent:5:crow', kind: 'read', ts: 30 }, { from: 'agent:5:crow', to: 'note:N2', kind: 'wrote', ts: 40 }],
    events: 3
  }
  const rand = () => 0.75
  const m = mergeIncoming(cur, pos, incoming, 2000, rand)
  assert.deepEqual(m.added, ['agent:5:crow', 'note:N2'])
  assert.equal(m.addedEdges.length, 2)
  assert.equal(m.dropped, 0)
  assert.deepEqual(m.pos.get('note:N1'), [50, 0, 0], 'an old node does not move')
  const crow = m.pos.get('agent:5:crow')
  assert.ok(Math.hypot(crow[0] - 50, crow[1], crow[2]) < 8, `the worker lands next to the note it read: ${crow}`)
  const n2 = m.pos.get('note:N2')
  assert.ok(Math.hypot(n2[0] - crow[0], n2[1] - crow[1], n2[2] - crow[2]) < 8, 'the note it wrote lands next to the worker, placed in the same step')
  assert.equal(m.graph.nodes.length, 4)
  // the same batch again adds nothing
  const twice = mergeIncoming(m.graph, m.pos, incoming, 2000, rand)
  assert.equal(twice.added.length, 0)
  assert.equal(twice.addedEdges.length, 0)
  // the cap: the oldest fall off, with their edges and positions, and dropped says how many
  const capped = mergeIncoming(cur, pos, incoming, 3, rand)
  assert.equal(capped.dropped, 1)
  assert.equal(capped.graph.nodes.length, 3)
  assert.ok(!capped.graph.nodes.some((n) => n.id === 'agent:corvid'), 'the oldest went')
  assert.ok(!capped.pos.has('agent:corvid'))
  assert.ok(capped.graph.edges.every((e) => e.from !== 'agent:corvid' && e.to !== 'agent:corvid'))
})

test('live: an edge is active for 10 s, eases over the next 10 s, is normal after, and a repeat restarts it', () => {
  const { ACTIVE_MS, ACTIVE_EASE_MS, activityOf, activityStateOf } = levels
  assert.equal(ACTIVE_MS, 10_000)
  assert.equal(ACTIVE_EASE_MS, 10_000)
  const t0 = 1_000_000
  assert.equal(activityStateOf(t0, t0), 'active')
  assert.equal(activityStateOf(t0, t0 + 9_999), 'active')
  assert.equal(activityOf(t0, t0 + 9_999), 1)
  assert.equal(activityStateOf(t0, t0 + 10_001), 'easing')
  const mid = activityOf(t0, t0 + 15_000)
  assert.ok(mid > 0 && mid < 1)
  assert.ok(activityOf(t0, t0 + 12_000) > mid && mid > activityOf(t0, t0 + 18_000), 'eases down')
  assert.equal(activityStateOf(t0, t0 + 20_000), 'normal')
  assert.equal(activityOf(t0, t0 + 20_000), 0)
  assert.equal(activityOf(undefined, t0), 0, 'an edge with no live event is normal')
  // the same agent reading the same note again: the newer event time is the clock now
  const again = Math.max(t0, t0 + 15_000)
  assert.equal(activityStateOf(again, t0 + 15_000), 'active')
  assert.equal(activityStateOf(again, t0 + 24_000), 'active')
})

test('live: the levels on top of the pick: active 100%, 60% outside a selection, running started edges at 90%', () => {
  const { ACTIVE_OTHER_OPACITY, RUNNING_STARTED_OPACITY, ARRIVAL_PULSE_MS, LEVEL_OPACITY, liveEdgeOpacity, liveNodeOpacity, pulseScale, breathScale } = levels
  assert.equal(ACTIVE_OTHER_OPACITY, 0.6)
  assert.equal(RUNNING_STARTED_OPACITY, LEVEL_OPACITY.neighbour)
  assert.equal(ARRIVAL_PULSE_MS, 1000)
  assert.equal(liveEdgeOpacity('none', 0.3, 'read', 1, false), 1, 'active: 100% whatever the fade')
  assert.equal(liveEdgeOpacity('neighbour', 0.3, 'read', 1, false), 1, 'active inside the selection: 100%')
  assert.equal(liveEdgeOpacity('other', 0.3, 'read', 1, false), 0.6, 'active outside the selection: 60%')
  assert.equal(liveEdgeOpacity('none', 0.3, 'read', 0, false), 0.3, 'normal: the fade')
  const half = liveEdgeOpacity('none', 0.3, 'read', 0.5, false)
  assert.ok(half > 0.3 && half < 1, 'easing sits between')
  assert.equal(liveEdgeOpacity('none', 0.3, 'started', 0, true), 0.9, 'a running worker started edge holds the neighbour level')
  assert.equal(liveEdgeOpacity('none', 0.3, 'read', 0, true), 0.3, 'its read edges do not')
  assert.equal(liveEdgeOpacity('other', 0.3, 'started', 0, true), LEVEL_OPACITY.other * 0.3, 'outside a selection the pick wins')
  assert.equal(liveNodeOpacity('none', 0.3, 1), 1)
  assert.equal(liveNodeOpacity('other', 0.3, 1), 0.6)
  assert.equal(liveNodeOpacity('selected', 0.3, 0), 1)
  assert.equal(pulseScale(-1), 1)
  assert.ok(pulseScale(500) > 1.5)
  assert.equal(pulseScale(1000), 1, 'after the pulse the node is its normal size')
  assert.ok(Math.abs(breathScale(0) - 1) < 0.1 && breathScale(700) > 1)
})

test('live: the catch-up queue holds batches while hidden, gives them all once when shown, and passes them through when visible', () => {
  const { LiveQueue } = levels
  const q = new LiveQueue()
  assert.deepEqual(q.offer([1, 2], true), [1, 2], 'visible: applied now, nothing queued')
  assert.equal(q.size, 0)
  assert.deepEqual(q.offer([3], false), [], 'hidden: queued')
  assert.deepEqual(q.offer([4, 5], false), [])
  assert.equal(q.size, 3)
  assert.deepEqual(q.take(), [3, 4, 5], 'shown: the whole queue in one step')
  assert.deepEqual(q.take(), [], 'and only once')
  assert.equal(q.size, 0)
})

// ---------- #212: curved edges ----------

test('curved edges: the bend angle is stable per edge key, in range, and differs between parallel edges', () => {
  const { bendAngle } = helpers
  const a = bendAngle('note:N1|agent:1:a|read')
  assert.equal(bendAngle('note:N1|agent:1:a|read'), a, 'the same key always bends the same way')
  assert.ok(a >= 0 && a < Math.PI * 2)
  const keys = ['note:N1|agent:1:a|read', 'note:N1|agent:1:a|wrote', 'agent:1:a|note:N1|read', 'source:rules|agent:1:a|started']
  const angles = keys.map(bendAngle)
  for (const x of angles) assert.ok(x >= 0 && x < Math.PI * 2)
  assert.equal(new Set(angles.map((x) => x.toFixed(6))).size, keys.length, 'the sample keys fan apart')
})

test('curved edges: the control point sits off the midpoint by 15% of the length, square to the edge', () => {
  const { controlPoint, CURVE_BEND } = helpers
  const a = [0, 0, 0]
  const b = [40, 0, 0]
  for (const angle of [0, 1, 2.5, 4, 6]) {
    const c = controlPoint(a, b, angle)
    const off = [c[0] - 20, c[1], c[2]]
    assert.ok(Math.abs(off[0]) < 1e-9, 'no offset along the edge')
    assert.ok(Math.abs(Math.hypot(off[1], off[2]) - 40 * CURVE_BEND) < 1e-9, 'offset is 15% of the length')
  }
  // a different angle is a different direction, so parallel edges do not overlap
  assert.ok(Math.hypot(...controlPoint(a, b, 0).map((x, i) => x - controlPoint(a, b, 2)[i])) > 1)
  // an edge not along an axis: still square to it and still 15%
  const p = [3, -5, 7]
  const q = [-11, 2, 20]
  const d = q.map((x, i) => x - p[i])
  const len = Math.hypot(...d)
  const c = controlPoint(p, q, 1.3)
  const off = c.map((x, i) => x - (p[i] + d[i] / 2))
  assert.ok(Math.abs(off[0] * d[0] + off[1] * d[1] + off[2] * d[2]) < 1e-9, 'square to the edge')
  assert.ok(Math.abs(Math.hypot(...off) - len * CURVE_BEND) < 1e-9)
  // a vertical edge uses the other reference axis and still works
  const cv = controlPoint([0, 0, 0], [0, 10, 0], 0.4)
  assert.ok(Math.abs(cv[1] - 5) < 1e-9 && Math.abs(Math.hypot(cv[0], cv[2]) - 10 * CURVE_BEND) < 1e-9)
  // ends that coincide: the midpoint, no NaN
  assert.deepEqual(controlPoint([1, 2, 3], [1, 2, 3], 2), [1, 2, 3])
})

test('curved edges: the curve starts at one end, ends at the other, passes halfway to the control point, and takes 20 vertices', () => {
  const { curvePoint, controlPoint, verticesPerEdge, CURVE_SEGMENTS } = helpers
  const a = [0, 0, 0]
  const b = [40, 0, 0]
  const c = controlPoint(a, b, 0)
  assert.deepEqual(curvePoint(a, c, b, 0), a)
  assert.deepEqual(curvePoint(a, c, b, 1), b)
  const mid = curvePoint(a, c, b, 0.5)
  assert.ok(Math.abs(mid[0] - 20) < 1e-9)
  assert.ok(Math.abs(Math.hypot(mid[1], mid[2]) - 40 * 0.15 * 0.5) < 1e-9, 'the apex is half the control offset')
  assert.equal(verticesPerEdge('straight'), 2)
  assert.equal(verticesPerEdge('curved'), CURVE_SEGMENTS * 2)
  assert.equal(CURVE_SEGMENTS, 10)
})

// ---------- #213: the project filter and the cross-project tints ----------

const P1 = 'D:\\projects\\dashboard'
const P2 = 'D:\\projects\\other'
const crowA = { kind: 'agent', agentName: 'Dash Crow', taskId: 301 }
const crowB = { kind: 'agent', agentName: 'Other Crow', taskId: 302 }
const T0 = NOW - 3 * H
const pEvents = [
  // the paths in the log vary in case and trailing slashes; the filter must not care
  { kind: 'worker-started', ts: T0, workerId: 'wa', agentName: crowA.agentName, taskId: 301, project: 'D:\\projects\\dashboard\\', inputs: [{ kind: 'task', origin: 'task #301', chars: 100 }, { kind: 'claude-md', origin: P1 + '\\CLAUDE.md', chars: 50 }, { kind: 'rules', origin: 'Corvid', chars: 9000 }, { kind: 'thesis', origin: 'thesis', chars: 5000 }] },
  { kind: 'worker-started', ts: T0 + 1000, workerId: 'wb', agentName: crowB.agentName, taskId: 302, project: 'D:\\Projects\\OTHER', inputs: [{ kind: 'task', origin: 'task #302', chars: 100 }, { kind: 'claude-md', origin: P2 + '\\CLAUDE.md', chars: 50 }, { kind: 'rules', origin: 'Corvid', chars: 9000 }] },
  { kind: 'note-written', ts: T0 + 2000, actor: crowB, noteId: 'N200', action: 'created' },
  { kind: 'note-written', ts: T0 + 3000, actor: crowA, noteId: 'N201', action: 'created' },
  // the crossings: the dashboard worker reads a note and a post written on the other project
  { kind: 'note-read', ts: T0 + 4000, actor: crowA, noteId: 'N200' },
  { kind: 'board-post', ts: T0 + 5000, actor: crowB, messageId: 1001 },
  { kind: 'board-read', ts: T0 + 6000, actor: crowA, messageIds: [1001] },
  // the other way: the other project's worker reads the dashboard note, and a user note nobody else reads
  { kind: 'note-read', ts: T0 + 7000, actor: crowB, noteId: 'N201' },
  { kind: 'note-read', ts: T0 + 8000, actor: crowB, noteId: 'N202' },
  // shared things: a user note and Corvid
  { kind: 'note-read', ts: T0 + 9000, actor: crowA, noteId: 'N1' },
  { kind: 'note-read', ts: T0 + 10_000, actor: corvid, noteId: 'N201' },
  { kind: 'board-post', ts: T0 + 11_000, actor: crowA, messageId: 1002, done: true },
  { kind: 'worker-merged', ts: T0 + 12_000, workerId: 'wa', taskId: 301, project: P1 },
  { kind: 'worker-merged', ts: T0 + 13_000, workerId: 'wb', taskId: 302, project: P2 + '\\' }
]
const pNotes = [
  { id: 'N1', name: 'Board voice', text: 'z', author: 'user', created: NOW - 2 * D, updated: NOW - 2 * D, size: 1, rev: '', file: '' },
  { id: 'N200', name: 'Other findings', text: 'o'.repeat(50), author: 'agent', agentName: crowB.agentName, taskId: 302, created: T0 + 2000, updated: T0 + 2000, size: 50, rev: '', file: '' },
  { id: 'N201', name: 'Dash findings', text: 'd'.repeat(60), author: 'agent', agentName: crowA.agentName, taskId: 301, created: T0 + 3000, updated: T0 + 3000, size: 60, rev: '', file: '' },
  { id: 'N202', name: 'Only the other side read this', text: 'u', author: 'user', created: NOW - 2 * D, updated: NOW - 2 * D, size: 1, rev: '', file: '' }
]
const pMessages = [
  { id: 1001, ts: T0 + 5000, author: 'agent', agentName: crowB.agentName, taskId: 302, text: 'hello from the other side' },
  { id: 1002, ts: T0 + 11_000, author: 'agent', agentName: crowA.agentName, taskId: 301, text: 'done', done: true }
]
const pTasks = [
  { id: 301, title: 'Dash task', notes: '', column: 'doing', order: 0, createdAt: 0, updatedAt: 0, project: P1 },
  { id: 302, title: 'Other task', notes: '', column: 'doing', order: 0, createdAt: 0, updatedAt: 0, project: P2 },
  // a task with no worker in the log yet, so the live filter has to ask the task for its project
  { id: 305, title: 'Dash task later', notes: '', column: 'todo', order: 0, createdAt: 0, updatedAt: 0, project: P1 + '\\' }
]
const pSrc = { events: pEvents, notes: pNotes, messages: pMessages, tasks: pTasks, now: NOW }
const idsOf = (g) => new Set(g.nodes.map((n) => n.id))

test("project filter: the project's workers, their sources, main and CLAUDE.md, and everything they touched one hop out", () => {
  const g = shared.deriveLineage(pSrc, { days: 7, project: P1 })
  const ids = idsOf(g)
  const a = shared.agentNodeId(crowA)
  const b = shared.agentNodeId(crowB)
  assert.ok(ids.has(a), 'the project worker')
  assert.ok(ids.has('source:task:301') && ids.has('source:claude-md:d:\\projects\\dashboard') && ids.has('source:rules') && ids.has('source:thesis'), 'its sources, the shared rules and thesis among them')
  assert.ok(ids.has(shared.projectNodeId(P1)), 'its main')
  assert.ok(ids.has('note:N201') && ids.has('post:1002'), 'what it wrote')
  assert.ok(ids.has('note:N200'), "the other project's note it read comes along")
  assert.ok(ids.has('post:1001'), "and the other project's post it read")
  assert.ok(ids.has('note:N1'), 'the user note it read')
  assert.ok(ids.has(shared.CORVID_NODE), 'Corvid, who read its note')
  assert.ok(!ids.has(b), "the other project's worker is dropped")
  assert.ok(!ids.has('source:task:302') && !ids.has('source:claude-md:d:\\projects\\other') && !ids.has(shared.projectNodeId(P2)), 'with its sources and main')
  assert.ok(!ids.has('note:N202'), 'and what only it reached')
  assert.ok(!g.edges.some((e) => e.from === b || e.to === b), 'no edge leads to the dropped worker')
  assert.ok(g.edges.some((e) => e.kind === 'read' && e.from === 'note:N200' && e.to === a), 'the crossing edge is there')
  assert.deepEqual(g.projects, ['D:\\projects\\dashboard', 'D:\\Projects\\OTHER'], 'the graph lists every project in the log, as first spelled, without trailing slashes, sorted by name')
  const other = shared.deriveLineage(pSrc, { days: 7, project: P2 })
  const oids = idsOf(other)
  assert.ok(oids.has(b) && oids.has('note:N201') && oids.has('note:N202') && oids.has('note:N200') && !oids.has(a) && !oids.has('post:1002'), 'the other project seen from its side')
  assert.ok(!oids.has(shared.CORVID_NODE), 'Corvid is only one hop from the dashboard note, not from the other side')
})

test('project filter: paths compare without case and trailing slashes, and the day window still applies', () => {
  const base = shared.deriveLineage(pSrc, { days: 7, project: P1 })
  for (const spelling of ['d:\\PROJECTS\\dashboard\\', 'D:\\projects\\dashboard/', 'D:\\projects\\dashboard']) {
    const g = shared.deriveLineage(pSrc, { days: 7, project: spelling })
    assert.deepEqual(
      g.nodes.map((n) => n.id),
      base.nodes.map((n) => n.id),
      spelling
    )
  }
  assert.equal(shared.normProject('D:\\A\\B\\\\'), 'd:\\a\\b')
  assert.equal(shared.projectRelationOf({ project: 'd:\\a\\b' }, 'D:\\A\\B\\'), 'own')
  const narrow = shared.deriveLineage({ ...pSrc, now: NOW + 10 * D }, { days: 7, project: P1 })
  assert.equal(narrow.nodes.length, 0, 'ten days later a 7-day window is empty')
  const none = shared.deriveLineage(pSrc, { days: 7, project: 'D:\\nowhere' })
  assert.equal(none.nodes.length, 0)
  assert.deepEqual(none.projects, base.projects, 'the project list does not depend on the filter')
})

test('project filter: a task filter takes priority, and without a project nothing is tinted', () => {
  const both = shared.deriveLineage(pSrc, { days: 7, taskId: 302, project: P1 })
  const task = shared.deriveLineage(pSrc, { days: 7, taskId: 302 })
  assert.deepEqual(
    both.nodes.map((n) => n.id),
    task.nodes.map((n) => n.id)
  )
  assert.ok(idsOf(both).has(shared.agentNodeId(crowB)))
  const all = shared.deriveLineage(pSrc, { days: 7 })
  assert.ok(all.nodes.every((n) => shared.projectRelationOf(n, undefined) === 'own'))
  assert.ok(idsOf(all).has(shared.agentNodeId(crowA)) && idsOf(all).has(shared.agentNodeId(crowB)))
})

test('project tints: a foreign note or post is foreign, what cannot have a project is shared, the rest is own', () => {
  const g = shared.deriveLineage(pSrc, { days: 7, project: P1 })
  const rel = (id) => shared.projectRelationOf(g.nodes.find((n) => n.id === id), P1)
  assert.equal(rel('note:N200'), 'foreign', 'a note written by a worker on another project and read here')
  assert.equal(rel('post:1001'), 'foreign', 'a post from another project read here')
  assert.equal(rel('note:N1'), 'shared', 'a user note')
  assert.equal(rel('source:rules'), 'shared')
  assert.equal(rel('source:thesis'), 'shared')
  assert.equal(rel(shared.CORVID_NODE), 'shared')
  assert.equal(rel(shared.agentNodeId(crowA)), 'own')
  assert.equal(rel('note:N201'), 'own')
  assert.equal(rel('post:1002'), 'own')
  assert.equal(rel('source:task:301'), 'own')
  assert.equal(rel('source:claude-md:d:\\projects\\dashboard'), 'own')
  assert.equal(rel(shared.projectNodeId(P1)), 'own')
  // the node's project is the normalised path, whatever the log spelled
  assert.equal(g.nodes.find((n) => n.id === 'note:N200').project, 'd:\\projects\\other')
  assert.equal(g.nodes.find((n) => n.id === shared.agentNodeId(crowA)).project, 'd:\\projects\\dashboard')
  // a worker known only from its note, before the log: the task tells its project
  const late = shared.deriveLineage({ ...pSrc, events: [] }, { days: 7, project: P1 })
  assert.equal(late.nodes.find((n) => n.id === shared.agentNodeId(crowA))?.project, 'd:\\projects\\dashboard')
  assert.ok(!idsOf(late).has(shared.agentNodeId(crowB)))
})

test("project filter: the view's colours take the tint and keep the shape, a gone node stays grey", () => {
  const { styleOf, FOREIGN_COLOR, SHARED_COLOR } = helpers
  const note = { id: 'note:N200', lane: 'artifact', type: 'note', label: 'N200', ts: 0, by: 'agent:302:other crow', project: 'd:\\projects\\other' }
  assert.deepEqual(styleOf(note, 'foreign'), { color: FOREIGN_COLOR, shape: 'box' })
  assert.deepEqual(styleOf(note, 'own'), styleOf(note), 'own is the normal look')
  assert.deepEqual(styleOf({ id: 'source:rules', lane: 'source', type: 'rules', label: 'r', ts: 0 }, 'shared'), { color: SHARED_COLOR, shape: 'octa' })
  assert.deepEqual(styleOf({ id: 'agent:corvid', lane: 'agent', type: 'corvid', label: 'Corvid', ts: 0 }, 'shared'), { color: SHARED_COLOR, shape: 'sphere' })
  assert.equal(styleOf({ ...note, gone: true }, 'foreign').color, styleOf({ ...note, gone: true }).color)
  assert.notEqual(FOREIGN_COLOR, SHARED_COLOR)
})

test('project filter: eventInFilter agrees with deriveLineage on what a live event can add', () => {
  const filter = { days: 7, project: 'd:\\PROJECTS\\dashboard\\' }
  const g = shared.deriveLineage(pSrc, filter)
  const taskProject = (id) => pTasks.find((t) => t.id === id)?.project
  const adds = (batch) => {
    const grown = shared.deriveLineage({ events: batch, notes: pNotes, messages: pMessages, tasks: pTasks, now: NOW }, filter, g)
    return grown.nodes.length > g.nodes.length || grown.edges.length > g.edges.length
  }
  const crowD = { kind: 'agent', agentName: 'Late Crow', taskId: 305 }
  const cases = [
    ['the project worker reads a note the graph has not seen', { kind: 'note-read', ts: NOW, actor: crowA, noteId: 'N202' }],
    ['the project worker reads a task file', { kind: 'task-file-read', ts: NOW, actor: crowA, taskId: 301, file: 'a.png' }],
    ["the other project's worker reads the project note", { kind: 'note-read', ts: NOW, actor: crowB, noteId: 'N201' }],
    ["the other project's worker posts", { kind: 'board-post', ts: NOW, actor: crowB, messageId: 1003 }],
    ['Corvid reads a project note', { kind: 'note-read', ts: NOW, actor: corvid, noteId: 'N200' }],
    ['Corvid reads a note the view does not show', { kind: 'note-read', ts: NOW, actor: corvid, noteId: 'N202' }],
    ['Corvid reads the board with a shown post in it', { kind: 'board-read', ts: NOW, actor: corvid, messageIds: [5, 1002] }],
    ['a worker starts in the project', { kind: 'worker-started', ts: NOW, workerId: 'wd', agentName: 'Late Crow', taskId: 305, project: P1 + '\\', inputs: [{ kind: 'task', origin: 't', chars: 1 }] }],
    ['a worker starts elsewhere', { kind: 'worker-started', ts: NOW, workerId: 'we', agentName: 'Far Crow', taskId: 306, project: P2, inputs: [{ kind: 'task', origin: 't', chars: 1 }] }],
    ['a merge in the project', { kind: 'worker-merged', ts: NOW, workerId: 'wa', taskId: 301, project: 'd:\\projects\\dashboard' }],
    ['a merge elsewhere', { kind: 'worker-merged', ts: NOW, workerId: 'wb', taskId: 302, project: P2 }],
    ['a ping over a shown post', { kind: 'ping', ts: NOW, from: 'x', to: 'Dash Crow', messageId: 1001, wake: false }],
    ['a worker ending', { kind: 'worker-ended', ts: NOW, workerId: 'wa', taskId: 301, reason: 'x' }],
    ['outside the day window', { kind: 'note-read', ts: NOW - 8 * D, actor: crowA, noteId: 'N202' }]
  ]
  for (const [name, e] of cases) assert.equal(shared.eventInFilter(e, filter, g, NOW, taskProject), adds([e]), name)
  // a worker whose start is in the same batch as its first read: the task says which project it is in
  const read = { kind: 'note-read', ts: NOW, actor: crowD, noteId: 'N201' }
  assert.equal(shared.eventInFilter(read, filter, g, NOW, taskProject), true, 'the task knows the project')
  assert.equal(shared.eventInFilter(read, filter, g, NOW), true, 'without that lookup the worker is of no known project, and the note it reads is shown: one hop, like Corvid')
  const stray = { ...read, actor: { kind: 'agent', agentName: 'Stray', taskId: 999 } }
  assert.equal(shared.eventInFilter(stray, filter, g, NOW, taskProject), adds([stray]), 'a worker of no known project touching a shown note comes along as shared, in both')
  assert.equal(shared.eventInFilter({ ...stray, noteId: 'N202' }, filter, g, NOW, taskProject), adds([{ ...stray, noteId: 'N202' }]), 'but not when it touches something the view does not show')
  assert.equal(shared.eventInFilter({ kind: 'note-read', ts: NOW, actor: crowB, noteId: 'N201' }, { days: 7, taskId: 302, project: P1 }, g, NOW), true, 'with a task picked the task rule decides')
  // a worker of another project, on a task the store does not know, starts and reads a shown note in one batch:
  // the batch itself says where it runs, so neither event gets in (without that it would slip in as shared)
  const farStart = { kind: 'worker-started', ts: NOW, workerId: 'wf', agentName: 'Far Crow', taskId: 777, project: P2, inputs: [] }
  const farRead = { kind: 'note-read', ts: NOW + 1, actor: { kind: 'agent', agentName: 'Far Crow', taskId: 777 }, noteId: 'N201' }
  const inBatch = shared.taskProjectsOf([farStart, farRead, { kind: 'worker-merged', ts: NOW, workerId: 'wa', taskId: 301, project: P1 }])
  assert.deepEqual([...inBatch], [[777, P2], [301, P1]])
  const lookup = (id) => inBatch.get(id) ?? taskProject(id)
  assert.equal(shared.eventInFilter(farStart, filter, g, NOW, lookup), false)
  assert.equal(shared.eventInFilter(farRead, filter, g, NOW, lookup), false, 'the batch placed the worker on the other project')
  assert.equal(shared.eventInFilter(farRead, filter, g, NOW, taskProject), true, 'without the batch lookup the worker is of no known project')
})

test('project filter: the seed spans two projects with a note written on one and read on the other', async () => {
  const seed = await import(pathToFileURL(join(root, 'scripts', 'seed', 'lineage.mjs')).href)
  const { events, messages, notes } = seed.lineageSeedAll(NOW)
  const projects = new Set(events.filter((e) => e.kind === 'worker-started').map((e) => e.project))
  assert.equal(projects.size, 2)
  assert.deepEqual([...projects], seed.SEED_PROJECTS)
  const src = {
    events,
    notes: notes.map((n) => ({ id: n.id, name: n.name, text: n.text, author: n.who === 'user' ? 'user' : n.who.kind === 'assistant' ? 'assistant' : 'agent', agentName: n.who.agentName, taskId: n.who.taskId, created: n.ts, updated: n.ts, size: 1, rev: '', file: '' })),
    messages,
    tasks: [],
    now: NOW
  }
  for (const p of seed.SEED_PROJECTS) {
    const g = shared.deriveLineage(src, { days: 30, project: p })
    const foreign = g.nodes.filter((n) => n.type === 'note' && shared.projectRelationOf(n, p) === 'foreign')
    assert.ok(foreign.length > 0, `${p} shows a note written on the other project`)
    assert.ok(
      g.nodes.every((n) => n.type !== 'worker' || shared.projectRelationOf(n, p) === 'own'),
      'and no worker of the other'
    )
    assert.ok(g.nodes.some((n) => n.type === 'project' && n.project === shared.normProject(p)))
  }
})
