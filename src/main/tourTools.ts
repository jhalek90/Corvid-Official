import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { TOUR_ANCHORS } from '@shared/tourAnchors'
import { flyTour, MAX_FLY_STEPS, MAX_TEXT, SAVED_PREFIX, TOUR_EVENTS, TOUR_VIEWS, type Tour } from '@shared/tours'
import type { ToolDef } from './mcp'

// Guided tours made on the fly (#216): Corvid the assistant builds a short tour when the user asks "how do I ...?" or
// "where is ...?" and plays it at once, in the #214 format and player. A tour only points at registry anchors and
// shows plain text: it never clicks, types, changes data or starts anything. play_tour and save_tour act on the window
// and the data folder, so a turn an agent's ping started refuses them (agentPing.gateTools); workers never get them.

export interface TourToolDeps {
  /** show this tour in the window now, replacing one that is playing */
  play: (tour: Tour) => void
  /** the data folder's tours folder, where the Help list reads the user's tours */
  dir: () => string
  /** the user's current message: save_tour only runs when it asks to keep a tour */
  request: () => string
}

/** "save that tour", "keep it", "store this one": the user asked to keep a tour, in their own message. */
export const ASKED_TO_KEEP = /\b(save|saved|saving|keep|store)\b/i

const stepInput = z.object({
  anchor: z.string().describe('a name from tour_anchors'),
  text: z.string().describe(`plain text, one or two sentences, at most ${MAX_TEXT} characters; no Markdown or HTML`),
  view: z.string().optional().describe('open this view first: ' + TOUR_VIEWS.join(', ')),
  advance: z.string().optional().describe('"next" (the default) or an event from tour_anchors that moves the tour on')
})
const tourInput = {
  title: z.string().describe('a short title, at most 60 characters'),
  summary: z.string().optional().describe('one line on what the tour shows; the title when left out'),
  steps: z.array(stepInput).describe(`3 to 6 steps is best; at most ${MAX_FLY_STEPS}`)
}

const refused = (errors: string[]): string => `Not played. Fix these and call again:\n- ${errors.join('\n- ')}`

/** A file name in `dir` for this id that isn't taken: my-x.json, then my-x-2.json and so on. */
function freeFile(dir: string, id: string): { id: string; file: string } {
  for (let n = 1; ; n++) {
    const tid = n === 1 ? id : `${id.slice(0, 56)}-${n}`
    const file = join(dir, `${tid}.json`)
    if (!existsSync(file)) return { id: tid, file }
  }
}

export function tourTools(d: TourToolDeps): ToolDef[] {
  // the last tour played in this run of the app, which "save that tour" keeps
  let last: { title: string; summary: string; steps: Tour['steps'] } | undefined
  return [
    {
      name: 'tour_anchors',
      description:
        'The vocabulary for play_tour: every place a tour step can point at (name and what it is), the views a step can open first, and the events a hands-on step can wait for. Call it before writing a tour.',
      input: {},
      readOnly: true,
      run: () => ({
        anchors: TOUR_ANCHORS.map((a) => ({ name: a.name, about: a.about })),
        views: TOUR_VIEWS,
        events: [...TOUR_EVENTS, ...TOUR_VIEWS.map((v) => `view-opened:${v}`)],
        limits: { steps: MAX_FLY_STEPS, text: MAX_TEXT }
      })
    },
    {
      name: 'play_tour',
      description:
        `Play a short guided tour in Corvid's window now: the crow flies to each place and a bubble shows the text, with Next and Back. ` +
        `Use it when the user asks where something is or how to do something in Corvid, or asks what a Corvid feature is or does. Call tour_anchors first; steps may only use its anchors, views and events. ` +
        `Keep it to 3 to 6 steps (at most ${MAX_FLY_STEPS}), plain text only. A tour only points and explains: it never clicks, types or changes anything. ` +
        'A tour already playing is replaced. If the tour is invalid nothing plays and you get the problems back: fix them and call again. ' +
        'The tour is not kept; only save_tour keeps it, and only when the user asks.',
      input: tourInput,
      run: ({ title, summary, steps }) => {
        const r = flyTour({ title, summary, steps })
        if ('errors' in r) return refused(r.errors)
        d.play(r.tour)
        last = { title: r.tour.title, summary: r.tour.summary, steps: r.tour.steps }
        return `Playing "${r.tour.title}" (${r.tour.steps.length} steps) in Corvid's window. It isn't saved; if the user wants to keep it, they can ask you to save it.`
      }
    },
    {
      name: 'save_tour',
      description:
        "Keep a tour in the data folder's tours folder, so it shows in the Guided tours list in Docs. Only when the user asks to keep it in their message (\"save that tour\"): never on your own. " +
        'With no steps it saves the tour play_tour played last; or pass a title and steps like play_tour. It never overwrites a saved tour.',
      input: { title: tourInput.title.optional(), summary: tourInput.summary, steps: tourInput.steps.optional() },
      run: ({ title, summary, steps }) => {
        if (!ASKED_TO_KEEP.test(d.request()))
          return 'Not saved: save_tour only runs when the user asks to keep a tour (for example "save that tour"). Tell them it can be kept if they want.'
        const src = steps ? { title, summary, steps } : last ? { title: title ?? last.title, summary: summary ?? last.summary, steps: last.steps } : undefined
        if (!src) return 'Not saved: no tour has been played yet. Pass a title and steps, or play one first.'
        const r = flyTour(src, SAVED_PREFIX)
        if ('errors' in r) return `Not saved. Fix these and call again:\n- ${r.errors.join('\n- ')}`
        mkdirSync(d.dir(), { recursive: true })
        const { id, file } = freeFile(d.dir(), r.tour.id)
        const tour: Tour = { ...r.tour, id }
        const tmp = file + '.tmp'
        writeFileSync(tmp, JSON.stringify(tour, null, 2) + '\n')
        renameSync(tmp, file)
        return `Saved "${tour.title}" as ${id}.json in the tours folder. It shows under Guided tours in Docs (the list re-reads the folder when it opens).`
      }
    }
  ]
}
