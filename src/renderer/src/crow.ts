// The crows' movement: perch, fidget, walk, hop, fly. One engine for Corvid's mascot and the agents'
// birds. Plain DOM rather than React: each bird writes one transform and a few classes on its root
// element. Every bird runs on one shared clock: frames only run while some bird is moving; perched,
// they wake on timers a few times a second to check their perches are still there. The clock stops
// whenever the window is hidden or unfocused, so the flock costs nothing in the tray.
//
// Perches are the top edges of real elements (cards, tab strips, panel heads, buttons, the rail).
// A spot is good when the element is the topmost thing just under the feet (not scrolled away,
// covered, or gone) and the box the bird would fill holds nothing clickable, no terminal, no
// assistant input or mic, and isn't near the field being typed in. Birds keep their distance: the
// perch a bird sits on, or the one it's flying to, is reserved, and no other bird lands within GAP.
//
// An agent's bird has a mood (from the same status its agent card shows) and a home (its card), and
// prefers perches near home. When its agent stops, it flies out of the window and is removed.

type Pose = 'idle' | 'walk' | 'hop' | 'crouch' | 'fly' | 'glide' | 'land'

/** The mascot's own ways, or an agent's: working is busier and pecks, idle wanders and preens, needs stays near home and flutters. */
export type Mood = 'mascot' | 'working' | 'idle' | 'needs'

export interface CrowOptions {
  still: boolean
  /** smaller birds for agents; Corvid's mascot is 1 */
  scale?: number
  mood?: () => Mood
  /** the element the bird likes to stay near: its agent's card, or the Agents tab */
  home?: () => Element | null
  /** a double-click (an agent's bird: go to its card); a single click always shoos */
  onOpen?: () => void
  /** a transparent pad drawn round the bird (Crow.tsx), so a small bird is still easy to click */
  padded?: boolean
  /** a tour's guide (#214): no life of its own; it goes only where guideTo sends it */
  guide?: boolean
  onHide: () => void
}

interface Pt {
  x: number
  y: number
}

/** A place on an element's top edge: frac runs along the straight part, end to end. */
interface Spot {
  el: Element
  frac: number
}

/** kinds of perch; cards are listed twice so they come up more often */
const CARDS = '.card, .pcard, .tcard, .srv-card, .tile, .agcard'
const PERCHES = [CARDS, CARDS, '.pane-tabs', '.fx-head, .srv-head, .kcol-head, .cv-strip', '.rail', '.btn:not(.ghost):not(.icon)', '.seg, .chip']
/** never perch over these, whatever is on top (the brand isn't clickable, but it's the app's name) */
const NO_GO =
  '.mb-compose-wrap, .mb-mentions, .mic-wrap, .term-host, .term-stage, .xterm, .ag-term, .overlay, .menu, .toast, .brand, .ticker, .tk-panel, [role="listbox"], [role="menu"], [role="dialog"]'
const CLICKABLE = 'button, a, input, textarea, select, label, summary, [role="button"], [contenteditable], [draggable="true"]'
/** An agent card is clickable as a whole, so stacked cards would leave no tops to perch on. A bird may
 *  cover the plain bottom edge of the card above (never its buttons or text); a double-click on an agent's
 *  bird goes to its card anyway. */
const SOFT = '.agcard'
/** the bird's body above its feet at full size, for clearance checks */
const HALF_W = 17
const HEIGHT = 30
/** no two birds land closer than this, at full size */
const GAP = 46
const SAMPLES: [number, number][] = [
  [-16, -24],
  [0, -29],
  [16, -24],
  [-16, -10],
  [0, -14],
  [16, -10]
]
/** the corners of a padded bird's click pad (Crow.tsx), so it never covers anything clickable either */
const PAD_SAMPLES: [number, number][] = [
  [-19, -34],
  [19, -34],
  [-19, -3],
  [19, -3]
]
/** a click shoos at most this often, so clicking away at a bird doesn't keep yanking it about */
const SHOO_COOLDOWN = 800
/** after a shoo, presses this close to where it was clicked, this soon, still count as on the bird */
const GRACE = { ms: 500, px: 24 }
/** crow.css classes for the little things it does while perched, and how long each takes */
const FIDGETS: Record<Mood, [string, number][]> = {
  mascot: [
    ['f-tilt', 1300],
    ['f-tilt', 1300],
    ['f-preen', 1500],
    ['f-blink', 180],
    ['f-blink', 180],
    ['f-ruffle', 450],
    ['f-tail', 400]
  ],
  working: [
    ['f-peck', 900],
    ['f-peck', 900],
    ['f-peck', 900],
    ['f-tilt', 1300],
    ['f-blink', 180]
  ],
  idle: [
    ['f-preen', 1500],
    ['f-preen', 1500],
    ['f-tilt', 1300],
    ['f-ruffle', 450],
    ['f-blink', 180],
    ['f-tail', 400]
  ],
  needs: [
    ['f-flutter', 900],
    ['f-tilt', 1300],
    ['f-blink', 180]
  ]
}
/** how long a bird sits before doing something bigger, by mood */
const REST: Record<Mood, [number, number]> = { mascot: [7000, 18000], working: [3500, 8000], idle: [9000, 22000], needs: [6000, 12000] }
/** how often it fidgets while sitting */
const FIDGET_EVERY: Record<Mood, [number, number]> = { mascot: [2500, 6500], working: [1600, 3800], idle: [3000, 7500], needs: [3500, 6500] }
/** a walking bird moves 34 px a second, so it's drawn at most this often (ms): about 30 fps */
const WALK_FRAME = 32
/** keep off the rounded corners */
const EDGE = 16
const MIN_WIDTH = 44
/** native minimise/maximise/close buttons over the right end of the title bar */
const CONTROLS = { w: 150, h: 40 }

