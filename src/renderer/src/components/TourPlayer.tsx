// Guided tours (#214): the crow flies to the step's anchor and perches, a speech bubble says the step, the anchor
// gets a soft highlight. No scrim: the rest of the app keeps working mid-tour. Esc or Skip ends it at once. The
// step logic is in @shared/tours, the tour list and events in ../tourPlayer; this file only draws.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { X } from 'lucide-react'
import '../tours.css'
import { agentsPaneFor, bubbleBox, currentStep, shouldHintTour, shouldOfferTour, stepLabel, tourEntries, waitsForEvent, type TourEntry } from '@shared/tours'
import { Crow as CrowEngine } from '../crow'
import { CrowArt } from './Crow'
import { setState, useStore } from '../store'
import { endTour, getTourStart, loadTours, loadTourState, playTour, tourBack, tourHinted, tourNext, tourOffered, useTours } from '../tourPlayer'
import { api } from '../api'

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const watchMotion = (cb: () => void): (() => void) => {
  reduceMotion.addEventListener('change', cb)
  return () => reduceMotion.removeEventListener('change', cb)
}

const FIRST_TOUR = 'your-first-day'
const BUBBLE_W = 300
const NONE: string[] = []

/** The first visible element with this anchor name, if any. */
function findAnchor(name: string): HTMLElement | null {
  for (const el of document.querySelectorAll<HTMLElement>(`[data-tour="${CSS.escape(name)}"]`)) {
    const r = el.getBoundingClientRect()
    if (r.width > 0 && r.height > 0) return el
  }
  return null
}

