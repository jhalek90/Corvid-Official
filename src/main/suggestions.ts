// The collector for agents' "Corvid could:" lines (#202). When a worker's done post carries one, the main process (not
// a model call) appends it to one note, with the task, project and date, and skips exact duplicates. Nothing is posted
// on the board about it; Corvid the assistant raises suggestions only when asked or when one recurs. Pure over a small
// notes interface, so scripts/test-corvid-thesis.mjs runs it without Corvid.

import { SUGGESTIONS_NOTE, suggestionLine } from '@shared/corvidThesis'

export interface SuggestionNotes {
  /** the note with this exact name, if any */
  find: (name: string) => { id: string; text: string } | undefined
  create: (name: string, text: string) => { id: string }
  append: (id: string, text: string) => void
}

export const SUGGESTIONS_HEADER =
  'Suggestions agents made in their done posts, one line each, collected by Corvid itself (the app, task #202). ' +
  'Corvid raises them only when the user asks, or when the same suggestion has come from more than one task; it never turns them into tasks on its own. ' +
  'Merge near-duplicates when the user asks.'

const key = (line: string): string => line.toLowerCase().replace(/\s+/g, ' ').replace(/[.!]+$/, '').trim()

/** The suggestion lines a note already holds (the text after the date, task and project columns). */
export function existingSuggestions(text: string): string[] {
  return text
    .split('\n')
    .map((l) => /^- .*? · (Corvid could: .*)$/.exec(l)?.[1])
    .filter((x): x is string => !!x)
}

/** One done post: appended as a line, 'duplicate' when the same suggestion is there, 'none' when the post has none. */
export function collectSuggestion(
  post: { text: string; taskId: number; project?: string; date?: Date },
  notes: SuggestionNotes
): 'added' | 'duplicate' | 'none' {
  const line = suggestionLine(post.text)
  if (!line) return 'none'
  const note = notes.find(SUGGESTIONS_NOTE)
  if (note && existingSuggestions(note.text).some((x) => key(x) === key(line))) return 'duplicate'
  const day = (post.date ?? new Date()).toISOString().slice(0, 10)
  const entry = `- ${day} · #${post.taskId} · ${post.project?.trim() || 'no project'} · ${line}`
  if (note) notes.append(note.id, entry)
  else notes.create(SUGGESTIONS_NOTE, `${SUGGESTIONS_HEADER}\n\n${entry}`)
  return 'added'
}