const rand = (a: number, b: number): number => a + Math.random() * (b - a)
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v))
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function typing(el: Element | null): el is HTMLElement {
  if (!el) return false
  if (el instanceof HTMLTextAreaElement) return true
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].includes(el.type)
  return el instanceof HTMLElement && el.isContentEditable
}

function overlaps(a: DOMRect | { left: number; right: number; top: number; bottom: number }, b: DOMRect, pad: number): boolean {
  return a.left < b.right + pad && a.right > b.left - pad && a.top < b.bottom + pad && a.bottom > b.top - pad
}

/** Is there text right under this point? Plain card padding is fine to cover, words aren't. */
function onText(el: Element, x: number, y: number): boolean {
  for (const n of el.childNodes) {
    if (n.nodeType !== Node.TEXT_NODE || !n.textContent?.trim()) continue
    const range = document.createRange()
    range.selectNodeContents(n)
    for (const r of range.getClientRects()) if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true
  }
  return false
}

// ---------- the shared clock ----------

/**
 * One clock for the whole flock: one requestAnimationFrame while any bird is moving, else one timer
 * for the earliest wait. Advances only while the window is visible and focused. Also owns the window
 * listeners every bird needs, so eight birds don't add eight sets.
 */
class Clock {
  time = 0
  paused = true
  private last = 0
  private frame = 0
  private timer = 0
  private waits: { at: number; done: () => void; owner: Crow }[] = []
  private anims = new Set<(t: number) => void>()
  private onPause: (() => void)[] = []
  readonly birds = new Set<Crow>()
  private pressing = false
  private dragging = false

  join(bird: Crow): void {
    if (!this.birds.size) this.listen(true)
    this.birds.add(bird)
    bird.root.classList.toggle('paused', this.paused)
    this.sync()
  }

  leave(bird: Crow): void {
    this.birds.delete(bird)
    this.waits = this.waits.filter((w) => w.owner !== bird)
    if (this.birds.size) return
    this.listen(false)
    this.anims.clear()
    this.waits = []
    cancelAnimationFrame(this.frame)
    clearTimeout(this.timer)
    this.frame = this.timer = 0
  }

  private listen(on: boolean): void {
    const op = on ? 'addEventListener' : 'removeEventListener'
    document[op]('visibilitychange', this.sync)
    window[op]('focus', this.sync)
    window[op]('blur', this.sync)
    window[op]('resize', this.wakeAll)
    window[op]('scroll', this.wakeAll, { capture: true, passive: true } as AddEventListenerOptions)
    window[op]('focusin', this.wakeAll)
    window[op]('pointerdown', this.onPointerDown, true)
    window[op]('pointerup', this.onPointerUp, true)
    window[op]('pointercancel', this.onPointerUp, true)
    window[op]('pointermove', this.onPointerMove as EventListener, { capture: true, passive: true } as AddEventListenerOptions)
    for (const t of ['dragstart', 'dragenter', 'dragend', 'drop']) window[op](t, this.onDrag as EventListener, true)
  }

  sleep(owner: Crow, ms: number): Promise<void> {
    return new Promise((done) => {
      this.waits.push({ at: this.time + ms, done, owner })
      this.kick()
    })
  }

  /** Calls step(k) each frame as k runs 0 to 1 over ms. A step returning false ends it early. */
  animate(ms: number, step: (k: number) => boolean | void): Promise<void> {
    return new Promise((done) => {
      const start = this.time
      const f = (t: number): void => {
        const k = Math.min(1, (t - start) / ms)
        if (step(k) === false || k >= 1) {
          this.anims.delete(f)
          done()
        }
      }
      this.anims.add(f)
      this.kick()
    })
  }

