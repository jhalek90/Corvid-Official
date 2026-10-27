// Debug aid (#83): drives a TEST copy of Corvid through removing (finishing) and undoing tasks in every state,
// and fails if anything throws, an error panel shows or the window goes blank. Only through a test copy you
// started yourself (#85): it talks to the copy's control port after checking it's yours.
//
//   npm run build && npm run test-instance -- start --owner <you> --data copy
//   node scripts/ui-smoke.mjs <test copy id> --owner <you>
//
// It makes fake tasks and fake worker entries in the window only; no agent or terminal is started.

import { evalIn } from './test-instance.mjs'

const [id, , owner] = process.argv.slice(2)
if (!id || process.argv[3] !== '--owner' || !owner) {
  console.error('usage: node scripts/ui-smoke.mjs <test copy id> --owner <you>')
  process.exit(1)
}

const scenario = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const D = window.__dash
  const api = window.api
  const log = []
  const problems = []
  const check = (step) => {
    const root = document.getElementById('root')
    if (!root || root.innerHTML.length < 200) problems.push(`${step}: blank window`)
    const panels = [...document.querySelectorAll('.crash-panel')].map((p) => p.textContent.slice(0, 160))
    if (panels.length) problems.push(`${step}: error panel: ${panels.join(' | ')}`)
  }
  const proj = D.getState().projects.projects.find((p) => !p.builtin) ?? D.getState().projects.projects[0]
  const cols = ['backlog', 'next', 'doing', 'done']
  const made = []
  for (let i = 0; i < 16; i++)
    made.push(await api.createTask({ title: `Smoke task ${i}`, notes: 'ui-smoke', column: cols[i % 4], projectId: proj?.id, project: proj?.folders?.[0]?.path }))
  await api.updateTask(made[1].id, { blockedBy: [made[0].id] })
  await api.updateTask(made[2].id, { blockedBy: [made[0].id, made[1].id] })
  const states = ['running', 'finished', 'exited', 'stopped']
  const fakeWorkers = () =>
    made.map((t, i) => ({ id: `smoke-w${i}`, taskId: t.id, taskTitle: t.title, agentName: `Smoke Agent ${i}`, model: 'sonnet', termId: `smoke-term-${i}`, project: t.project ?? '', startedAt: Date.now() - 60_000, workedMs: 1000, state: states[i % 4], git: { state: 'kept', message: 'kept: 1 commit not merged' } }))
  const inject = () => D.setState({ assistant: { ...D.getState().assistant, workers: fakeWorkers() } })
  inject()
  D.sampleAgents(4, ['busy', 'idle', 'waiting', 'exited'])
  await sleep(300)
  const clickText = (sel, text) => [...document.querySelectorAll(sel)].find((b) => b.textContent.trim() === text)?.click()
  // only its own cards, never the copy's other tasks
  const smokeCards = () => [...document.querySelectorAll('.tcard')].filter((c) => c.querySelector('.tc-title')?.textContent.startsWith('Smoke task'))
  // the one finish action (#134): Remove… in the editor, then Remove in its confirmation
  const removeVia = async (t) => {
    D.setState({ taskEditor: t })
    await sleep(60)
    clickText('.task-dialog button', 'Remove…')
    await sleep(30)
    clickText('.remove-confirm button', 'Remove')
  }

  // 1. the editor opens and closes on a task (this alone blanked the window before #83)
  D.setState({ view: 'tasks' })
  await sleep(300)
  smokeCards()[0]?.click()
  await sleep(300)
  check('editor open')
  log.push('editor open: ' + !!document.querySelector('.task-dialog'))
  // 2. the card face has no finish buttons; Remove… asks first, with Cancel focused, and Escape keeps the editor
  if (smokeCards().some((c) => c.querySelector('.tc-actions, .prio'))) problems.push('card face still has finish buttons or a priority')
  clickText('.task-dialog button', 'Remove…')
  await sleep(200)
  const confirmBox = document.querySelector('.remove-confirm')
  if (!confirmBox) problems.push('Remove… did not ask first')
  else if (document.activeElement?.textContent.trim() !== 'Cancel') problems.push(`confirmation focus is on "${document.activeElement?.textContent.trim()}", not Cancel`)
  document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await sleep(200)
  if (document.querySelector('.remove-confirm')) problems.push('Escape did not cancel the confirmation')
  if (!document.querySelector('.task-dialog')) problems.push('Escape on the confirmation closed the editor too')
  const firstLeft = D.getState().tasks.length
  clickText('.task-dialog button', 'Remove…')
  await sleep(150)
  clickText('.remove-confirm button', 'Remove')
  await sleep(400)
  check('remove from editor')
  if (D.getState().tasks.length !== firstLeft - 1) problems.push('Remove did not remove the task')
  if (document.querySelector('.task-dialog')) problems.push('the editor stayed open after Remove')
  // 3. several cards in a row, quickly, in each view with the editor and the switcher open
  for (const view of ['tasks', 'terminals', 'projects', 'notes']) {
    inject()
    D.setState({ view: 'tasks' })
    await sleep(250)
    for (let i = 0; i < 3; i++) {
      const t = D.getState().tasks.find((x) => x.notes === 'ui-smoke')
      if (t) await removeVia(t)
      await sleep(30)
    }
    D.setState({ view })
    await sleep(400)
    check(`burst then ${view}`)
    D.setState({ taskEditor: undefined })
  }
  // 4. undo brings one back; then the removed task's editor and links in the board and agents
  const smokeLeft = () => D.getState().tasks.filter((x) => x.notes === 'ui-smoke').length
  const before = smokeLeft()
  clickText('.toast button', 'Undo')
  await sleep(500)
  check('undo')
  if (smokeLeft() !== before + 1) problems.push(`undo: ${before} smoke tasks before, ${smokeLeft()} after`)
  D.setState({ taskEditor: made[0] })
  await sleep(300)
  check('editor on a removed task')
  D.setState({ taskEditor: undefined })
  // 5. the Corvid project page (#78's panel looped before #83), and a project picked in the switcher
  const corvid = D.getState().projects.projects.find((p) => p.builtin)
  if (corvid) {
    D.setState({ view: 'projects', selectedProject: corvid.folders[0]?.path })
    await sleep(800)
    check('Corvid project page')
  }
  if (proj?.id) {
    D.setScope(proj.id)
    for (const view of ['tasks', 'terminals', 'notes']) {
      D.setState({ view })
      await sleep(300)
      check(`scoped ${view}`)
    }
    D.setScope(undefined)
  }
  // 6. clean up what's left of the smoke tasks
  for (const t of D.getState().tasks.filter((x) => x.notes === 'ui-smoke')) await api.removeTask(t.id)
  D.sampleAgents(0)
  await sleep(500)
  check('cleanup')
  log.push(`tasks left: ${D.getState().tasks.length}`)
  return { log, problems }
}

