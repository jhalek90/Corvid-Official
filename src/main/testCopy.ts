import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { app, type BrowserWindow } from 'electron'
import { isTestCopy } from './dataDir'
import * as lineage from './lineage'

// Agents' test copies of Corvid (#85), started by scripts/test-instance.mjs. A test copy stays inside its own data
// folder: no login item, Start Menu shortcut, global hotkey, tray, desktop notifications, usage polling, deploys,
// git merges or pushes, no assistant session and no real workers unless the test opts in. The real app never
// opens the control port below.

export const TEST = isTestCopy()
/** Who started this copy (the task or agent name the script was given). */
export const owner = (): string => process.env.DASH_TEST_INSTANCE || 'unnamed'
/** Opt-ins a test can ask for: DASH_TEST_ASSISTANT=1 starts Corvid's assistant (on a fresh session in this folder),
 *  DASH_TEST_WORKERS=1 lets real workers start. Both spend Claude usage. */
export const allowAssistant = (): boolean => !TEST || process.env.DASH_TEST_ASSISTANT === '1'
export const allowWorkers = (): boolean => !TEST || process.env.DASH_TEST_WORKERS === '1'
export const REFUSED = "This is a test copy of Corvid, so it doesn't do that."

/** The real app must not be driveable: a --remote-debugging-port passed to it is dropped. */
export function guardDebugPort(): void {
  if (TEST) return
  for (const sw of ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk'])
    if (app.commandLine.hasSwitch(sw)) {
      app.commandLine.removeSwitch(sw)
      console.warn(`[guard] ignored --${sw}: only test copies can be driven`)
    }
}

/** The test copy's control port, on localhost only and behind the script's random token: who am I (pid, owner,
 *  data folder), run JavaScript in the window, and quit cleanly. The script checks "who am I" against its own
 *  registry entry before it sends anything else. */
export function startControlPort(win: () => BrowserWindow | null, quit: () => void): void {
  const port = Number(process.env.DASH_TEST_PORT)
  const token = process.env.DASH_TEST_TOKEN ?? ''
  if (!TEST || !port || token.length < 32) return
  const want = Buffer.from(`Bearer ${token}`)
  const server = createServer((req, res) => {
    const got = Buffer.from(String(req.headers.authorization ?? ''))
    const reply = (code: number, body: unknown): void => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (got.length !== want.length || !timingSafeEqual(got, want)) return reply(401, { error: 'wrong token' })
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      try {
        if (req.url === '/whoami') return reply(200, { pid: process.pid, owner: owner(), dataDir: app.getPath('userData'), test: true })
        if (req.method !== 'POST') return reply(405, { error: 'POST only' })
        if (req.url === '/quit') {
          reply(200, { ok: true })
          return void setTimeout(quit, 100)
        }
        // a hidden copy's window shown, the way a tray click or the hotkey shows it (#122)
        if (req.url === '/show') {
          const w = win()
          if (!w || w.isDestroyed()) return reply(409, { error: 'no window' })
          w.show()
          return reply(200, { ok: true })
        }
        if (req.url === '/eval') {
          const w = win()
          if (!w || w.isDestroyed()) return reply(409, { error: 'no window' })
          const { js } = JSON.parse(body || '{}')
          return reply(200, { value: await w.webContents.executeJavaScript(String(js), true) })
        }
        // a few fake lineage events through the real writer, so the Context cloud's live path can be watched (#210)
        if (req.url === '/lineage-live') return reply(200, { ok: true, events: fakeLineageEvents(JSON.parse(body || '{}')) })
        reply(404, { error: 'unknown' })
      } catch (e) {
        reply(500, { error: (e as Error).message })
      }
    })
  })
  server.on('error', (e) => console.error('[test] control port failed', e))
  server.listen(port, '127.0.0.1', () => console.log(`[test] control port ${port} on 127.0.0.1 for ${owner()}`))
}

/** ~/.claude, read only. A test copy given CLAUDE_CONFIG_DIR (a fake folder from the test script) reads that instead. */
export const claudeHome = (): string => (TEST && process.env.CLAUDE_CONFIG_DIR) || join(homedir(), '.claude')

/**
 * Fake events for a test copy's Context cloud (#210), appended through the real log writer so they are pushed to
 * the window like live ones: a worker starts on a made-up task with its inputs, reads a note, posts, and with
 * `step` 2 or more also writes a note and merges. Only reachable through the control port, so never in the real app.
 */
export function fakeLineageEvents(opts: { task?: number; step?: number; name?: string }): number {
  const taskId = Number(opts.task) || 900 + Math.floor(Math.random() * 90)
  const name = String(opts.name || 'Visiting Live Crow')
  const workerId = `fake-${taskId}-${Date.now().toString(36)}`
  const actor = { kind: 'agent' as const, agentName: name, taskId, workerId }
  lineage.workerStarted({ workerId, agentName: name, taskId, project: process.cwd(), title: `Fake task #${taskId}`, notes: 'x'.repeat(400), attachedBytes: 0, rules: 'r'.repeat(9000), thesis: 't'.repeat(5000), resumed: false })
  lineage.noteRead(actor, 'N1')
  lineage.boardRead(actor, [1, 2])
  lineage.boardPosted(actor, 1 + Math.floor(Math.random() * 100000))
  let n = 4
  if ((Number(opts.step) || 1) >= 2) {
    lineage.noteWritten(actor, 'N1', 'appended')
    lineage.workerMerged(workerId, taskId, process.cwd())
    lineage.workerEnded({ id: workerId, taskId, reason: 'finished' })
    n += 3
  }
  return n
}