  /** Resolves the next time the clock stops (window hidden, minimised, in the tray or unfocused). */
  whenPaused(): Promise<void> {
    return this.paused ? Promise.resolve() : new Promise((done) => this.onPause.push(done))
  }

  private kick(): void {
    if (this.paused) return
    if (this.anims.size) {
      clearTimeout(this.timer)
      this.timer = 0
      if (!this.frame) this.frame = requestAnimationFrame(this.tick)
    } else if (!this.frame && !this.timer && this.waits.length) {
      let next = Infinity
      for (const w of this.waits) next = Math.min(next, w.at)
      this.timer = window.setTimeout(this.tick, Math.max(0, next - this.time))
    }
  }

  private tick = (): void => {
    this.frame = 0
    this.timer = 0
    if (this.paused) return
    const now = performance.now()
    this.time += now - this.last
    this.last = now
    for (const f of [...this.anims]) f(this.time)
    const due = this.waits.filter((w) => w.at <= this.time)
    if (due.length) this.waits = this.waits.filter((w) => w.at > this.time)
    for (const w of due) w.done()
    this.kick()
  }

  /** End one bird's waits now (or everyone's), so a perched bird re-checks its perch straight away. */
  wake(owner?: Crow): void {
    if (this.paused) return
    let any = false
    for (const w of this.waits)
      if (!owner || w.owner === owner) {
        w.at = this.time
        any = true
      }
    if (!any) return
    clearTimeout(this.timer)
    this.timer = 0
    this.kick()
  }
  private wakeAll = (): void => this.wake()

  /** Run only while the window is visible and focused. */
  private sync = (): void => {
    const run = document.visibilityState === 'visible' && document.hasFocus()
    if (run !== this.paused) return
    this.paused = !run
    for (const b of this.birds) b.root.classList.toggle('paused', this.paused)
    if (this.paused) {
      cancelAnimationFrame(this.frame)
      clearTimeout(this.timer)
      this.frame = this.timer = 0
      for (const done of this.onPause.splice(0)) done()
    } else {
      this.last = performance.now()
      this.wake()
      this.kick()
    }
  }

  // While the user is pressing or dragging anywhere else, the birds let everything through.
  // Tracked apart because a drag starting fires pointercancel while it's still going. Files
  // dragged in from outside only bring dragenter, and no dragend if they leave again.
  private onPointerDown = (e: Event): void => {
    this.pressing = ![...this.birds].some((b) => b.root.contains(e.target as Node))
    this.dragging = false
    this.passive()
  }
  private onPointerUp = (): void => {
    this.pressing = false
    this.passive()
  }
  /** A move with no button down means no press or drag is going on, whatever was missed (a release
   *  outside the window, a file dragged in and back out), so a stale passive never eats the next click. */
  private onPointerMove = (e: PointerEvent): void => {
    if (e.buttons || !(this.pressing || this.dragging)) return
    this.pressing = this.dragging = false
    this.passive()
  }
  private onDrag = (e: DragEvent): void => {
    this.dragging = e.type === 'dragstart' || e.type === 'dragenter'
    this.passive()
  }
  private passive(): void {
    for (const b of this.birds) b.root.classList.toggle('passive', this.pressing || this.dragging)
  }
}

const clock = new Clock()

// ---------- a bird ----------

export class Crow {
  private pos: Pt = { x: -60, y: 120 }
  private spot: Spot | null = null
  /** where it's flying or hopping to, reserved until it lands */
  private target: Spot | null = null
  private flip: Element
  private dead = false
  /** asked to leave: the life loop winds down and the bird flies out */
  private gone = false
  private exiting = false
  private shooed = false
  /** when a click last shooed it, and where */
  private shooAt = -Infinity
  private shooPt: Pt = { x: 0, y: 0 }
  /** bumped by each guideTo, so a newer one takes over from a flight still going */
  private guideSeq = 0
  private life: Promise<void>
  private readonly s: number
  private readonly halfW: number
  private readonly height: number
  private readonly samples: [number, number][]

  constructor(
    readonly root: HTMLElement,
    private opts: CrowOptions
  ) {
    this.s = opts.scale ?? 1
    this.halfW = HALF_W * this.s
    this.height = HEIGHT * this.s
    this.samples = opts.padded ? [...SAMPLES, ...PAD_SAMPLES] : SAMPLES
    this.flip = root.querySelector('.flip')!
    root.hidden = true
    this.pose('idle')
    root.addEventListener('mousedown', this.onMouseDown)
    root.addEventListener('click', this.onClick)
    root.addEventListener('dblclick', this.onDblClick)
    root.addEventListener('contextmenu', this.onContextMenu)
    root.addEventListener('wheel', this.onWheel, { passive: false })
    clock.join(this)
    this.life = opts.guide ? Promise.resolve() : this.live()
  }

