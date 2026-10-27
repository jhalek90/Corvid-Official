// Tests for #168, the ssh connector's upload operation: what may be sent (inside the worker's worktree or scratchpad
// after links are followed, nothing the deny rules cover, no key files or secrets, plain files under the size cap),
// the overwrite flag, the approval text, the audit line, and real uploads to a fake SFTP server on localhost, the
// kill switch included. Runs on Node 24's own TypeScript support with a stand-in for electron; all data is fake and
// lives in a temp folder.
//
//   npm run test-upload

import { register, createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = mkdtempSync(join(tmpdir(), 'corvid-upload-'))
globalThis.__userData = join(tmp, 'data')
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent(\`
      const x = (b) => Buffer.from(b.map((c) => c ^ 0x5a))
      export const app = { getPath: () => globalThis.__userData }
      export const safeStorage = {
        isEncryptionAvailable: () => true,
        getSelectedStorageBackend: () => 'gnome_libsecret', // read on Linux only: a real keyring, so platform/keyring.ts lets secrets be saved
        encryptString: (s) => x([...Buffer.from('fake-dpapi:' + s)]),
        decryptString: (b) => { const s = x([...b]).toString(); if (!s.startsWith('fake-dpapi:')) throw new Error('bad'); return s.slice(11) }
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
      return u.endsWith('.ts') ? next(u, { ...c, format: 'module-typescript' }) : next(u, c)
    }`)
)

const up = await import('../src/main/connectors/upload.ts')
const { denyRules } = await import('../src/main/agentDeny.ts')

const SECRET = 'Planted-Fake-Secret-4410' // a made-up value (secret-scan: allow)
const data = globalThis.__userData
const proj = join(tmp, 'projects', 'shop')
const worktree = join(tmp, 'worktrees', 'task-1')
const scratch = join(tmp, 'pad', 'scratchpad')
const outside = join(tmp, 'elsewhere')
const home = join(tmp, 'home')
for (const d of [data, proj, worktree, scratch, outside, join(home, '.claude'), join(worktree, 'sub')]) mkdirSync(d, { recursive: true })
const put = (p, body) => (writeFileSync(p, body), p)
const sha = (b) => createHash('sha256').update(b).digest('hex')

/** a one-member ustar archive, enough for the name check */
function tarOf(name, body) {
  const h = Buffer.alloc(512)
  h.write(name, 0)
  h.write('0000644\0', 100)
  h.write(body.length.toString(8).padStart(11, '0') + '\0', 124)
  h.write('ustar\0', 257)
  const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512)
  Buffer.from(body).copy(pad)
  return Buffer.concat([h, pad, Buffer.alloc(1024)])
}

const ctx = (over = {}) => ({ roots: [worktree, scratch], rules: denyRules(proj, worktree), cwd: worktree, maxBytes: 1024, hasKnownSecret: (t) => t.includes(SECRET), home, ...over })
const plan = (local, extra = {}, over = {}) => up.planUpload({ local_path: local, remote_path: '/tmp/upload/f.txt', ...extra }, ctx(over))

test('inside the worktree or the scratchpad is fine; the plan has the size, hash and exact bytes', () => {
  const p = plan(put(join(worktree, 'sub', 'app.txt'), 'hello'))
  assert.equal(p.size, 5)
  assert.equal(p.sha256, sha('hello'))
  assert.equal(p.data.toString(), 'hello')
  assert.equal(p.overwrite, false)
  assert.equal(plan(put(join(scratch, 'bundle.tar'), tarOf('src/a.ts', 'export {}')), {}, { maxBytes: 4096 }).size, 2048, 'a tar of plain files passes')
  assert.equal(plan('sub/app.txt').local, p.local, 'a relative path is under the worktree')
})

