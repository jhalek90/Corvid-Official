// Tests for #156, Cmd instead of Ctrl on macOS (src/shared/platformInfo.ts, used by src/renderer/src/keys.ts): which
// modifier a shortcut checks and how its label is written, per platform. Windows labels and keys are pinned to what
// the window showed before #156; Linux matches Windows; macOS gets Cmd and the ⌃⌥⇧⌘ symbols. Also the global hotkey
// default per platform and the Wayland note. Pure functions; no app or data folder is touched.
//
//   npm run test-keys

import { register } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    export async function resolve(s, c, next) {
      if (s.startsWith('@shared/')) return { url: ${JSON.stringify(src)} + 'shared/' + s.slice(8) + '.ts', shortCircuit: true }
      if ((s.startsWith('./') || s.startsWith('../')) && c.parentURL?.split('?')[0].endsWith('.ts') && !/\\.[a-z]+$/.test(s)) {
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
const K = await import(src + 'shared/platformInfo.ts')
const W = await import(src + 'shared/welcome.ts')

const win = K.platformInfo('win32')
const linux = K.platformInfo('linux')
const mac = K.platformInfo('darwin')
const ev = (o) => ({ ctrlKey: false, metaKey: false, ...o })

test('Windows labels are exactly the ones the window showed before #156', () => {
  const labels = ['J', 'B', 'K', 'P', 'D', '7', 'C', 'V', 'X', 'Z', 'Y', 'A'].map((k) => K.shortcutLabel(win, k))
  assert.deepEqual(labels, ['Ctrl+J', 'Ctrl+B', 'Ctrl+K', 'Ctrl+P', 'Ctrl+D', 'Ctrl+7', 'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A'])
  assert.equal(K.ctrlLabel(win, '`'), 'Ctrl+`')
  assert.equal(K.ctrlLabel(win, 'Shift+`'), 'Ctrl+Shift+`')
  assert.equal(K.shortcutLabel(win, 'Shift+Z'), 'Ctrl+Shift+Z')
  assert.equal(K.modClickLabel(win), 'Ctrl+click')
  assert.equal(win.modLabel, 'Ctrl')
})

test('Linux labels match Windows', () => {
  for (const k of ['J', 'B', 'K', 'P', 'D', 'C', 'Shift+Z']) assert.equal(K.shortcutLabel(linux, k), K.shortcutLabel(win, k))
  assert.equal(K.ctrlLabel(linux, 'Shift+`'), 'Ctrl+Shift+`')
  assert.equal(K.modClickLabel(linux), 'Ctrl+click')
})

test('macOS labels use ⌘ and the symbols in Apple order', () => {
  assert.deepEqual(['J', 'B', 'K', 'P', 'C', 'V', 'A'].map((k) => K.shortcutLabel(mac, k)), ['⌘J', '⌘B', '⌘K', '⌘P', '⌘C', '⌘V', '⌘A'])
  assert.equal(K.shortcutLabel(mac, 'Shift+Z'), '⇧⌘Z')
  assert.equal(K.shortcutLabel(mac, 'Alt+Shift+I'), '⌥⇧⌘I')
  assert.equal(K.ctrlLabel(mac, '`'), '⌃`')
  assert.equal(K.ctrlLabel(mac, 'Shift+`'), '⌃⇧`')
  assert.equal(K.modClickLabel(mac), '⌘-click')
})

test('the shortcut modifier is Ctrl on Windows and Linux, Cmd on macOS', () => {
  for (const p of [win, linux]) {
    assert.equal(K.modDown(p, ev({ ctrlKey: true })), true)
    assert.equal(K.modDown(p, ev({ metaKey: true })), false)
    assert.equal(K.otherModDown(p, ev({ metaKey: true })), true)
    assert.equal(K.otherModDown(p, ev({ ctrlKey: true })), false)
    // Windows as before: Ctrl counts whether or not the Windows key is also down
    assert.equal(K.modDown(p, ev({ ctrlKey: true, metaKey: true })), true)
  }
  assert.equal(K.modDown(mac, ev({ metaKey: true })), true)
  // Ctrl on macOS is not the shortcut modifier (Ctrl+click is a right click, Ctrl+C an interrupt)
  assert.equal(K.modDown(mac, ev({ ctrlKey: true })), false)
  assert.equal(K.otherModDown(mac, ev({ ctrlKey: true })), true)
})

test('the global hotkey default: Control+Alt+Space on Windows and Linux, Command+Shift+Space on macOS', () => {
  assert.equal(K.defaultHotkey('win32'), 'Control+Alt+Space')
  assert.equal(K.defaultHotkey('linux'), 'Control+Alt+Space')
  assert.equal(K.defaultHotkey('darwin'), 'Command+Shift+Space')
})

test('the hotkey notice is unchanged on Windows and adds the Wayland note only under Wayland', () => {
  const plain = "The hotkey Control+Alt+Space couldn't be registered (another app may have it). Pick another in Settings."
  assert.equal(K.hotkeyFailText('Control+Alt+Space', 'win32', { XDG_SESSION_TYPE: 'wayland' }), plain)
  assert.equal(K.hotkeyFailText('Control+Alt+Space', 'linux', { XDG_SESSION_TYPE: 'x11' }), plain)
  assert.match(K.hotkeyFailText('Control+Alt+Space', 'linux', { XDG_SESSION_TYPE: 'wayland' }), /^The hotkey .*couldn't be registered.*Wayland.*GlobalShortcuts portal/)
  assert.match(K.hotkeyFailText('Control+Alt+Space', 'linux', { WAYLAND_DISPLAY: 'wayland-0' }), /Wayland/)
})

test('the first-run welcome names the hotkey as before on Windows, and as Cmd on macOS', () => {
  assert.match(W.firstRunText('plain', '', 'Control+Alt+Space'), /Ctrl\+Alt\+Space/)
  const t = W.firstRunText('plain', '', 'Command+Shift+Space')
  assert.match(t, /Cmd\+Shift\+Space/)
  assert.doesNotMatch(t, /Command/)
})

test('on macOS the welcome names the window shortcuts with Cmd', () => {
  const t = W.firstRunText('terse', '', 'Command+Shift+Space', true)
  assert.equal(t, 'Welcome to Corvid. Agents page: Cmd+1. Talk to Corvid: Cmd+J. Show Corvid: Cmd+Shift+Space. Search: Cmd+K. Settings: left rail, Cmd+6.')
  assert.equal(
    W.firstRunText('terse', '', 'Control+Alt+Space'),
    'Welcome to Corvid. Agents page: Ctrl+1. Talk to Corvid: Ctrl+J. Show Corvid: Ctrl+Alt+Space. Search: Ctrl+K. Settings: left rail, Ctrl+6.'
  )
})
