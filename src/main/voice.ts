import { systemPreferences } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { VoiceStatus } from '@shared/types'
import { VOICE_UNAVAILABLE, voiceStatusOf, voiceSupported } from './platform'

// Voice dictation, done the way the Claude Code VS Code extension does it: 16 kHz mono
// linear16 audio streamed to Anthropic's speech-to-text socket, signed with the claude.ai
// login Claude Code keeps in ~/.claude/.credentials.json. The renderer captures the mic
// and splices the text into the input; this side owns the socket and the stop rules.

const URL_BASE = 'wss://api.anthropic.com/api/ws/speech_to_text/voice_stream'
const KEEPALIVE = JSON.stringify({ type: 'KeepAlive' })
const CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' })
const KEEPALIVE_MS = 8000
const CLOSE_WAIT_MS = 3000
const SILENCE_MS = 15_000
const MAX_MS = 120_000
const RETRY_DELAY_MS = 250
/** audio kept until the first transcript, replayed on connect and on the one retry */
const REPLAY_BYTES = 160_000
const BASE_KEYTERMS = ['Claude', 'Claude Code', 'MCP', 'subagent', 'worktree', 'codebase', 'TypeScript', 'JSON', 'OAuth', 'webhook', 'regex', 'localhost', 'Electron', 'dashboard', 'Corvid']

const NOT_SIGNED_IN = 'Voice dictation needs a claude.ai sign-in. Run claude and use /login, then try again.'
const NO_AUDIO = 'No audio detected from microphone. Check that the correct input device is selected and that the dashboard has microphone access.'

type Send = (channel: string, ...args: unknown[]) => void

interface Stream {
  id: string
  ws: WebSocket | null
  attempt: number
  committed: string
  interim: string
  startedAt: number
  lastTranscriptAt: number
  gotTranscript: boolean
  retried: boolean
  replay: Uint8Array<ArrayBuffer>[]
  replayBytes: number
  hadSignal: boolean
  stopping: boolean
  error?: string
  timers: NodeJS.Timeout[]
}

let send: Send = () => {}
let refreshLogin: () => Promise<unknown> = async () => {}
let current: Stream | null = null

export function initVoice(opts: { send: Send; refreshLogin: () => Promise<unknown> }): void {
  send = opts.send
  refreshLogin = opts.refreshLogin
}

const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')

function readLogin(): { token: string; expiresAt?: number } | null {
  try {
    const o = JSON.parse(readFileSync(join(claudeDir(), '.credentials.json'), 'utf8'))?.claudeAiOauth
    return typeof o?.accessToken === 'string' && o.accessToken ? { token: o.accessToken, expiresAt: o.expiresAt } : null
  } catch {
    return null
  }
}

export function voiceStatus(): VoiceStatus {
  return voiceStatusOf({ micAccess: () => systemPreferences.getMediaAccessStatus('microphone'), signedIn: () => readLogin() !== null })
}

const LANGS: Record<string, string> = {
  english: 'en', spanish: 'es', español: 'es', french: 'fr', français: 'fr', german: 'de', deutsch: 'de',
  japanese: 'ja', portuguese: 'pt', italian: 'it', korean: 'ko', hindi: 'hi', indonesian: 'id',
  russian: 'ru', polish: 'pl', turkish: 'tr', dutch: 'nl', chinese: 'zh', swedish: 'sv', danish: 'da', norwegian: 'no'
}

/** Claude Code's "language" setting, as the 2-letter code the socket wants. */
function language(): string {
  try {
    const l = JSON.parse(readFileSync(join(claudeDir(), 'settings.json'), 'utf8'))?.language
    if (typeof l !== 'string' || !l.trim()) return 'en'
    const v = l.trim().toLowerCase()
    if (/^[a-z]{2}(-|$)/.test(v)) return v.slice(0, 2)
    return LANGS[v] ?? 'en'
  } catch {
    return 'en'
  }
}

/** comma-joined, ASCII only, deduped, capped at 1 KB like the extension */
function keytermHeader(terms: string[]): string {
  const seen = new Set<string>()
  const out: string[] = []
  let len = 0
  for (const t of terms) {
    const w = t.replace(/,/g, ' ').replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim()
    if (!w || seen.has(w)) continue
    const add = w.length + (out.length ? 1 : 0)
    if (len + add > 1024) break
    seen.add(w)
    out.push(w)
    len += add
  }
  return out.join(',')
}

const hasSignal = (b: Uint8Array): boolean => {
  for (let i = 0; i + 1 < b.length; i += 2) if (b[i] !== 0 || b[i + 1] !== 0) return true
  return false
}

function emitText(s: Stream): void {
  const text = s.interim ? (s.committed ? `${s.committed} ${s.interim}` : s.interim) : s.committed
  send('voice:text', s.id, text)
}

function commitInterim(s: Stream): void {
  if (!s.interim) return
  s.committed = s.committed ? `${s.committed} ${s.interim}` : s.interim
  s.interim = ''
  emitText(s)
}