test('outside, .., a link pointing out, the data folder and ~/.claude are refused', () => {
  const out = put(join(outside, 'x.txt'), 'x')
  assert.throws(() => plan(out), /outside your worktree and scratchpad/)
  assert.throws(() => plan(join(worktree, '..', '..', 'elsewhere', 'x.txt')), /outside your worktree/)
  // a junction needs no admin rights on Windows, and is a plain symlink elsewhere
  symlinkSync(outside, join(worktree, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => plan(join(worktree, 'link', 'x.txt')), /outside your worktree.*after following links/)
  // the data folder: even with a root that contains it, the deny rules refuse it
  const inData = put(join(data, 'connections.json'), '{}')
  assert.throws(() => plan(inData, {}, { roots: [tmp] }), /deny rule .*data/)
  const claude = put(join(home, '.claude', 'settings.json'), '{}')
  assert.throws(() => plan(claude, {}, { roots: [home] }), /never uploaded/)
  assert.throws(() => plan(join(worktree, 'missing.txt')), /does not exist/)
  assert.throws(() => plan(put(join(worktree, 'a.txt'), 'a'), {}, { roots: [] }), /knows neither/)
})

test('rules, home and cwd spelled through a link still cover the real file', () => {
  // the same mismatch as a CI runner's 8.3 TEMP (C:\Users\RUNNER~1\...) or macOS's /var -> /private/var
  const type = process.platform === 'win32' ? 'junction' : 'dir'
  const dataLink = join(tmp, 'data-link')
  const homeLink = join(tmp, 'home-link')
  symlinkSync(data, dataLink, type)
  symlinkSync(home, homeLink, type)
  const inData = put(join(data, 'secrets.json'), '{}')
  globalThis.__userData = dataLink
  try {
    assert.throws(() => plan(inData, {}, { roots: [tmp] }), /deny rule .*data/)
  } finally {
    globalThis.__userData = data
  }
  const claude = put(join(home, '.claude', 'other.json'), '{}')
  assert.throws(() => plan(claude, {}, { roots: [tmp], home: homeLink }), /never uploaded/)
})

test('key files, secrets, folders and too-big files are refused', () => {
  assert.throws(() => plan(put(join(worktree, '.env'), 'X=1')), /deny rule \*\*\/\.env/)
  assert.throws(() => plan(put(join(worktree, 'server.pem'), 'x')), /deny rule|named like/)
  assert.throws(() => plan(put(join(worktree, 'k.txt'), '-----BEGIN ' + 'OPENSSH PRIVATE KEY-----\nabc')), /a private key/)
  assert.throws(() => plan(put(join(worktree, 'c.txt'), 'password = "' + 'Zx81-Fake-Only' + '"')), /a hard-coded password/)
  // the commit scan's rule, not the notes' looser one: prose like this in docs and source is fine
  assert.ok(plan(put(join(worktree, 'doc.md'), 'A missing required token: filled from the default theme (2 of them)')))
  assert.throws(() => plan(put(join(worktree, 'known.txt'), `x ${SECRET} y`)), /saved in Corvid|looks like/)
  assert.ok(plan(put(join(worktree, 'ok.txt'), `token = "abc123!x" // secret-scan: allow`)), 'the commit scan marker is honoured')
  assert.throws(() => plan(put(join(scratch, 'b.tar.gz'), gzipSync(tarOf('repo/.env', 'A=1')))), /archive holds repo\/\.env/)
  assert.throws(() => plan(put(join(scratch, 'c.tgz'), gzipSync(Buffer.from('id: -----BEGIN ' + 'RSA PRIVATE KEY-----')))), /private key/)
  assert.throws(() => plan(join(worktree, 'sub')), /not a plain file/)
  assert.throws(() => plan(put(join(worktree, 'big.bin'), Buffer.alloc(1025))), /over the 1.0 KB upload limit/)
})

test('remote_path, overwrite and mode are checked', () => {
  const f = put(join(worktree, 'm.txt'), 'm')
  for (const r of ['tmp/x', '/tmp/dir/', '/tmp/../etc/passwd', '/tmp/a\nb', ''])
    assert.throws(() => up.planUpload({ local_path: f, remote_path: r }, ctx()), /remote_path/)
  assert.throws(() => plan(f, { overwrite: 'yes' }), /overwrite must be true or false/)
  assert.equal(plan(f, { overwrite: true }).overwrite, true)
  assert.equal(plan(f, { mode: '0640' }).mode, 0o640)
  for (const m of ['4755', '0999', 'rwx', '777777']) assert.throws(() => plan(f, { mode: m }), /mode must be/)
})

test('the approval text and the audit line: path, size, hash, never content', () => {
  const p = plan(put(join(worktree, 'note.txt'), 'some content'), { overwrite: true, mode: '644' })
  assert.equal(up.shownUpload(p), `upload ${p.local} (12 bytes, sha256 ${p.sha256.slice(0, 12)}) to /tmp/upload/f.txt, mode 0644, replacing it if it exists`)
  assert.match(up.auditUpload(p), new RegExp(`sha256 ${p.sha256}\\) to /tmp/upload/f\\.txt \\(overwrite\\)$`))
  assert.ok(!up.auditUpload(p).includes('some content'))
  assert.equal(up.fmtSize(2.5 * 1024 * 1024), '2.5 MB')
})

test('deny-rule paths read the same way Claude Code does, on every platform', () => {
  const win = { home: 'C:\\Users\\me', cwd: 'D:\\w', platform: 'win32' }
  assert.ok(up.ruleCovers('//c/Users/me/AppData/Roaming/Corvid/**', 'C:\\Users\\me\\AppData\\Roaming\\corvid\\x.json', win))
  assert.ok(up.ruleCovers('~/.ssh/**', 'C:\\Users\\me\\.ssh\\id', win))
  assert.ok(up.ruleCovers('**/.env', 'D:\\w\\a\\.env', win))
  assert.ok(up.ruleCovers('./config/secret.txt', 'D:\\w\\config\\secret.txt', win))
  assert.ok(!up.ruleCovers('**/.env', 'D:\\w\\a\\.env.example.md\\x', win))
  const lin = { home: '/home/me', cwd: '/w', platform: 'linux' }
  assert.ok(up.ruleCovers('//home/me/.config/Corvid/**', '/home/me/.config/Corvid/a/b', lin))
  assert.ok(!up.ruleCovers('//home/me/.config/Corvid/**', '/home/me/.config/corvid/a', lin), 'Linux keeps case')
  assert.ok(up.ruleCovers('//home/me/repo \\[old\\]/**/.env', '/home/me/repo [old]/x/.env', lin), 'escaped brackets are literal')
  assert.equal(up.scratchpadDir('D:\\projects\\dash', 'ab-12', 'C:\\T'), join('C:\\T', 'claude', 'D--projects-dash', 'ab-12', 'scratchpad'))
  assert.equal(up.scratchpadDir('/w', '../x'), undefined)
})

// ---------- real uploads to a fake SFTP server ----------

const require = createRequire(import.meta.url)
const { Server, utils } = require('ssh2')
const { OPEN_MODE, STATUS_CODE } = utils.sftp
const hostKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey
/** the server's files: path -> { data, mode } */
const files = new Map()
const dirs = new Set(['/tmp', '/tmp/upload', '/tmp/upload/adir'])
let hold = null
const server = new Server({ hostKeys: [hostKey] }, (client) => {
  client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === SECRET ? ctx.accept() : ctx.reject(['password'])))
  client.on('session', (accept) =>
    accept().on('sftp', (acc) => {
      const s = acc()
      const handles = new Map()
      let n = 0
      const attrs = (f) => ({ mode: f.mode | 0o100000, uid: 0, gid: 0, size: f.data.length, atime: 0, mtime: 0 })
      s.on('STAT', (id, p) => (files.has(p) ? s.attrs(id, attrs(files.get(p))) : dirs.has(p) ? s.attrs(id, { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 }) : s.status(id, STATUS_CODE.NO_SUCH_FILE)))
      s.on('OPEN', (id, p, flags, a) => {
        if ((flags & OPEN_MODE.EXCL) && files.has(p)) return s.status(id, STATUS_CODE.FAILURE)
        const prev = files.get(p)
        files.set(p, { data: Buffer.alloc(0), mode: prev?.mode ?? (a?.mode ?? 0o666) & ~0o022 })
        const h = Buffer.from(String(++n))
        handles.set(h.toString(), p)
        s.handle(id, h)
      })
      s.on('WRITE', (id, h, offset, chunk) => {
        const go = () => {
          const f = files.get(handles.get(h.toString()))
          const end = offset + chunk.length
          if (f.data.length < end) f.data = Buffer.concat([f.data, Buffer.alloc(end - f.data.length)])
          chunk.copy(f.data, offset)
          s.status(id, STATUS_CODE.OK)
        }
        if (hold) hold.push(go)
        else go()
      })
      s.on('CLOSE', (id) => s.status(id, STATUS_CODE.OK))
      s.on('SETSTAT', (id, p, a) => {
        if (files.has(p) && a.mode !== undefined) files.get(p).mode = a.mode & 0o7777
        s.status(id, STATUS_CODE.OK)
      })
    })
  )
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
after(() => {
  server.close()
  rmSync(tmp, { recursive: true, force: true })
})

const xor = (s) => Buffer.from([...Buffer.from('fake-dpapi:' + s)].map((c) => c ^ 0x5a)).toString('base64')
mkdirSync(join(data, 'remote'), { recursive: true })
writeFileSync(join(data, 'remote', 'connections.json'), JSON.stringify({ systems: [{ id: 'sys-1', name: 'fake-box', host: '127.0.0.1', port, user: 'tester', auth: 'password', projects: [proj], safety: 'free', createdAt: 1, updatedAt: 2 }] }))
writeFileSync(join(data, 'remote', 'secrets.json'), JSON.stringify({ 'sys-1': { password: xor(SECRET) } }))

const remoteStore = await import('../src/main/remote/store.ts')
const remote = await import('../src/main/remote/index.ts')
const store = await import('../src/main/connectors/store.ts')
const connectors = await import('../src/main/connectors/index.ts')
const projectIdForPath = (p) => (p.toLowerCase() === proj.toLowerCase() ? 'p1' : undefined)
remote.initRemote({ changed: () => {}, approvalRequested: () => {} })
store.initConnectorStore({ projectIdForPath, remoteSystems: remoteStore.listSystems, remoteSecret: remoteStore.getSecret })
connectors.initConnectors({ projectIdForPath, changed: () => {} })
const agent = { project: proj, agent: 'worker #1', cwd: worktree, uploadRoots: () => [worktree, scratch] }
const send = (local, remote_path, extra = {}) => connectors.call(agent, 'fake-box', 'upload', { local_path: local, remote_path, ...extra })

test('upload, the hash matches the server copy; an existing file is refused; overwrite replaces it', async () => {
  const body = Buffer.concat([Buffer.from('v1 '), Buffer.alloc(200_000, 7)])
  const f = put(join(scratch, 'payload.bin'), body)
  const r = await send(f, '/tmp/upload/payload.bin', { mode: '0640' })
  assert.equal(r.bytes, body.length)
  assert.equal(r.sha256, sha(body))
  assert.equal(sha(files.get('/tmp/upload/payload.bin').data), r.sha256, 'what the server holds is what was hashed')
  assert.equal(files.get('/tmp/upload/payload.bin').mode, 0o640)
  assert.equal(r.replaced, false)
  assert.match(r.check, /^sha256sum '\/tmp\/upload\/payload\.bin'$/)

  put(f, 'v2')
  await assert.rejects(send(f, '/tmp/upload/payload.bin'), /already exists on the server.*overwrite: true/)
  assert.equal(sha(files.get('/tmp/upload/payload.bin').data), sha(body), 'unchanged')
  const r2 = await send(f, '/tmp/upload/payload.bin', { overwrite: true })
  assert.equal(r2.replaced, true)
  assert.equal(files.get('/tmp/upload/payload.bin').data.toString(), 'v2')
  assert.equal(files.get('/tmp/upload/payload.bin').mode, 0o640, 'replacing keeps the mode')

  await assert.rejects(send(f, '/tmp/upload/adir', { overwrite: true }), /is a folder on the server/)
  await assert.rejects(send(put(join(worktree, '.env'), 'A=1'), '/tmp/upload/e'), /deny rule/)
  assert.ok(!files.has('/tmp/upload/e'))
  await assert.rejects(connectors.call({ project: proj, agent: 'assistant' }, 'fake-box', 'upload', { local_path: f, remote_path: '/tmp/upload/z' }), /knows neither/)

  const audit = store.readCallAudit().filter((e) => e.operation === 'upload')
  assert.ok(audit.some((e) => e.decision === 'automatic' && e.request.includes(`sha256 ${sha(body)}`)))
  assert.ok(audit.some((e) => e.decision === 'refused' && /deny rule/.test(e.error)))
  assert.ok(audit.every((e) => !e.request.includes('v1 ') && !e.request.includes('A=1')), 'no content in the audit')
})

test('Strict asks first with the planned line; a decline sends nothing', async () => {
  const safety = (level) => (remoteStore.saveSystem({ ...remoteStore.getSystem('sys-1'), safety: level }), store.syncRemote())
  safety('strict')
  const f = put(join(worktree, 'strict.txt'), 'strict')
  const p = send(f, '/tmp/upload/strict.txt')
  for (let i = 0; i < 200 && !remote.listApprovals().length; i++) await new Promise((r) => setTimeout(r, 10))
  const a = remote.listApprovals()[0]
  assert.match(a.command, /^upload .*strict\.txt \(6 bytes, sha256 [0-9a-f]{12}\) to \/tmp\/upload\/strict\.txt$/)
  remote.decide(a.id, false)
  await assert.rejects(p, /declined/)
  assert.ok(!files.has('/tmp/upload/strict.txt'))
  safety('free')
})

test('the kill switch refuses an upload, and cuts one off mid-transfer', async () => {
  const f = put(join(worktree, 'k.bin'), Buffer.alloc(300_000, 1))
  connectors.switchOffAll(true)
  await assert.rejects(send(f, '/tmp/upload/k1.bin'), /switched off/)
  connectors.switchOffAll(false)
  hold = []
  const p = send(f, '/tmp/upload/k2.bin')
  for (let i = 0; i < 300 && !hold.length; i++) await new Promise((r) => setTimeout(r, 10))
  assert.ok(hold.length, 'writes reached the server')
  connectors.switchOffAll(true)
  await assert.rejects(p, /switched off/)
  connectors.switchOffAll(false)
  hold = null
  assert.ok((files.get('/tmp/upload/k2.bin')?.data.length ?? 0) < 300_000, 'the transfer did not finish')
})
