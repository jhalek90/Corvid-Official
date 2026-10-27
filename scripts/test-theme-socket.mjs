// Tests for #114, the theme socket: a sample theme extension, written here and never shipped, registers a light and
// a dark theme that show up as real themes (tokens, terminal palette, window chrome, Follow system and the toggle);
// bad data (url(), braces, semicolons, comments, huge values, missing and unknown tokens, a clashing id, an id that
// would shadow a built-in theme, a registration that isn't a theme) is rejected or repaired with a reason and never
// throws; a deliberately poor theme gets contrast and status-colour warnings; switching the extension off, removing
// it or breaking it falls back to the default theme of the same kind and comes back after; a saved setting for a
// missing theme loads fine; and the tier-1 diff check takes a theme extension. Runs on Node 24's own TypeScript
// support with a stand-in for electron, like test-sockets.mjs.
//
//   npm run test-theme-socket

import { register } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-theme-socket-'))
globalThis.__userData = join(tmp, 'data')
mkdirSync(globalThis.__userData, { recursive: true })
const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      export const app = { getPath: () => globalThis.__userData, isPackaged: false, getVersion: () => '0.0.0' }
      export const safeStorage = { isEncryptionAvailable: () => false }
    \`)
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: fake, shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return u.endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)
after(() => rmSync(tmp, { recursive: true, force: true }))

const themes = await import(src + 'shared/themes.ts')
const socket = await import(src + 'extensions/sockets/theme.ts')
const { diffShape } = await import(src + 'extensions/sockets/diffShape.ts')
const { SOCKET_BUILD_GUIDANCE } = await import(src + 'extensions/sockets/guidance.ts')

// ---------- the sample extension (test only) ----------

const GOOD_DARK = {
  id: 'night',
  name: 'Sample Night',
  kind: 'dark',
  blurb: 'A test theme',
  tokens: {
    bg: '#101020', 'bg-1': '#16162a', 'bg-2': '#1c1c33', 'bg-3': '#24243f', 'bg-4': '#2e2e4d',
    line: '#22223a', 'line-2': '#2c2c48', 'line-3': '#3a3a5a',
    text: '#f0f0ff', 'text-2': '#c0c0dd', 'text-3': '#8888aa', 'text-4': '#55557a',
    accent: '#ff79c6', 'accent-hover': '#ff92d0', 'accent-ink': '#1a0010',
    warn: '#f1fa8c', danger: '#ff5555', 'danger-ink': '#1a0000',
    'syn-keyword': 'rgb(255, 121, 198)', 'syn-string': 'hsl(65, 92%, 76%)', chrome: 'rgba(16, 16, 32, 0.85)'
  },
  term: { background: '#0c0c18', red: '#ff5555', green: '#50fa7b' }
}
const GOOD_LIGHT = {
  id: 'day',
  name: 'Sample Day',
  kind: 'light',
  tokens: {
    bg: '#f4f1ea', 'bg-1': '#ffffff', 'bg-2': '#faf8f3', 'bg-3': '#ece8de', 'bg-4': '#ded9cc',
    line: '#e4dfd3', 'line-2': '#d6d0c2', 'line-3': '#bfb8a8',
    text: '#1d1a14', 'text-2': '#4a4436', 'text-3': '#6e6756', 'text-4': '#9b9483',
    accent: '#7a3fb0', 'accent-hover': '#6a3399', 'accent-ink': '#ffffff',
    warn: '#8a5a00', danger: '#c0262d', 'danger-ink': '#ffffff'
  }
}
const sample = (register) => ({ id: 'sample-themes', name: 'Sample themes', api: 1, register })
const good = sample((s) => s.theme([GOOD_DARK, GOOD_LIGHT]))
const quietLog = []
const deps = (off = []) => ({ enabled: (id) => !off.includes(id), log: (what, details) => quietLog.push(`${what}: ${details}`) })
const prefs = (p) => ({ theme: 'corvid', themeFollowSystem: false, themeLight: 'light', themeDark: 'corvid', ...p })

test('a good theme extension registers a light and a dark theme that behave like built-in ones', () => {
  const load = socket.loadThemeExtensions([good], deps())
  assert.equal(load.results[0].state, 'loaded')
  assert.equal(load.results[0].registered, 2)
  assert.deepEqual(load.rejected, [])
  const ids = themes.extensionThemes().map((t) => t.id)
  assert.deepEqual(ids, ['sample-themes.night', 'sample-themes.day'])
  assert.ok(themes.isThemeId('sample-themes.night'))
  const night = themes.themeDef('sample-themes.night')
  assert.equal(night.kind, 'dark')
  assert.equal(night.ext.owner, 'sample-themes')
  assert.equal(night.ext.ownerName, 'Sample themes')
  // every token is set: its own, the rest from Corvid's default dark theme
  const k = themes.themeTokens('sample-themes.night')
  assert.equal(k.bg, '#101020')
  assert.equal(k['syn-keyword'], '#ff79c6', 'rgb() is stored as #rrggbb')
  assert.equal(k['syn-string'].startsWith('#'), true)
  assert.equal(k.chrome, 'rgba(16, 16, 32, 0.85)')
  assert.equal(k['heat-1'], themes.themeTokens('corvid')['heat-1'])
  for (const n of themes.TOKEN_NAMES) assert.ok(k[n], `token ${n} is set`)
  // the terminal follows: its own colours, then the tokens, then the default palette
  const term = themes.termPalette('sample-themes.night')
  assert.equal(term.background, '#0c0c18')
  assert.equal(term.foreground, '#f0f0ff')
  assert.equal(term.cursor, '#ff79c6')
  assert.equal(term.green, '#50fa7b')
  assert.match(term.selectionBackground, /^#ff79c6[0-9a-f]{2}$/)
  // the native frame
  assert.deepEqual(themes.themeChrome('sample-themes.day'), { bg: '#f4f1ea', symbol: '#4a4436' })
  // Follow system and the toggle use the kind's pick
  const p = prefs({ themeFollowSystem: true, themeLight: 'sample-themes.day', themeDark: 'sample-themes.night' })
  assert.equal(themes.resolveTheme(p, true), 'sample-themes.night')
  assert.equal(themes.resolveTheme(p, false), 'sample-themes.day')
  assert.equal(themes.resolveTheme(prefs({ theme: 'sample-themes.day', themeLight: 'sample-themes.day' }), true), 'sample-themes.day')
  // a good theme has nothing to warn about
  assert.deepEqual(night.ext.warnings, [])
  assert.equal(night.ext.lowContrast, false)
  // built-ins are untouched
  assert.equal(themes.THEMES.length, 9)
  assert.ok(themes.isBuiltinThemeId('nord'))
  assert.equal(themes.isBuiltinThemeId('sample-themes.night'), false)
})

// ---------- bad data ----------

const withToken = (name, value) => ({ ...GOOD_DARK, id: 'bad', tokens: { ...GOOD_DARK.tokens, [name]: value } })
const rejectionFor = (theme) => {
  const load = socket.loadThemeExtensions([sample((s) => s.theme(theme))], deps())
  assert.equal(load.results[0].state, 'loaded', 'a bad theme never fails the extension')
  assert.equal(themes.extensionThemes().length, 0)
  assert.equal(load.rejected.length, 1)
  return load.rejected[0].reason
}

test('values that could break out of a declaration are rejected, with the reason', () => {
  const cases = [
    ['url(https://example.com/x.png)', /url\(\)/],
    ['#fff; background: red', /semicolon/],
    ['#fff } body { display: none', /brace/],
    ['#fff /* x */', /comment/],
    ['var(--bg)', /var\(\)/],
    ['linear-gradient(red, blue)', /gradient/],
    ['image-set("x.png" 1x)', /image/],
    ['expression(alert(1))', /expression/],
    ['#fff\\', /backslash/],
    ['#fff\nbody{}', /line break/],
    ['#' + 'f'.repeat(200), /longer than/],
    ['rebeccapurple', /form Corvid accepts/],
    ['rgb(1, 2)', /form Corvid accepts/],
    ['"#fff"', /characters/],
    [42, /not text/]
  ]
  for (const [value, why] of cases) assert.match(rejectionFor(withToken('bg', value)), why, String(value))
  assert.match(rejectionFor({ ...GOOD_DARK, id: 'bad', term: { red: 'url(x)' } }), /terminal colour red uses url/)
  assert.match(rejectionFor({ ...GOOD_DARK, id: 'bad', chromeSymbol: '#fff;' }), /chromeSymbol/)
  // the accepted forms
  for (const v of ['#abc', '#abcd', '#aabbcc', '#aabbccdd', 'rgb(1 2 3)', 'rgba(1, 2, 3, 0.5)', 'rgb(10% 20% 30% / 50%)', 'hsl(200, 50%, 40%)', 'hsla(200deg 50% 40% / 0.3)', 'transparent', 'White'])
    assert.equal(socket.valueProblem(v), null, v)
  assert.equal(socket.canonicalColour(socket.parseColour('#aabbccdd')), 'rgba(170, 187, 204, 0.867)')
  assert.equal(socket.canonicalColour(socket.parseColour('hsl(0, 100%, 50%)')), '#ff0000')
})

test('shapes, ids, limits, and missing or unknown tokens', () => {
  assert.match(rejectionFor('a string'), /must be an object/)
  assert.match(rejectionFor(42), /must be an object/)
  assert.match(rejectionFor({ ...GOOD_DARK, id: 'x.dark' }), /no dots/)
  assert.match(rejectionFor({ ...GOOD_DARK, id: '../dark' }), /lowercase/)
  assert.match(rejectionFor({ ...GOOD_DARK, kind: 'sepia' }), /kind/)
  assert.match(rejectionFor({ ...GOOD_DARK, name: '' }), /name/)
  assert.match(rejectionFor({ ...GOOD_DARK, name: 'x'.repeat(41) }), /name/)
  assert.match(rejectionFor({ ...GOOD_DARK, tokens: [] }), /needs tokens/)
  assert.match(rejectionFor({ ...GOOD_DARK, tokens: Object.fromEntries(Array.from({ length: 151 }, (_, i) => [`t${i}`, '#000'])) }), /at most 150/)
  assert.match(rejectionFor({ ...GOOD_DARK, tokens: { bg: '#000', text: '#fff' } }), /missing accent/)
  // a theme id that is a built-in one's is namespaced, so it can't replace it
  let load = socket.loadThemeExtensions([sample((s) => s.theme({ ...GOOD_DARK, id: 'dark' }))], deps())
  assert.deepEqual(themes.extensionThemes().map((t) => t.id), ['sample-themes.dark'])
  assert.equal(themes.themeDef('dark').ext, undefined)
  assert.equal(themes.themeTokens('dark').bg, '#0a0c0f')
  // the same id twice: the second is turned away, the first stays
  load = socket.loadThemeExtensions([sample((s) => (s.theme(GOOD_DARK), s.theme({ ...GOOD_DARK, name: 'Again' })))], deps())
  assert.equal(themes.extensionThemes().length, 1)
  assert.match(load.rejected[0].reason, /registered twice/)
  // two extensions can both have a "night": the ids differ
  load = socket.loadThemeExtensions([good, { ...good, id: 'other-themes', name: 'Other' }], deps())
  assert.equal(themes.extensionThemes().length, 4)
  // at most 8 per extension
  load = socket.loadThemeExtensions([sample((s) => s.theme(Array.from({ length: 10 }, (_, i) => ({ ...GOOD_DARK, id: `n${i}` }))))], deps())
  assert.equal(themes.extensionThemes().length, 8)
  assert.equal(load.rejected.length, 2)
  // missing required tokens are filled from the default theme of the same kind, with a warning that names them
  load = socket.loadThemeExtensions([sample((s) => s.theme({ ...GOOD_LIGHT, tokens: { bg: '#ffffff', text: '#000000', accent: '#0050a0', 'bogus-token': '#fff', 'url(x)': '#fff' } }))], deps())
  const day = themes.themeDef('sample-themes.day')
  assert.equal(day.tokens['bg-1'], themes.themeTokens('light')['bg-1'])
  assert.ok(day.ext.warnings.some((w) => /Missing required tokens bg-1, .* filled from Light/.test(w)), day.ext.warnings.join('\n'))
  assert.ok(day.ext.warnings.some((w) => /Ignored unknown tokens: bogus-token, url\(x\)/.test(w)))
  assert.equal(day.tokens['bogus-token'], undefined)
  // a non-array, non-function export, a throwing register, and a newer API: skipped by the loader, never thrown
  quietLog.length = 0
  load = socket.loadThemeExtensions(
    [
      { id: 'no-register', name: 'No register', api: 1 },
      sample(() => {
        throw new Error('broken file')
      }),
      { ...good, id: 'too-new', api: 9 },
      null
    ],
    deps()
  )
  assert.deepEqual(load.results.map((r) => r.state), ['skipped', 'failed', 'skipped', 'skipped'])
  assert.equal(themes.extensionThemes().length, 0)
  assert.ok(quietLog.length >= 4, 'each is in the crash log')
  assert.doesNotThrow(() => socket.loadThemeExtensions('not an array', deps()))
  assert.match(socket.rejectionNotice({ results: [{ id: 'x', name: 'X' }], rejected: [{ owner: 'x', theme: 'bad', reason: 'R.' }] }), /bad from X \(R\.\)/)
})

test('a poor theme gets contrast and status-colour warnings, but still registers', () => {
  const poor = {
    id: 'murky',
    name: 'Murky',
    kind: 'dark',
    tokens: { ...GOOD_DARK.tokens, text: '#444455', 'text-2': '#333344', accent: '#cc4444', warn: '#cc4646', danger: '#cc4444', 'accent-ink': '#cc4444', 'crow-body': '#101020' },
    term: { background: '#101020', foreground: '#202030' }
  }
  socket.loadThemeExtensions([sample((s) => s.theme(poor))], deps())
  const t = themes.themeDef('sample-themes.murky')
  assert.equal(t.ext.lowContrast, true)
  const w = t.ext.warnings.join('\n')
  assert.match(w, /Body text on the background is \d\.\d:1/)
  assert.match(w, /Secondary text on panels/)
  assert.match(w, /Button text on the accent/)
  assert.match(w, /terminal text/)
  assert.match(w, /working and idle \(accent\) and needs you \(warn\)/)
  assert.match(w, /needs you \(warn\) and error \(danger\)/)
  assert.match(w, /crow blends into the background/)
  // the maths
  assert.equal(Math.round(socket.contrastRatio(socket.parseColour('#000'), socket.parseColour('#fff')) * 10) / 10, 21)
  assert.ok(socket.deltaE(socket.parseColour('#ff0000'), socket.parseColour('#00ff00')) > 100)
})

test('extreme palettes: every token, the terminal and the crow rim inputs stay plain colours', () => {
  const extremes = [
    { id: 'pure-black', kind: 'dark', tokens: { bg: '#000', text: '#fff', accent: '#0f0' } },
    { id: 'pure-white', kind: 'light', tokens: { bg: '#fff', text: '#000', accent: '#00f' } },
    { id: 'neon', kind: 'dark', tokens: { bg: 'hsl(300, 100%, 10%)', text: 'hsl(60, 100%, 70%)', accent: 'rgb(0 255 255)' } }
  ].map((t) => ({ ...t, name: t.id }))
  socket.loadThemeExtensions([sample((s) => s.theme(extremes))], deps())
  for (const t of extremes) {
    const id = `sample-themes.${t.id}`
    const k = themes.themeTokens(id)
    for (const [n, v] of Object.entries(k)) assert.equal(socket.valueProblem(v), null, `${id} ${n}=${v}`)
    // the crow's rim code only takes #rrggbb backgrounds
    assert.match(k.bg, /^#[0-9a-f]{6}$/)
    const term = themes.termPalette(id)
    for (const v of Object.values(term)) assert.ok(socket.parseColour(v), `${id} terminal ${v}`)
  }
})

// ---------- lifecycle ----------

test('off, removed or broken: the default theme of the same kind shows, and the pick comes back', () => {
  const p = prefs({ theme: 'sample-themes.night', themeDark: 'sample-themes.night', themeLight: 'sample-themes.day' })
  const follow = { ...p, themeFollowSystem: true }
  socket.loadThemeExtensions([good], deps())
  assert.equal(themes.resolveTheme(p, false), 'sample-themes.night')
  // switched off
  socket.loadThemeExtensions([good], deps(['sample-themes']))
  assert.equal(themes.isThemeId('sample-themes.night'), false)
  assert.equal(themes.resolveTheme(p, false), 'corvid')
  assert.equal(themes.resolveTheme(follow, false), 'light')
  assert.equal(themes.resolveTheme(follow, true), 'corvid')
  assert.equal(themes.resolveTheme(prefs({ theme: 'sample-themes.day', themeLight: 'sample-themes.day' }), true), 'light', 'a light pick falls back to the light default')
  // back on: the same saved pick shows again
  socket.loadThemeExtensions([good], deps())
  assert.equal(themes.resolveTheme(p, false), 'sample-themes.night')
  // removed from the index, and broken
  socket.loadThemeExtensions([], deps())
  assert.equal(themes.resolveTheme(p, false), 'corvid')
  socket.loadThemeExtensions([sample(() => JSON.parse('{'))], deps())
  assert.equal(themes.resolveTheme(follow, false), 'light')
  // registered then thrown: what it registered goes too
  socket.loadThemeExtensions([sample((s) => (s.theme(GOOD_DARK), JSON.parse('{')))], deps())
  assert.equal(themes.isThemeId('sample-themes.night'), false)
})

test('a saved setting for a missing theme loads fine; garbage is repaired', async () => {
  socket.loadThemeExtensions([], deps())
  writeFileSync(
    join(globalThis.__userData, 'config.json'),
    JSON.stringify({ theme: 'gone-ext.night', themeLight: 'nope; } body {', themeDark: 'gone-ext.night', themeFollowSystem: false })
  )
  const { getConfig, setConfig } = await import(src + 'main/config.ts')
  const c = getConfig()
  assert.equal(c.theme, 'gone-ext.night', 'kept, to come back with its extension')
  assert.equal(c.themeLight, 'light', 'not an id at all: back to the default')
  assert.equal(themes.resolveTheme(c, true), 'corvid')
  const url = new URLSearchParams({ theme: themes.resolveTheme(c, true) }).toString()
  assert.equal(url, 'theme=corvid', 'first paint gets a theme that exists')
  assert.equal(setConfig({ theme: '<script>' }).theme, 'corvid')
  assert.equal(setConfig({ theme: 'other-ext.day' }).theme, 'other-ext.day')
})

// ---------- the tier-1 check and the guidance ----------

test('a diff that only adds a theme extension and its registration is tier 1', () => {
  const files = [
    { path: 'src/extensions/sample-themes/themes.ts', status: 'A' },
    {
      path: 'src/extensions/themeExtensions.ts',
      status: 'M',
      added: ["import sampleThemes from './sample-themes/themes'", 'export const THEME_EXTENSIONS: ExtensionModule<ThemeSockets>[] = [sampleThemes]'],
      removed: ['export const THEME_EXTENSIONS: ExtensionModule<ThemeSockets>[] = []']
    }
  ]
  assert.equal(diffShape('sample-themes', files).tier1, true)
  // the old way, an entry in the core theme data, isn't
  const core = diffShape('sample-themes', [...files, { path: 'src/shared/themes.ts', status: 'M' }])
  assert.equal(core.tier1, false)
  assert.deepEqual(core.outside, ['src/shared/themes.ts'])
  // nor is a mismatched index name
  assert.equal(
    diffShape('sample-themes', [{ ...files[1], added: ['export const THEME_EXTENSIONS: ExtensionModule<MainSockets>[] = [sampleThemes]'], removed: [] }]).tier1,
    false
  )
  assert.match(SOCKET_BUILD_GUIDANCE, /themeExtensions\.ts/)
  assert.match(SOCKET_BUILD_GUIDANCE, /tier 1/)
})
