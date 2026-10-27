import type { Note } from './types'
import { hasUserName, userLabel } from './userName'

/** A single note's text is capped here; the editor and the tools refuse anything bigger. */
export const MAX_NOTE_BYTES = 200 * 1024
/** from here the editor warns that the note is large */
export const LARGE_NOTE_BYTES = 100 * 1024

export const noteBytes = (s: string): number => new TextEncoder().encode(s).length

export const sizeLabel = (n: number): string => (n < 1024 ? `${n} B` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`)

/** Who wrote a note, as the Notes view shows it. `me` is the user's name from Settings ("You" until one is set). */
export const noteAuthor = (n: Note, me?: string): string =>
  n.author === 'user' ? (hasUserName(me) ? userLabel(me) : 'You') : n.author === 'assistant' ? 'Corvid' : (n.agentName ?? `Worker for #${n.taskId}`)

/** The header's updated-by, in the Notes view's words. */
export const updatedByLabel = (by: string | undefined, me?: string): string | undefined =>
  by === 'user' ? (hasUserName(me) ? userLabel(me) : 'you') : by === 'assistant' ? 'Corvid' : by
