import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLASSIFIER_PROMPTS,
  CLASSIFIER_VERSION,
  SCAN_RUNS,
  SKIP_PHRASE,
  WARN_PHRASE,
  capabilityGap,
  classifierFlags,
  classifierInput,
  deterministicScan,
  findingsOf,
  mergeClassifier,
  parseClassifierOutput,
  verdictOf,
  type ClassifierOutput,
  type ScanReport,
  type ScanState
} from '@shared/extensionScan'
import { validateCorvid } from '@shared/extensions'

// The extension scan (#96, docs/EXTENSIONS.md "Safety scanning"): the deterministic checks, then the classifier,
// run through the user's own Claude CLI in a context that cannot act. Results are cached by the text's hash and
// CLASSIFIER_VERSION. Nothing here builds, installs or runs anything from an extension.

/** How the scan reaches the ledger and the CLI; index.ts wires the real ones, the tests their own. */
export interface ScanDeps {
  get: (key: string) => { hash: string; text: string | null; scan?: ScanState } | null
  setScan: (key: string, scan: ScanState | undefined) => void
  claude: () => Promise<string | null>
  model: () => string
}

let deps: ScanDeps | null = null
export const initScan = (d: ScanDeps): void => {
  deps = d
}

// ---------- the isolated call ----------

/**
 * The CLI flags that take away every way to act (checked against Claude Code 2.1.306):
 *  --print                       one answer, no interactive session
 *  --tools ""                    no built-in tools at all (no Bash, Read, Write, WebFetch, Task, …)
 *  --strict-mcp-config + an empty --mcp-config: no MCP servers, not even the user's own
 *  --setting-sources ""          no user, project or local settings, so no hooks, permissions or plugins from them
 *  --safe-mode                   CLAUDE.md, skills, plugins, hooks, MCP servers, custom agents and commands all off
 *  --disable-slash-commands      no skills or commands
 *  --no-session-persistence      nothing saved, nothing to resume
 *  --system-prompt               replaces Claude Code's own agent prompt with the classifier's
 * and it runs in a new, empty temporary folder (removed afterwards), with an environment holding only what the CLI
 * needs to start and find its login: no API keys, no Corvid tokens, no project paths.
 * --bare would be stricter still, but it never reads the subscription login (only ANTHROPIC_API_KEY), so it can't
 * run on the user's plan.
 */
export function isolatedArgs(systemPrompt: string, model: string): string[] {
  return [
    '--print',
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--safe-mode',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'json',
    '--model', model,
    '--system-prompt', systemPrompt
  ]
}

const ENV_KEEP = ['SystemRoot', 'SYSTEMROOT', 'windir', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'HOME', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERNAME', 'LANG', 'PATH', 'Path']
// macOS and Linux (#161): who the user is, their shell, and where temp files, runtime sockets and config live. No
// tokens, no SSH_AUTH_SOCK or DBUS address: the CLI reads its login from ~/.claude or the Keychain with HOME and USER.
const ENV_KEEP_POSIX = ['TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'XDG_RUNTIME_DIR', 'XDG_CONFIG_HOME']

/** Only what the CLI needs to start and find its login. */
export function isolatedEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const k of [...ENV_KEEP, ...ENV_KEEP_POSIX]) if (from[k] !== undefined) env[k] = from[k]
  env.CLAUDE_CODE_SAFE_MODE = '1'
  env.DISABLE_AUTOUPDATER = '1'
  return env
}

export interface CallResult {
  ok: boolean
  /** the model's answer text */
  result: string
  cost: number
  error?: string
  /** what the CLI reported about tools: none should ever have been used */
  turns?: number
  denials?: number
  /** what was left in the temporary folder afterwards (it should be empty) */
  leftover: string[]
}

const CALL_TIMEOUT_MS = 120_000

