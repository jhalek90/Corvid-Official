import { appendFileSync, existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { scrubber } from './remote/scrub'

// crash.log in the data folder (#83): window crashes, React errors and main-process exceptions, so the next
// blank window leaves evidence. Size-limited: past MAX it moves to crash.log.1 (replacing the older one).
const MAX = 256 * 1024

export const crashLogFile = (): string => join(app.getPath('userData'), 'crash.log')

/** Masks anything that looks like a secret: known remote secrets, API keys, bearer tokens, key=value
 *  secrets and long random strings. */
export function scrubSecrets(text: string): string {
  let out = text
  try {
    out = scrubber()(out)
  } catch {
    /* the remote secret store isn't readable: the patterns below still apply */
  }
  return out
    .replace(/sk-ant-[\w-]+/g, 'sk-ant-•••')
    .replace(/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, '$1 •••')
    .replace(/\b(token|password|passwd|secret|api[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;)]+/gi, '$1$2•••')
    // random-looking runs: long hex (the tool server's tokens) or mixed-case base64 with digits; paths stay readable
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '•••')
    .replace(/\b(?=[\w-]*\d)(?=[\w-]*[A-Z])(?=[\w-]*[a-z])[\w-]{32,}\b/g, '•••')
}

/** Appends one entry: the time, which process, what happened and the details (a stack, a reason). */
export function logCrash(proc: 'main' | 'renderer' | 'window' | 'child', what: string, details = ''): void {
  try {
    const file = crashLogFile()
    if (existsSync(file) && statSync(file).size > MAX) renameSync(file, file + '.1')
    const body = scrubSecrets(details.trim())
    const entry = `[${new Date().toISOString()}] [${proc}] ${scrubSecrets(what.trim())}${body ? '\n' + body.replace(/^/gm, '  ') : ''}\n\n`
    appendFileSync(file, entry.length > 20_000 ? entry.slice(0, 20_000) + '\n  …cut\n\n' : entry)
  } catch (e) {
    console.error('crash.log write failed', e)
  }
  console.error(`[crash] [${proc}] ${what}`)
}

/** The last part of the log, for the notice's "show details". */
export function crashLogTail(chars = 4000): string {
  try {
    const raw = readFileSync(crashLogFile(), 'utf8')
    return raw.slice(-chars)
  } catch {
    return ''
  }
}

const errText = (e: unknown): string => (e instanceof Error ? `${e.stack ?? e.message}` : String(e))

/** Main-process exceptions and rejections get logged and Corvid keeps running: quitting would end every agent,
 *  and Electron's default for an uncaught exception is a modal error box. */
export function catchMainErrors(): void {
  process.on('uncaughtException', (e) => logCrash('main', 'Uncaught exception', errText(e)))
  process.on('unhandledRejection', (e) => logCrash('main', 'Unhandled promise rejection', errText(e)))
  app.on('child-process-gone', (_e, d) => {
    if (d.reason !== 'clean-exit') logCrash('child', `${d.type} process gone: ${d.reason} (exit code ${d.exitCode})`, d.name ?? '')
  })
}