  destroy(): void {
    this.dead = true
    clock.leave(this)
    this.root.removeEventListener('mousedown', this.onMouseDown)
    this.root.removeEventListener('click', this.onClick)
    this.root.removeEventListener('dblclick', this.onDblClick)
    this.guard(false)
    this.root.removeEventListener('contextmenu', this.onContextMenu)
    this.root.removeEventListener('wheel', this.onWheel)
  }

  /**
   * Its agent stopped: take off and fly out of the window. Resolves once it's out, at once if it never
   * got in, and with a quick fade instead when it can't fly (reduced motion, or the window isn't in
   * use, so the clock is stopped). Destroy it after.
   */
  async leave(): Promise<void> {
    if (this.gone) return
    this.gone = true
    this.spot = this.target = null
    clock.wake(this)
    if (this.root.hidden || this.dead) return
    if (this.opts.still || clock.paused) return this.fade()
    await Promise.race([this.life, clock.whenPaused()])
    if (clock.paused) return this.fade()
    this.exiting = true
    const out = { x: this.pos.x < window.innerWidth / 2 ? -50 : window.innerWidth + 50, y: rand(30, 140) }
    await Promise.race([this.flight(null, out), clock.whenPaused()])
    this.root.hidden = true
  }

  /**
   * Guided tours (#214): fly to just above `el`'s top-left corner and perch there, or with no element to the middle
   * of the window, above the bubble. For a bird made with `guide`. With reduced motion, or the clock stopped, it just
   * appears there. The first call takes off from `from` (where the mascot sat) when given, else from off-screen.
   * Resolves when it has landed, or when a newer guideTo took over.
   */
  async guideTo(el: Element | null, from?: Pt): Promise<void> {
    if (this.over) return
    const seq = ++this.guideSeq
    const to = this.guidePoint(el)
    if (this.opts.still || clock.paused) {
      this.place(to)
      this.pose('idle')
      this.root.hidden = false
      return
    }
    if (this.root.hidden) {
      this.place(from ?? { x: to.x > window.innerWidth / 2 ? -40 : window.innerWidth + 40, y: rand(60, 200) })
      this.root.hidden = false
    }
    if (await this.flight(null, to, () => seq !== this.guideSeq)) {
      this.pose('land')
      await this.sleep(180)
      if (seq === this.guideSeq && !this.over) this.pose('idle')
    }
  }

  private guidePoint(el: Element | null): Pt {
    const w = window.innerWidth
    const h = window.innerHeight
    const r = el?.getBoundingClientRect()
    if (!r || !r.width) return { x: w / 2, y: clamp(h / 2 - 90, this.height + 4, h - 4) }
    return { x: clamp(r.left + 22, 24, w - 24), y: clamp(r.top + 1, this.height + 4, h - 4) }
  }

  /** A little flutter on the spot, for when its agent posts on the board. */
  flutter(): void {
    if (this.spot && !this.opts.still && !this.gone) this.fidget(['f-flutter', 900])
  }

  private fade(): Promise<void> {
    this.root.classList.add('fading')
    return new Promise((done) => setTimeout(done, 220))
  }

  private get over(): boolean {
    return this.dead || this.gone
  }

  private mood(): Mood {
    return this.opts.mood?.() ?? 'mascot'
  }

  // ---------- behaviour ----------

  private async live(): Promise<void> {
    await this.enter()
    while (!this.over) {
      const [a, b] = REST[this.mood()]
      await this.rest(this.opts.still ? Infinity : rand(a, b))
      if (this.over) return
      await this.next()
    }
  }

  /** Arrive from off-screen, or just appear (with a quick fade in) when motion is reduced. */
  private async enter(): Promise<void> {
    let spot = this.pick()
    while (!spot && !this.over) {
      await this.sleep(2000)
      spot = this.pick()
    }
    if (!spot || this.over) return
    if (this.opts.still) return this.settle(spot)
    const p = this.point(spot)
    const fromLeft = p.x > window.innerWidth / 2 ? Math.random() < 0.3 : Math.random() < 0.7
    this.place({ x: fromLeft ? -40 : window.innerWidth + 40, y: rand(60, Math.min(260, window.innerHeight / 2)) })
    this.root.hidden = false
    await this.flyTo(spot)
  }

