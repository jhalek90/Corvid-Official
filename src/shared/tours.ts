// Guided tours (#214): the crow flies to a part of the screen, perches, and a speech bubble explains it. A tour is
// data, never code: one JSON file, checked here, played by the renderer's TourPlayer. Built-in tours live in
// src/renderer/src/tours/*.json; the user's own go in the data folder's tours folder. Pure functions only, so the
// validator and the player's step logic are tested on their own (scripts/test-tours.mjs).
//
// The format is versioned: `format: 1`. A later change bumps it, and a file with an unknown format is refused with a
// plain error instead of being half-read.

import { TOUR_ANCHOR_NAMES } from './tourAnchors'

export const TOUR_FORMAT = 1
/** Most steps in one tour. */
export const MAX_STEPS = 12
/** Most characters in one step's text: about two sentences. */
export const MAX_TEXT = 240
export const MAX_TITLE = 60
export const MAX_SUMMARY = 160

/** Views a step may open first: the same ids the show tool and the rail use. */
export const TOUR_VIEWS = ['terminals', 'tasks', 'usage', 'projects', 'notes', 'settings', 'connections', 'extensions', 'docs', 'lineage'] as const
export type TourView = (typeof TOUR_VIEWS)[number]

/** Things the app tells the player about, for hands-on steps. Small and closed: anything else fails validation. */
export const TOUR_EVENTS = ['task-created', 'worker-started', 'worker-done'] as const
export type TourEvent = (typeof TOUR_EVENTS)[number] | `view-opened:${TourView}`

export interface TourStep {
  /** a name from TOUR_ANCHORS */
  anchor: string
  /** plain text, one or two sentences */
  text: string
  /** open this view first */
  view?: TourView
  /** "next" (the default: a Next button) or an event that moves the tour on by itself */
  advance?: 'next' | TourEvent
}

export interface Tour {
  format: 1
  id: string
  title: string
  summary: string
  steps: TourStep[]
}

/** Where a tour came from, for the Help list. */
export type TourSource = 'built-in' | 'user'
export interface ListedTour extends Tour {
  source: TourSource
}

export const isTourEvent = (v: unknown): v is TourEvent =>
  typeof v === 'string' &&
  ((TOUR_EVENTS as readonly string[]).includes(v) || (v.startsWith('view-opened:') && (TOUR_VIEWS as readonly string[]).includes(v.slice('view-opened:'.length))))

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * Check a parsed tour file. Returns the tour (only the known fields, trimmed) or every problem found, in plain words.
 * `anchors` is the anchor vocabulary; the registry by default.
 */
export function validateTour(json: unknown, anchors: ReadonlySet<string> = TOUR_ANCHOR_NAMES): { tour: Tour } | { errors: string[] } {
  const errors: string[] = []
  if (!isObj(json)) return { errors: ['A tour must be a JSON object.'] }
  if (json.format !== TOUR_FORMAT) errors.push(`Unknown format ${JSON.stringify(json.format)}: this Corvid reads format ${TOUR_FORMAT}.`)
  const str = (k: string, max: number): string => {
    const v = json[k]
    if (typeof v !== 'string' || !v.trim()) {
      errors.push(`"${k}" must be a non-empty string.`)
      return ''
    }
    if (v.trim().length > max) errors.push(`"${k}" is ${v.trim().length} characters; at most ${max}.`)
    return v.trim()
  }
  const id = str('id', 60)
  if (id && !/^[a-z0-9][a-z0-9-]*$/.test(id)) errors.push(`"id" must be lowercase letters, digits and dashes, like "your-first-day".`)
  const title = str('title', MAX_TITLE)
  const summary = str('summary', MAX_SUMMARY)
  const steps: TourStep[] = []
  if (!Array.isArray(json.steps) || !json.steps.length) errors.push('"steps" must be a list with at least one step.')
  else {
    if (json.steps.length > MAX_STEPS) errors.push(`Too many steps: ${json.steps.length}; at most ${MAX_STEPS}.`)
    json.steps.forEach((s, i) => {
      const at = `Step ${i + 1}`
      if (!isObj(s)) return errors.push(`${at} must be an object.`)
      const before = errors.length
      if (typeof s.anchor !== 'string' || !anchors.has(s.anchor)) errors.push(`${at}: unknown anchor ${JSON.stringify(s.anchor)}.`)
      if (typeof s.text !== 'string' || !s.text.trim()) errors.push(`${at}: "text" must be a non-empty string.`)
      else if (s.text.trim().length > MAX_TEXT) errors.push(`${at}: text is ${s.text.trim().length} characters; at most ${MAX_TEXT}.`)
      if (s.view !== undefined && !(TOUR_VIEWS as readonly unknown[]).includes(s.view)) errors.push(`${at}: unknown view ${JSON.stringify(s.view)}.`)
      if (s.advance !== undefined && s.advance !== 'next' && !isTourEvent(s.advance)) errors.push(`${at}: unknown event ${JSON.stringify(s.advance)}.`)
      if (errors.length > before) return
      const step: TourStep = { anchor: s.anchor as string, text: (s.text as string).trim() }
      if (s.view !== undefined) step.view = s.view as TourView
      if (s.advance !== undefined && s.advance !== 'next') step.advance = s.advance as TourEvent
      steps.push(step)
    })
  }
  if (errors.length) return { errors }
  return { tour: { format: TOUR_FORMAT, id, title, summary, steps } }
}

