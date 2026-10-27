import { memo, useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { CrowExtra, CrowHat, CrowLook } from '@shared/types'
import { themeTokens } from '@shared/themes'
import { PLAIN_LOOK } from '@shared/agentAvatar'
import { lookProps } from '../crowLook'
import { Crow as CrowEngine, type Mood } from '../crow'
import { needsYou, useAgents, type AgentStatus } from '../agents'
import { workerLook } from './AgentAvatar'
import { setAgentBirds, setCrow, setState, useStore } from '../store'
import { playOnce, windowActive } from '../motion'
import { useTours } from '../tourPlayer'

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)')
const watchMotion = (cb: () => void): (() => void) => {
  reduceMotion.addEventListener('change', cb)
  return () => reduceMotion.removeEventListener('change', cb)
}

/** The crow mascot, while it's switched on. With reduced motion it sits still and never flies. */
export function Crow(): ReactNode {
  // during a guided tour (#214) the mascot steps aside: the tour's guide bird takes off from its spot
  const touring = useTours((s) => !!s.run)
  const on = useStore((s) => s.config?.crow ?? false) && !touring
  const still = useSyncExternalStore(watchMotion, () => reduceMotion.matches)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!on || !ref.current) return
    const crow = new CrowEngine(ref.current, { still, onHide: () => setCrow(false) })
    return () => crow.destroy()
  }, [on, still])

  if (!on) return null
  return (
    <div className="crow" ref={ref} title="Click to shoo, right-click to hide" hidden>
      <CrowArt />
    </div>
  )
}

// ---------- agents' birds ----------
// Each live agent's own bird, on the same engine as the mascot, in its avatar's look (the user's own
// look stays the mascot's). Agent birds are drawn at 80% of the mascot's size, so Corvid's bird is the
// big one at a glance. With reduced motion a bird sits still near its agent's card, fading in and out.

/** At most this many birds; the card order (needs you, then working) decides which. */
const MAX_BIRDS = 8
const BIRD_SCALE = 0.8

interface Bird {
  key: string
  termId: string
  name: string
  look: CrowLook
  status: AgentStatus
  leaving: boolean
}

const sameLook = (a: CrowLook, b: CrowLook): boolean =>
  a === b || (Object.keys(a).length === Object.keys(b).length && (Object.keys(a) as (keyof CrowLook)[]).every((k) => a[k] === b[k]))

const moodOf = (st: AgentStatus): Mood => (needsYou(st) ? 'needs' : st === 'busy' || st === 'starting' ? 'working' : 'idle')

const cardOf = (termId: string): HTMLElement | null => document.querySelector(`.agcard[data-term="${CSS.escape(termId)}"]`)

/** Its card when that's showing; for an agent that needs you and whose card isn't, the Agents tab. */
function homeOf(termId: string, st: AgentStatus): Element | null {
  const card = cardOf(termId)
  if (card && card.getBoundingClientRect().height > 0) return card
  return needsYou(st) ? document.querySelector('.rail-btn[data-view="terminals"]') : null
}

/** Double-clicking a bird: the Agents view with the cards showing, its agent's card scrolled to and marked for a moment. */
function goToCard(termId: string): void {
  setState({ view: 'terminals', agentsPane: 'cards' })
  requestAnimationFrame(() => {
    const card = cardOf(termId)
    if (!card) return
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    card.focus({ preventScroll: true })
    card.classList.add('bird-picked')
    setTimeout(() => card.classList.remove('bird-picked'), 1400)
  })
}

const engines = new Map<string, CrowEngine>()