/** One isolated call. The extension text goes in on stdin, as delimited data. */
export function isolatedCall(bin: string, systemPrompt: string, input: string, model: string): Promise<CallResult> {
  const cwd = mkdtempSync(join(tmpdir(), 'corvid-scan-'))
  return new Promise((resolve) => {
    let out = ''
    let err = ''
    let done = false
    const finish = (r: Omit<CallResult, 'leftover'>): void => {
      if (done) return
      done = true
      let leftover: string[] = []
      try {
        leftover = readdirSync(cwd)
      } catch {
        /* gone already */
      }
      rmSync(cwd, { recursive: true, force: true })
      resolve({ ...r, leftover })
    }
    const child = spawn(bin, isolatedArgs(systemPrompt, model), { cwd, env: isolatedEnv(), windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, result: '', cost: 0, error: `The classifier didn't answer within ${CALL_TIMEOUT_MS / 1000} seconds.` })
    }, CALL_TIMEOUT_MS)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      finish({ ok: false, result: '', cost: 0, error: `Claude couldn't be started: ${e.message}` })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      let j: any = null
      try {
        j = JSON.parse(out.trim().split('\n').pop() ?? '')
      } catch {
        /* not the JSON envelope */
      }
      if (!j || typeof j !== 'object')
        return finish({ ok: false, result: '', cost: 0, error: `Claude exited (${code ?? 'killed'}) without an answer. ${err.trim().split('\n').slice(-2).join(' ')}`.trim() })
      const cost = typeof j.total_cost_usd === 'number' ? j.total_cost_usd : 0
      if (j.is_error || j.subtype !== 'success') return finish({ ok: false, result: '', cost, error: `Claude reported an error: ${String(j.result ?? j.subtype ?? 'unknown').slice(0, 300)}` })
      finish({ ok: true, result: String(j.result ?? ''), cost, turns: j.num_turns, denials: Array.isArray(j.permission_denials) ? j.permission_denials.length : 0 })
    })
    child.stdin.end(input)
  })
}

/** One classifier run with one prompt: the answer is checked strictly, and an invalid one is retried once. */
export async function classifyOnce(
  call: (prompt: string, input: string) => Promise<CallResult>,
  prompt: string,
  text: string
): Promise<{ ok: true; out: ClassifierOutput; cost: number; calls: number } | { ok: false; error: string; cost: number; calls: number }> {
  let cost = 0
  let last = ''
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await call(prompt, attempt === 1 ? classifierInput(text) : `${classifierInput(text)}\n\nYour previous answer was refused (${last}). Reply with the JSON object only, exactly as specified.`)
    cost += r.cost
    if (!r.ok) {
      last = r.error ?? 'the call failed'
      continue
    }
    const p = parseClassifierOutput(r.result)
    if (p.ok) return { ok: true, out: p.out, cost, calls: attempt }
    last = p.error
  }
  return { ok: false, error: `The classifier failed twice: ${last}`, cost, calls: 2 }
}

// ---------- the cache ----------

const cacheFile = (): string => join(app.getPath('userData'), 'extension-scans.json')
type Cache = Record<string, ScanReport>
const cacheKey = (hash: string, model: string): string => `${hash}:${CLASSIFIER_VERSION}:${model}`

function readCache(): Cache {
  try {
    const j = JSON.parse(readFileSync(cacheFile(), 'utf8'))
    return j && typeof j === 'object' ? j : {}
  } catch {
    return {}
  }
}

function writeCache(c: Cache): void {
  const keys = Object.keys(c)
  // a few hundred reports at most: the oldest go first
  if (keys.length > 300) for (const k of keys.sort((a, b) => c[a].at - c[b].at).slice(0, keys.length - 300)) delete c[k]
  const tmp = cacheFile() + '.tmp'
  writeFileSync(tmp, JSON.stringify(c))
  renameSync(tmp, cacheFile())
}

// ---------- a scan ----------

const running = new Set<string>()

