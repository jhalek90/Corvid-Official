// Tests for #160: voice dictation stays Windows-only. The gate (voiceSupported, voiceStatusOf in the platform
// layer) runs per platform on any machine, and src/main/voice.ts is driven with process.platform swapped, a stand-in
// for electron and WebSocket, and a fake Claude config folder in a temp dir: on macOS and Linux it must not look at
// the mic setting or the credentials file, and on Windows it must do exactly what it did before. Nothing touches
// ~/.claude or the network.
//
//   npm run test-voice-platform

import { register } from 'node:module'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-voice-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
// a fake Claude config folder with a fake login, so a read of it would succeed if anything tried
process.env.CLAUDE_CONFIG_DIR = tmp
writeFileSync(join(tmp, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'fake-token-for-tests' } }))

// the fake electron's systemPreferences counts its calls
globalThis.__mic = { calls: 0, answer: 'granted' }
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const systemPreferences = { getMediaAccessStatus: () => { globalThis.__mic.calls++; return globalThis.__mic.answer } }')
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
      return /\\.ts(?:\\?|$)/.test(u) ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

// a WebSocket stand-in: records each socket opened, never connects
const sockets = []
globalThis.WebSocket = class {
  static OPEN = 1
  readyState = 0
  constructor(url, init) {
    this.url = url
    this.init = init
    sockets.push(this)
  }
  send() {}
  close() {}
  addEventListener() {}
}

const { voiceSupported, voiceStatusOf, VOICE_UNAVAILABLE } = await import(src + 'main/platform/index.ts')
const voice = await import(src + 'main/voice.ts')

const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
function as(platform, fn) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', realPlatform)
  }
}

const probe = () => {
  const calls = { mic: 0, login: 0 }
  return { calls, p: { micAccess: () => (calls.mic++, 'granted'), signedIn: () => (calls.login++, true) } }
}

test('voiceSupported: Windows only', () => {
  assert.equal(voiceSupported('win32'), true)
  assert.equal(voiceSupported('darwin'), false)
  assert.equal(voiceSupported('linux'), false)
  assert.equal(voiceSupported('freebsd'), false)
})

test('the message is short and plain', () => {
  assert.equal(VOICE_UNAVAILABLE, "Voice input isn't available on this platform yet")
})

test('voiceStatusOf on macOS and Linux calls neither probe', () => {
  for (const os of ['darwin', 'linux']) {
    const { calls, p } = probe()
    assert.deepEqual(voiceStatusOf(p, os), { supported: false, enabled: false, micDenied: false, platform: os })
    assert.deepEqual(calls, { mic: 0, login: 0 }, os)
  }
})

test('voiceStatusOf on Windows: same checks as before', () => {
  const { calls, p } = probe()
  assert.deepEqual(voiceStatusOf(p, 'win32'), { supported: true, enabled: true, micDenied: false, platform: 'win32' })
  assert.deepEqual(calls, { mic: 1, login: 1 })
  for (const [mic, denied] of [['denied', true], ['restricted', true], ['granted', false], ['not-determined', false], ['unknown', false]]) {
    assert.equal(voiceStatusOf({ micAccess: () => mic, signedIn: () => true }, 'win32').micDenied, denied, mic)
  }
  const throwing = { micAccess: () => { throw new Error('not supported') }, signedIn: () => false }
  assert.deepEqual(voiceStatusOf(throwing, 'win32'), { supported: true, enabled: false, micDenied: false, platform: 'win32' })
})

test('voice.ts voiceStatus: no mic check or credentials read off Windows', () => {
  for (const os of ['darwin', 'linux']) {
    globalThis.__mic.calls = 0
    assert.deepEqual(as(os, () => voice.voiceStatus()), { supported: false, enabled: false, micDenied: false, platform: os })
    assert.equal(globalThis.__mic.calls, 0, os)
  }
})

test('voice.ts voiceStatus on Windows reads the login and the mic setting', () => {
  globalThis.__mic.calls = 0
  globalThis.__mic.answer = 'denied'
  assert.deepEqual(as('win32', () => voice.voiceStatus()), { supported: true, enabled: true, micDenied: true, platform: 'win32' })
  assert.equal(globalThis.__mic.calls, 1)
  globalThis.__mic.answer = 'granted'
})

test('startVoice off Windows ends at once with the message and opens no socket', async () => {
  for (const os of ['darwin', 'linux']) {
    const sent = []
    let refreshed = 0
    voice.initVoice({ send: (...a) => sent.push(a), refreshLogin: async () => void refreshed++ })
    sockets.length = 0
    await as(os, () => voice.startVoice(`v-${os}`))
    assert.deepEqual(sent, [['voice:end', `v-${os}`, VOICE_UNAVAILABLE, 'unsupported']], os)
    assert.equal(sockets.length, 0, os)
    assert.equal(refreshed, 0, os)
  }
})

test('startVoice on Windows still connects with the stored login', async () => {
  const sent = []
  voice.initVoice({ send: (...a) => sent.push(a), refreshLogin: async () => {} })
  sockets.length = 0
  await as('win32', () => voice.startVoice('v-win'))
  assert.equal(sockets.length, 1)
  assert.match(sockets[0].url, /^wss:\/\/api\.anthropic\.com\/api\/ws\/speech_to_text\/voice_stream\?/)
  assert.equal(sockets[0].init.headers.Authorization, 'Bearer fake-token-for-tests')
  voice.stopVoice('v-win')
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(sent.at(-1).slice(0, 2), ['voice:end', 'v-win'])
})
