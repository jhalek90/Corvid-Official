// Every theme lives here, as data. A theme is a set of colour tokens (the CSS variables the
// stylesheets use, named without the leading --), a terminal palette, and whether it's light or
// dark. Light themes start from LIGHT and dark ones from DARK, so a theme only lists what it changes.
// Adding a theme is adding an entry to THEMES; no CSS needed. Extensions add themes through the theme socket
// (src/extensions/sockets/theme.ts), which validates them and hands them to setExtensionThemes(); they use the same
// tokens, listed in TOKEN_NAMES.
//
// Nord (c) Sven Greb and Solarized (c) Ethan Schoonover are both MIT licensed; their colours are
// used as published, except where noted to keep text readable.

export type ThemeKind = 'light' | 'dark'

export type BuiltinThemeId = 'dark' | 'light' | 'corvid' | 'midnight' | 'paper' | 'dusk' | 'contrast' | 'nord' | 'solarized'

/** An extension's theme: "<extension id>.<theme id>", so it can never clash with a built-in one (they have no dot). */
export type ExtensionThemeId = `${string}.${string}`

export type ThemeId = BuiltinThemeId | ExtensionThemeId

export type Tokens = Record<string, string>

/** xterm's colours. It paints to a canvas, so these are literal colours rather than CSS tokens. */
export interface TermPalette {
  background: string
  foreground: string
  cursor: string
  cursorAccent: string
  selectionBackground: string
  black: string
  red: string
  green: string
  yellow: string
  blue: string
  magenta: string
  cyan: string
  white: string
  brightBlack: string
  brightRed: string
  brightGreen: string
  brightYellow: string
  brightBlue: string
  brightMagenta: string
  brightCyan: string
  brightWhite: string
}

export interface ThemeDef {
  id: ThemeId
  name: string
  kind: ThemeKind
  /** one line for the picker's tooltip */
  blurb: string
  tokens: Tokens
  term?: Partial<TermPalette>
  /** colour of the native min/max/close glyphs; defaults to text-2 */
  chromeSymbol?: string
  /** set on an extension's theme: which extension added it, and the readability warnings found when it registered */
  ext?: { owner: string; ownerName: string; warnings: string[]; lowContrast: boolean }
}

const DARK: Tokens = {
  bg: '#0a0c0f',
  'bg-1': '#0d1014',
  'bg-2': '#12161b',
  'bg-3': '#181d23',
  'bg-4': '#1f252d',
  line: '#1a2027',
  'line-2': '#252c35',
  'line-3': '#313944',
  text: '#e7eaee',
  'text-2': '#a2abb7',
  'text-3': '#6c7682',
  'text-4': '#48505a',
  accent: '#4fd6c5',
  'accent-hover': '#63e0d0',
  'accent-ink': '#062521',
  warn: '#e8a33d',
  danger: '#ef6b6b',
  /** text on a solid danger fill */
  'danger-ink': '#fff',
  opus: '#3987e5',
  sonnet: '#d95926',
  haiku: '#199e70',
  fable: '#c98500',
  other: '#6c7682',
  // commit graph lanes and live-session colours, a fixed cycle
  'lane-0': '#4a94ea',
  'lane-1': '#e0703f',
  'lane-2': '#2bb383',
  'lane-3': '#d9a12a',
  'lane-4': '#a57cec',
  'lane-5': '#e05a8c',
  'lane-6': '#2fb3c9',
  'lane-7': '#93ad3f',
  // activity heatmap, quiet to busy
  'heat-1': '#104281',
  'heat-2': '#1c5cab',
  'heat-3': '#2a78d6',
  'heat-4': '#5598e7',
  'heat-5': '#86b6ef',
  // syntax colours in the file preview
  'syn-keyword': '#c49cf0',
  'syn-string': '#9fd18b',
  'syn-number': '#eba86a',
  'syn-comment': '#6c7682',
  'syn-title': '#72b4f2',
  'syn-type': '#4fd6c5',
  'syn-attr': '#e3c27a',
  'syn-tag': '#f08c8c',
  // the crow mascot: lifted off the near-black background, with a faint rim to keep its outline
  'crow-body': '#262d36',
  'crow-wing': '#2f3843',
  'crow-beak': '#3d4652',
  'crow-eye': '#dfe5ec',
  'crow-sheen': 'rgba(130, 155, 230, 0.4)',
  'crow-rim': 'rgba(170, 190, 210, 0.45)',
  'crow-shade': 'rgba(0, 0, 0, 0.5)',
  // the same crow in the assistant's avatar, a shade lighter so it reads small against its disc
  'crow-av-body': '#36404b',
  'crow-av-wing': '#414c59',
  'crow-av-beak': '#5a6573',
  // translucent chrome over the backdrop
  chrome: 'rgba(10, 12, 15, 0.85)',
  'chrome-2': 'rgba(10, 12, 15, 0.6)',
  glass: 'rgba(13, 16, 20, 0.7)',
  'tip-bg': 'rgba(24, 29, 35, 0.96)',
  scrim: 'rgba(4, 6, 8, 0.6)',
  tick: 'rgba(255, 255, 255, 0.22)',
  // base for box-shadows: color-mix(in srgb, var(--shadow) N%, transparent)
  shadow: '#000'
}

