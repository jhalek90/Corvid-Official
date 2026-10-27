// Tests for #155: the window's title bar, the Dock and taskbar badge, the tray images and the electron-builder blocks
// per platform. The functions take the platform as an argument, so the win32, darwin and linux branches all run here
// on any machine. The Windows values are pinned literally: they are what main/index.ts passed before #155. The icons
// are rendered again into a temp folder and compared with resources/, so make-icons can't change Windows' icons.
//
//   npm run test-window-platform

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const root = join(import.meta.dirname, '..')
const src = pathToFileURL(join(root, 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if (s === 'electron') return { url: 'data:text/javascript,export const app = {}', shortCircuit: true }
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
        for (const ext of ['.ts', '/index.ts']) {
          try { return await next(s + ext, c) } catch {}
        }
      }
      return next(s, c)
    }
    export async function load(u, c, next) {
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const P = await import(src + 'main/platform/index.ts')
const chrome = { bg: '#10151b', symbol: '#c9d1d9' }

test('title bar: Windows keeps the hidden title bar with the coloured overlay, exactly as before', () => {
  assert.equal(P.titleBarKind('win32', {}), 'overlay')
  assert.equal(P.titleBarKind('win32', { CORVID_NATIVE_FRAME: '1' }), 'overlay')
  assert.deepEqual(P.titleBarOptions(chrome, 'overlay'), {
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#10151b', symbolColor: '#c9d1d9', height: 40 }
  })
  assert.equal(P.restylesOverlay(P.titleBarKind('win32', {})), true)
})

test('title bar: macOS gets the inset traffic lights and no overlay colours', () => {
  assert.equal(P.titleBarKind('darwin', {}), 'inset')
  assert.equal(P.titleBarKind('darwin', { CORVID_NATIVE_FRAME: '1' }), 'inset')
  const o = P.titleBarOptions(chrome, 'inset')
  assert.deepEqual(o, { titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 13 } })
  assert.equal('titleBarOverlay' in o, false)
  // setTitleBarOverlay doesn't exist on macOS: a theme switch must not call it
  assert.equal(P.restylesOverlay('inset'), false)
})

test('title bar: Linux keeps the overlay, CORVID_NATIVE_FRAME=1 falls back to the desktop frame', () => {
  assert.equal(P.titleBarKind('linux', {}), 'overlay')
  assert.equal(P.titleBarKind('freebsd', {}), 'overlay')
  assert.equal(P.titleBarKind('linux', { CORVID_NATIVE_FRAME: '0' }), 'overlay')
  assert.equal(P.titleBarKind('linux', { CORVID_NATIVE_FRAME: '1' }), 'frame')
  assert.deepEqual(P.titleBarOptions(chrome, 'frame'), {})
  assert.equal(P.restylesOverlay('frame'), false)
})