// ---------- tours the assistant makes on the fly (#216) ----------

/** Most steps in a tour Corvid the assistant makes on the spot: short, unlike a written tour. */
export const MAX_FLY_STEPS = 8
/** Saved on-the-fly tours get ids with this prefix, so one never shadows a built-in tour. */
export const SAVED_PREFIX = 'my-'

/** A tour id from a title: lowercase letters, digits and dashes, never empty. */
export const tourIdFrom = (title: string, prefix = ''): string =>
  prefix + (title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '') || 'tour')

/**
 * The assistant's tour (a title, steps and maybe a summary) as a whole format-1 tour, checked by validateTour and held
 * to MAX_FLY_STEPS. The same format and rules as a tour file; only the id and summary are filled in when missing.
 */
export function flyTour(input: { title?: unknown; summary?: unknown; steps?: unknown }, prefix = ''): { tour: Tour } | { errors: string[] } {
  const title = typeof input.title === 'string' ? input.title : ''
  const summary = typeof input.summary === 'string' && input.summary.trim() ? input.summary : title
  const r = validateTour({ format: TOUR_FORMAT, id: tourIdFrom(title, prefix), title, summary, steps: input.steps })
  const long = Array.isArray(input.steps) && input.steps.length > MAX_FLY_STEPS ? [`Too many steps for a tour made on the spot: ${input.steps.length}; at most ${MAX_FLY_STEPS}.`] : []
  if ('errors' in r) return { errors: [...long, ...r.errors.filter((e) => !e.startsWith('Too many steps'))] }
  return long.length ? { errors: long } : r
}

/** Built-in tours first, then the user's; a user tour with a built-in's id is skipped (and named), never a silent swap. */
export function mergeTours(builtIn: Tour[], user: Tour[]): { tours: ListedTour[]; clashes: string[] } {
  const ids = new Set(builtIn.map((t) => t.id))
  const clashes: string[] = []
  const tours: ListedTour[] = builtIn.map((t) => ({ ...t, source: 'built-in' }))
  for (const t of user) {
    if (ids.has(t.id)) {
      clashes.push(t.id)
      continue
    }
    ids.add(t.id)
    tours.push({ ...t, source: 'user' })
  }
  return { tours, clashes }
}

/** One line of a tour list: the Docs list and the title bar's "?" menu (#218) both draw from this, so they never differ. */
export interface TourEntry {
  id: string
  title: string
  summary: string
  /** from the data folder's tours folder, not built in */
  yours: boolean
  /** finished at least once */
  done: boolean
}

export const tourEntries = (tours: readonly ListedTour[], finished: readonly string[]): TourEntry[] =>
  tours.map((t) => ({ id: t.id, title: t.title, summary: t.summary, yours: t.source === 'user', done: finished.includes(t.id) }))

// ---------- the player's step logic ----------

export interface TourRun {
  tour: Tour
  index: number
}

