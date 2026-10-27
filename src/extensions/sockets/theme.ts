import {
  DEFAULT_DARK,
  DEFAULT_LIGHT,
  REQUIRED_TOKENS,
  TERM_KEYS,
  TOKEN_NAMES,
  setExtensionThemes,
  termPalette,
  themeDef,
  themeTokens,
  type TermPalette,
  type ThemeDef,
  type ThemeKind,
  type Tokens
} from '../../shared/themes'
import { createRegistry } from './registry'
import { loadExtensions, type ExtensionModule, type LoadDeps, type LoadResult, type SocketHost } from './load'

// The theme socket (#114): an extension registers whole themes as data, from its own folder, through one entry in
// src/extensions/themeExtensions.ts. Both the main process (the saved setting, the window background, first paint) and
// the window (the picker, the CSS variables) load that index the same way.
//
// A theme is the same token set the built-in themes use (TOKEN_NAMES in shared/themes.ts) and ends up in CSS, so every
// value is treated as untrusted: only plain colours in a few known forms pass, and a theme with anything else is
// rejected whole. A rejected theme is skipped with a reason (crash.log and a quiet notice); the extension's other
// themes still register, and nothing here throws past the loader. Readability problems only warn.

export interface ExtensionTheme {
  /** unique within the extension; Corvid's id for it is "<extension id>.<id>" */
  id: string
  /** shown in the picker, at most 40 characters */
  name: string
  /** light or dark: where it goes for Follow system and the title-bar toggle */
  kind: ThemeKind
  /** one line for the picker's tooltip, at most 100 characters */
  blurb?: string
  /** design tokens by name, without the leading -- (see TOKEN_NAMES); missing ones come from Corvid's default theme of the same kind */
  tokens: Record<string, string>
  /** the terminal palette, all optional; missing colours follow the tokens and Corvid's default palette */
  term?: Partial<TermPalette>
  /** the native min/max/close glyphs' colour; defaults to text-2 */
  chromeSymbol?: string
}

export interface ThemeSockets {
  /** Registers one theme, or several at once. Returns the unregister function. */
  theme: (t: ExtensionTheme | ExtensionTheme[]) => () => void
}

/** A theme the socket turned away, and why, in plain words. */
export interface ThemeRejection {
  owner: string
  theme: string
  reason: string
}

export const THEME_LIMITS = { themesPerExtension: 8, tokens: 150, valueLength: 64, name: 40, blurb: 100 }
/** Below these a warning shows on the Extensions page and next to the theme in the picker (never a block). */
export const CONTRAST = { text: 4.5, status: 3 }
/** Two status colours closer than this (CIE76 ΔE) are reported as near-identical. */
export const STATUS_MIN_DELTA = 15

const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
/** The tokens a theme can't do without: with none of these there's nothing to fill from that would still be its own. */
const ESSENTIAL = ['bg', 'text', 'accent']

// ---------- colours ----------

export interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

const NUM = '[+-]?(?:\\d{1,4}(?:\\.\\d{1,6})?|\\.\\d{1,6})'
const SEP = '\\s*[,\\s]\\s*'
const ALPHA = `(?:\\s*[,/]\\s*(${NUM})(%?))?`
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/
const RGB = new RegExp(`^rgba?\\(\\s*(${NUM})(%?)${SEP}(${NUM})(%?)${SEP}(${NUM})(%?)${ALPHA}\\s*\\)$`)
const HSL = new RegExp(`^hsla?\\(\\s*(${NUM})(deg)?${SEP}(${NUM})%${SEP}(${NUM})%${ALPHA}\\s*\\)$`)
const NAMED: Record<string, Rgba> = { transparent: { r: 0, g: 0, b: 0, a: 0 }, black: { r: 0, g: 0, b: 0, a: 1 }, white: { r: 255, g: 255, b: 255, a: 1 } }

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))
const alpha = (v: string | undefined, pct: string | undefined): number => (v === undefined ? 1 : clamp(pct ? Number(v) / 100 : Number(v), 0, 1))