/** One bird per live agent, flying off (then removed) when its agent stops or the cap leaves it out. */
export function AgentBirds(): ReactNode {
  const on = useStore((s) => !!s.config?.crow && s.config.agentBirds !== false)
  const avatars = useStore((s) => s.config?.agentAvatars ?? true)
  const workers = useStore((s) => s.assistant.workers)
  const still = useSyncExternalStore(watchMotion, () => reduceMotion.matches)
  const agents = useAgents()
  const [birds, setBirds] = useState<Bird[]>([])

  const wanted = useMemo(
    () =>
      agents
        .filter((g) => g.origin !== 'shell' && g.status !== 'exited')
        .slice(0, MAX_BIRDS)
        .map((g) => {
          const name = g.worker?.agentName ?? g.t.agentName ?? g.live?.name ?? g.t.title
          const w = g.worker ?? workers.find((x) => x.agentName === name)
          return { termId: g.t.termId, name, look: avatars ? workerLook(w, name) : PLAIN_LOOK, status: g.status }
        }),
    [agents, workers, avatars]
  )

  useEffect(() => {
    setBirds((prev) => {
      const want = new Map(wanted.map((b) => [b.termId, b]))
      // a bird only gets a new object (and its AgentBird a render) when something it shows changed
      const next = prev.map((b) => {
        const w = !b.leaving && want.get(b.termId)
        if (!w) return b.leaving ? b : { ...b, leaving: true }
        return w.name === b.name && w.status === b.status && sameLook(w.look, b.look) ? b : { ...b, ...w }
      })
      for (const w of wanted)
        if (!next.some((b) => b.termId === w.termId && !b.leaving)) next.push({ ...w, key: `${w.termId}:${performance.now()}`, leaving: false })
      return next.length === prev.length && next.every((b, i) => b === prev[i]) ? prev : next
    })
  }, [wanted])
  const onGone = useCallback((key: string) => setBirds((prev) => prev.filter((x) => x.key !== key)), [])

  // a flutter on the spot when an agent posts while the board is showing
  const last = useStore((s) => s.board.messages.at(-1))
  const lastId = useRef(last?.id)
  useEffect(() => {
    if (!last || last.id === lastId.current) return
    lastId.current = last.id
    const board = document.querySelector('.mboard')
    if (!board || !board.getBoundingClientRect().height || board.classList.contains('strip')) return
    const bird = birds.find((b) => !b.leaving && b.name === last.agentName)
    if (bird) engines.get(bird.key)?.flutter()
  }, [last, birds])

  if (!on) return null
  return (
    <>
      {birds.map((b) => (
        <AgentBird key={b.key} bird={b} still={still} onGone={onGone} />
      ))}
    </>
  )
}

const AgentBird = memo(function AgentBird({ bird, still, onGone }: { bird: Bird; still: boolean; onGone: (key: string) => void }): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const status = useRef(bird.status)
  status.current = bird.status
  const gone = useRef(onGone)
  gone.current = onGone
  const theme = useStore((s) => s.theme)
  const bg = themeTokens(theme).bg ?? null
  const { key, termId, leaving } = bird

  useEffect(() => {
    const crow = new CrowEngine(ref.current!, {
      still,
      scale: BIRD_SCALE,
      mood: () => moodOf(status.current),
      home: () => homeOf(termId, status.current),
      // a click shoos it (crow.ts, cosmetic only); a double-click goes to its agent's card
      onOpen: () => goToCard(termId),
      padded: true,
      onHide: () => setAgentBirds(false)
    })
    engines.set(key, crow)
    return () => {
      engines.delete(key)
      crow.destroy()
    }
  }, [still, key, termId])

  useEffect(() => {
    if (!leaving) return
    let live = true
    const crow = engines.get(key)
    void (crow ? crow.leave() : Promise.resolve()).then(() => live && gone.current(key))
    return () => {
      live = false
    }
  }, [leaving, key])

  const word = needsYou(bird.status) ? 'needs you' : bird.status === 'busy' ? 'working' : bird.status
  return (
    <div
      className="crow agent-bird"
      ref={ref}
      title={`${bird.name} · ${word}. Click to shoo, double-click to open its card, right-click to hide the agent birds.`}
      style={lookProps(bird.look, /^#[0-9a-f]{6}$/i.test(bg ?? '') ? bg : null)}
      hidden
    >
      <CrowArt look={bird.look} padded />
    </div>
  )
})

const PREVIEW_FIDGETS: [string, number][] = [
  ['f-tilt', 1300],
  ['f-blink', 180],
  ['f-preen', 1500],
  ['f-blink', 180],
  ['f-ruffle', 450],
  ['f-tail', 400]
]

/**
 * The mascot drawn large for the look editor, perched and fidgeting the way it does on the app,
 * or held in `pose`. Uses the same crow.css rules, so whatever the mascot shows, this shows.
 */
export function CrowPreview({ pose = 'idle', size = 132 }: { pose?: 'idle' | 'fly' | 'land'; size?: number }): ReactNode {
  const still = useSyncExternalStore(watchMotion, () => reduceMotion.matches)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = ref.current
    if (still || pose !== 'idle' || !el) return
    let undo = 0
    const tick = window.setInterval(() => {
      if (document.visibilityState === 'hidden') return
      const [name, ms] = PREVIEW_FIDGETS[Math.floor(Math.random() * PREVIEW_FIDGETS.length)]
      el.classList.add(name)
      undo = window.setTimeout(() => el.classList.remove(name), ms)
    }, 2400)
    return () => {
      clearInterval(tick)
      clearTimeout(undo)
      for (const [name] of PREVIEW_FIDGETS) el.classList.remove(name)
    }
  }, [still, pose])

  return (
    <div className="crow crow-preview" ref={ref} data-pose={pose} style={{ width: size, height: (size * 36) / 44 }}>
      <CrowArt />
    </div>
  )
}