/** Scans one extension: cached when the same text was scanned by this classifier version and model. */
export async function scan(key: string, call?: (prompt: string, input: string) => Promise<CallResult>): Promise<ScanState | { error: string }> {
  if (!deps) return { error: 'Scanning is not ready yet.' }
  const rec = deps.get(key)
  if (!rec) return { error: 'That extension is no longer in the list.' }
  if (rec.text === null) return { error: "The extension's stored text is missing, so it can't be scanned." }
  if (running.has(key)) return { error: 'This extension is already being scanned.' }
  const v = validateCorvid(rec.text)
  if (!v.ok) return { error: `The stored text no longer validates: ${v.errors[0]}` }
  const model = deps.model()
  const keep = { warnConfirmed: undefined, skipped: rec.scan?.skipped }
  const cached = readCache()[cacheKey(rec.hash, model)]
  if (cached) {
    const s: ScanState = { state: 'done', at: Date.now(), verdict: cached.verdict, findings: findingsOf(cached), classifier: model, classifierVersion: CLASSIFIER_VERSION, report: cached, effort: cached.classifier.effort, complexity: (cached.classifier.complexity - 1) / 9, ...keep }
    deps.setScan(key, s)
    return s
  }
  running.add(key)
  deps.setScan(key, { state: 'scanning', at: Date.now(), findings: [], classifier: model, classifierVersion: CLASSIFIER_VERSION, skipped: rec.scan?.skipped })
  try {
    const text = v.ext.canonical
    const det = deterministicScan(text, v.ext.header)
    let doCall = call
    if (!doCall) {
      const bin = await deps.claude()
      if (!bin) throw new Error('Claude Code (claude) not found, and the classifier runs on it. Install it from https://code.claude.com/docs/en/overview, or point Corvid at it in Settings.')
      doCall = (prompt, input) => isolatedCall(bin, prompt, input, model)
    }
    let cost = 0
    let calls = 0
    const outs: ClassifierOutput[] = []
    for (const prompt of CLASSIFIER_PROMPTS.slice(0, SCAN_RUNS)) {
      const r = await classifyOnce(doCall, prompt, text)
      cost += r.cost
      calls += r.calls
      if (!r.ok) throw Object.assign(new Error(r.error), { cost })
      outs.push(r.out)
    }
    const cls = outs.reduce(mergeClassifier)
    const gap = capabilityGap(v.ext.header, cls)
    const flags = [...det.flags, ...classifierFlags(text, cls)]
    const { verdict, blocking } = verdictOf(det, cls, gap, flags)
    const report: ScanReport = {
      version: 1,
      hash: rec.hash,
      classifierVersion: CLASSIFIER_VERSION,
      model,
      at: Date.now(),
      runs: outs.length,
      deterministic: det,
      classifier: cls,
      gap,
      flags,
      verdict,
      blockingCategories: blocking,
      cost: { usd: cost, calls }
    }
    const c = readCache()
    c[cacheKey(rec.hash, model)] = report
    writeCache(c)
    const s: ScanState = { state: 'done', at: Date.now(), verdict, findings: findingsOf(report), classifier: model, classifierVersion: CLASSIFIER_VERSION, report, effort: cls.effort, complexity: (cls.complexity - 1) / 9, ...keep }
    deps.setScan(key, s)
    return s
  } catch (e) {
    // a failed scan is never "clear": no verdict, and it can be retried
    const s: ScanState = { state: 'failed', at: Date.now(), findings: [], classifier: model, classifierVersion: CLASSIFIER_VERSION, error: (e as Error).message, skipped: rec.scan?.skipped }
    deps.setScan(key, s)
    return s
  } finally {
    running.delete(key)
  }
}

/** The user typed the phrase to pass a warning. Only for a finished scan with the verdict "warn". */
export function confirmWarning(key: string, phrase: unknown): ScanState | { error: string } {
  const rec = deps?.get(key)
  if (!rec?.scan || rec.scan.state !== 'done' || rec.scan.verdict !== 'warn') return { error: 'Only a scan with a warning can be confirmed.' }
  if (typeof phrase !== 'string' || phrase.trim().toLowerCase() !== WARN_PHRASE.toLowerCase()) return { error: `Type "${WARN_PHRASE}" to continue.` }
  const s: ScanState = { ...rec.scan, warnConfirmed: { at: Date.now(), phrase: phrase.trim() } }
  deps!.setScan(key, s)
  return s
}

/** "Review without the AI scan": recorded with the typed phrase. Never for a blocked extension. */
export function skipScan(key: string, phrase: unknown): ScanState | { error: string } {
  const rec = deps?.get(key)
  if (!rec) return { error: 'That extension is no longer in the list.' }
  if (rec.scan?.state === 'done' && rec.scan.verdict === 'block') return { error: 'A blocked extension can\'t be reviewed for install.' }
  if (rec.scan?.state === 'scanning') return { error: 'A scan is running.' }
  if (typeof phrase !== 'string' || phrase.trim().toLowerCase() !== SKIP_PHRASE.toLowerCase()) return { error: `Type "${SKIP_PHRASE}" to continue without the scan.` }
  const s: ScanState = { ...(rec.scan ?? { state: 'failed', at: Date.now(), findings: [], error: 'Not scanned.' }), skipped: { at: Date.now(), phrase: phrase.trim() } }
  deps!.setScan(key, s)
  return s
}

/** A scan left "scanning" by a restart is a failed scan. */
export function settleInterrupted(list: { key: string; scan?: ScanState }[]): void {
  for (const r of list) if (r.scan?.state === 'scanning') deps?.setScan(r.key, { ...r.scan, state: 'failed', error: 'Corvid was closed during the scan. Scan again.' })
}