test('title bar reaches the preload as an argument, with the platform default as the fallback', () => {
  for (const k of ['overlay', 'inset', 'frame']) assert.equal(P.titleBarFromArgv(['electron', '--x', P.titleBarArg(k)], 'win32'), k)
  assert.equal(P.titleBarArg('inset'), '--corvid-titlebar=inset')
  assert.equal(P.titleBarFromArgv([], 'win32'), 'overlay')
  assert.equal(P.titleBarFromArgv(undefined, 'darwin'), 'inset')
  assert.equal(P.titleBarFromArgv(['--corvid-titlebar=bogus'], 'linux'), 'overlay')
  // the class it becomes only has styles for inset and frame, so Windows' top row is untouched
  const css = readFileSync(join(root, 'src/renderer/src/styles.css'), 'utf8')
  assert.match(css, /\.titlebar-inset \.titlebar \{\s*padding: 0 14px 0 80px;/)
  assert.match(css, /\.titlebar-frame \.titlebar \{/)
  assert.doesNotMatch(css, /\.titlebar-overlay/)
  assert.match(css, /\.titlebar \{[^}]*padding: 0 150px 0 14px;/)
})

test('needs-you badge: overlay dot on Windows, Dock dot with one bounce on macOS, a count on Linux', () => {
  assert.deepEqual(P.needsYouBadge(true, false, 'win32'), { kind: 'overlay', on: true, description: 'A session needs you' })
  assert.deepEqual(P.needsYouBadge(false, true, 'win32'), { kind: 'overlay', on: false, description: '' })
  assert.deepEqual(P.needsYouBadge(true, false, 'darwin'), { kind: 'dock', text: '•', bounce: true })
  assert.deepEqual(P.needsYouBadge(true, true, 'darwin'), { kind: 'dock', text: '•', bounce: false })
  assert.deepEqual(P.needsYouBadge(false, true, 'darwin'), { kind: 'dock', text: '', bounce: false })
  assert.deepEqual(P.needsYouBadge(true, false, 'linux'), { kind: 'count', count: 1 })
  assert.deepEqual(P.needsYouBadge(false, true, 'linux'), { kind: 'count', count: 0 })
})

test('AppUserModelId and the Start Menu shortcut are Windows only', () => {
  assert.equal(P.usesAppUserModelId('win32'), true)
  assert.equal(P.usesAppUserModelId('darwin'), false)
  assert.equal(P.usesAppUserModelId('linux'), false)
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  assert.match(index, /if \(usesAppUserModelId\(\)\) app\.setAppUserModelId\('dev\.local\.claude-dashboard'\)/)
  assert.match(index, /if \(usesAppUserModelId\(\)\) ensureStartMenuShortcut\(\)/)
  assert.equal(index.match(/setOverlayIcon\(/g)?.length, 1)
  assert.match(index, /badge\.kind === 'overlay'\) \{\s*if \(win && !win\.isDestroyed\(\)\) win\.setOverlayIcon/)
  // the Dock click shows the window, but not the activate macOS sends at launch (a --hidden start stays hidden)
  assert.match(index, /app\.on\('activate', \(\) => \{\s*if \(windowReady\) showWindow\(\)/)
  assert.match(index, /win\.once\('ready-to-show', \(\) => \{\s*windowReady = true/)
})

// a PNG's size and pixels (8-bit RGBA, filter 0, as make-icons writes them)
function readPng(file) {
  const b = readFileSync(file)
  let i = 8, w = 0, h = 0
  const idat = []
  while (i < b.length) {
    const len = b.readUInt32BE(i), type = b.toString('ascii', i + 4, i + 8), d = b.subarray(i + 8, i + 8 + len)
    if (type === 'IHDR') (w = d.readUInt32BE(0)), (h = d.readUInt32BE(4))
    if (type === 'IDAT') idat.push(d)
    i += 12 + len
  }
  const raw = inflateSync(Buffer.concat(idat))
  const px = Buffer.alloc(w * h * 4)
  for (let y = 0; y < h; y++) raw.copy(px, y * w * 4, y * (w * 4 + 1) + 1, (y + 1) * (w * 4 + 1))
  return { w, h, px }
}

test('tray images: Windows and Linux keep tray.png, macOS gets black-on-transparent templates at 16 px and @2x', () => {
  assert.deepEqual(P.trayImage('win32'), { normal: 'tray.png', alert: 'tray-alert.png' })
  assert.deepEqual(P.trayImage('linux'), { normal: 'tray.png', alert: 'tray-alert.png' })
  const mac = P.trayImage('darwin')
  assert.deepEqual(mac, { normal: 'trayTemplate.png', alert: 'tray-alertTemplate.png' })
  for (const name of [mac.normal, mac.alert]) {
    // the name must end in Template for macOS to tint it; @2x sits beside it for Retina menu bars
    assert.match(name, /Template\.png$/)
    for (const [file, size] of [[name, 16], [name.replace('.png', '@2x.png'), 32]]) {
      const { w, h, px } = readPng(join(root, 'resources', file))
      assert.deepEqual([w, h], [size, size], file)
      let ink = 0
      for (let o = 0; o < px.length; o += 4) {
        assert.deepEqual([px[o], px[o + 1], px[o + 2]], [0, 0, 0], `${file}: only black, the alpha carries the shape`)
        if (px[o + 3] > 128) ink++
      }
      assert.ok(ink > size, `${file} has a visible glyph`)
    }
  }
  const index = readFileSync(join(root, 'src/main/index.ts'), 'utf8')
  for (const f of ['tray.png', 'tray-alert.png', 'trayTemplate.png', 'tray-alertTemplate.png'])
    assert.match(index, new RegExp(`'${f.replace('.', '\\.')}': `), `index.ts maps ${f}`)
})

test('make-icons renders every icon in resources/ byte for byte (so the Windows icons are unchanged)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'corvid-icons-'))
  after(() => rmSync(tmp, { recursive: true, force: true }))
  execFileSync(process.execPath, [join(root, 'scripts/make-icons.mjs')], { cwd: tmp })
  const made = readdirSync(join(tmp, 'resources')).sort()
  assert.deepEqual(made, readdirSync(join(root, 'resources')).sort())
  for (const f of made) assert.ok(readFileSync(join(tmp, 'resources', f)).equals(readFileSync(join(root, 'resources', f))), f)
  const big = readPng(join(root, 'resources/icon-1024.png'))
  assert.deepEqual([big.w, big.h], [1024, 1024])
  // the macOS icon grid's margin: the corners and edges are transparent, the middle isn't
  assert.equal(big.px[3], 0)
  assert.equal(big.px[(512 * 1024 + 40) * 4 + 3], 0)
  assert.equal(big.px[(512 * 1024 + 512) * 4 + 3], 255)
  assert.deepEqual([readPng(join(root, 'resources/icon.png')).w, readPng(join(root, 'resources/tray.png')).w], [256, 32])
})

test('electron-builder: win unchanged, mac and linux blocks beside it, node-pty unpacked on every platform', () => {
  const b = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).build
  assert.deepEqual(b.win, { icon: 'resources/icon.png', target: 'dir' })
  assert.equal(b.appId, 'dev.local.claude-dashboard')
  assert.equal(b.productName, 'Corvid')
  assert.deepEqual(b.mac, { icon: 'resources/icon-1024.png', target: 'dir', category: 'public.app-category.developer-tools' })
  // voice is Windows-only (#160), so the app never asks for the mic on macOS
  assert.equal(b.mac.extendInfo, undefined)
  assert.deepEqual(b.linux, { icon: 'resources/icon.png', target: 'dir', category: 'Development' })
  // @lydell/node-pty-darwin-arm64, -darwin-x64, -linux-x64 ... all sit under @lydell
  assert.deepEqual(b.asarUnpack, ['resources/**', 'node_modules/@lydell/**'])
  assert.ok(b.files.includes('resources/**'))
})