// shapes the mascot and the assistant's avatar share, so they're the same bird
const BODY =
  'M30 17.5 C30.5 23.5 26 28.2 19.5 28.2 C15 28.2 11.5 26.6 10 23.8 C9.4 19.6 13.5 15.6 19.5 15 C24 14.6 29.5 13.8 30 17.5 Z'
const WING_FOLD = 'M27.5 17 C22 16.2 15.5 18 8.5 23.2 C13 24.6 20.5 24.6 25.8 21.4 C27.4 20.4 28.2 18.4 27.5 17 Z'
const BACK_SHEEN = 'M14.5 17.4 C18.5 15.7 23 15.3 26.5 15.6'
const HEAD = { cx: 30.2, cy: 12.4, r: 5.3 }
const BEAK = 'M34.2 10.6 Q39.4 11.2 41.6 13.2 Q38.4 14.2 34.8 15 Z'
const HEAD_SHEEN = 'M27 8.6 C28.6 7.6 30.6 7.4 32 7.9'
const EYE = { cx: 31.8, cy: 11.3 }

// ---------- hats and accessories ----------
// Drawn round a base at (0, 0) with the crown going up, then seated on the head by HAT_AT. They sit
// inside the head's group, so they tilt, peck and droop with it. Fills are fixed; c-trim parts take
// the crow's accent colour.

const HAT_AT: Record<Exclude<CrowHat, 'none'>, string> = {
  top: 'translate(29.9 8.4) rotate(-9)',
  wizard: 'translate(29.8 8.4) rotate(-12)',
  party: 'translate(30.6 8) rotate(14)',
  cap: 'translate(30.4 8.6) rotate(-4)',
  crown: 'translate(29.8 8.3) rotate(-8)',
  beanie: 'translate(29.9 8.9) rotate(-8)',
  tricorn: 'translate(29.8 8.4) rotate(-6)'
}