function connect(s: Stream, token: string, keyterms: string): void {
  const attempt = ++s.attempt
  const params = new URLSearchParams({
    encoding: 'linear16',
    sample_rate: '16000',
    channels: '1',
    endpointing_ms: '300',
    utterance_end_ms: '1000',
    language: language(),
    use_conversation_engine: 'true'
  })
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'x-app': 'cli', 'anthropic-client-platform': 'claude_code_dashboard' }
  if (keyterms) headers['x-config-keyterms'] = keyterms
  // Node's WebSocket (undici) takes extra handshake headers in its init object.
  const ws = new WebSocket(`${URL_BASE}?${params}`, { headers } as unknown as string[])
  ws.binaryType = 'arraybuffer'
  s.ws = ws
  let keepalive: NodeJS.Timeout | null = null
  const live = (): boolean => current === s && s.attempt === attempt

  ws.onopen = () => {
    if (!live()) return ws.close()
    ws.send(KEEPALIVE)
    keepalive = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(KEEPALIVE), KEEPALIVE_MS)
    for (const chunk of s.replay) ws.send(chunk)
  }
  ws.onmessage = (e) => {
    if (!live() || typeof e.data !== 'string') return
    let m: { type?: string; data?: string; description?: string; message?: string }
    try {
      m = JSON.parse(e.data)
    } catch {
      return
    }
    if ((m.type === 'TranscriptInterim' || m.type === 'TranscriptText') && m.data) {
      s.interim = m.data.trim()
      s.lastTranscriptAt = Date.now()
      if (!s.gotTranscript) {
        s.gotTranscript = true
        s.replay = []
        s.replayBytes = 0
      }
      emitText(s)
    } else if (m.type === 'TranscriptEndpoint') commitInterim(s)
    else if (m.type === 'TranscriptError' || m.type === 'error') fail(s, m.description ?? m.message ?? 'transcription error', token, keyterms)
  }
  ws.onerror = () => {
    if (live() && !s.stopping) fail(s, 'could not reach Anthropic speech-to-text', token, keyterms)
  }
  ws.onclose = () => {
    if (keepalive) clearInterval(keepalive)
    if (s.attempt === attempt) commitInterim(s)
  }
}

function fail(s: Stream, message: string, token: string, keyterms: string): void {
  console.error('[voice]', message)
  if (s.stopping) return
  // Same as the extension: one quiet retry if it breaks before anything was heard.
  if (!s.gotTranscript && !s.retried) {
    s.retried = true
    s.ws?.close()
    s.lastTranscriptAt = Date.now()
    s.timers.push(setTimeout(() => current === s && !s.stopping && connect(s, token, keyterms), RETRY_DELAY_MS))
    return
  }
  s.error = message
  void stopStream(s)
}

async function stopStream(s: Stream): Promise<void> {
  if (s.stopping) return
  s.stopping = true
  for (const t of s.timers) clearTimeout(t)
  const ws = s.ws
  if (ws && ws.readyState === WebSocket.OPEN) {
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        ws.close()
        resolve()
      }, CLOSE_WAIT_MS)
      ws.addEventListener('close', () => {
        clearTimeout(t)
        resolve()
      })
      ws.send(CLOSE_STREAM)
    })
  } else ws?.close()
  commitInterim(s)
  let error = s.error ? `Dictation error: ${s.error}` : undefined
  if (!error && !s.committed && !s.hadSignal && Date.now() - s.startedAt > 2000) error = NO_AUDIO
  if (current === s) current = null
  send('voice:end', s.id, error)
}

export async function startVoice(id: string, extraKeyterms: string[] = []): Promise<void> {
  if (current) void stopStream(current)
  const now = Date.now()
  const s: Stream = {
    id, ws: null, attempt: 0, committed: '', interim: '', startedAt: now, lastTranscriptAt: now,
    gotTranscript: false, retried: false, replay: [], replayBytes: 0, hadSignal: false, stopping: false, timers: []
  }
  current = s

  // Windows only (#160): elsewhere there's no login to read, so say so instead of trying
  if (!voiceSupported()) {
    current = null
    s.stopping = true
    send('voice:end', id, VOICE_UNAVAILABLE, 'unsupported')
    return
  }

  let login = readLogin()
  if (login?.expiresAt && login.expiresAt < Date.now() + 60_000) {
    // claude.exe refreshes its own token on any call; the usage lookup is one we already make.
    await refreshLogin().catch(() => {})
    login = readLogin() ?? login
  }
  if (current !== s || s.stopping) return
  if (!login) {
    current = null
    s.stopping = true
    send('voice:end', id, NOT_SIGNED_IN, 'not_signed_in')
    return
  }

  s.timers.push(
    setInterval(() => {
      if (Date.now() - s.lastTranscriptAt > SILENCE_MS) void stopStream(s)
    }, 1000),
    setTimeout(() => void stopStream(s), MAX_MS)
  )
  connect(s, login.token, keytermHeader([...BASE_KEYTERMS, ...extraKeyterms]))
}

export function voiceAudio(id: string, chunk: Uint8Array): void {
  const s = current
  if (!s || s.id !== id || s.stopping) return
  const buf = new Uint8Array(chunk)
  if (!s.hadSignal && hasSignal(buf)) s.hadSignal = true
  if (!s.gotTranscript && s.replayBytes < REPLAY_BYTES) {
    s.replay.push(buf)
    s.replayBytes += buf.length
  }
  if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(buf)
}

export function stopVoice(id: string): void {
  if (current?.id === id) void stopStream(current)
}

export function shutdownVoice(): void {
  if (current) void stopStream(current)
}