const LIGHT: Tokens = {
  ...DARK,
  bg: '#eef1f4',
  'bg-1': '#ffffff',
  'bg-2': '#f6f8fa',
  'bg-3': '#ebeef2',
  'bg-4': '#dde2e8',
  line: '#e2e6eb',
  'line-2': '#d3d9e0',
  'line-3': '#bcc4ce',
  text: '#151a20',
  'text-2': '#444d58',
  'text-3': '#6b7480',
  'text-4': '#9aa2ac',
  accent: '#0c9483',
  'accent-hover': '#0a8273',
  'accent-ink': '#ffffff',
  warn: '#b86e0a',
  danger: '#d23f3f',
  other: '#8a939e',
  'lane-0': '#2a78d6',
  'lane-1': '#c4521f',
  'lane-2': '#158a61',
  'lane-3': '#a86f00',
  'lane-4': '#7d4fd0',
  'lane-5': '#c23a6c',
  'lane-6': '#13879b',
  'lane-7': '#66801d',
  'heat-1': '#cfe0f6',
  'heat-2': '#9cc0ee',
  'heat-3': '#5598e7',
  'heat-4': '#2a78d6',
  'heat-5': '#1c5cab',
  'syn-keyword': '#8a3fd1',
  'syn-string': '#2b6e2e',
  'syn-number': '#a5510a',
  'syn-comment': '#6b7480',
  'syn-title': '#1f62b5',
  'syn-type': '#0a7567',
  'syn-attr': '#855800',
  'syn-tag': '#bb3528',
  'crow-body': '#1b2027',
  'crow-wing': '#262d36',
  'crow-beak': '#39414b',
  'crow-eye': '#f2f5f8',
  'crow-sheen': 'rgba(95, 115, 190, 0.5)',
  'crow-rim': 'rgba(255, 255, 255, 0.6)',
  'crow-shade': 'rgba(25, 35, 50, 0.25)',
  'crow-av-body': '#1b2027',
  'crow-av-wing': '#262d36',
  'crow-av-beak': '#39414b',
  chrome: 'rgba(255, 255, 255, 0.85)',
  'chrome-2': 'rgba(255, 255, 255, 0.6)',
  glass: 'rgba(255, 255, 255, 0.75)',
  'tip-bg': 'rgba(255, 255, 255, 0.97)',
  scrim: 'rgba(30, 38, 48, 0.3)',
  tick: 'rgba(20, 30, 40, 0.3)',
  shadow: 'rgba(25, 35, 50, 0.3)'
}

const TERM_DARK: Omit<TermPalette, 'background' | 'foreground' | 'cursor' | 'cursorAccent' | 'selectionBackground'> = {
  black: '#1b2028',
  red: '#ef6b6b',
  green: '#5fd38d',
  yellow: '#e8b44d',
  blue: '#5b9cf0',
  magenta: '#c88cf0',
  cyan: '#4fd6c5',
  white: '#c9d0d8',
  brightBlack: '#5b6573',
  brightRed: '#ff8a8a',
  brightGreen: '#7ee2a4',
  brightYellow: '#f4c86d',
  brightBlue: '#7fb3f5',
  brightMagenta: '#d9a8f5',
  brightCyan: '#7de6d9',
  brightWhite: '#f2f4f7'
}