function HatShape({ hat }: { hat: Exclude<CrowHat, 'none'> }): ReactNode {
  switch (hat) {
    case 'top':
      return (
        <>
          {/* a faint pale edge, so the black hat still reads on a dark page at avatar size */}
          <g stroke="rgba(255, 255, 255, 0.16)" strokeWidth="0.3" strokeLinejoin="round">
            <path fill="#23262e" d="M-2.6 -0.3 L-2.9 -6 Q0 -6.5 2.9 -6 L2.6 -0.3 Z" />
            <path className="c-trim" stroke="none" d="M-2.65 -1.8 L2.65 -1.8 L2.6 -0.4 L-2.6 -0.4 Z" />
            <path fill="#23262e" d="M-4.6 -0.2 Q0 1.3 4.6 -0.2 Q4.9 0.5 4.2 0.8 Q0 1.9 -4.2 0.8 Q-4.9 0.5 -4.6 -0.2 Z" />
          </g>
          <path fill="none" stroke="rgba(255, 255, 255, 0.2)" strokeWidth="0.4" strokeLinecap="round" d="M-2.5 -5.6 Q0 -6 2.5 -5.6" />
        </>
      )
    case 'wizard':
      return (
        <>
          <path fill="#4b47a8" d="M-3 -0.1 Q-2.2 -3.5 -1 -6 Q-0.3 -7.4 -2.2 -8.2 Q0.6 -8.4 1.2 -6.4 Q2.2 -3.4 3 -0.1 Z" />
          <path fill="#f2c94c" d="M0.6 -4.7 L0.9 -3.9 L1.7 -3.6 L0.9 -3.3 L0.6 -2.5 L0.3 -3.3 L-0.5 -3.6 L0.3 -3.9 Z" />
          <path className="c-trim" d="M-2.9 -0.4 Q0 0.4 2.9 -0.4 L2.7 -1.4 Q0 -0.6 -2.7 -1.4 Z" />
          <path fill="#4b47a8" d="M-5 0.2 Q0 1.8 5 0.2 Q0 -1 -5 0.2 Z" />
        </>
      )
    case 'party':
      return (
        <>
          <path fill="#e05a8c" d="M-2.7 0 L0 -7 L2.7 0 Q0 0.8 -2.7 0 Z" />
          <path className="c-trim" d="M-1.95 -1.9 L1.95 -1.9 L1.58 -2.9 L-1.58 -2.9 Z M-1.08 -4.2 L1.08 -4.2 L0.73 -5.1 L-0.73 -5.1 Z" />
          <circle fill="#f4f1ea" stroke="rgba(0, 0, 0, 0.18)" strokeWidth="0.25" cx="0" cy="-7.2" r="0.95" />
        </>
      )
    case 'cap':
      return (
        <>
          <path fill="#a8332f" d="M3.8 -0.4 Q7.2 -0.7 8.8 0.8 Q6.2 1.5 3.4 0.9 Z" />
          <path fill="#d64541" d="M-4.5 0.3 C-4.6 -4.2 4.2 -4.4 4.5 0.3 Z" />
          <path fill="none" stroke="#a8332f" strokeWidth="0.35" d="M0 -3.3 Q-0.7 -1.6 -0.5 0.3" />
          <circle className="c-trim" cx="0" cy="-3.4" r="0.6" />
        </>
      )
    case 'crown':
      return (
        <>
          <path fill="#e8b931" d="M-3.4 0.2 L-3.9 -4 L-1.9 -2.1 L0 -4.9 L1.9 -2.1 L3.9 -4 L3.4 0.2 Q0 0.9 -3.4 0.2 Z" />
          <path fill="#c99a1e" d="M-3.45 -0.1 Q0 0.6 3.45 -0.1 L3.55 -1.1 Q0 -0.4 -3.55 -1.1 Z" />
          <circle fill="#e8b931" cx="-3.9" cy="-4" r="0.45" />
          <circle fill="#e8b931" cx="0" cy="-4.9" r="0.5" />
          <circle fill="#e8b931" cx="3.9" cy="-4" r="0.45" />
          <circle className="c-trim" cx="0" cy="-0.6" r="0.55" />
        </>
      )
    case 'beanie':
      return (
        <>
          <path fill="#3d8fd1" d="M-4.9 0 C-5 -5.6 5 -5.6 4.9 0 Z" />
          <path fill="#2f75ad" d="M-5.1 0.9 Q0 2 5.1 0.9 L4.9 -0.8 Q0 0.2 -4.9 -0.8 Z" />
          <circle fill="#e7ecf2" stroke="rgba(0, 0, 0, 0.18)" strokeWidth="0.25" cx="0" cy="-4.6" r="1.3" />
        </>
      )
    case 'tricorn':
      return (
        <path
          fill="#3b2a20"
          stroke="#d4a73a"
          strokeWidth="0.5"
          strokeLinejoin="round"
          d="M-5.6 -0.4 Q-3 1.3 0 0.8 Q3 1.3 5.6 -0.4 Q4.4 -1.2 4 -2.8 Q0 -5 -4 -2.8 Q-4.4 -1.2 -5.6 -0.4 Z"
        />
      )
  }
}

export function Hat({ hat }: { hat: CrowHat }): ReactNode {
  if (hat === 'none') return null
  return (
    <g className="c-hat" transform={HAT_AT[hat]}>
      <HatShape hat={hat} />
    </g>
  )
}

/** Glasses ring the eye, so they go in the head's group. */
function Glasses(): ReactNode {
  return (
    <g className="c-glasses">
      <path d="M30 11 L25.8 10.3" />
      <circle cx={EYE.cx} cy={EYE.cy} r="1.85" />
    </g>
  )
}

/** A bow tie sits on the neck, so it goes with the body and stays put while the head moves. */
function BowTie(): ReactNode {
  return (
    <g className="c-bowtie" transform="translate(29.4 18.6) scale(0.9)">
      <path d="M0 0 L-2.1 -1.3 L-2.1 1.3 Z M0 0 L2.1 -1.3 L2.1 1.3 Z" />
      <circle r="0.6" />
    </g>
  )
}

function useLook(): { hat: CrowHat; extra: CrowExtra } {
  const hat = useStore((s) => s.config?.crowLook?.hat ?? 'none')
  const extra = useStore((s) => s.config?.crowLook?.extra ?? 'none')
  return { hat, extra }
}

