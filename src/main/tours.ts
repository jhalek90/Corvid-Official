// Guided tours (#214), the main side: the user's own tours from the data folder's tours folder, and tours.json (which
// tours were finished, whether the first-run offer was seen, and which tours a view has offered once). Built-in tours are bundled into the renderer.
// A bad tour file is skipped and named, never a crash.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, type IpcMain } from 'electron'
import { readToursState, validateTour, type Tour, type ToursState } from '../shared/tours'

export const toursDir = (): string => join(app.getPath('userData'), 'tours')
const stateFile = (): string => join(app.getPath('userData'), 'tours.json')

/** Every *.json in the tours folder that validates; the rest by file name with their first problem. */
export function readUserTours(): { tours: Tour[]; skipped: string[] } {
  const tours: Tour[] = []
  const skipped: string[] = []
  let files: string[] = []
  try {
    files = existsSync(toursDir()) ? readdirSync(toursDir()).filter((f) => f.toLowerCase().endsWith('.json')) : []
  } catch {
    return { tours, skipped }
  }
  for (const f of files.sort()) {
    try {
      const r = validateTour(JSON.parse(readFileSync(join(toursDir(), f), 'utf8')))
      if ('tour' in r) tours.push(r.tour)
      else skipped.push(`${f}: ${r.errors[0].replace(/\.$/, '')}`)
    } catch (e) {
      skipped.push(`${f}: not valid JSON (${(e as Error).message})`)
    }
  }
  return { tours, skipped }
}

function readState(): ToursState {
  try {
    return readToursState(JSON.parse(readFileSync(stateFile(), 'utf8')))
  } catch {
    return { finished: [] }
  }
}

function saveState(s: ToursState): ToursState {
  try {
    const tmp = stateFile() + '.tmp'
    writeFileSync(tmp, JSON.stringify(s))
    renameSync(tmp, stateFile())
  } catch (e) {
    console.error('[tours] cannot save tours.json', e)
  }
  return s
}

export function registerTours(ipc: IpcMain): void {
  ipc.handle('tours:user', () => readUserTours())
  ipc.handle('tours:state', () => readState())
  ipc.handle('tours:offered', () => saveState({ ...readState(), offered: true }))
  ipc.handle('tours:hinted', (_e, id: unknown) => {
    const s = readState()
    if (typeof id !== 'string' || s.hinted?.includes(id)) return s
    return saveState({ ...s, hinted: [...(s.hinted ?? []), id].slice(-200) })
  })
  ipc.handle('tours:finished', (_e, id: unknown) => {
    const s = readState()
    if (typeof id !== 'string' || s.finished.includes(id)) return s
    return saveState({ ...s, finished: [...s.finished, id].slice(-200), offered: true })
  })
  ipc.handle('tours:openFolder', () => {
    mkdirSync(toursDir(), { recursive: true })
    return toursDir()
  })
}
