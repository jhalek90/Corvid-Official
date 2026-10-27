// Tests for #159, secret storage per platform: the platform check (src/main/platform/keyring.ts) for every
// safeStorage backend (dpapi, keychain, gnome_libsecret, kwallet, kwallet5, kwallet6, basic_text, unknown, none),
// and both real secret stores (connectors/store.ts, remote/store.ts) through a fake safeStorage: Linux without a
// keyring refuses to save and writes nothing, a locked keyring gives a clear error with no secret in it, and
// Windows behaves as before. Runs on Node 24's own TypeScript support; all data is fake and lives in a temp folder.
//
//   npm run test-keyring

import { register } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-keyring-'))
globalThis.__userData = join(tmp, 'data')
// what the fake safeStorage does, changed per test: whether it says it can encrypt, the Linux backend, and
// whether decrypting fails (a locked or missing keyring)
globalThis.__ss = { available: true, backend: 'gnome_libsecret', locked: false }
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      const x = (b) => Buffer.from(b.map((c) => c ^ 0x5a))
      export const app = { getPath: () => globalThis.__userData }
      export const safeStorage = {
        isEncryptionAvailable: () => globalThis.__ss.available,
        getSelectedStorageBackend: () => globalThis.__ss.backend,
        encryptString: (s) => x([...Buffer.from('fake-keyring:' + s)]),
        decryptString: (b) => {
          if (globalThis.__ss.locked) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.')
          const s = x([...b]).toString(); if (!s.startsWith('fake-keyring:')) throw new Error('bad'); return s.slice(13)
        }
      }\`)
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

const K = await import('../src/main/platform/keyring.ts')
after(() => rmSync(tmp, { recursive: true, force: true }))

const fake = (available, backend) => ({ isEncryptionAvailable: () => available, ...(backend === undefined ? {} : { getSelectedStorageBackend: () => backend }) })

// ---------- the platform check, every backend ----------

test('Windows: DPAPI when safeStorage can encrypt, otherwise refused with platform-neutral words', () => {
  assert.deepEqual(K.secretStorageStatus(fake(true), 'win32'), { available: true, backend: 'dpapi' })
  const no = K.secretStorageStatus(fake(false), 'win32')
  assert.equal(no.available, false)
  assert.equal(no.reason, K.NO_SECURE_STORAGE)
  assert.doesNotMatch(no.reason, /Windows/)
})

test('macOS: the Keychain when safeStorage can encrypt', () => {
  assert.deepEqual(K.secretStorageStatus(fake(true), 'darwin'), { available: true, backend: 'keychain' })
  assert.equal(K.secretStorageStatus(fake(false), 'darwin').available, false)
})

test('Linux: GNOME Keyring and KWallet count as a keyring', () => {
  for (const b of ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6']) assert.deepEqual(K.secretStorageStatus(fake(true, b), 'linux'), { available: true, backend: b }, b)
})

test('Linux: basic_text is refused even though safeStorage says it can encrypt', () => {
  const st = K.secretStorageStatus(fake(true, 'basic_text'), 'linux')
  assert.deepEqual(st, { available: false, backend: 'basic_text', reason: K.NO_KEYRING })
  assert.equal(
    K.NO_KEYRING,
    'No system keyring found. Install and unlock one (for example GNOME Keyring or KWallet) so Corvid can store secrets safely, then try again.'
  )
})

test('Linux: unknown, empty, missing or throwing backends and an unavailable keyring are all refused', () => {
  assert.equal(K.secretStorageStatus(fake(true, 'unknown'), 'linux').available, false)
  assert.equal(K.secretStorageStatus(fake(true, ''), 'linux').backend, 'unknown')
  assert.equal(K.secretStorageStatus(fake(true), 'linux').available, false, 'no getSelectedStorageBackend at all')
  const throws = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => { throw new Error('not ready') } }
  assert.equal(K.secretStorageStatus(throws, 'linux').available, false)
  assert.equal(K.secretStorageStatus(fake(false, 'gnome_libsecret'), 'linux').reason, K.NO_KEYRING, 'a keyring that is there but not usable')
  const broken = { isEncryptionAvailable: () => { throw new Error('boom') } }
  assert.equal(K.secretStorageStatus(broken, 'win32').available, false)
  assert.equal(K.secretStorageStatus(fake(true, 'basic_text'), 'freebsd').available, false, 'other unixes are treated as Linux')
})

test('read errors are plain, per platform, and never carry a value', () => {
  assert.match(K.secretReadError({ available: false, backend: 'basic_text' }, 'linux'), /keyring is available, or it is locked/)
  assert.match(K.secretReadError({ available: false, backend: 'dpapi' }, 'win32'), /system secure storage is not available right now/)
  assert.match(K.secretReadError({ available: true, backend: 'dpapi' }, 'win32'), /Set it again/)
})

// ---------- both real stores through the fake safeStorage ----------

const SECRET = 'not-a-real-secret-' + 'k3yr1ng' // a made-up value for the leak search (secret-scan: allow)
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
/** Runs fn as if on `platform`, with the fake keyring set to `ss`. */
function as(platform, ss, fn) {
  Object.defineProperty(process, 'platform', { ...realPlatform, value: platform })
  const before = globalThis.__ss
  globalThis.__ss = { available: true, backend: 'unknown', locked: false, ...ss }
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', realPlatform)
    globalThis.__ss = before
  }
}
const dataFiles = () => {
  const out = []
  for (const f of [join(tmp, 'data', 'connections', 'secrets.json'), join(tmp, 'data', 'remote', 'secrets.json')]) if (existsSync(f)) out.push(readFileSync(f, 'utf8'))
  return out.join('\n')
}

const remoteStore = await import('../src/main/remote/store.ts')
const store = await import('../src/main/connectors/store.ts')
const secure = await import('../src/main/secureStorage.ts')
remoteStore.initStore()
store.initConnectorStore({ projectIdForPath: () => undefined, remoteSystems: remoteStore.listSystems, remoteSecret: remoteStore.getSecret })
const conn = store.saveConnection({ connectorId: 'http-api', name: 'shop-api', config: { base_url: 'https://api.example.com/v1', auth: 'header' }, projectIds: [] })
const server = (extra = {}) => ({ name: 'box', host: 'box.example.test', port: 22, user: 'ops', auth: 'password', projects: [], safety: 'strict', ...extra })

test('Linux without a keyring: a connection secret is refused and nothing is written', () => {
  for (const backend of ['basic_text', 'unknown']) {
    assert.throws(() => as('linux', { backend }, () => store.setSecret(conn.id, 'api_key', SECRET)), { message: K.NO_KEYRING })
    assert.equal(store.view(store.getConnection(conn.id)).secretsSet.api_key, false)
  }
  assert.doesNotMatch(dataFiles(), new RegExp(SECRET))
  assert.equal(as('linux', { backend: 'basic_text' }, () => store.connectionsState().secretStorage.reason), K.NO_KEYRING)
})

test('Linux without a keyring: an SSH password is refused and the server is not saved', () => {
  assert.throws(() => as('linux', { backend: 'basic_text' }, () => remoteStore.saveSystem(server({ password: SECRET }))), { message: K.NO_KEYRING }) // a made-up value (secret-scan: allow)
  assert.equal(remoteStore.listSystems().length, 0)
  assert.doesNotMatch(dataFiles(), new RegExp(SECRET))
  assert.throws(() => as('linux', { backend: 'basic_text' }, () => secure.encryptSecret(SECRET)), { message: K.NO_KEYRING })
})

test('Linux with GNOME Keyring or KWallet: secrets save encrypted and read back', () => {
  as('linux', { backend: 'gnome_libsecret' }, () => store.setSecret(conn.id, 'api_key', SECRET))
  assert.equal(as('linux', { backend: 'kwallet6' }, () => store.secretValue(store.getConnection(conn.id), 'api_key')), SECRET)
  const sys = as('linux', { backend: 'kwallet5' }, () => remoteStore.saveSystem(server({ password: SECRET + '-ssh' }))) // a made-up value (secret-scan: allow)
  assert.equal(as('linux', { backend: 'gnome_libsecret' }, () => remoteStore.getSecret(sys.id, 'password')), SECRET + '-ssh')
  assert.doesNotMatch(dataFiles(), new RegExp(SECRET), 'never in plain text on disk')
})

test('a locked or missing keyring: reading gives a clear error, no crash, and the secret is in no message', () => {
  const sys = remoteStore.listSystems()[0]
  const c = store.getConnection(conn.id)
  as('linux', { backend: 'basic_text', locked: true }, () => {
    assert.equal(store.secretValue(c, 'api_key'), undefined)
    const problem = store.secretProblem(c, 'api_key')
    assert.match(problem, /could not be read: no system keyring is available, or it is locked/)
    assert.throws(() => remoteStore.getSecret(sys.id, 'password'), (e) => /keyring/.test(e.message) && !e.message.includes(SECRET))
    assert.deepEqual(remoteStore.allSecretValues(), [], 'the scrubber list skips what it cannot read')
    assert.deepEqual(store.allConnectionSecrets(), [])
  })
  as('linux', { backend: 'gnome_libsecret' }, () => {
    assert.equal(store.secretProblem(c, 'api_key'), undefined, 'unlocked again: reads fine')
    assert.equal(store.secretValue(c, 'api_key'), SECRET)
  })
})

test('Windows unchanged: DPAPI saves and reads; no secure storage refuses with neutral words', () => {
  const c = store.getConnection(conn.id)
  as('win32', { available: true }, () => store.setSecret(conn.id, 'api_key', SECRET + '-win'))
  assert.equal(as('win32', { available: true }, () => store.secretValue(c, 'api_key')), SECRET + '-win')
  assert.equal(as('win32', { available: true }, () => store.connectionsState().secretStorage.available), true)
  assert.throws(() => as('win32', { available: false }, () => store.setSecret(conn.id, 'api_key', 'x')), { message: K.NO_SECURE_STORAGE })
  assert.equal(as('win32', { available: true }, () => store.secretValue(c, 'api_key')), SECRET + '-win', 'the refused save left the old one')
  // clearing needs no keyring
  as('linux', { backend: 'basic_text' }, () => store.setSecret(conn.id, 'api_key', null))
  assert.equal(store.view(store.getConnection(conn.id)).secretsSet.api_key, false)
})