/** A colour in one of the accepted forms, or null. Only these forms ever reach CSS. */
export function parseColour(raw: string): Rgba | null {
  const v = raw.trim().toLowerCase()
  if (NAMED[v]) return NAMED[v]
  if (HEX.test(v)) {
    const h = v.length <= 5 ? [...v.slice(1)].map((c) => c + c).join('') : v.slice(1)
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
  }
  let m = RGB.exec(v)
  if (m) {
    const ch = (n: string, pct: string): number => clamp(pct ? (Number(n) * 255) / 100 : Number(n), 0, 255)
    return { r: ch(m[1], m[2]), g: ch(m[3], m[4]), b: ch(m[5], m[6]), a: alpha(m[7], m[8]) }
  }
  m = HSL.exec(v)
  if (m) {
    const h = (((Number(m[1]) % 360) + 360) % 360) / 360
    const s = clamp(Number(m[3]) / 100, 0, 1)
    const l = clamp(Number(m[4]) / 100, 0, 1)
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    const hue = (t: number): number => {
      const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t
      return x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p
    }
    return { r: hue(h + 1 / 3) * 255, g: hue(h) * 255, b: hue(h - 1 / 3) * 255, a: alpha(m[5], m[6]) }
  }
  return null
}

const hex2 = (n: number): string => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')

/**
 * The one form an accepted colour is stored in: #rrggbb when opaque, rgba(r, g, b, a) when not. Whatever the author
 * wrote, only this reaches CSS, the terminal and the native window frame (which reads #aarrggbb, not #rrggbbaa).
 */
export function canonicalColour(c: Rgba): string {
  if (c.a >= 1) return `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Math.round(c.a * 1000) / 1000})`
}