const TERM_LIGHT: typeof TERM_DARK = {
  black: '#1f252d',
  red: '#c93838',
  green: '#1d8a4e',
  yellow: '#9a6a00',
  blue: '#2563c9',
  magenta: '#9440c4',
  cyan: '#0c8576',
  white: '#8a939e',
  brightBlack: '#5b6573',
  brightRed: '#e04f4f',
  brightGreen: '#26a35f',
  brightYellow: '#b88300',
  brightBlue: '#3a7be0',
  brightMagenta: '#a95ad6',
  brightCyan: '#109e8c',
  brightWhite: '#c2c9d2'
}

/**
 * Every design token a theme can set, in one place: the built-in themes and extension themes use exactly these. A
 * theme that leaves one out gets it from its base (built-ins) or from the default theme of its kind (extensions).
 */
export const TOKEN_NAMES: readonly string[] = Object.keys(DARK)

/** The tokens an extension theme must give; a missing one is filled from the default theme of its kind, with a warning. */
export const REQUIRED_TOKENS: readonly string[] = [
  'bg', 'bg-1', 'bg-2', 'bg-3', 'bg-4', 'line', 'line-2', 'line-3', 'text', 'text-2', 'text-3', 'text-4',
  'accent', 'accent-hover', 'accent-ink', 'warn', 'danger', 'danger-ink'
]

/** The terminal palette's keys, all optional. */
export const TERM_KEYS: readonly (keyof TermPalette)[] = ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', ...(Object.keys(TERM_DARK) as (keyof TermPalette)[])]