  /** Sit for a while, fidgeting, riding along if the perch moves. Returns early if it has to leave. */
  private async rest(ms: number): Promise<void> {
    const end = clock.time + ms
    const every = (): number => rand(...FIDGET_EVERY[this.mood()])
    let fidgetAt = clock.time + rand(1500, 4000)
    while (!this.over && !this.shooed && clock.time < end) {
      await this.sleep(this.opts.still ? 1000 : 320)
      if (this.over || this.shooed) return
      const held = this.hold()
      if (held === 'lost') return
      if (held === 'moved') await this.ride()
      else if (!this.opts.still && clock.time >= fidgetAt) {
        this.fidget()
        fidgetAt = clock.time + every()
      }
    }
  }

  private async next(): Promise<void> {
    const shooed = this.shooed
    this.shooed = false
    if (document.querySelector('.overlay')) return
    const lost = this.hold() === 'lost'
    if (this.opts.still) {
      if (lost || shooed) await this.relocate()
      return
    }
    if (lost || shooed) return this.flyAway()
    const mood = this.mood()
    const home = this.homePoint()
    // a bird that has drifted from home goes back
    if (home && mood !== 'mascot' && dist(home, this.pos) > (mood === 'idle' ? 600 : 260)) return this.flyAway()
    const r = Math.random()
    if (mood === 'working') {
      if (r < 0.35 && (await this.hops())) return
      if (r < 0.65 && (await this.walk())) return
      if (r < 0.85) return
      return this.flyAway()
    }
    if (mood === 'needs') {
      if (r < 0.3 && (await this.hops())) return
      if (r < 0.9) return
      return this.flyAway()
    }
    if (r < 0.3 && (await this.walk())) return
    if (r < 0.55 && (await this.hops())) return
    if (r < 0.65) return // stay put a while longer
    await this.flyAway()
  }

  /** Is the perch still there, and not crowded? Snaps to it if it moved. */
  private hold(): 'ok' | 'moved' | 'lost' {
    if (!this.spot) return 'lost'
    // a dialog or the palette is up and covers every perch: wait behind its scrim
    if (document.querySelector('.overlay')) return 'ok'
    const p = this.point(this.spot)
    if (!this.standable(this.spot, p, false)) return 'lost'
    // perches that moved together (a card list re-sorted): the later bird makes room
    if (this.crowdedBy(p, 0.6, true)) return 'lost'
    if (Math.abs(p.x - this.pos.x) + Math.abs(p.y - this.pos.y) < 0.5) return 'ok'
    this.place(p)
    return 'moved'
  }

  /** Follow a moving perch frame by frame (a panel being dragged, a list scrolling) until it stops. */
  private async ride(): Promise<void> {
    let moved = true
    while (moved && this.spot && !this.over) {
      moved = false
      const spot = this.spot
      await this.animate(500, () => {
        if (!spot.el.isConnected) return false
        const p = this.point(spot)
        if (Math.abs(p.x - this.pos.x) + Math.abs(p.y - this.pos.y) < 0.5) return
        this.place(p)
        moved = true
      })
    }
  }

  /** Runs alongside the perch checks rather than holding them up. */
  private fidget(which?: [string, number]): void {
    if (!which && Math.random() < 0.25) {
      // look the other way, sometimes turning back
      this.face(-this.facing())
      if (Math.random() < 0.5) void this.sleep(rand(700, 1600)).then(() => this.spot && this.face(-this.facing()))
      return
    }
    const list = FIDGETS[this.mood()]
    const [name, ms] = which ?? list[Math.floor(Math.random() * list.length)]
    this.root.classList.add(name)
    void this.sleep(ms).then(() => this.root.classList.remove(name))
  }

  /** Stroll along the current perch. */
  private async walk(): Promise<boolean> {
    const spot = this.spot!
    const span = spot.el.getBoundingClientRect().width - 2 * EDGE
    if (span < 60) return false
    let dir = Math.random() < 0.5 ? -1 : 1
    const step = rand(30, Math.min(170, span * 0.8)) / span
    if (spot.frac + dir * step > 1 || spot.frac + dir * step < 0) dir = -dir
    const to = clamp(spot.frac + dir * step, 0, 1)
    if (!this.standable({ el: spot.el, frac: to }) || !this.standable({ el: spot.el, frac: (to + spot.frac) / 2 })) return false
    const from = spot.frac
    const ms = (Math.abs(to - from) * span * 1000) / 34
    this.target = { el: spot.el, frac: to }
    this.face(dir)
    this.pose('walk')
    let drawn = -Infinity
    await this.animate(ms, (k) => {
      // shooed mid-stroll: stop here and take off
      if (!spot.el.isConnected || this.shooed) return false
      // a stroll is slow enough that WALK_FRAME looks the same as every frame, and frames nothing
      // moves in cost nothing to draw
      if (k < 1 && clock.time - drawn < WALK_FRAME) return
      drawn = clock.time
      spot.frac = from + (to - from) * k
      const p = this.point(spot)
      this.place({ x: p.x, y: p.y - Math.abs(Math.sin((k * ms * Math.PI) / 300)) * 0.8 })
    })
    this.target = null
    this.pose('idle')
    return true
  }