/** Why a value can't go into CSS, or null when it's a plain colour. The checks before the parse only make the reason clearer. */
export function valueProblem(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'is not text'
  if (raw.length > THEME_LIMITS.valueLength) return `is longer than ${THEME_LIMITS.valueLength} characters`
  const v = raw.toLowerCase()
  if (/[\r\n]/.test(v)) return 'contains a line break'
  if (/url\s*\(/.test(v)) return 'uses url(), which themes may not'
  if (/var\s*\(/.test(v)) return 'uses var(), which themes may not'
  if (/gradient|image|element\s*\(|expression|javascript:|@import/.test(v)) return 'uses an image, gradient or expression, which themes may not'
  if (/[;{}]/.test(v)) return 'contains a semicolon or a brace'
  if (/\/\*|\*\//.test(v)) return 'contains a comment'
  if (v.includes('\\')) return 'contains a backslash'
  if (/[<>"'`!@]/.test(v)) return 'contains characters a colour never has'
  if (!parseColour(raw)) return "isn't a colour in a form Corvid accepts (#hex, rgb(), rgba(), hsl(), hsla(), transparent, black or white)"
  return null
}

const lin = (c: number): number => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}
const luminance = (c: Rgba): number => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
/** `top` painted over `under` (which is opaque). */
const over = (top: Rgba, under: Rgba): Rgba => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 })

/** WCAG contrast ratio of a foreground over a background; translucent colours are laid over `base` first. */
export function contrastRatio(fg: Rgba, bg: Rgba, base: Rgba = NAMED.black): number {
  const b = over(bg, base)
  const f = over(fg, b)
  const [hi, lo] = [luminance(f), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

function lab(c: Rgba): [number, number, number] {
  const [r, g, b] = [lin(c.r), lin(c.g), lin(c.b)]
  const xyz = [(r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, r * 0.2126 + g * 0.7152 + b * 0.0722, (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883]
  const f = xyz.map((t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116))
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])]
}

/** CIE76 colour difference: under about 15, two small dots are hard to tell apart. */
export function deltaE(a: Rgba, b: Rgba): number {
  const [x, y] = [lab(a), lab(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

// ---------- readability ----------

const TEXT_PAIRS: [string, string, string][] = [
  ['text', 'bg', 'Body text on the background'],
  ['text', 'bg-1', 'Body text on panels'],
  ['text', 'bg-2', 'Body text on raised panels'],
  ['text-2', 'bg-1', 'Secondary text on panels'],
  ['accent-ink', 'accent', 'Button text on the accent'],
  ['danger-ink', 'danger', 'Button text on the danger colour']
]
const STATUS: [string, string][] = [
  ['accent', 'working and idle (accent)'],
  ['warn', 'needs you (warn)'],
  ['danger', 'error (danger)']
]

/** The readability warnings for a full token set and terminal palette. Never blocks: the user's taste decides. */
export function readabilityWarnings(k: Tokens, term: TermPalette, kind: ThemeKind): string[] {
  const out: string[] = []
  const base = kind === 'light' ? NAMED.white : NAMED.black
  const c = (name: string): Rgba | null => (k[name] ? parseColour(k[name]) : null)
  const bg = c('bg')
  const fmt = (n: number): string => n.toFixed(1)
  for (const [fg, under, what] of TEXT_PAIRS) {
    const f = c(fg)
    const b = c(under)
    if (!f || !b) continue
    const r = contrastRatio(f, b, bg ? over(bg, base) : base)
    if (r < CONTRAST.text) out.push(`Low contrast: ${what} is ${fmt(r)}:1 (${fg} on ${under}); text needs ${CONTRAST.text}:1.`)
  }
  if (bg)
    for (const [name, what] of STATUS) {
      const f = c(name)
      if (!f) continue
      const r = contrastRatio(f, bg, base)
      if (r < CONTRAST.status) out.push(`Low contrast: the ${what} status colour is ${fmt(r)}:1 on the background; it needs ${CONTRAST.status}:1 to show.`)
    }
  const tf = parseColour(term.foreground)
  const tb = parseColour(term.background)
  if (tf && tb) {
    const r = contrastRatio(tf, tb, base)
    if (r < CONTRAST.text) out.push(`Low contrast: terminal text is ${fmt(r)}:1 on the terminal background; text needs ${CONTRAST.text}:1.`)
  }
  // the crow on the page and in the avatars: its body needs to stand off the background a little, or only its rim shows
  const body = c('crow-body')
  if (body && bg && contrastRatio(body, bg, base) < 1.2)
    out.push('The crow blends into the background (crow-body on bg); set crow-body, crow-wing and crow-rim so its outline shows.')
  for (let i = 0; i < STATUS.length; i++)
    for (let j = i + 1; j < STATUS.length; j++) {
      const a = c(STATUS[i][0])
      const b = c(STATUS[j][0])
      if (!a || !b) continue
      const d = deltaE(bg ? over(a, over(bg, base)) : a, bg ? over(b, over(bg, base)) : b)
      if (d < STATUS_MIN_DELTA) out.push(`Status colours too alike: ${STATUS[i][1]} and ${STATUS[j][1]} are hard to tell apart (difference ${Math.round(d)}, aim for ${STATUS_MIN_DELTA} or more).`)
    }
  return out
}

// ---------- validation ----------

type Checked = { def: ThemeDef } | { reason: string }

const isPlainObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const list = (xs: string[], max = 6): string => (xs.length > max ? `${xs.slice(0, max).join(', ')} and ${xs.length - max} more` : xs.join(', '))

/** Checks one registration and builds the theme Corvid will use. Pure: never throws on any input. */
export function checkTheme(owner: string, ownerName: string, t: unknown): Checked {
  if (!isPlainObject(t)) return { reason: 'A theme must be an object with an id, a name, a kind and tokens.' }
  const { id, name, kind, blurb, tokens, term, chromeSymbol } = t
  if (typeof id !== 'string' || id.length > 32 || !ID.test(id))
    return { reason: 'A theme needs an id of up to 32 lowercase letters, digits and single hyphens (no dots: Corvid adds the extension id in front, so it can never replace a built-in theme).' }
  const where = `The theme "${id}"`
  if (typeof name !== 'string' || !name.trim() || name.length > THEME_LIMITS.name) return { reason: `${where} needs a name of 1 to ${THEME_LIMITS.name} characters.` }
  if (/[\r\n<>]/.test(name)) return { reason: `${where} has a name with line breaks or angle brackets.` }
  if (kind !== 'light' && kind !== 'dark') return { reason: `${where} needs a kind: "light" or "dark".` }
  if (blurb !== undefined && (typeof blurb !== 'string' || blurb.length > THEME_LIMITS.blurb || /[\r\n]/.test(blurb))) return { reason: `${where} has a blurb that isn't one line of at most ${THEME_LIMITS.blurb} characters.` }
  if (!isPlainObject(tokens)) return { reason: `${where} needs tokens: an object of token names and colours.` }
  const names = Object.keys(tokens)
  if (names.length > THEME_LIMITS.tokens) return { reason: `${where} has ${names.length} tokens; at most ${THEME_LIMITS.tokens} are allowed.` }
  const warnings: string[] = []
  const own: Tokens = {}
  const unknown: string[] = []
  for (const n of names) {
    if (!TOKEN_NAMES.includes(n)) {
      unknown.push(n.slice(0, 40))
      continue
    }
    const problem = valueProblem(tokens[n])
    if (problem) return { reason: `${where}: the token ${n} ${problem}.` }
    own[n] = canonicalColour(parseColour(tokens[n] as string)!)
  }
  if (unknown.length) warnings.push(`Ignored unknown token${unknown.length === 1 ? '' : 's'}: ${list(unknown)}.`)
  const absent = ESSENTIAL.filter((n) => !own[n])
  if (absent.length) return { reason: `${where} is missing ${list(absent)}, which every theme must set.` }
  const fallback = kind === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK
  const missing = REQUIRED_TOKENS.filter((n) => !own[n])
  if (missing.length) warnings.push(`Missing required token${missing.length === 1 ? '' : 's'} ${list(missing)}, filled from ${themeDef(fallback).name}.`)

  let termOut: Partial<TermPalette> | undefined
  if (term !== undefined) {
    if (!isPlainObject(term)) return { reason: `${where} has a term palette that isn't an object.` }
    termOut = {}
    const unknownTerm: string[] = []
    for (const n of Object.keys(term)) {
      if (!(TERM_KEYS as readonly string[]).includes(n)) {
        unknownTerm.push(n.slice(0, 40))
        continue
      }
      const problem = valueProblem(term[n])
      if (problem) return { reason: `${where}: the terminal colour ${n} ${problem}.` }
      termOut[n as keyof TermPalette] = canonicalColour(parseColour(term[n] as string)!)
    }
    if (unknownTerm.length) warnings.push(`Ignored unknown terminal colour${unknownTerm.length === 1 ? '' : 's'}: ${list(unknownTerm)}.`)
  }
  if (chromeSymbol !== undefined) {
    const problem = valueProblem(chromeSymbol)
    if (problem) return { reason: `${where}: chromeSymbol ${problem}.` }
  }

  const full = `${owner}.${id}`
  const def: ThemeDef = {
    id: full as ThemeDef['id'],
    name: name.trim(),
    kind,
    blurb: typeof blurb === 'string' && blurb.trim() ? blurb.trim() : `A ${kind} theme`,
    // the default theme of the same kind underneath, so every token is set and nothing falls through to another theme
    tokens: { ...themeTokens(fallback), ...own },
    term: termOut,
    chromeSymbol: typeof chromeSymbol === 'string' ? canonicalColour(parseColour(chromeSymbol)!) : undefined,
    ext: { owner, ownerName, warnings, lowContrast: false }
  }
  const readability = readabilityWarnings(def.tokens, paletteFor(def), kind)
  def.ext!.warnings.push(...readability)
  def.ext!.lowContrast = readability.length > 0
  return { def }
}

/** termPalette() for a theme that isn't registered yet: the same rules, from the theme's own data. */
function paletteFor(def: ThemeDef): TermPalette {
  const base = termPalette(def.kind === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK)
  const k = def.tokens
  const background = def.term?.background ?? (def.kind === 'light' ? k['bg-2'] : k.bg)
  return { ...base, background, foreground: k.text, cursor: k.accent, cursorAccent: background, ...def.term }
}

// ---------- the registry and the loader ----------

const themes = createRegistry<ThemeDef>('Theme', (t) => t.id)
let rejected: ThemeRejection[] = []

export const themeHost: SocketHost<ThemeSockets> & { ownerNames: Map<string, string> } = {
  ownerNames: new Map(),
  socketsFor: (owner) => ({
    theme: (t) => {
      const ownerName = themeHost.ownerNames.get(owner) ?? owner
      const items: unknown[] = Array.isArray(t) ? t : [t]
      const offs: (() => void)[] = []
      for (const item of items) {
        const label = isPlainObject(item) && typeof item.id === 'string' ? item.id.slice(0, 32) : '(no id)'
        if (themes.list().filter((e) => e.owner === owner).length >= THEME_LIMITS.themesPerExtension) {
          rejected.push({ owner, theme: label, reason: `An extension may register at most ${THEME_LIMITS.themesPerExtension} themes.` })
          continue
        }
        const r = checkTheme(owner, ownerName, item)
        if ('reason' in r) {
          rejected.push({ owner, theme: label, reason: r.reason })
          continue
        }
        try {
          offs.push(themes.add(owner, r.def))
        } catch {
          rejected.push({ owner, theme: label, reason: `The theme "${label}" is registered twice.` })
        }
      }
      return () => offs.forEach((off) => off())
    }
  }),
  count: (owner) => themes.list().filter((e) => e.owner === owner).length,
  removeOwner: (owner) => themes.removeOwner(owner)
}

export interface ThemeLoad {
  results: LoadResult[]
  rejected: ThemeRejection[]
}

/**
 * Loads (or reloads) the theme extensions and hands their themes to shared/themes.ts. One that is off registers nothing;
 * one that throws or is malformed is skipped by the usual loader; a bad theme is skipped on its own. Never throws.
 */
export function loadThemeExtensions(mods: ExtensionModule<ThemeSockets>[], deps: LoadDeps): ThemeLoad {
  themes.clear()
  rejected = []
  themeHost.ownerNames = new Map((Array.isArray(mods) ? mods : []).filter((m) => typeof m?.id === 'string' && typeof m?.name === 'string').map((m) => [m.id, m.name]))
  let results: LoadResult[] = []
  try {
    results = loadExtensions(Array.isArray(mods) ? mods : [], themeHost, deps)
  } catch (e) {
    deps.log('Theme extensions failed to load', e instanceof Error ? e.message : String(e))
  }
  // an extension that failed has its own reason, and lost the themes it had registered
  const live = new Set(results.filter((r) => r.state === 'loaded').map((r) => r.id))
  rejected = rejected.filter((r) => live.has(r.owner))
  for (const r of rejected) deps.log(`Theme ${r.owner}.${r.theme} skipped`, r.reason)
  setExtensionThemes(themes.list().map((e) => e.item))
  return { results, rejected: [...rejected] }
}

/** The rejections from the last load, for the Extensions page. */
export const themeRejections = (): ThemeRejection[] => [...rejected]

/** A notice for the user about rejected themes, or null. */
export function rejectionNotice(load: ThemeLoad): string | null {
  if (!load.rejected.length) return null
  const name = (owner: string): string => load.results.find((r) => r.id === owner)?.name ?? owner
  return `${load.rejected.length === 1 ? 'A theme was' : `${load.rejected.length} themes were`} skipped: ${load.rejected.map((r) => `${r.theme} from ${name(r.owner)} (${r.reason})`).join('; ')} Details are in the crash log.`
}