/** The crow, drawn facing right in a 44x36 box with its feet at (22, 35), in the user's look or `look`. crow.css animates the groups. */
export function CrowArt({ look, padded = false }: { look?: CrowLook; padded?: boolean }): ReactNode {
  const mine = useLook()
  const { hat, extra } = look ?? mine
  return (
    <svg className="crow-svg" viewBox="0 0 44 36" width="44" height="36" aria-hidden>
      <g className="flip">
        <g className="bird">
          <g className="legs">
            <path className="c-leg leg-a" d="M20 27 L19.2 34.6 M17.4 35 L19.2 34.6 L22 34.8" />
            <path className="c-leg leg-b" d="M23.6 27 L23.6 34.6 M21.8 35 L23.6 34.6 L26.4 34.8" />
          </g>
          <g className="hit">
            {/* an agent's smaller bird: an unpainted box round it takes the click too, about 30 x 28 px
                on screen, so a thin tail or leg isn't all there is to hit (crow.ts keeps it clear) */}
            {padded && <rect className="hit-pad" x="3" y="0" width="38" height="35" />}
            <path className="c-body c-tail" d="M12.5 21.2 L2 26 L2.4 28.6 L5.2 28.3 L14 25.6 Z" />
            <path className="c-body" d={BODY} />
            <path className="c-wing wing-fold" d={WING_FOLD} />
            <path
              className="c-wing wing-up"
              d="M26 17.5 C23 11 18 5 9 2.5 L10.5 5.2 L7 5.6 L10.6 8 L7.6 9.2 L12 10.6 L9.6 12.4 L14.4 13.4 C17.5 15.5 20.5 18 22 19.5 Z"
            />
            <path className="c-sheen" d={BACK_SHEEN} />
            {extra === 'bowtie' && <BowTie />}
            <g className="head">
              <circle className="c-body" {...HEAD} />
              <path className="c-beak" d={BEAK} />
              <path className="c-sheen" d={HEAD_SHEEN} />
              <circle className="c-eye" {...EYE} r="1.05" />
              {extra === 'glasses' && <Glasses />}
              <Hat hat={hat} />
            </g>
          </g>
        </g>
      </g>
    </svg>
  )
}

// ---------- avatar ----------

/** What the assistant's avatar shows: the assistant's own state, plus the two the Corvid strip knows about. */
export type CrowMood = 'idle' | 'starting' | 'thinking' | 'tool' | 'waiting' | 'listening' | 'error'

const watchVisible = (cb: () => void): (() => void) => {
  document.addEventListener('visibilitychange', cb)
  return () => document.removeEventListener('visibilitychange', cb)
}

// the avatar disc, in the mascot's own coordinates so the head shapes are reused as they are
const DISC = { cx: 33.6, cy: 14.4, r: 10.6 }
const PIP_ANGLES = [45, 18, 72, -9, 99, -36]

/**
 * The crow's head and shoulders in a disc, for the assistant panel. `mood` picks the pose and
 * crow.css animates it; `beak` (0..1) opens the beak, for the mic level while dictating. `pips`
 * are dot colours around the rim, one per running worker. It stops animating while the window is
 * hidden, and with reduced motion it holds still and only the pose and rim colour change.
 */
