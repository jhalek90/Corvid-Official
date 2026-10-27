// Pane widths live in CSS variables on :root, so dragging a handle never re-renders React.
// Unset means the stylesheet default; only widths the user has dragged are saved.

export type Pane = 'explorer' | 'preview' | 'terminal'

interface Limits {
  min: number
  max: number
  /** cap as a fraction of the window, so a saved width can't crowd out everything else */
  vw?: number
}

const LIMITS: Record<Pane, Limits> = {
  explorer: { min: 180, max: 560, vw: 0.3 },
  preview: { min: 280, max: 1200, vw: 0.45 },
  terminal: { min: 280, max: 1100, vw: 0.45 },
}

/** The main view never gets squeezed below this by a drag. */
export const MIN_MAIN = 520

const KEY = 'paneWidths'
let widths: Partial<Record<Pane, number>> = load()

function load(): Partial<Record<Pane, number>> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => k in LIMITS && typeof v === 'number'))
  } catch {
    return {}
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(widths))
  } catch {
    /* ignore */
  }
}

function apply(pane: Pane): void {
  const w = widths[pane]
  const style = document.documentElement.style
  if (w === undefined) style.removeProperty(`--w-${pane}`)
  else style.setProperty(`--w-${pane}`, `${w}px`)
}

export function clampWidth(pane: Pane, w: number, slack = Infinity): number {
  const { min, max, vw } = LIMITS[pane]
  const cap = Math.min(max, vw ? window.innerWidth * vw : Infinity, slack)
  return Math.round(Math.max(min, Math.min(cap, w)))
}

/** Live update while dragging; call commit() when the drag ends. */
export function setWidth(pane: Pane, w: number): void {
  widths[pane] = w
  apply(pane)
}

export function commit(): void {
  save()
}

export function resetWidth(pane: Pane): void {
  delete widths[pane]
  apply(pane)
  save()
}

export function resetLayout(): void {
  widths = {}
  for (const p of Object.keys(LIMITS) as Pane[]) apply(p)
  save()
}

export function hasCustomLayout(): boolean {
  return Object.keys(widths).length > 0
}

for (const p of Object.keys(widths) as Pane[]) apply(p)