export const THEMES: ThemeDef[] = [
  {
    id: 'corvid',
    name: 'Corvid',
    kind: 'dark',
    blurb: 'Near-black with the blue-violet sheen of a crow’s feathers',
    tokens: {
      bg: '#0b0b11',
      'bg-1': '#0f0f17',
      'bg-2': '#14141e',
      'bg-3': '#1a1a27',
      'bg-4': '#232332',
      line: '#1c1c2a',
      'line-2': '#282839',
      'line-3': '#35354a',
      text: '#e8e7f0',
      'text-2': '#aba9c2',
      'text-3': '#77758f',
      'text-4': '#4d4b64',
      accent: '#9b9cff',
      'accent-hover': '#b0b1ff',
      'accent-ink': '#12123a',
      warn: '#e8a33d',
      danger: '#f07178',
      'danger-ink': '#1a0507',
      'heat-1': '#2a2470',
      'heat-2': '#3d3599',
      'heat-3': '#5a50c8',
      'heat-4': '#8079ea',
      'heat-5': '#aca7f7',
      'syn-keyword': '#c9a0f5',
      'syn-type': '#7fd3e6',
      'syn-comment': '#85839d',
      'crow-body': '#24232f',
      'crow-wing': '#2d2c3c',
      'crow-beak': '#3c3b4e',
      'crow-sheen': 'rgba(140, 125, 255, 0.55)',
      'crow-rim': 'rgba(175, 170, 230, 0.45)',
      'crow-av-body': '#353447',
      'crow-av-wing': '#403f55',
      'crow-av-beak': '#5a5970',
      chrome: 'rgba(11, 11, 17, 0.85)',
      'chrome-2': 'rgba(11, 11, 17, 0.6)',
      glass: 'rgba(15, 15, 23, 0.7)',
      'tip-bg': 'rgba(26, 26, 39, 0.96)',
      scrim: 'rgba(4, 4, 10, 0.6)',
    },
    term: { magenta: '#b99cf5', brightMagenta: '#d2bbfa', blue: '#7d95f5', brightBlue: '#a1b3fa' }
  },
  {
    id: 'midnight',
    name: 'Midnight',
    kind: 'dark',
    blurb: 'Deep navy with a clear blue accent',
    tokens: {
      bg: '#0a1020',
      'bg-1': '#0d1428',
      'bg-2': '#111a31',
      'bg-3': '#16213b',
      'bg-4': '#1e2b48',
      line: '#18233c',
      'line-2': '#22304f',
      'line-3': '#2f3f62',
      text: '#e6ecf7',
      'text-2': '#a6b4cc',
      'text-3': '#73829e',
      'text-4': '#4a5874',
      accent: '#5eaaff',
      'accent-hover': '#7cbbff',
      'accent-ink': '#04152c',
      warn: '#f0b35a',
      danger: '#ff7a85',
      'danger-ink': '#2a0509',
      'syn-type': '#6fd6e8',
      'syn-comment': '#73829e',
      'crow-body': '#1e2739',
      'crow-wing': '#263149',
      'crow-beak': '#354262',
      'crow-sheen': 'rgba(110, 150, 255, 0.5)',
      'crow-rim': 'rgba(160, 185, 230, 0.45)',
      'crow-av-body': '#2e3a55',
      'crow-av-wing': '#384666',
      'crow-av-beak': '#52618a',
      chrome: 'rgba(10, 16, 32, 0.85)',
      'chrome-2': 'rgba(10, 16, 32, 0.6)',
      glass: 'rgba(13, 20, 40, 0.7)',
      'tip-bg': 'rgba(22, 33, 59, 0.96)',
      scrim: 'rgba(2, 5, 14, 0.6)',
    },
    term: { cyan: '#5ccfe6', brightCyan: '#8ee0f0' }
  },
  {
    id: 'dusk',
    name: 'Dusk',
    kind: 'dark',
    blurb: 'Soft and low contrast, for long evenings',
    tokens: {
      bg: '#24222c',
      'bg-1': '#292731',
      'bg-2': '#2e2c37',
      'bg-3': '#35323f',
      'bg-4': '#3e3b4a',
      line: '#36333f',
      'line-2': '#403d4b',
      'line-3': '#4d4959',
      text: '#dcd7e2',
      'text-2': '#b4aec0',
      'text-3': '#8f899c',
      'text-4': '#6a6577',
      accent: '#9ccbe0',
      'accent-hover': '#b2d7e8',
      'accent-ink': '#16272f',
      warn: '#e8c07f',
      danger: '#ec9191',
      'danger-ink': '#2a1012',
      'heat-1': '#34445a',
      'heat-2': '#45607c',
      'heat-3': '#5d7f9e',
      'heat-4': '#7ea2bd',
      'heat-5': '#a6c4d8',
      'syn-keyword': '#c6abe6',
      'syn-string': '#a9cf9a',
      'syn-number': '#e6b38a',
      'syn-comment': '#9a94a7',
      'syn-title': '#93bce8',
      'syn-type': '#9ccbe0',
      'syn-attr': '#e0c78f',
      'syn-tag': '#e8a0a0',
      'crow-body': '#1c1b22',
      'crow-wing': '#25232c',
      'crow-beak': '#3a3744',
      'crow-eye': '#e6e1ec',
      'crow-sheen': 'rgba(150, 160, 220, 0.4)',
      'crow-rim': 'rgba(200, 195, 215, 0.35)',
      'crow-shade': 'rgba(0, 0, 0, 0.35)',
      'crow-av-body': '#1c1b22',
      'crow-av-wing': '#25232c',
      'crow-av-beak': '#3a3744',
      chrome: 'rgba(36, 34, 44, 0.85)',
      'chrome-2': 'rgba(36, 34, 44, 0.6)',
      glass: 'rgba(41, 39, 49, 0.75)',
      'tip-bg': 'rgba(53, 50, 63, 0.97)',
      scrim: 'rgba(14, 13, 18, 0.55)',
      tick: 'rgba(255, 255, 255, 0.2)',
      shadow: 'rgba(0, 0, 0, 0.7)'
    },
    term: {
      black: '#35323f',
      red: '#ec9191',
      green: '#a9cf9a',
      yellow: '#e8c07f',
      blue: '#93bce8',
      magenta: '#c6abe6',
      cyan: '#9ccbe0',
      white: '#c8c2d0',
      brightBlack: '#6a6577',
      brightRed: '#f3abab',
      brightGreen: '#bfdcb3',
      brightYellow: '#efcf9c',
      brightBlue: '#afcdee',
      brightMagenta: '#d6c1ee',
      brightCyan: '#b4d8e8',
      brightWhite: '#ece8f0'
    }
  },
  {
    id: 'contrast',
    name: 'High contrast',
    kind: 'dark',
    blurb: 'Pure black, bright text and strong outlines, for readability',
    tokens: {
      bg: '#000000',
      'bg-1': '#0a0a0a',
      'bg-2': '#121212',
      'bg-3': '#1c1c1c',
      'bg-4': '#2c2c2c',
      line: '#4a4a4a',
      'line-2': '#6a6a6a',
      'line-3': '#8c8c8c',
      text: '#ffffff',
      'text-2': '#e6e6e6',
      'text-3': '#c4c4c4',
      'text-4': '#9a9a9a',
      accent: '#3fe0ff',
      'accent-hover': '#7aeaff',
      'accent-ink': '#000000',
      warn: '#ffc531',
      danger: '#ff6b6b',
      'danger-ink': '#000000',
      other: '#a0a0a0',
      'syn-keyword': '#d7a8ff',
      'syn-string': '#a8ec8c',
      'syn-number': '#ffb574',
      'syn-comment': '#b0b0b0',
      'syn-title': '#8cc8ff',
      'syn-type': '#3fe0ff',
      'syn-attr': '#ffd780',
      'syn-tag': '#ff9a9a',
      'crow-body': '#2a2a2a',
      'crow-wing': '#363636',
      'crow-beak': '#4a4a4a',
      'crow-eye': '#ffffff',
      'crow-sheen': 'rgba(120, 200, 255, 0.45)',
      'crow-rim': 'rgba(230, 230, 230, 0.7)',
      'crow-av-body': '#3a3a3a',
      'crow-av-wing': '#464646',
      'crow-av-beak': '#606060',
      chrome: 'rgba(0, 0, 0, 0.92)',
      'chrome-2': 'rgba(0, 0, 0, 0.75)',
      glass: 'rgba(10, 10, 10, 0.9)',
      'tip-bg': 'rgba(18, 18, 18, 0.98)',
      scrim: 'rgba(0, 0, 0, 0.7)',
      tick: 'rgba(255, 255, 255, 0.5)'
    },
    term: { foreground: '#ffffff', black: '#2c2c2c', white: '#e6e6e6', brightBlack: '#8c8c8c', brightWhite: '#ffffff' },
    chromeSymbol: '#ffffff'
  },
  {
    id: 'nord',
    name: 'Nord',
    kind: 'dark',
    blurb: 'The arctic Nord palette by Sven Greb (MIT)',
    tokens: {
      // Polar Night, with in-between steps for the extra surfaces the app needs
      bg: '#2e3440',
      'bg-1': '#323845',
      'bg-2': '#3b4252',
      'bg-3': '#434c5e',
      'bg-4': '#4c566a',
      line: '#3b4252',
      'line-2': '#434c5e',
      'line-3': '#4c566a',
      // Snow Storm. Nord's own comment grey (#616e88) is too faint for text, so text-3 is lighter
      text: '#eceff4',
      'text-2': '#d8dee9',
      'text-3': '#a7b0c0',
      'text-4': '#7b869a',
      // Frost
      accent: '#88c0d0',
      'accent-hover': '#8fbcbb',
      'accent-ink': '#2e3440',
      // Aurora; the red is lifted so error text stays readable on Polar Night, and the syntax colours a step for the same reason
      warn: '#ebcb8b',
      danger: '#e8a0a6',
      'danger-ink': '#2e3440',
      other: '#7b869a',
      'lane-0': '#81a1c1',
      'lane-1': '#d08770',
      'lane-2': '#a3be8c',
      'lane-3': '#ebcb8b',
      'lane-4': '#b48ead',
      'lane-5': '#bf616a',
      'lane-6': '#88c0d0',
      'lane-7': '#8fbcbb',
      'heat-1': '#3f5470',
      'heat-2': '#4f6c8f',
      'heat-3': '#5e81ac',
      'heat-4': '#81a1c1',
      'heat-5': '#88c0d0',
      'syn-keyword': '#8fb0d0',
      'syn-string': '#a3be8c',
      'syn-number': '#c4a3be',
      'syn-comment': '#9ea8ba',
      'syn-title': '#88c0d0',
      'syn-type': '#8fbcbb',
      'syn-attr': '#ebcb8b',
      'syn-tag': '#dc9a85',
      'crow-body': '#1f232c',
      'crow-wing': '#272c37',
      'crow-beak': '#3b4252',
      'crow-eye': '#eceff4',
      'crow-sheen': 'rgba(136, 192, 208, 0.4)',
      'crow-rim': 'rgba(216, 222, 233, 0.35)',
      'crow-shade': 'rgba(0, 0, 0, 0.35)',
      'crow-av-body': '#1f232c',
      'crow-av-wing': '#272c37',
      'crow-av-beak': '#3b4252',
      chrome: 'rgba(46, 52, 64, 0.88)',
      'chrome-2': 'rgba(46, 52, 64, 0.62)',
      glass: 'rgba(50, 56, 69, 0.78)',
      'tip-bg': 'rgba(67, 76, 94, 0.97)',
      scrim: 'rgba(20, 23, 29, 0.55)',
      tick: 'rgba(216, 222, 233, 0.3)',
      shadow: 'rgba(0, 0, 0, 0.6)'
    },
    // Nord's published terminal mapping
    term: {
      background: '#2e3440',
      foreground: '#d8dee9',
      black: '#3b4252',
      red: '#bf616a',
      green: '#a3be8c',
      yellow: '#ebcb8b',
      blue: '#81a1c1',
      magenta: '#b48ead',
      cyan: '#88c0d0',
      white: '#e5e9f0',
      brightBlack: '#4c566a',
      brightRed: '#bf616a',
      brightGreen: '#a3be8c',
      brightYellow: '#ebcb8b',
      brightBlue: '#81a1c1',
      brightMagenta: '#b48ead',
      brightCyan: '#8fbcbb',
      brightWhite: '#eceff4'
    }
  },
  {
    id: 'paper',
    name: 'Paper',
    kind: 'light',
    blurb: 'Warm off-white with ink-blue accents',
    tokens: {
      bg: '#f2ede3',
      'bg-1': '#fbf8f2',
      'bg-2': '#f6f2ea',
      'bg-3': '#ebe5d9',
      'bg-4': '#ddd5c5',
      line: '#e4ddcf',
      'line-2': '#d6cdbb',
      'line-3': '#bfb39e',
      text: '#2a251f',
      'text-2': '#544b40',
      'text-3': '#73685a',
      'text-4': '#a59a8a',
      accent: '#2c6a88',
      'accent-hover': '#245a74',
      'accent-ink': '#ffffff',
      warn: '#985800',
      danger: '#b02a45',
      other: '#958a7b',
      'heat-1': '#e6dcc6',
      'heat-2': '#cdbf9c',
      'heat-3': '#8fa7b3',
      'heat-4': '#4f8098',
      'heat-5': '#2c6a88',
      'syn-keyword': '#7b3fa8',
      'syn-string': '#3d6b22',
      'syn-number': '#a0490d',
      'syn-comment': '#766b5c',
      'syn-title': '#2c5f9e',
      'syn-type': '#1f6b6b',
      'syn-attr': '#80560a',
      'syn-tag': '#a83226',
      'crow-body': '#221e1a',
      'crow-wing': '#2d2823',
      'crow-beak': '#3f3831',
      'crow-eye': '#f7f2e8',
      'crow-sheen': 'rgba(80, 95, 160, 0.45)',
      'crow-rim': 'rgba(255, 252, 245, 0.6)',
      'crow-shade': 'rgba(60, 45, 25, 0.22)',
      'crow-av-body': '#221e1a',
      'crow-av-wing': '#2d2823',
      'crow-av-beak': '#3f3831',
      chrome: 'rgba(251, 248, 242, 0.86)',
      'chrome-2': 'rgba(251, 248, 242, 0.6)',
      glass: 'rgba(251, 248, 242, 0.78)',
      'tip-bg': 'rgba(253, 251, 247, 0.97)',
      scrim: 'rgba(50, 40, 25, 0.28)',
      tick: 'rgba(60, 45, 25, 0.3)',
      shadow: 'rgba(60, 45, 25, 0.28)'
    },
    term: {
      background: '#f6f2ea',
      foreground: '#2a251f',
      black: '#2a251f',
      red: '#b02a45',
      green: '#3d6b22',
      yellow: '#8a5a00',
      blue: '#2c5f9e',
      magenta: '#7b3fa8',
      cyan: '#1f6b6b',
      white: '#958a7b',
      brightBlack: '#73685a',
      brightRed: '#cf4d40',
      brightGreen: '#4f8530',
      brightYellow: '#a87000',
      brightBlue: '#3a75bd',
      brightMagenta: '#9352c4',
      brightCyan: '#2a8585',
      brightWhite: '#c8bfae'
    }
  },
  {
    id: 'solarized',
    name: 'Solarized Light',
    kind: 'light',
    blurb: 'Ethan Schoonover’s Solarized, light variant (MIT)',
    tokens: {
      // base2 / base3 surfaces
      bg: '#eee8d5',
      'bg-1': '#fdf6e3',
      'bg-2': '#f7f0dc',
      'bg-3': '#e8e1cb',
      'bg-4': '#dcd4bc',
      line: '#e3dcc6',
      'line-2': '#d5ccb2',
      'line-3': '#bdb397',
      // body text is base02 and secondary text base01, which clear 4.5:1 where base00 doesn't
      text: '#073642',
      'text-2': '#4a5f66',
      'text-3': '#586e75',
      'text-4': '#93a1a1',
      // blue, darkened a step so links and status text stay readable on base3
      accent: '#1f6fa8',
      'accent-hover': '#268bd2',
      'accent-ink': '#fdf6e3',
      warn: '#826200',
      danger: '#c42b28',
      'danger-ink': '#fdf6e3',
      other: '#93a1a1',
      'lane-0': '#268bd2',
      'lane-1': '#cb4b16',
      'lane-2': '#859900',
      'lane-3': '#b58900',
      'lane-4': '#6c71c4',
      'lane-5': '#d33682',
      'lane-6': '#2aa198',
      'lane-7': '#586e75',
      'heat-1': '#e0dcc6',
      'heat-2': '#b5cbd4',
      'heat-3': '#7fb0d6',
      'heat-4': '#268bd2',
      'heat-5': '#1f6fa8',
      'syn-keyword': '#575cb0',
      'syn-string': '#5c6b00',
      'syn-number': '#b03f12',
      'syn-comment': '#586e75',
      'syn-title': '#1f6fa8',
      'syn-type': '#1d7a73',
      'syn-attr': '#826200',
      'syn-tag': '#c42b28',
      'crow-body': '#073642',
      'crow-wing': '#0b4250',
      'crow-beak': '#2a525c',
      'crow-eye': '#fdf6e3',
      'crow-sheen': 'rgba(108, 113, 196, 0.5)',
      'crow-rim': 'rgba(253, 246, 227, 0.65)',
      'crow-shade': 'rgba(0, 43, 54, 0.22)',
      'crow-av-body': '#073642',
      'crow-av-wing': '#0b4250',
      'crow-av-beak': '#2a525c',
      chrome: 'rgba(253, 246, 227, 0.86)',
      'chrome-2': 'rgba(253, 246, 227, 0.6)',
      glass: 'rgba(253, 246, 227, 0.78)',
      'tip-bg': 'rgba(253, 246, 227, 0.97)',
      scrim: 'rgba(0, 43, 54, 0.25)',
      tick: 'rgba(0, 43, 54, 0.3)',
      shadow: 'rgba(0, 43, 54, 0.25)'
    },
    // Solarized's published terminal mapping, with base01 as the foreground for contrast
    term: {
      background: '#fdf6e3',
      foreground: '#586e75',
      cursor: '#586e75',
      black: '#073642',
      red: '#dc322f',
      green: '#859900',
      yellow: '#b58900',
      blue: '#268bd2',
      magenta: '#d33682',
      cyan: '#2aa198',
      white: '#eee8d5',
      brightBlack: '#002b36',
      brightRed: '#cb4b16',
      brightGreen: '#586e75',
      brightYellow: '#657b83',
      brightBlue: '#839496',
      brightMagenta: '#6c71c4',
      brightCyan: '#93a1a1',
      brightWhite: '#fdf6e3'
    }
  },
  {
    id: 'dark',
    name: 'Dark',
    kind: 'dark',
    blurb: 'The original dark theme, with a teal accent',
    tokens: {},
    term: { background: '#0a0c0f', foreground: '#d8dde4', selectionBackground: 'rgba(79, 214, 197, 0.25)' },
    chromeSymbol: '#8b95a3'
  },
  {
    id: 'light',
    name: 'Light',
    kind: 'light',
    blurb: 'The original light theme, with a teal accent',
    tokens: {},
    term: { background: '#f6f8fa', foreground: '#1f252d', selectionBackground: 'rgba(12, 148, 131, 0.22)' }
  }
]

