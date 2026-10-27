// Guided tours (#214), the renderer's side: the tour list (built-in files bundled from ./tours, the user's from the
// data folder), the tour playing now, and the app events hands-on steps wait for. The step logic itself is pure and
// lives in @shared/tours; components/TourPlayer.tsx draws the crow, the bubble and the first-run card.
//
// Adding a tour is adding one JSON file to ./tours (or the data folder's tours folder): nothing here changes.

import { useSyncExternalStore } from 'react'
import {
  backStep,
  mergeTours,
  nextStep,
  onTourEvent,
  startTour,
  validateTour,
  type ListedTour,
  type Tour,
  type TourMove,
  type TourRun,
  type ToursState
} from '@shared/tours'
import { api } from './api'
import { getState, subscribe, toast } from './store'
import { focusedView } from './panes'

const BUILT_IN: Tour[] = Object.entries(import.meta.glob<unknown>('./tours/*.json', { eager: true, import: 'default' })).flatMap(([file, json]) => {
  const r = validateTour(json)
  if ('tour' in r) return [r.tour]
  // scripts/test-tours.mjs keeps this from happening; if it does, the tour is left out rather than the app failing
  console.error(`[tours] built-in ${file} is invalid:`, r.errors)
  return []
})

interface TourStore {
  tours: ListedTour[]
  run: TourRun | null
  state: ToursState | null
  /** where the mascot sat when the tour started: the guide takes off from there */
  from?: { x: number; y: number }
  /** a tour Corvid the assistant made on the fly (#216): not in the list, so its end isn't recorded in tours.json */
  adhoc?: boolean
}

let store: TourStore = { tours: mergeTours(BUILT_IN, []).tours, run: null, state: null }
const listeners = new Set<() => void>()
function set(patch: Partial<TourStore>): void {
  store = { ...store, ...patch }
  for (const l of listeners) l()
}
const watch = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useTours<T>(pick: (s: TourStore) => T): T {
  return useSyncExternalStore(watch, () => pick(store))
}

/** Read the user's tours again (at start-up and whenever the list opens). Bad files are named in one notice. */
let lastSkipped = ''
export async function loadTours(): Promise<void> {
  try {
    const user = await api.toursUser()
    const { tours, clashes } = mergeTours(BUILT_IN, user.tours)
    set({ tours })
    const skipped = [...user.skipped, ...clashes.map((id) => `${id}: a built-in tour already has this id`)]
    // once per change, not on every open of the list
    const key = skipped.join('; ')
    if (skipped.length && key !== lastSkipped) toast(`Skipped ${skipped.length} tour file${skipped.length === 1 ? '' : 's'}: ${key}`, 'error')
    lastSkipped = key
  } catch (e) {
    console.error('[tours] cannot read the tours folder', e)
  }
}

export async function loadTourState(): Promise<void> {
  try {
    set({ state: await api.toursState() })
  } catch {
    set({ state: { finished: [], offered: true } })
  }
}

/** Where the mascot sits now, read before it steps aside for the guide. */
function mascotPoint(): { x: number; y: number } | undefined {
  const el = document.querySelector('.crow:not(.agent-bird):not(.tour-crow):not([hidden])')
  if (!el) return undefined
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.bottom }
}

export function playTour(id: string): void {
  const tour = store.tours.find((t) => t.id === id)
  if (!tour) return toast(`No tour called “${id}”.`, 'error')
  set({ run: startTour(tour), from: mascotPoint(), adhoc: false })
}

/** A tour Corvid the assistant made on the fly (#216): checked again here, then played, replacing one already playing. */
export function playTourData(json: unknown): void {
  const r = validateTour(json)
  if ('errors' in r) return toast(`Corvid's tour couldn't play: ${r.errors[0]}`, 'error')
  // a running tour hands its spot over: keep where the crow took off from
  set({ run: startTour(r.tour), from: store.run ? store.from : mascotPoint(), adhoc: true })
}
api.on('tour:play', playTourData)

function move(m: TourMove): void {
  if ('run' in m) return set({ run: m.run })
  const id = store.run?.tour.id
  const adhoc = store.adhoc
  set({ run: null, adhoc: false })
  if (!id || adhoc) return
  void (m.end === 'finished' ? api.tourFinished(id) : api.toursOffered()).then((state) => set({ state }), () => {})
}

export const tourNext = (): void => void (store.run && move(nextStep(store.run)))
export const tourBack = (): void => void (store.run && set({ run: backStep(store.run) }))
export const endTour = (): void => move({ end: 'skipped' })
/** The first-run card was answered: don't offer it again. */
export const tourOffered = (): void => void api.toursOffered().then((state) => set({ state }), () => {})
/** A view offered this tour: don't offer it there again. */
export const tourHinted = (id: string): void => void api.tourHinted(id).then((state) => set({ state }), () => {})

/** An app event: moves a hands-on step on when it is the one it waits for. */
export function tourEvent(event: string): void {
  if (!store.run) return
  const m = onTourEvent(store.run, event)
  if (m) move(m)
}

// The events, read off the app's own state, so no other file needs a hook: a task with a new id, a worker that
// started running, a worker that finished, and the focused view changing.
let seen: { maxTask: number; running: Set<string>; done: Set<string>; view: string } | null = null
subscribe(() => {
  const s = getState()
  const now = {
    maxTask: s.tasks.reduce((m, t) => Math.max(m, t.id), 0),
    running: new Set(s.assistant.workers.filter((w) => w.state === 'running').map((w) => w.id)),
    done: new Set(s.assistant.workers.filter((w) => w.state === 'finished').map((w) => w.id)),
    view: focusedView(s.layout) ?? s.view
  }
  const was = seen
  seen = now
  if (!was || !store.run) return
  if (now.maxTask > was.maxTask) tourEvent('task-created')
  if ([...now.running].some((id) => !was.running.has(id))) tourEvent('worker-started')
  if ([...now.done].some((id) => !was.done.has(id))) tourEvent('worker-done')
  if (now.view !== was.view) tourEvent(`view-opened:${now.view}`)
})

export const getTourStart = (): { x: number; y: number } | undefined => store.from
