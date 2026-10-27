import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { Mic } from 'lucide-react'
import type { VoiceStatus } from '@shared/types'
import { VOICE_UNAVAILABLE } from '@shared/platformInfo'
import { api } from '../api'
import { keyLabel, mod, otherMod } from '../keys'

// Voice dictation for the assistant input, modelled on the Claude Code VS Code extension:
// Ctrl+D (or the mic button) tapped toggles recording, held past 200 ms it's push-to-talk.
// The transcript is spliced in at the cursor and shown dimmed until recording stops;
// typing, Enter or another Ctrl+D ends it.

const HOLD_MS = 200
const LEVEL_EVERY_MS = 50

interface Compose {
  gen: number
  prefix: string | null
  suffix: string
}

/** RMS of a 16-bit chunk mapped onto 0..1 the same way the extension's meter does it */
function levelOf(pcm: Int16Array): number {
  if (!pcm.length) return 0
  let sum = 0
  for (const v of pcm) sum += v * v
  const db = 20 * Math.log10(Math.sqrt(sum / pcm.length) / 32768 || 1e-10)
  const n = Math.max(0, Math.min(1, (db + 70) / 60))
  return Math.min(1, Math.pow(Math.max(0, n - 0.2) / 0.8, 0.7) * 1.4)
}

interface Capture {
  stream: MediaStream
  ctx: AudioContext
}

async function openMic(onChunk: (pcm: Int16Array) => void): Promise<Capture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })
  // Chromium resamples the mic to the context rate, so this hands us 16 kHz directly.
  const ctx = new AudioContext({ sampleRate: 16000 })
  const src = ctx.createMediaStreamSource(stream)
  const proc = ctx.createScriptProcessor(1024, 1, 1)
  proc.onaudioprocess = (e) => {
    const f = e.inputBuffer.getChannelData(0)
    const pcm = new Int16Array(f.length)
    for (let i = 0; i < f.length; i++) pcm[i] = Math.max(-1, Math.min(1, f[i])) * 0x7fff
    onChunk(pcm)
  }
  src.connect(proc)
  proc.connect(ctx.destination)
  return { stream, ctx }
}

function micError(e: unknown): string {
  const name = (e as DOMException)?.name
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'Dictation error: no microphone found'
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Dictation error: microphone access was blocked'
  if (name === 'NotReadableError') return 'Dictation error: the microphone is in use by another app'
  return `Dictation error: ${(e as Error)?.message ?? e}`
}

export interface Dictation {
  status: VoiceStatus | null
  recording: boolean
  level: number
  error?: string
  /** the dictated span of the input while recording */
  interim: { start: number; end: number } | null
  toggle: () => void
  stop: () => void
  onMicDown: () => void
  /** call from the input's onChange: typing over a dictation ends it */
  noteTyping: () => void
}