const BY_ID = new Map<string, ThemeDef>(THEMES.map((t) => [t.id, t]))
/** The themes extensions have registered right now (validated by the theme socket); replaced on every reload. */
let EXT_BY_ID = new Map<string, ThemeDef>()

export const DEFAULT_DARK: ThemeId = 'corvid'
export const DEFAULT_LIGHT: ThemeId = 'light'

const EXT_THEME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*\.[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Whether `id` has the shape of an extension theme's id, whether or not that extension is loaded right now. */
export function isExtensionThemeId(id: unknown): id is ExtensionThemeId {
  return typeof id === 'string' && id.length <= 100 && EXT_THEME_ID.test(id)
}

/** Replaces the extension themes (the theme socket's loader calls this after every load). */
export function setExtensionThemes(defs: ThemeDef[]): void {
  EXT_BY_ID = new Map(defs.filter((d) => isExtensionThemeId(d.id)).map((d) => [d.id, d]))
}

/** The extension themes registered right now, in registration order. */
export const extensionThemes = (): ThemeDef[] => [...EXT_BY_ID.values()]

/** A theme that exists right now: a built-in one, or one an extension that is on has registered. */
export function isThemeId(id: unknown): id is ThemeId {
  return typeof id === 'string' && (BY_ID.has(id) || EXT_BY_ID.has(id))
}

export const isBuiltinThemeId = (id: unknown): id is BuiltinThemeId => typeof id === 'string' && BY_ID.has(id)

export function themeDef(id: string | undefined): ThemeDef {
  return (id !== undefined && (BY_ID.get(id) ?? EXT_BY_ID.get(id))) || BY_ID.get(DEFAULT_DARK)!
}

/** A theme's full token set: its own on top of the light or dark base. */
export function themeTokens(id: string | undefined): Tokens {
  const t = themeDef(id)
  return { ...(t.kind === 'light' ? LIGHT : DARK), ...t.tokens }
}

/** #rrggbb plus an alpha byte, for the few places that need a literal translucent colour. */
const withAlpha = (hex: string, a: number): string =>
  /^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(a * 255).toString(16).padStart(2, '0') : hex

export function termPalette(id: string | undefined): TermPalette {
  const t = themeDef(id)
  const k = themeTokens(id)
  const background = t.term?.background ?? (t.kind === 'light' ? k['bg-2'] : k.bg)
  return {
    background,
    foreground: k.text,
    cursor: k.accent,
    cursorAccent: background,
    selectionBackground: withAlpha(k.accent, t.kind === 'light' ? 0.22 : 0.28),
    ...(t.kind === 'light' ? TERM_LIGHT : TERM_DARK),
    ...t.term
  }
}

/** The window background and the native min/max/close glyphs, which CSS can't reach. */
export function themeChrome(id: string | undefined): { bg: string; symbol: string } {
  const t = themeDef(id)
  const k = themeTokens(id)
  return { bg: k.bg, symbol: t.chromeSymbol ?? k['text-2'] }
}

export interface ThemePrefs {
  theme: ThemeId
  themeFollowSystem: boolean
  themeLight: ThemeId
  themeDark: ThemeId
}

/** The theme config asks for, which may be an extension theme that is gone right now. */
export const wantedTheme = (p: ThemePrefs, osDark: boolean): string => (p.themeFollowSystem ? (osDark ? p.themeDark : p.themeLight) : p.theme)

/**
 * The kind a wanted theme was picked as, even when it's gone: the Follow system slot it sits in, or the slot the
 * picked theme also went into (picking a theme always fills its kind's slot).
 */
export function wantedKind(p: ThemePrefs, osDark: boolean): ThemeKind {
  const id = wantedTheme(p, osDark)
  if (isThemeId(id)) return themeDef(id).kind
  if (p.themeFollowSystem) return osDark ? 'dark' : 'light'
  return id === p.themeLight && id !== p.themeDark ? 'light' : 'dark'
}

/**
 * The theme to show: the picked one, or with Follow system on, the light or dark pick to match the OS. A pick that
 * doesn't exist right now (an extension theme whose extension is off, removed or broken) shows the default theme of
 * the same kind; the pick itself stays saved, so it comes back when the extension does.
 */
export function resolveTheme(p: ThemePrefs, osDark: boolean): ThemeId {
  const id = wantedTheme(p, osDark)
  if (isThemeId(id)) return id
  return wantedKind(p, osDark) === 'light' ? DEFAULT_LIGHT : DEFAULT_DARK
}

/** A saved theme setting worth keeping: a built-in theme, or anything shaped like an extension theme's id. */
export const isSavedThemeId = (id: unknown): id is ThemeId => isBuiltinThemeId(id) || isExtensionThemeId(id)
