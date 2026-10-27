// Text measured the way people see it. A JavaScript string's length counts UTF-16 pieces, so an emoji
// is 2 to 11 of them and cutting by length can leave half of one (a lone surrogate, a broken glyph).
// These count and cut by grapheme clusters (Intl.Segmenter, in Node and Chromium alike): a flag, a
// keycap, a skin-tone or family emoji is one character, as it is on screen.

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** The characters of a string as people see them. */
export const chars = (s: string): string[] => Array.from(graphemes.segment(s), (g) => g.segment)

/** How many characters a string has as people see them. */
export function charCount(s: string): number {
  // plain ASCII is one character per unit (CRLF aside, which nothing here keeps), and it's most text
  if (!/[^\x00-\x7f]/.test(s)) return s.length
  let n = 0
  for (const _ of graphemes.segment(s)) n++
  return n
}

/** The first `max` characters, never splitting one. */
export function headChars(s: string, max: number): string {
  if (max <= 0) return ''
  if (s.length <= max) return s
  let end = 0
  let n = 0
  for (const g of graphemes.segment(s)) {
    if (n++ === max) break
    end = g.index + g.segment.length
  }
  return s.slice(0, end)
}

/** At most `max` characters: cut with an ellipsis (counted in `max`) when longer. */
export function cutText(s: string, max: number, more = '…'): string {
  if (charCount(s) <= max) return s
  return headChars(s, max - charCount(more)).trimEnd() + more
}

// An emoji: a picture shown as one by default, anything asked to be one (U+FE0F), a flag (regional
// indicators), a keycap (U+20E3), or a pictograph from the emoji planes, with whatever modifiers and
// joiners follow it. Text-style symbols such as ©, ™, ↔ or a bare ☺ are not counted.
const EMOJI = /\p{Emoji_Presentation}|\ufe0f|\u20e3|\p{Regional_Indicator}|[\u{1f000}-\u{1faff}]/u

/** Whether one character (as from `chars`) is an emoji. */
export const isEmoji = (c: string): boolean => EMOJI.test(c)

/** The emoji in a string, in order, each sequence as one. */
export const emojiIn = (s: string): string[] => (/[^\x00-\x7f]/.test(s) ? chars(s).filter(isEmoji) : [])

/** The longest start of a string, in whole characters, that fits in `max` UTF-16 units: for size caps. */
export function headUnits(s: string, max: number): string {
  if (s.length <= max) return s
  // no character as people see it is anywhere near 64 units long, so the window always holds the boundary
  const from = Math.max(0, max - 64)
  let end = from
  for (const g of graphemes.segment(s.slice(from, max + 64))) {
    const at = from + g.index + g.segment.length
    if (at > max) break
    end = at
  }
  return s.slice(0, end)
}