export function CrowHead({
  mood,
  beak = 0,
  pips = [],
  size = 34,
  label
}: {
  mood: CrowMood
  beak?: number
  pips?: string[]
  size?: number
  label: string
}): ReactNode {
  const clip = useId()
  const { hat, extra } = useLook()
  const hidden = useSyncExternalStore(watchVisible, () => document.visibilityState === 'hidden')
  const ref = useRef<HTMLDivElement>(null)
  const { cx, cy, r } = DISC

  // waiting quietly: a blink about every 5.5 s and a tilt about every 13 s, as one-off runs, so the
  // window isn't redrawn on every frame in between (motion.ts)
  useEffect(() => {
    if (mood !== 'idle') return
    const every = (ms: number, cls: string): number =>
      window.setInterval(() => windowActive() && ref.current && playOnce(ref.current, cls), ms)
    const timers = [every(5500, 'blink'), every(13000, 'tilt')]
    return () => timers.forEach(clearInterval)
  }, [mood])

  return (
    <div
      ref={ref}
      className={`crow-av av-${mood}${hidden ? ' paused' : ''}`}
      role="img"
      aria-label={label}
      style={{ width: size, height: size, ['--beak' as string]: `${Math.round(Math.min(1, beak) * 26)}deg` }}
    >
      <svg viewBox={`${cx - 11.2} ${cy - 11.2} 22.4 22.4`} width={size} height={size} aria-hidden>
        <defs>
          <clipPath id={clip}>
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
        </defs>
        <circle className="av-disc" cx={cx} cy={cy} r={r} />
        <g clipPath={`url(#${clip})`}>
          <g className="av-bust">
            <path className="c-body" d={BODY} />
            <path className="c-wing" d={WING_FOLD} />
            <path className="c-sheen" d={BACK_SHEEN} />
            {extra === 'bowtie' && <BowTie />}
            <g className="av-head">
              {hat === 'none' && <path className="av-tuft" d="M27.6 7.9 L26.6 5.9 M29.9 7.1 L29.9 4.8 M32.2 7.4 L33.3 5.5" />}
              <circle className="c-body" {...HEAD} />
              {/* the beak in two halves, so the lower one can open */}
              <path className="c-beak" d="M34.2 10.6 Q39.4 11.2 41.6 13.2 L34.5 13.2 Z" />
              <path className="c-beak av-jaw" d="M34.5 13.2 L41.6 13.2 Q38.4 14.2 34.8 15 Z" />
              <path className="c-sheen" d={HEAD_SHEEN} />
              <circle className="c-eye av-eye" {...EYE} r="1.2" />
              {extra === 'glasses' && <Glasses />}
            </g>
          </g>
        </g>
        <circle className="av-rim" cx={cx} cy={cy} r={r} />
        {/* the hat outside the clip and over the rim, so a tall one can poke out of the disc; the
            same classes give it the head's pose and animation, in step with the head inside */}
        <g className="av-bust">
          <g className="av-head">
            <Hat hat={hat} />
          </g>
        </g>
        {pips.map((fill, i) => {
          const a = (PIP_ANGLES[i % PIP_ANGLES.length] * Math.PI) / 180
          return <circle key={i} className="av-pip" cx={cx + r * Math.cos(a)} cy={cy + r * Math.sin(a)} r="1.9" fill={fill} />
        })}
      </svg>
    </div>
  )
}

// ---------- still badge ----------

/**
 * A crow's head in a small disc, in a look of its own rather than the user's: agents' random crows on
 * the board and the cards. The same shapes, hats and accessories as the avatar above, but a still SVG
 * with no per-instance timers or subscriptions, so a list of dozens costs little. `moving` adds one
 * slow head bob (a working agent's card); reduced motion keeps it still. Colours left unset in `look`
 * fall back to the theme's crow. Feathers close to the page background get the editor's firmer rim.
 */
export const CrowBadge = memo(function CrowBadge({
  look,
  size = 20,
  label,
  moving = false
}: {
  look: CrowLook
  /** px, or a CSS length such as one of the --av-* sizes in crow.css */
  size?: number | string
  label: string
  moving?: boolean
}): ReactNode {
  const clip = useId()
  const theme = useStore((s) => s.theme)
  const bg = themeTokens(theme).bg ?? null
  const { cx, cy, r } = DISC
  return (
    <span
      className={`crow-badge${moving ? ' moving' : ''}`}
      role="img"
      aria-label={label}
      title={label}
      style={{ width: size, height: size, ...lookProps(look, /^#[0-9a-f]{6}$/i.test(bg ?? '') ? bg : null) }}
    >
      <svg viewBox={`${cx - 11.2} ${cy - 11.2} 22.4 22.4`} width="100%" height="100%" aria-hidden>
        <defs>
          <clipPath id={clip}>
            <circle cx={cx} cy={cy} r={r} />
          </clipPath>
        </defs>
        <circle className="cb-disc" cx={cx} cy={cy} r={r} />
        <g clipPath={`url(#${clip})`}>
          {/* no back sheen: only a stub of it falls inside the disc, which reads as a glitch at chat size */}
          <g className="cb-bust">
            <path className="c-body" d={BODY} />
            <path className="c-wing" d={WING_FOLD} />
            {look.extra === 'bowtie' && <BowTie />}
            <g className="cb-head">
              <circle className="c-body" {...HEAD} />
              <path className="c-beak" d={BEAK} />
              <path className="c-sheen" d={HEAD_SHEEN} />
              <circle className="c-eye" {...EYE} r="1.25" />
              <circle className="cb-glint" cx={EYE.cx + 0.42} cy={EYE.cy - 0.45} r="0.4" />
              {look.extra === 'glasses' && <Glasses />}
            </g>
          </g>
        </g>
        <circle className="cb-rim" cx={cx} cy={cy} r={r} />
        <g className="cb-bust">
          <g className="cb-head">
            <Hat hat={look.hat} />
          </g>
        </g>
      </svg>
    </span>
  )
})