  /** A hop or three along the perch, or one hop onto a perch close by (towards home, for an agent's bird). */
  private async hops(): Promise<boolean> {
    const here = this.spot!
    const near = this.pick({ not: here.el, near: this.pos, within: 110 })
    if (near && Math.random() < 0.6) {
      await this.hop(near)
      return true
    }
    const span = here.el.getBoundingClientRect().width - 2 * EDGE
    if (span < 40) return false
    const dir = Math.random() < 0.5 ? -1 : 1
    let n = 0
    for (let i = Math.floor(rand(1, 4)); i > 0 && this.spot?.el === here.el && !this.over && !this.shooed; i--) {
      const to = { el: here.el, frac: this.spot.frac + (dir * rand(16, 26)) / span }
      if (to.frac < 0 || to.frac > 1 || !this.standable(to)) break
      await this.hop(to)
      n++
      await this.sleep(rand(120, 300))
    }
    return n > 0
  }

  private async hop(to: Spot): Promise<void> {
    const a = { ...this.pos }
    this.target = to
    this.face(Math.sign(this.point(to).x - a.x))
    this.pose('crouch')
    await this.sleep(110)
    if (this.over) return
    this.pose('hop')
    const ms = clamp(260 + dist(a, this.point(to)) * 1.8, 260, 560)
    await this.animate(ms, (k) => {
      const b = this.point(to)
      const lift = (Math.abs(b.y - a.y) / 2 + 10) * 4 * k * (1 - k)
      this.place({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k - lift })
    })
    if (this.over) return
    this.spot = to
    this.target = null
    this.pose('crouch')
    await this.sleep(90)
    if (this.over) return
    this.pose('idle')
    if (!this.standable(to, undefined, false)) await this.flyAway()
  }

  private async flyAway(): Promise<void> {
    if (this.over) return
    const from = this.spot?.el
    const to = this.pick({ not: from, beyond: 120 }) ?? this.pick({ not: from }) ?? this.pick()
    if (to) return this.flyTo(to)
    // nowhere to land: leave the window and come back when somewhere turns up
    await this.flight(null, { x: this.pos.x < window.innerWidth / 2 ? -50 : window.innerWidth + 50, y: rand(40, 160) })
    if (this.over) return
    this.root.hidden = true
    this.spot = null
    await this.enter()
  }

  /** Fly to a spot, picking another on the way if it stops being somewhere to land. */
  private async flyTo(target: Spot): Promise<void> {
    if (this.spot) {
      this.pose('crouch')
      await this.sleep(150)
    }
    this.spot = null
    let to: Spot | null = target
    for (let tries = 0; to && tries < 4 && !this.over; tries++) {
      this.target = to
      if (await this.flight(to)) {
        this.spot = to
        this.target = null
        this.place(this.point(to))
        this.pose('land')
        await this.sleep(180)
        if (this.over) return
        this.pose('idle')
        return
      }
      this.target = null
      to = this.over ? null : this.pick({ not: to.el })
    }
    if (!this.over) await this.flyAway()
  }

  /** One curved flight to a spot (tracked as it moves) or a fixed point. False if the spot went bad. */
  private async flight(to: Spot | null, fixed?: Pt, stop?: () => boolean): Promise<boolean> {
    const a = { ...this.pos }
    let b = to ? this.point(to) : fixed!
    const d = dist(a, b)
    const ms = clamp(d / 0.33, 700, 2600)
    const c = { x: (a.x + b.x) / 2 + rand(-60, 60), y: Math.max(12, Math.min(a.y, b.y) - 40 - d * 0.25) }
    let ok = true
    let checkAt = 0
    let prevX = a.x
    this.pose('fly')
    await this.animate(ms, (k) => {
      if (stop?.()) return (ok = false)
      if (to && clock.time >= checkAt) {
        checkAt = clock.time + 250
        // Near the end, make sure there's still somewhere to land; before that, just follow it.
        if (!to.el.isConnected || (k > 0.6 && !this.standable(to))) return (ok = false)
        b = this.point(to)
      }
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2
      const x = (1 - e) ** 2 * a.x + 2 * (1 - e) * e * c.x + e * e * b.x
      const y = (1 - e) ** 2 * a.y + 2 * (1 - e) * e * c.y + e * e * b.y
      if (Math.abs(x - prevX) > 0.3) this.face(Math.sign(x - prevX))
      prevX = x
      if (k > 0.82) this.pose('glide')
      this.place({ x, y })
    })
    return ok && !(this.over && !this.exiting) && (!to || this.standable(to))
  }

