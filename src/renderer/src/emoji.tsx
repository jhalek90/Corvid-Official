import type { ReactNode } from 'react'
import { chars, isEmoji } from '@shared/text'

// Emoji in board text. Each one goes in a span of its own (the emoji font first, so it lines up and
// never takes a text font's black-and-white glyph). Older systems lack newer emoji: Windows 10 draws
// 🪶 as an empty box and 🐦‍⬛ as a bird and a black square. Whether this window can draw one is
// measured once on a canvas; one it can't is shown simplified (the first part of a sequence, a flag's
// two letters) or as a small "emoji" label, never a box. The real emoji stays in the text, so copying
// a selection gives it back whole.

const FONT = "32px 'Segoe UI Emoji', 'Apple Color Emoji', 'Noto Color Emoji', 'Inter Variable', 'Segoe UI', sans-serif"
const ZWJ = '\u200d'
const RI = /^[\u{1f1e6}-\u{1f1ff}]{2}$/u
const SKIN = /[\u{1f3fb}-\u{1f3ff}]/u

let ctx: CanvasRenderingContext2D | null | undefined
let missing: string | undefined
const known = new Map<string, boolean>()

/** What a string draws as, as a fingerprint of its pixels' coverage. */
function ink(s: string): string {
  const c = ctx!
  c.clearRect(0, 0, 160, 48)
  c.fillText(s, 4, 36)
  const d = c.getImageData(0, 0, 160, 48).data
  let out = ''
  for (let i = 3; i < d.length; i += 16) out += d[i] > 127 ? '1' : '0'
  return out
}

/** The parts a sequence is made of, when it is one: the people in a family, a flag's letters, a hand and its skin tone. */
function parts(e: string): string[] {
  if (e.includes(ZWJ)) return e.split(ZWJ).filter(Boolean)
  if (RI.test(e)) return [...e]
  const skin = SKIN.exec(e)
  if (skin && skin.index > 0) return [e.slice(0, skin.index), skin[0]]
  return []
}

/** Whether this window draws the emoji as one picture. */
export function canShow(e: string): boolean {
  const hit = known.get(e)
  if (hit !== undefined) return hit
  if (ctx === undefined) {
    ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
    if (ctx) {
      ctx.canvas.width = 160
      ctx.canvas.height = 48
      ctx.font = FONT
      ctx.textBaseline = 'alphabetic'
      missing = ink('\u{10fffd}')
    }
  }
  let ok = true
  if (ctx) {
    const drawn = ink(e)
    const p = parts(e)
    // a box (the font has nothing), nothing at all, or a sequence drawn as its parts side by side
    ok = drawn !== missing && drawn.includes('1')
    if (ok && p.length > 1) ok = ctx.measureText(e).width < 0.8 * p.reduce((w, x) => w + ctx!.measureText(x).width, 0)
  }
  known.set(e, ok)
  return ok
}

const hex = (e: string): string =>
  [...e]
    .map((c) => c.codePointAt(0)!)
    .filter((n) => n !== 0xfe0f && n !== 0x200d)
    .map((n) => `U+${n.toString(16).toUpperCase()}`)
    .join(' ')

/** An emoji this window can't draw: the closest thing it can, with the real one kept for copying. */
function fallback(e: string, key: string): ReactNode {
  let show = 'emoji'
  let title = `An emoji this system's font can't draw (${hex(e)}). It's still in the message: copy it to see it elsewhere.`
  if (RI.test(e)) {
    show = [...e].map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65)).join('')
    title = `The flag for ${show} (this system shows flags as letters)`
  } else {
    const first = parts(e)[0]
    if (first && canShow(first)) {
      show = first
      title = `Shown simplified: this system's emoji font is older than this emoji (${hex(e)})`
    }
  }
  return (
    <span key={key} className={`emo-fb${isEmoji(show) ? '' : ' label'}`} data-show={show} title={title}>
      <span className="emo-src">{e}</span>
    </span>
  )
}

/** A run of text with each emoji in its own span. Plain text comes back as it is. */
export function emojify(text: string, keyFrom = 0): ReactNode[] {
  if (!/[^\x00-\x7f]/.test(text)) return [text]
  const out: ReactNode[] = []
  let run = ''
  let n = 0
  const next = (): string => `e${keyFrom}.${n++}`
  for (const c of chars(text)) {
    if (!isEmoji(c)) {
      run += c
      continue
    }
    if (run) out.push(run)
    run = ''
    out.push(
      canShow(c) ? (
        <span key={next()} className="emo">
          {c}
        </span>
      ) : (
        fallback(c, next())
      )
    )
  }
  if (run) out.push(run)
  return out
}

/** Text that may hold emoji, for toasts, previews and quotes. */
export const EmojiText = ({ text }: { text: string }): ReactNode => <>{emojify(text)}</>