export function useDictation(opts: {
  value: string
  setValue: (v: string) => void
  inputRef: RefObject<HTMLTextAreaElement | null>
  keyterms: () => string[]
  /** brings the input on screen when the hotkey fires while it's off screen */
  reveal: () => void
  /** 'focused': Ctrl+D only while this input has focus (the board's box). The default answers
   *  Ctrl+D anywhere except in an input marked data-own-dictation, which has its own. */
  hotkey?: 'global' | 'focused'
}): Dictation {
  const [status, setStatus] = useState<VoiceStatus | null>(null)
  const [recording, setRecording] = useState(false)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string>()
  const [interim, setInterim] = useState<{ start: number; end: number } | null>(null)
  const [holdStart, setHoldStart] = useState<number | null>(null)

  const compose = useRef<Compose>({ gen: 0, prefix: null, suffix: '' })
  const idRef = useRef<string | null>(null)
  const lastId = useRef<string | null>(null)
  const capture = useRef<Capture | null>(null)
  const caret = useRef<number | null>(null)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const recRef = useRef(recording)
  recRef.current = recording

  useEffect(() => {
    const load = (): void => void api.voiceStatus().then(setStatus, () => {})
    load()
    // privacy settings can change while we're in the background
    window.addEventListener('focus', load)
    return () => window.removeEventListener('focus', load)
  }, [])

  const teardown = (): void => {
    const c = capture.current
    capture.current = null
    if (c) {
      c.stream.getTracks().forEach((t) => t.stop())
      void c.ctx.close().catch(() => {})
    }
    compose.current = { gen: compose.current.gen + 1, prefix: null, suffix: '' }
    setRecording(false)
    setInterim(null)
    setLevel(0)
  }

  const stop = useCallback((): void => {
    const id = idRef.current
    idRef.current = null
    if (id) api.voiceStop(id)
    teardown()
  }, [])

  const start = useCallback(async (): Promise<void> => {
    if (idRef.current) return
    const ta = optsRef.current.inputRef.current
    const value = optsRef.current.value
    const pos = ta && document.activeElement === ta ? ta.selectionStart : value.length
    ta?.focus()
    compose.current = { gen: compose.current.gen + 1, prefix: value.slice(0, pos), suffix: value.slice(pos) }
    const id = `voice-${Date.now()}`
    idRef.current = lastId.current = id
    setRecording(true)
    setError(undefined)
    setLevel(0)
    void api.voiceStart(id, optsRef.current.keyterms())
    let lastLevel = 0
    try {
      const c = await openMic((pcm) => {
        if (idRef.current !== id) return
        api.voiceAudio(id, new Uint8Array(pcm.buffer))
        const now = Date.now()
        if (now - lastLevel >= LEVEL_EVERY_MS) {
          lastLevel = now
          setLevel(levelOf(pcm))
        }
      })
      if (idRef.current !== id) {
        c.stream.getTracks().forEach((t) => t.stop())
        void c.ctx.close()
        return
      }
      capture.current = c
    } catch (e) {
      if (idRef.current !== id) return
      stop()
      setError(micError(e))
    }
  }, [stop])

  const toggle = useCallback((): void => {
    if (recRef.current) stop()
    else void start()
  }, [start, stop])
  const toggleRef = useRef(toggle)
  toggleRef.current = toggle

  // transcript in, ended streams out
  useEffect(() => {
    const offText = api.on('voice:text', (id, text) => {
      const c = compose.current
      if (id !== idRef.current || c.prefix === null) return
      const lead = c.prefix && !/\s$/.test(c.prefix) && text ? ' ' : ''
      const tail = c.suffix && !/^\s/.test(c.suffix) && text ? ' ' : ''
      const start = c.prefix.length + lead.length
      const end = start + text.length
      caret.current = end
      optsRef.current.setValue(c.prefix + lead + text + tail + c.suffix)
      setInterim(text ? { start, end } : null)
    })
    const offEnd = api.on('voice:end', (id, err) => {
      if (id === idRef.current) {
        idRef.current = null
        teardown()
      }
      if (err && id === lastId.current) setError(err)
    })
    return () => {
      offText()
      offEnd()
    }
  }, [])

  // keep the cursor right after the dictated text
  useLayoutEffect(() => {
    const ta = optsRef.current.inputRef.current
    if (caret.current === null || !ta) return
    ta.setSelectionRange(caret.current, caret.current)
    caret.current = null
  }, [opts.value])

  useEffect(() => () => stop(), [stop])

  // Ctrl+D: keydown starts (or stops), a release after 200 ms means it was held to talk.
  const usable = !!status?.enabled && !status.micDenied
  useEffect(() => {
    if (!usable) return
    let keyHeld = false
    let keyDownAt: number | null = null
    const isCombo = (e: KeyboardEvent): boolean => mod(e) && e.key.toLowerCase() === 'd' && !e.shiftKey && !e.altKey && !otherMod(e)
    const onDown = (e: KeyboardEvent): void => {
      if (e.repeat || !isCombo(e)) return
      // a terminal needs Ctrl+D for itself (EOF)
      const active = document.activeElement as HTMLElement | null
      if (active?.closest('.xterm')) return
      if (!recRef.current) {
        if (optsRef.current.hotkey === 'focused' ? active !== optsRef.current.inputRef.current : active?.closest('[data-own-dictation]')) return
      }
      e.preventDefault()
      if (recRef.current) {
        toggleRef.current()
        keyDownAt = null
        keyHeld = false
        return
      }
      keyDownAt = Date.now()
      keyHeld = true
      if (optsRef.current.inputRef.current) toggleRef.current()
      else {
        optsRef.current.reveal()
        setTimeout(() => toggleRef.current(), 60)
      }
    }
    const onUp = (e: KeyboardEvent): void => {
      if (!(e.key.toLowerCase() === 'd' || e.key === 'Control') || !keyHeld) return
      keyHeld = false
      const at = keyDownAt
      keyDownAt = null
      if (at !== null && Date.now() - at >= HOLD_MS && recRef.current) toggleRef.current()
    }
    const onBlur = (): void => {
      if (!keyHeld) return
      keyHeld = false
      keyDownAt = null
      if (recRef.current) toggleRef.current()
    }
    document.addEventListener('keydown', onDown, true)
    document.addEventListener('keyup', onUp, true)
    window.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('keydown', onDown, true)
      document.removeEventListener('keyup', onUp, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [usable])

  // mic button: a short click toggles, holding past 200 ms records until release
  useEffect(() => {
    if (holdStart === null) return
    const t = setTimeout(() => {
      if (!recRef.current) toggleRef.current()
    }, HOLD_MS)
    const release = (): void => {
      setHoldStart(null)
      if (Date.now() - holdStart < HOLD_MS) toggleRef.current()
      else if (recRef.current) toggleRef.current()
    }
    document.addEventListener('mouseup', release)
    window.addEventListener('blur', release)
    return () => {
      clearTimeout(t)
      document.removeEventListener('mouseup', release)
      window.removeEventListener('blur', release)
    }
  }, [holdStart])

  return {
    status,
    recording,
    level,
    error,
    interim,
    toggle,
    stop,
    onMicDown: () => setHoldStart(Date.now()),
    noteTyping: () => {
      if (recRef.current) stop()
    }
  }
}

// ---------- button ----------

const BARS = [0.6, 1, 0.75]

function LevelBars({ level }: { level: number }): ReactNode {
  return (
    <svg width={20} height={20} viewBox="0 0 20 20" aria-hidden="true">
      {BARS.map((k, i) => {
        const h = 4 + 12 * level * k
        return <rect key={i} x={i * 8} y={(20 - h) / 2} width={4} height={h} rx={2} fill="currentColor" />
      })}
    </svg>
  )
}

const PRIVACY: Record<string, string> = {
  win32: 'Settings → Privacy & security → Microphone',
  darwin: 'System Settings → Privacy & Security → Microphone'
}

export function MicButton({ d }: { d: Dictation }): ReactNode {
  const s = d.status
  if (!s) return null
  const denied = s.micDenied
  const disabled = !s.supported || denied || !s.enabled
  const tip = d.error
    ? d.error
    : !s.supported
      ? VOICE_UNAVAILABLE
      : !s.enabled
      ? 'Voice dictation needs a claude.ai sign-in (run claude, then /login)'
      : denied
        ? `Microphone access denied — enable in ${PRIVACY[s.platform] ?? 'your system settings'}`
        : d.recording
          ? 'Stop recording'
          : null
  return (
    <div className="mic-wrap">
      <button
        type="button"
        className={`mic-btn${d.recording ? ' recording' : ''}`}
        disabled={disabled}
        aria-label={d.error ?? (!s.supported ? VOICE_UNAVAILABLE : denied ? 'Microphone access denied' : d.recording ? 'Stop recording' : 'Voice dictation')}
        onMouseDown={(e) => {
          if (e.button !== 0) return
          e.preventDefault() // keep the cursor where it is in the input
          d.onMicDown()
        }}
      >
        {d.recording && <LevelBars level={d.level} />}
        <span className="mic-puck">
          <Mic size={15} />
        </span>
      </button>
      <span className={`mic-tip${d.error ? ' error' : ''}`} aria-hidden="true">
        {tip ?? (
          <>
            Tap or hold to record <kbd>{keyLabel('D')}</kbd>
          </>
        )}
      </span>
    </div>
  )
}
