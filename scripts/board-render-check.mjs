// Regression check for #181: a busy board must not freeze the window. Drives a TEST copy of Corvid you started
// yourself (#85): puts a fake board of 2500 messages (long formatted posts, attachments, mentions, notices, five
// channels) into the window's state only, nothing on disk, then hides and shows the board a few times. Fails when
// more than 300 messages are drawn, a long task passes the budget, or showing the board takes longer than it.
//
//   npm run build && npm run test-instance -- start --owner <you> --data empty
//   npm run test-board-render -- <test copy id> --owner <you>

import { evalIn } from './test-instance.mjs'

const [id, , owner] = process.argv.slice(2)
if (!id || process.argv[3] !== '--owner' || !owner) {
  console.error('usage: npm run test-board-render -- <test copy id> --owner <you>')
  process.exit(1)
}

const BUDGET_MS = 100
const MAX_DRAWN = 300

const scenario = async (COUNT) => {
  // timers are throttled hard in a covered window, so wait by yielding through a MessageChannel
  const tick = () => new Promise((r) => {
    const c = new MessageChannel()
    c.port1.onmessage = () => r()
    c.port2.postMessage(0)
  })
  const sleep = async (ms) => {
    const end = performance.now() + ms
    while (performance.now() < end) await tick()
  }
  const D = window.__dash
  const names = ['Head Folder Coordinator', 'Chief Bundle Custodian', 'Interim Build Navigator']
  const projects = D.getState().projects.projects.map((p) => p.id).concat(['fake-a', 'fake-b', 'fake-c', 'fake-d']).slice(0, 5)
  const long = (i) =>
    `Right, #${i % 80} is wrapped:\n\n- **Board**: \`stickToBottom\` stays happy\n- see N${i % 40} and m${Math.max(1, i - 3)}\n  - nested C:\\fake\\file${i}.ts\n\n1. run \`npm run typecheck\`\n2. ask @user\n\n` +
    'More detail so the post folds behind Show more. '.repeat(10)
  const start = Date.now() - 13 * 86400_000
  const messages = []
  for (let i = 1; i <= COUNT; i++) {
    const r = i % 6
    const m = { id: i, ts: start + i * 400_000, text: '' }
    if (r === 0) Object.assign(m, { author: 'corvid', text: `Head Folder Coordinator (#${i % 90}) wrapped up.`, taskId: i % 90 })
    else if (r === 1) Object.assign(m, { author: 'user', text: `@${names[i % 3]} peck at #${i % 90}?`, to: [names[i % 3]] })
    else if (r === 2) Object.assign(m, { author: 'user', text: `shot ${i}`, attachments: [{ name: `shot${i}.png`, size: 2048, kind: 'image' }] })
    else if (r === 3) Object.assign(m, { author: 'assistant', text: `Started a worker on #${i % 90}.\n\n- task created`, actions: [{ label: 'Created task', ok: true }] })
    else Object.assign(m, { author: 'agent', agentName: names[i % 3], taskId: i % 90, text: r === 4 ? long(i) : `Picking up #${i % 90}, @user ☕`, question: r === 5 })
    if (i % 5) m.project = projects[i % projects.length]
    if (i % 11 === 0) m.replyTo = i - 2
    messages.push(m)
  }
  const saved = D.getState().board
  const savedLayout = D.getState().layout
  const out = { problems: [] }
  const longs = []
  const po = new PerformanceObserver((l) => l.getEntries().forEach((e) => longs.push(Math.round(e.duration))))
  po.observe({ type: 'longtask' })
  try {
    D.setState({ board: { messages, seenUpTo: COUNT - 20, keepDays: 14, channelSeen: {} }, view: 'terminals' })
    await sleep(1500)
    // one pane with Agents and Tasks as tabs, so switching really takes the board off the page
    for (const p of [...document.querySelectorAll('.pane[data-pane]')]) if (!p.querySelector('.mboard')) p.querySelector('button[title="Close pane"]')?.click()
    await sleep(300)
    document.querySelector('[data-view="tasks"]').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }))
    await sleep(500)
    if (document.querySelector('.mboard')?.isConnected) out.problems.push("couldn't hide the board (Tasks didn't open as a tab)")
    longs.length = 0
    out.shows = []
    out.hide = []
    out.hidden = []
    out.show = []
    for (let i = 0; i < 3; i++) {
      // hiding: switching to Tasks mounts the Tasks view, which isn't the board's to answer for
      document.querySelector('[data-view="tasks"]').click()
      await sleep(400)
      out.hide.push(...longs.splice(0))
      // a new message while hidden
      D.setState({ board: { ...D.getState().board, messages: [...D.getState().board.messages, { id: COUNT + i + 1, ts: Date.now(), author: 'agent', agentName: names[0], text: 'Another one while hidden.' }] } })
      await sleep(400)
      out.hidden.push(...longs.splice(0))
      const t0 = performance.now()
      document.querySelector('[data-view="terminals"]').click()
      void document.querySelector('.mb-list')?.scrollHeight // render, style and layout, forced
      out.shows.push(Math.round(performance.now() - t0))
      await sleep(600)
      out.show.push(...longs.splice(0))
    }
    out.drawn = document.querySelectorAll('.mb-msg').length
    out.nodes = document.querySelectorAll('*').length
    out.longTasks = [...out.hidden, ...out.show]
  } finally {
    po.disconnect()
    D.setState({ board: saved, layout: savedLayout })
  }
  return out
}

const COUNT = 2500
const out = await evalIn(id, owner, `(${scenario.toString()})(${COUNT})`)
const r = typeof out === 'string' ? JSON.parse(out) : out
const problems = [...r.problems]
if (!(r.drawn > 0)) problems.push('no messages drawn')
if (r.drawn > MAX_DRAWN) problems.push(`${r.drawn} messages drawn (at most ${MAX_DRAWN})`)
const worst = Math.max(0, ...(r.longTasks ?? []))
if (worst > BUDGET_MS) problems.push(`a long task of ${worst} ms (budget ${BUDGET_MS} ms)`)
const slowest = Math.max(0, ...(r.shows ?? []))
if (slowest > BUDGET_MS) problems.push(`showing the board took ${slowest} ms (budget ${BUDGET_MS} ms)`)
console.log(`board of ${COUNT}: ${r.drawn} drawn, ${r.nodes} DOM nodes, shows ${r.shows?.join(' / ')} ms, long tasks while hidden [${r.hidden?.join(', ')}] and on show [${r.show?.join(', ')}] ms (on hiding, Tasks view included: [${r.hide?.join(', ')}])`)
if (problems.length) {
  console.error(`FAIL: ${problems.join('; ')}`)
  process.exit(1)
}
console.log('ok')
