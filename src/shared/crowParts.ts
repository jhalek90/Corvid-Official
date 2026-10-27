// The crow's options, in one place: the colour presets, the hats and the accessories. The look
// editor in Settings offers exactly these, and agents' random crows are picked from them, so a hat or
// colour added here shows up in both. Also the colour maths both use to keep a crow readable.

import type { CrowExtra, CrowHat, CrowLook } from './types'

export type CrowPart = 'body' | 'beak' | 'eye' | 'accent'

export interface CrowPartDef {
  key: CrowPart
  label: string
  /** the theme token the editor's "theme default" swatch shows */
  cssVar: string
  /** the colour picker's starting value while the theme's own colour is in use */
  fallback: string
  presets: [name: string, hex: string][]
}

/** Each colour's presets, in the editor's order. */
export const CROW_PARTS: CrowPartDef[] = [
  {
    key: 'body',
    label: 'Feathers',
    cssVar: '--crow-body',
    fallback: '#262d36',
    presets: [
      ['Slate', '#4a5563'],
      ['Midnight', '#24324f'],
      ['Plum', '#4a2f4f'],
      ['Forest', '#2d4a3a'],
      ['Rust', '#7a3e2a'],
      ['Snow', '#e8ecf0']
    ]
  },
  {
    key: 'beak',
    label: 'Beak and feet',
    cssVar: '--crow-beak',
    fallback: '#3d4652',
    presets: [
      ['Gold', '#e0a43a'],
      ['Orange', '#e07a3a'],
      ['Pink', '#e8909c'],
      ['Ivory', '#e8dcc4'],
      ['Black', '#14171c']
    ]
  },
  {
    key: 'eye',
    label: 'Eye',
    cssVar: '--crow-eye',
    fallback: '#dfe5ec',
    presets: [
      ['Black', '#101317'],
      ['Amber', '#f2b134'],
      ['Ice', '#9fe3ff'],
      ['Red', '#e05050'],
      ['Green', '#7fdc8a']
    ]
  },
  {
    key: 'accent',
    label: 'Sheen and trim',
    cssVar: '--crow-trim',
    fallback: '#8a9fe6',
    presets: [
      ['Teal', '#4fd6c5'],
      ['Violet', '#a57cec'],
      ['Gold', '#e3c27a'],
      ['Rose', '#e05a8c'],
      ['Green', '#2bb383']
    ]
  }
]

export const CROW_HATS: CrowHat[] = ['none', 'top', 'wizard', 'party', 'cap', 'crown', 'beanie', 'tricorn']

export const HAT_LABEL: Record<CrowHat, string> = {
  none: 'No hat',
  top: 'Top hat',
  wizard: 'Wizard hat',
  party: 'Party hat',
  cap: 'Baseball cap',
  crown: 'Crown',
  beanie: 'Beanie',
  tricorn: 'Tricorn'
}

export const CROW_EXTRAS: [CrowExtra, string][] = [
  ['none', 'None'],
  ['glasses', 'Glasses'],
  ['bowtie', 'Bow tie']
]

export const presetsOf = (part: CrowPart): string[] => CROW_PARTS.find((p) => p.key === part)!.presets.map(([, c]) => c)

// ---------- colour maths ----------

const HEX = /^#[0-9a-f]{6}$/i
export const isHex = (v: unknown): v is string => typeof v === 'string' && HEX.test(v)

export const rgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function luminance(c: string): number {
  const [r, g, b] = rgb(c).map((v) => {
    v /= 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((m, n) => n - m)
  return (x + 0.05) / (y + 0.05)
}

/** Below this contrast ratio against the page, feathers read as background and get a firmer rim (the original dark crow is about 1.4). */
export const LOW_CONTRAST = 1.35

/** A look read from disk or another process: only known hats and #rrggbb colours survive. */
export function cleanLook(v: unknown): CrowLook | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  const look: CrowLook = {
    hat: CROW_HATS.includes(o.hat as CrowHat) ? (o.hat as CrowHat) : 'none',
    extra: CROW_EXTRAS.some(([x]) => x === o.extra) ? (o.extra as CrowExtra) : 'none'
  }
  for (const k of ['body', 'beak', 'eye', 'accent'] as const) if (isHex(o[k])) look[k] = o[k]
  return look
}