  /** Reduced motion: no flying, just reappear somewhere else. */
  private async relocate(): Promise<void> {
    const to = this.pick({ not: this.spot?.el })
    if (to) return this.settle(to)
    this.root.hidden = true
    this.spot = null
    await this.enter()
  }

  private settle(spot: Spot): void {
    this.spot = spot
    this.place(this.point(spot))
    this.pose('idle')
    this.root.hidden = false
  }

  // ---------- perches ----------

  /** Where home is on screen, if it's showing. */
  private homePoint(): Pt | null {
    const el = this.opts.home?.()
    if (!el) return null
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height || r.bottom < 0 || r.top > window.innerHeight) return null
    return { x: r.left + r.width / 2, y: r.top }
  }

  /**
   * A random good spot: a random kind of perch first, so the many cards don't crowd out the
   * rail and tab strips, then a random element of that kind. `near`/`within` keeps it close
   * (for hops), `beyond` far enough to be worth a flight. A bird with a home showing looks at a
   * few good spots and takes one of the nearest to it.
   */
  private pick(o: { not?: Element; near?: Pt; within?: number; beyond?: number } = {}): Spot | null {
    const home = this.mood() === 'mascot' ? null : this.homePoint()
    const found: [Spot, Pt][] = []
    const want = home ? 6 : 1
    const kinds = home ? [CARDS, ...PERCHES] : PERCHES
    for (const sel of new Set(shuffle([...kinds]))) {
      let tries = 0
      for (const el of shuffle([...document.querySelectorAll(sel)])) {
        if (el === o.not || this.root.contains(el)) continue
        const r = el.getBoundingClientRect()
        if (r.width < MIN_WIDTH || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) continue
        let frac = rand(0.1, 0.9)
        // hop straight across to the bit of the perch nearest the bird
        if (o.near) frac = clamp((o.near.x - r.left - EDGE) / (r.width - 2 * EDGE) + rand(-0.15, 0.15), 0, 1)
        const spot = { el, frac }
        const p = this.point(spot)
        if (o.near && dist(p, o.near) > (o.within ?? Infinity)) continue
        if (o.near && dist(p, o.near) < 20) continue
        if (o.beyond && dist(p, this.pos) < o.beyond) continue
        if (this.standable(spot, p)) {
          found.push([spot, p])
          break
        }
        if (++tries >= 6) break
      }
      if (found.length >= want) break
    }
    if (!home || found.length < 2) return found[0]?.[0] ?? null
    found.sort((x, y) => dist(x[1], home) - dist(y[1], home))
    return found[Math.floor(Math.random() * Math.min(2, found.length))][0]
  }

  private point(s: Spot): Pt {
    const r = s.el.getBoundingClientRect()
    const edge = Math.min(EDGE, r.width / 2)
    // +1 puts the toes on the element's top border rather than just above it
    return { x: r.left + edge + s.frac * (r.width - 2 * edge), y: r.top + 1 }
  }

  /** Another bird sits or is landing within `k` gaps of p (only ones that got there first, with `older`). */
  private crowdedBy(p: Pt, k: number, older = false): boolean {
    for (const b of clock.birds) {
      if (b === this) {
        if (older) return false
        continue
      }
      const q = b.claim()
      if (q && dist(p, q) < GAP * Math.max(this.s, b.s) * k) return true
    }
    return false
  }

  /** The point this bird has reserved: where it's going, else where it sits. */
  private claim(): Pt | null {
    if (this.gone || this.dead) return null
    if (this.target?.el.isConnected) return this.point(this.target)
    return this.spot ? this.pos : null
  }

  private standable(s: Spot, p = this.point(s), spacing = true): boolean {
    if (!s.el.isConnected) return false
    const w = window.innerWidth
    if (p.x < 20 || p.x > w - 20 || p.y < this.height + 4 || p.y > window.innerHeight - 4) return false
    if (p.y - this.height < CONTROLS.h && p.x + this.halfW > w - CONTROLS.w) return false
    if (spacing && this.crowdedBy(p, 1)) return false
    // the perch must be what's actually under the feet: not scrolled out of view, covered, or hidden
    const under = this.hit(p.x, p.y + 2)
    if (!under || !s.el.contains(under)) return false
    return this.clear(p)
  }

  /** Nothing the user needs is in the way of the bird's body. */
  private clear(p: Pt): boolean {
    const box = { left: p.x - this.halfW, right: p.x + this.halfW, top: p.y - this.height, bottom: p.y - 2 }
    for (const el of document.querySelectorAll(NO_GO)) {
      const r = el.getBoundingClientRect()
      if (r.width && r.height && overlaps(box, r, 10)) return false
    }
    const active = document.activeElement
    if (typing(active) && overlaps(box, active.getBoundingClientRect(), 28)) return false
    for (const [dx, dy] of this.samples) {
      const x = p.x + dx * this.s
      const y = p.y + dy * this.s
      const el = this.hit(x, y)
      if (!el || el.closest(NO_GO)) return false
      const click = el.closest(CLICKABLE)
      // the plain edge of an agent card is fine, its buttons and words aren't
      if (click && !(click.matches(SOFT) && !el.closest(`${SOFT} :is(${CLICKABLE})`) && !onText(el, x, y))) return false
      // catches clickable divs and resize handles without a list of them
      const cursor = getComputedStyle(el).cursor
      if (cursor !== 'auto' && cursor !== 'default' && cursor !== 'text' && !click?.matches(SOFT)) return false
    }
    return true
  }

  /** Topmost element at a point, looking through every bird. */
  private hit(x: number, y: number): Element | null {
    for (const el of document.elementsFromPoint(x, y)) if (!el.closest('.crow')) return el
    return null
  }

  // ---------- drawing ----------

  private place(p: Pt): void {
    if (this.dead || (this.gone && !this.exiting)) return
    this.pos = p
    this.root.style.transform = `translate3d(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px, 0)`
  }

  private pose(p: Pose): void {
    if (this.gone && !this.exiting) return
    if (this.root.dataset.pose !== p) this.root.dataset.pose = p
  }

  private facing(): number {
    return this.flip.classList.contains('left') ? -1 : 1
  }

  private face(dir: number): void {
    if (dir) this.flip.classList.toggle('left', dir < 0)
  }

  // ---------- clock ----------

  private sleep(ms: number): Promise<void> {
    return clock.sleep(this, ms)
  }

  /** The shared clock's animate, cut short once the bird is asked to leave (except its way out). */
  private animate(ms: number, step: (k: number) => boolean | void): Promise<void> {
    return clock.animate(ms, (k) => (this.dead || (this.gone && !this.exiting) ? false : step(k)))
  }

  // ---------- input ----------

  /** don't take focus from whatever the user was typing in */
  private onMouseDown = (e: MouseEvent): void => e.preventDefault()
  /**
   * A click shoos the bird: it takes off and lands somewhere else, or with reduced motion just moves
   * to another perch. This is the one shoo for every bird, Corvid's and the agents'. It's purely
   * cosmetic: it only moves the drawing, and never reaches the agent (no stop, restart, message,
   * status change or board post). Ignored while it's already going (in flight, or a shoo is waiting
   * to happen) and for a moment after a shoo, so repeated clicks don't stack or make it jitter.
   */
  private onClick = (e: MouseEvent): void => {
    if (this.over || this.shooed || !this.spot || performance.now() - this.shooAt < SHOO_COOLDOWN) return
    this.shooed = true
    this.shooAt = performance.now()
    this.shooPt = { x: e.clientX, y: e.clientY }
    this.guard(true)
    clock.wake(this)
  }
  private onDblClick = (): void => this.opts.onOpen?.()

  /**
   * Just after a shoo the bird lifts off, and in flight it lets clicks through, so the second half of
   * a double-click (or a quick extra click) would land on whatever was under it. For a moment, presses
   * right where the bird was clicked are kept from the page, and a double-click there still opens.
   */
  private guard(on: boolean): void {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick'])
      window[on ? 'addEventListener' : 'removeEventListener'](t, this.onGuard as EventListener, true)
  }
  private onGuard = (e: MouseEvent): void => {
    if (performance.now() - this.shooAt > GRACE.ms) return this.guard(false)
    if (e.button !== 0 || dist({ x: e.clientX, y: e.clientY }, this.shooPt) > GRACE.px) return
    e.stopPropagation()
    // cancelling the mousedown keeps focus where it was; cancelling a pointerdown would drop the
    // mouse events after it, and the dblclick with them
    if (e.type === 'mousedown') e.preventDefault()
    if (e.type === 'dblclick') this.opts.onOpen?.()
  }
  private onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    this.opts.onHide()
  }
  /** The wheel would stop at the bird; scroll whatever it's sitting over instead. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault()
    for (let el = this.hit(e.clientX, e.clientY); el; el = el.parentElement) {
      const s = getComputedStyle(el)
      if (/(auto|scroll)/.test(s.overflowY + s.overflowX) && (el.scrollHeight > el.clientHeight || el.scrollWidth > el.clientWidth)) {
        el.scrollBy(e.deltaX, e.deltaY)
        return
      }
    }
  }
}