export type TourMove = { run: TourRun } | { end: 'finished' | 'skipped' }

export const startTour = (tour: Tour): TourRun => ({ tour, index: 0 })

export const currentStep = (r: TourRun): TourStep => r.tour.steps[r.index]

/** Next (or "Skip this step" on a hands-on step): the following step, or the end after the last. */
export function nextStep(r: TourRun): TourMove {
  return r.index + 1 >= r.tour.steps.length ? { end: 'finished' } : { run: { ...r, index: r.index + 1 } }
}

/** Back: the step before, staying on the first. */
export const backStep = (r: TourRun): TourRun => ({ ...r, index: Math.max(0, r.index - 1) })

/** An app event: moves on only when the current step waits for exactly this one. */
export function onTourEvent(r: TourRun, event: string): TourMove | null {
  const want = currentStep(r).advance
  return want && want !== 'next' && want === event ? nextStep(r) : null
}

/**
 * A narrow Agents view shows its cards or the board, not both (AgentsView's Cards / Board switch). The half a step's
 * anchor lives on, so the player can show it: the board for the messages.* anchors, the cards for a worker card.
 */
export const agentsPaneFor = (anchor: string): 'cards' | 'board' | undefined =>
  anchor.startsWith('messages.') ? 'board' : anchor === 'agents.worker-card' ? 'cards' : undefined

/** Whether the bubble shows a Next button (a plain step) or waits, offering "Skip this step" (a hands-on step). */
export const waitsForEvent = (s: TourStep): boolean => !!s.advance && s.advance !== 'next'

export const stepLabel = (r: TourRun): string => `Step ${r.index + 1} of ${r.tour.steps.length}`

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/**
 * Where the bubble goes: below the anchor when there is room, else above it, clamped to the window. With no anchor
 * (missing at run time) it sits centred, so the tour never hangs.
 */
export function bubbleBox(anchor: Box | null, bubble: { width: number; height: number }, win: { width: number; height: number }, gap = 14): { left: number; top: number; centred: boolean } {
  const clampX = (x: number): number => Math.max(8, Math.min(win.width - bubble.width - 8, x))
  const clampY = (y: number): number => Math.max(8, Math.min(win.height - bubble.height - 8, y))
  if (!anchor || anchor.width <= 0 || anchor.height <= 0) {
    return { left: clampX((win.width - bubble.width) / 2), top: clampY((win.height - bubble.height) / 2), centred: true }
  }
  const left = clampX(anchor.left + anchor.width / 2 - bubble.width / 2)
  const below = anchor.top + anchor.height + gap
  if (below + bubble.height <= win.height - 8) return { left, top: below, centred: false }
  const above = anchor.top - gap - bubble.height
  if (above >= 8) return { left, top: above, centred: false }
  // a tall anchor (a whole view): beside it, inside its top edge
  return { left: clampX(anchor.left + 24), top: clampY(anchor.top + 24), centred: false }
}

// ---------- the data folder's tours.json ----------

/** tours.json in the data folder: which tours the user finished, whether the first-run offer was seen, and which tours a view has offered once (#215). */
export interface ToursState {
  finished: string[]
  offered?: boolean
  hinted?: string[]
}

export function readToursState(json: unknown): ToursState {
  if (!isObj(json)) return { finished: [] }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const hinted = strings(json.hinted)
  return { finished: strings(json.finished), offered: json.offered === true || undefined, ...(hinted.length ? { hinted } : {}) }
}

/** The first-run card shows once: tours on, never offered, and nothing finished yet. */
export const shouldOfferTour = (s: ToursState, offerTours: boolean | undefined): boolean => offerTours !== false && !s.offered && !s.finished.length

/**
 * A view's soft offer of its own tour (#215: the Context cloud offers "Who knows what"): once ever, with tours on, and
 * only after the first-run card was answered, so the two never show together. A finished tour is not offered.
 */
export const shouldHintTour = (s: ToursState, offerTours: boolean | undefined, id: string): boolean =>
  offerTours !== false && !shouldOfferTour(s, offerTours) && !s.finished.includes(id) && !(s.hinted ?? []).includes(id)
