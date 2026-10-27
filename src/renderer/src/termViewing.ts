import { api } from './api'

// Terminals on screen or focused, counted per place that shows them, for main: a finished agent the user has open in a
// card, a tab or the Agents view, or is typing into, is never closed (#70). Whatever shows a terminal calls showing().

const shown = new Map<string, number>()

export function showing(termId: string, on: boolean): void {
  const n = (shown.get(termId) ?? 0) + (on ? 1 : -1)
  if (n > 0) shown.set(termId, n)
  else shown.delete(termId)
  api.viewingTerminals([...shown.keys()])
}

// a reloaded window starts with none, whatever the last one showed
api.viewingTerminals([])