export function TourPlayer(): ReactNode {
  const run = useTours((s) => s.run)
  const still = useSyncExternalStore(watchMotion, () => reduceMotion.matches)
  const crowRef = useRef<HTMLDivElement>(null)
  const engine = useRef<CrowEngine | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  // the guide stays drawn while it flies out after the tour
  const [guide, setGuide] = useState(false)
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [pos, setPos] = useState<{ left: number; top: number; centred: boolean } | null>(null)

  useEffect(() => {
    void loadTours()
    void loadTourState()
  }, [])

  // the guide bird: made when a tour starts, flies out when it ends
  useEffect(() => {
    if (run && !guide) setGuide(true)
    if (!run && engine.current) {
      const crow = engine.current
      engine.current = null
      void crow.leave().then(() => {
        crow.destroy()
        setGuide(false)
      })
    }
  }, [!!run, guide])
  useLayoutEffect(() => {
    if (!guide || !crowRef.current || engine.current) return
    engine.current = new CrowEngine(crowRef.current, { still, guide: true, onHide: endTour })
  }, [guide])
  useEffect(() => () => engine.current?.destroy(), [])

  // each step: open its view, find the anchor, scroll it in, light it, send the crow
  const step = run ? currentStep(run) : null
  useEffect(() => {
    if (!step) return
    if (step.view) setState({ view: step.view })
    // in a narrow Agents view the anchor may sit on the hidden half; with room for both this changes nothing on screen
    const pane = agentsPaneFor(step.anchor)
    if (pane) setState({ agentsPane: pane })
    let live = true
    let el: HTMLElement | null = null
    // look a few times while the view draws; after about a second, go on without it (the bubble shows centred)
    let tries = 0
    let t = 0
    const look = (): void => {
      if (!live) return
      el = findAnchor(step.anchor)
      if (!el && ++tries < 8) {
        t = window.setTimeout(look, 140)
        return
      }
      el?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: still ? 'auto' : 'smooth' })
      el?.classList.add('tour-hl')
      setAnchor(el)
      void engine.current?.guideTo(el, getTourStart())
    }
    t = window.setTimeout(look, 120)
    return () => {
      live = false
      clearTimeout(t)
      el?.classList.remove('tour-hl')
      setAnchor(null)
    }
  }, [run, still])

  // keep the bubble beside its anchor as things move
  useEffect(() => {
    if (!run) return setPos(null)
    const place = (): void => {
      const b = bubbleRef.current
      const r = anchor?.isConnected ? anchor.getBoundingClientRect() : null
      setPos(bubbleBox(r, { width: b?.offsetWidth ?? BUBBLE_W, height: b?.offsetHeight ?? 140 }, { width: window.innerWidth, height: window.innerHeight }))
    }
    place()
    const every = setInterval(place, 400)
    window.addEventListener('resize', place)
    return () => {
      clearInterval(every)
      window.removeEventListener('resize', place)
    }
  }, [run, anchor])

  useEffect(() => {
    if (!run) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') endTour()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [!!run])

  return (
    <>
      {guide && (
        <div className="crow tour-crow" ref={crowRef} title="Right-click to end the tour" hidden>
          <CrowArt />
        </div>
      )}
      {run && step && (
        <div
          ref={bubbleRef}
          className={`tour-bubble${pos?.centred ? ' centred' : ''}`}
          role="dialog"
          aria-label={run.tour.title}
          aria-live="polite"
          style={{ width: BUBBLE_W, left: pos?.left ?? -9999, top: pos?.top ?? -9999 }}
        >
          <div className="tour-head">
            <span className="tour-title">{run.tour.title}</span>
            <button className="btn ghost icon xs" title="End the tour (Esc)" aria-label="End the tour" onClick={endTour}>
              <X size={13} />
            </button>
          </div>
          <p className="tour-text">{step.text}</p>
          {waitsForEvent(step) && <p className="tour-wait">Go ahead and try it; I’ll move on when you do.</p>}
          <div className="tour-foot">
            <span className="tour-count">{stepLabel(run)}</span>
            <button className="btn ghost sm" onClick={endTour}>
              Skip
            </button>
            <button className="btn ghost sm" onClick={tourBack} disabled={run.index === 0}>
              Back
            </button>
            <button className="btn primary sm" onClick={tourNext}>
              {waitsForEvent(step) ? 'Skip this step' : run.index + 1 === run.tour.steps.length ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      )}
      <TourOffer />
    </>
  )
}

/** The first-run card: one offer of "Your first day", gone for good once answered. */
function TourOffer(): ReactNode {
  const offerTours = useStore((s) => s.config?.offerTours)
  const config = useStore((s) => !!s.config)
  const state = useTours((s) => s.state)
  const running = useTours((s) => !!s.run)
  const has = useTours((s) => s.tours.some((t) => t.id === FIRST_TOUR))
  if (!config || !state || running || !has || !shouldOfferTour(state, offerTours)) return null
  return (
    <div className="tour-offer" role="dialog" aria-label="Want a quick tour?">
      <div className="tour-title">Want a quick tour?</div>
      <p className="tour-text">The crow shows you the daily loop: a task, a worker, the board, and merge. About two minutes.</p>
      <div className="tour-foot">
        <button
          className="btn ghost sm"
          onClick={tourOffered}
        >
          No thanks
        </button>
        <button
          className="btn primary sm"
          onClick={() => {
            tourOffered()
            playTour(FIRST_TOUR)
          }}
        >
          Show me around
        </button>
      </div>
    </div>
  )
}

/**
 * A view's one soft offer of its own tour (#215), drawn inside that view: a line with Show me, not the first-run card.
 * Decided once per open view, as soon as nothing else is on: it waits out the first-run card and another tour (the
 * view may sit in a split pane meanwhile). Showing it counts as the offer, so it never comes back. Opened by that
 * same tour, it counts as offered and stays hidden.
 */
export function TourHint({ id, text }: { id: string; text: string }): ReactNode {
  const offerTours = useStore((s) => s.config?.offerTours)
  const config = useStore((s) => !!s.config)
  const state = useTours((s) => s.state)
  const playing = useTours((s) => s.run?.tour.id)
  const has = useTours((s) => s.tours.some((t) => t.id === id))
  const decided = useRef(false)
  const [shown, setShown] = useState(false)
  useEffect(() => {
    if (decided.current || !config || !state) return
    if (playing === id) {
      decided.current = true
      return tourHinted(id)
    }
    if (playing || shouldOfferTour(state, offerTours)) return
    decided.current = true
    if (!has || !shouldHintTour(state, offerTours, id)) return
    setShown(true)
    tourHinted(id)
  }, [config, state, playing, has, offerTours])
  if (!shown || playing) return null
  return (
    <div className="tour-hint" role="note">
      <span>{text}</span>
      <button className="btn ghost xs" onClick={() => (setShown(false), playTour(id))}>
        Show me
      </button>
      <button className="btn ghost icon xs" title="Not now" aria-label="Close" onClick={() => setShown(false)}>
        <X size={12} />
      </button>
    </div>
  )
}

/** Every tour as list lines, the user's read again from their folder on mount: the Docs list and the "?" menu (#218). */
export function useTourEntries(): TourEntry[] {
  const tours = useTours((s) => s.tours)
  const finished = useTours((s) => s.state?.finished ?? NONE)
  useEffect(() => {
    void loadTours()
  }, [])
  return useMemo(() => tourEntries(tours, finished), [tours, finished])
}

/** The Help list (in the Docs view's side): every tour, built-in and the user's, to play again. */
export function TourList(): ReactNode {
  const entries = useTourEntries()
  return (
    <div className="tour-list" aria-label="Guided tours">
      <div className="docs-tree-sec">Guided tours</div>
      <ul>
        {entries.map((t) => (
          <li key={t.id}>
            <a href="#" className="docs-tree-link" title={t.summary} onClick={(e) => (e.preventDefault(), playTour(t.id))}>
              {t.title}
              {t.yours ? ' (yours)' : ''}
              {t.done ? ' ✓' : ''}
            </a>
          </li>
        ))}
        <li>
          <a href="#" className="docs-tree-link tour-folder" title="Your own tours go in this folder, one JSON file each" onClick={(e) => (e.preventDefault(), void api.toursFolder().then((d) => api.openFolder(d)))}>
            Open the tours folder
          </a>
        </li>
      </ul>
    </div>
  )
}