// errors the window logs while the scenario runs count as failures, as they did over the debugger
const wrapped = `(async () => {
  const errors = []
  const onErr = (e) => errors.push(String(e.error?.stack ?? e.reason?.stack ?? e.message ?? e.reason))
  const origError = console.error
  console.error = (...a) => (errors.push(a.map(String).join(' ')), origError(...a))
  addEventListener('error', onErr)
  addEventListener('unhandledrejection', onErr)
  try {
    const out = await (${scenario})()
    await new Promise((r) => setTimeout(r, 1000))
    return { ...out, errors }
  } finally {
    console.error = origError
    removeEventListener('error', onErr)
    removeEventListener('unhandledrejection', onErr)
  }
})()`
let out
try {
  out = await evalIn(id, owner, wrapped)
} catch (e) {
  console.error('the scenario itself failed:', e.message)
  out = { log: [], errors: [], problems: ['the scenario itself failed'] }
}
for (const l of out.log) console.log(l)
for (const e of out.errors) console.log('ERROR:', e.split('\n').slice(0, 6).join('\n  '))
for (const p of out.problems) console.log('PROBLEM:', p)
console.log(out.problems.length || out.errors.length ? 'FAILED' : 'passed')
// exitCode, not process.exit(): exiting straight after a fetch aborts Node on Windows with a libuv assertion
// ("!(handle->flags & UV_HANDLE_CLOSING)"), which turned a passing run into a failing exit code (#162)
process.exitCode = out.problems.length || out.errors.length ? 1 : 0
