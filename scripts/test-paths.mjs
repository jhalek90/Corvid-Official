// Tests for #151 (cross-platform 3/15): path keys, git and worktree paths, the drive list and the worker
// instructions on macOS and Linux, with today's Windows outputs pinned beside them. The pure parts take the
// platform as an argument (or see a stubbed process.platform), so POSIX-shaped inputs run on any machine. The last
// test is real: a temp repo where prepareBranch makes a worktree with a node_modules link and cleanUp removes it.
// Every path here is made up or in a temp folder; nothing touches Corvid's data folder or ~/.claude.
//
//   npm run test-paths

import { register } from 'node:module'
import { execFileSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test, after } from 'node:test'
import assert from 'node:assert/strict'

const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), 'corvid-paths-')))
globalThis.__paths = { userData: join(tmp, 'data'), appData: join(tmp, 'appdata') }
mkdirSync(globalThis.__paths.userData, { recursive: true })
const src = pathToFileURL(join(import.meta.dirname, '..', 'src') + '/').href
register(
  'data:text/javascript,' +
    encodeURIComponent(`
    const fake = 'data:text/javascript,' + encodeURIComponent('export const app = { getPath: (n) => globalThis.__paths[n] ?? globalThis.__paths.userData }; export const safeStorage = { isEncryptionAvailable: () => false }')
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

const K = await import(src + 'shared/pathKeys.ts')
const P = await import(src + 'main/platform/index.ts')
const { normKey, within, skipReason } = await import(src + 'shared/projectList.ts')
const { projectKey } = await import(src + 'shared/projects.ts')
const G = await import(src + 'main/git.ts')
const A = await import(src + 'main/agentGit.ts')
const { listDrives } = await import(src + 'main/files.ts')
const words = await import(src + 'main/platform/agentWords.ts')
const { branchPrompt } = await import(src + 'main/gitTools.ts')

after(() => rmSync(tmp, { recursive: true, force: true }))

/** Run fn with process.platform stubbed, the way normKey and projectKey see the machine they run on. */
function as(platform, fn) {
  const was = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { ...was, value: platform })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', was)
  }
}

// ---------- path keys ----------

test('win32 keys are today\'s, whatever machine runs this', () => {
  const cases = [
    ['D:\\projects\\dashboard', 'd:\\projects\\dashboard'],
    ['D:/Projects/Dashboard/', 'd:\\projects\\dashboard'],
    ['C:\\', 'c:'],
    ['\\\\server\\share\\Repo', '\\\\server\\share\\repo'],
    ['', '']
  ]
  for (const [input, key] of cases) {
    assert.equal(K.pathKey(input, 'win32'), key)
    assert.equal(as('win32', () => normKey(input)), key)
    // projectKey keeps the separators as written on Windows, as before
    assert.equal(as('win32', () => projectKey(input)), input.replace(/[\\/]+$/, '').toLowerCase())
  }
  assert.equal(K.within('d:\\a\\b', 'd:\\a', 'win32'), true)
  assert.equal(K.within('d:\\a-b', 'd:\\a', 'win32'), false)
  assert.equal(K.within('c:\\x', 'c:', 'win32'), true)
  assert.equal(as('win32', () => within('d:\\a\\b', 'd:\\a')), true)
  assert.equal(P.pathKey, K.pathKey, 'the platform layer re-exports the shared pathKey')
  assert.equal(P.within, K.within)
})

test('macOS keys keep / and fold case; Linux keys keep case', () => {
  assert.equal(K.pathKey('/Users/X/Repo/', 'darwin'), '/users/x/repo')
  assert.equal(K.pathKey('/home/x/Repo//', 'linux'), '/home/x/Repo')
  assert.equal(K.pathKey('/', 'linux'), '/')
  assert.equal(K.pathKey('', 'linux'), '')
  assert.equal(K.pathKey('/home/a\\b', 'linux'), '/home/a\\b', 'a backslash is a file name character on POSIX')
  assert.equal(as('darwin', () => normKey('/Users/X/Repo')), '/users/x/repo')
  assert.equal(as('linux', () => normKey('/home/X/Repo/')), '/home/X/Repo')
  assert.equal(as('linux', () => normKey('/home/x/repo')) === as('linux', () => normKey('/home/x/Repo')), false)
  assert.equal(as('darwin', () => projectKey('/Users/X/Repo/')), '/users/x/repo')
  assert.equal(as('linux', () => projectKey('/home/X/Repo/')), '/home/X/Repo')
  assert.equal(as('freebsd', () => normKey('/home/X')), '/home/X', 'other unixes count as Linux')
})

test('within on POSIX uses / and treats the root as containing everything', () => {
  assert.equal(K.within('/home/x/repo/src', '/home/x/repo', 'linux'), true)
  assert.equal(K.within('/home/x/repo', '/home/x/repo', 'linux'), true)
  assert.equal(K.within('/home/x/repo-worktrees/a', '/home/x/repo', 'linux'), false)
  assert.equal(K.within('/home/x/repo\\src', '/home/x/repo', 'linux'), false)
  assert.equal(K.within('/home/x', '/', 'darwin'), true)
  assert.equal(K.within('/home/x', '', 'linux'), false)
  assert.equal(as('linux', () => within('/home/x/repo/src', '/home/x/repo')), true)
})

test('samePath compares what git prints', () => {
  assert.equal(K.samePath('D:/projects/dashboard\n', 'd:\\Projects\\Dashboard\\', 'win32'), true)
  assert.equal(K.samePath('/Users/x/Repo', '/users/x/repo/', 'darwin'), true)
  assert.equal(K.samePath('/home/x/Repo', '/home/x/repo', 'linux'), false)
  assert.equal(K.samePath(' /home/x/repo\n', '/home/x/repo/', 'linux'), true)
})

test('the window finds its platform through the preload when it has no process.platform', () => {
  globalThis.api = { platform: { os: 'darwin' } }
  try {
    assert.equal(as(undefined, () => K.hostOs()), 'darwin')
    assert.equal(as(undefined, () => normKey('/Users/X')), '/users/x')
  } finally {
    delete globalThis.api
  }
  assert.equal(as(undefined, () => K.hostOs()), 'win32', 'nothing known: Windows, as before')
})

// ---------- the import's skip rules ----------

const cand = (path, extra = {}) => ({ path, name: 'x', exists: true, isRepo: true, sessions: 3, corvidSessions: 0, ...extra })

test('skip rules on Windows are unchanged', () => {
  const env = { os: 'win32', tempDirs: ['C:\\Users\\x\\AppData\\Local\\Temp'], dataDirs: ['C:\\Users\\x\\AppData\\Roaming\\Corvid'] }
  assert.equal(skipReason(cand('C:\\Users\\x\\AppData\\Local\\Temp\\abc'), env), 'Temporary or scratchpad folder')
  assert.equal(skipReason(cand('D:\\work\\scratchpad'), env), 'Temporary or scratchpad folder')
  assert.equal(skipReason(cand('D:\\x\\Temp\\claude\\y'), env), 'Temporary or scratchpad folder')
  assert.equal(skipReason(cand('C:/Users/x/AppData/Roaming/Corvid/assistant'), env), "Corvid assistant's working folder")
  assert.equal(skipReason(cand('C:\\Users\\x\\AppData\\Roaming\\Corvid'), env), "Corvid's own data folder")
  assert.equal(skipReason(cand('D:\\projects\\dashboard'), env), null)
})

test('skip rules on macOS: tmpdir and its /private realpath, data folder, assistant', () => {
  const env = { os: 'darwin', tempDirs: P.tempDirs('darwin', {}, '/var/folders/ab/xy/T'), dataDirs: ['/Users/x/Library/Application Support/Corvid'] }
  assert.deepEqual(env.tempDirs, ['/var/folders/ab/xy/T', '/private/var/folders/ab/xy/T'])
  assert.equal(skipReason(cand('/var/folders/ab/xy/T/claude/abc'), env), 'Temporary or scratchpad folder')
  assert.equal(skipReason(cand('/private/var/folders/ab/xy/T/abc'), env), 'Temporary or scratchpad folder')
  assert.equal(skipReason(cand('/Users/x/work/scratchpad'), env), 'Temporary or scratchpad folder')
  assert.equal(skipReason(cand('/users/x/library/application support/corvid/assistant'), env), "Corvid assistant's working folder")
  assert.equal(skipReason(cand('/Users/x/Library/Application Support/Corvid'), env), "Corvid's own data folder")
  assert.equal(skipReason(cand('/Users/x/Code/app'), env), null)
})

test('skip rules on Linux: /tmp, data folder, case kept', () => {
  const env = { os: 'linux', tempDirs: P.tempDirs('linux', {}, '/tmp'), dataDirs: ['/home/x/.config/Corvid'] }
  assert.equal(skipReason(cand('/tmp/claude/abc'), env), 'Temporary or scratchpad folder')
  assert.equal(skipReason(cand('/home/x/.config/Corvid/assistant'), env), "Corvid assistant's working folder")
  assert.equal(skipReason(cand('/home/x/.config/Corvid/notes'), env), "Corvid's own data folder")
  assert.equal(skipReason(cand('/home/x/.config/corvid'), env), null, 'a different folder on a case-sensitive disk')
  assert.equal(skipReason(cand('/home/x/code/app'), env), null)
  assert.equal(skipReason(cand('/home/x/code/app-worktrees/task-3-x'), env), 'Git worktree of app: its sessions count under the parent project')
})

// ---------- git and worktree paths ----------

test('toNative: Windows turns / into \\ as winPath did, POSIX paths stay paths', () => {
  assert.equal(P.toNative('D:/projects/dashboard', 'win32'), 'D:\\projects\\dashboard')
  assert.equal(P.toNative('/home/u/repo', 'linux'), '/home/u/repo')
  assert.equal(P.toNative('/Users/u/repo', 'darwin'), '/Users/u/repo')
})

test('repoFacts paths from rev-parse, Windows and POSIX', () => {
  assert.deepEqual(G.repoPaths('D:/projects/dashboard', 'D:/projects/dashboard/.git', 'D:/projects/dashboard/.git', 'win32'), {
    top: 'D:\\projects\\dashboard',
    repo: 'D:\\projects\\dashboard',
    worktree: false
  })
  assert.deepEqual(
    G.repoPaths('D:/projects/dashboard-worktrees/task-1-x', 'D:/projects/dashboard/.git', 'D:/projects/dashboard/.git/worktrees/task-1-x', 'win32'),
    { top: 'D:\\projects\\dashboard-worktrees\\task-1-x', repo: 'D:\\projects\\dashboard', worktree: true }
  )
  assert.deepEqual(G.repoPaths('/home/u/repo', '/home/u/repo/.git', '/home/u/repo/.git', 'linux'), { top: '/home/u/repo', repo: '/home/u/repo', worktree: false })
  assert.deepEqual(G.repoPaths('/home/u/repo-worktrees/task-1-x', '/home/u/repo/.git', '/home/u/repo/.git/worktrees/task-1-x', 'linux'), {
    top: '/home/u/repo-worktrees/task-1-x',
    repo: '/home/u/repo',
    worktree: true
  })
})

test('mainRepo from the common git dir', () => {
  assert.equal(A.repoOfCommonDir('D:/projects/dashboard/.git\n', 'win32'), 'D:\\projects\\dashboard')
  assert.equal(A.repoOfCommonDir('/home/u/repo/.git\n', 'linux'), '/home/u/repo')
  assert.equal(A.repoOfCommonDir('/Users/u/Repo/.git', 'darwin'), '/Users/u/Repo')
  assert.equal(A.repoOfCommonDir('/srv/bare.git', 'linux'), null, 'a bare repo has no main folder')
  assert.equal(A.repoOfCommonDir('', 'linux'), null)
})

test('git worktree list, Windows and POSIX', () => {
  const out = (a, b) => `worktree ${a}\nHEAD 1111\nbranch refs/heads/main\n\nworktree ${b}\nHEAD 2222\nbranch refs/heads/task-7-x\n\n`
  assert.deepEqual(A.parseWorktrees(out('D:/p/repo', 'D:/p/repo-worktrees/task-7-x'), 'win32'), [
    { path: 'D:\\p\\repo', branch: 'main' },
    { path: 'D:\\p\\repo-worktrees\\task-7-x', branch: 'task-7-x' }
  ])
  assert.deepEqual(A.parseWorktrees(out('/home/u/repo', '/home/u/repo-worktrees/task-7-x'), 'linux'), [
    { path: '/home/u/repo', branch: 'main' },
    { path: '/home/u/repo-worktrees/task-7-x', branch: 'task-7-x' }
  ])
})

test('the moved-repo check compares the worktree link with the git dir', () => {
  assert.equal(A.linksElsewhere('D:/p/repo/.git/worktrees/t', 'D:/p/repo/.git', 'win32'), false)
  assert.equal(A.linksElsewhere('d:/P/Repo/.git/worktrees/t', 'D:\\p\\repo\\.git', 'win32'), false)
  assert.equal(A.linksElsewhere('D:/old/repo/.git/worktrees/t', 'D:/p/repo/.git', 'win32'), true)
  assert.equal(A.linksElsewhere('/home/u/repo/.git/worktrees/t', '/home/u/repo/.git', 'linux'), false)
  assert.equal(A.linksElsewhere('/home/u/old/.git/worktrees/t', '/home/u/repo/.git', 'linux'), true)
  assert.equal(A.linksElsewhere('/home/u/Repo/.git/worktrees/t', '/home/u/repo/.git', 'linux'), true, 'case counts on Linux')
  assert.equal(A.linksElsewhere('/Users/u/Repo/.git/worktrees/t', '/Users/u/repo/.git', 'darwin'), false)
})

// ---------- the drive list ----------

test('drives: mounted volumes on macOS and Linux, never the startup disk twice', async () => {
  const dirs = { '/Volumes': ['Macintosh HD', 'USB', '.Trashes'], '/media/sam': ['DISK'], '/mnt': ['c', 'wsl'] }
  const list = async (d) => {
    if (!dirs[d]) throw new Error('ENOENT')
    return dirs[d]
  }
  const real = async (p) => (p === '/Volumes/Macintosh HD' ? '/' : p)
  assert.deepEqual(await listDrives('darwin', {}, list, real), [
    { name: '/', path: '/', dir: true },
    { name: 'USB', path: '/Volumes/USB', dir: true }
  ])
  assert.deepEqual(await listDrives('linux', { USER: 'sam' }, list, real), [
    { name: '/', path: '/', dir: true },
    { name: 'DISK', path: '/media/sam/DISK', dir: true },
    { name: 'c', path: '/mnt/c', dir: true },
    { name: 'wsl', path: '/mnt/wsl', dir: true }
  ])
  assert.deepEqual(await listDrives('linux', {}, async () => [], real), [{ name: '/', path: '/', dir: true }])
})

// ---------- worker instructions ----------

const branch = { repo: '/home/u/repo', branch: 'task-7-x', cwd: '/home/u/repo-worktrees/task-7-x', defaultBranch: 'main', worktree: '/home/u/repo-worktrees/task-7-x', reused: false }

test('Windows workers are told exactly what they were told before', () => {
  assert.equal(words.unlinkDepsCommand('win32'), 'cmd /c rmdir node_modules')
  assert.equal(words.killByNameExamples('win32'), 'taskkill /IM, Stop-Process -Name')
  const p = branchPrompt(branch, 'win32')
  assert.ok(p.includes(`If you must change dependencies, first remove only the link with "cmd /c rmdir node_modules", then install.`))
  assert.ok(!p.includes('rm node_modules'))
})

test('POSIX workers remove the link with plain rm, and are warned off rm -rf node_modules/', () => {
  for (const os of ['darwin', 'linux']) {
    assert.equal(words.unlinkDepsCommand(os), 'rm node_modules')
    assert.equal(words.killByNameExamples(os), 'pkill, killall')
    const p = branchPrompt(branch, os)
    assert.ok(p.includes(`first remove only the link with "rm node_modules" (no -r and no trailing slash: "rm -rf node_modules/" follows the link`))
    assert.ok(!p.includes('cmd /c'))
    assert.ok(!/\brm -r[f]? node_modules"/.test(p.replace('"rm -rf node_modules/" follows', '')), 'no recursive rm is offered as the command')
  }
})

// ---------- a real worktree ----------

const gitOk = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('a real worktree with a node_modules link: made, ignored, unlinked without touching the packages, removed', { skip: !gitOk && 'git not found' }, async () => {
  for (const [k, v] of Object.entries({ GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' }))
    process.env[k] = v
  const repo = join(tmp, 'Repo')
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1\n')
  // the common folder-only rule, which a POSIX symlink slips past
  writeFileSync(join(repo, '.gitignore'), 'node_modules/\n')
  writeFileSync(join(repo, 'README.md'), 'test\n')
  const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  run(repo, 'init', '-q', '-b', 'main')
  run(repo, 'add', '-A')
  run(repo, 'commit', '-q', '-m', 'first')

  const plan = await A.prepareBranch(repo, 151, 'Paths test')
  assert.equal(plan.kind, 'branch', plan.reason)
  const b = plan.b
  assert.ok(K.samePath(b.repo, repo), `${b.repo} is ${repo}`)
  assert.ok(K.samePath(b.worktree, join(`${repo}-worktrees`, 'task-151-paths-test')), b.worktree)
  assert.equal(b.worktree, P.toNative(b.worktree), 'paths come back as the OS writes them')

  const link = join(b.worktree, 'node_modules')
  assert.ok(lstatSync(link).isSymbolicLink(), 'node_modules is a link (a junction on Windows)')
  assert.equal(readFileSync(join(link, 'pkg', 'index.js'), 'utf8'), 'module.exports = 1\n')
  assert.equal(run(b.worktree, 'status', '--porcelain').trim(), '', 'git does not list the link as new')

  assert.ok(K.samePath(await A.mainRepo(b.worktree), repo), 'mainRepo from inside the worktree')
  const facts = await G.repoFacts(b.worktree)
  assert.equal(facts.worktree, true)
  assert.ok(K.samePath(facts.repo, repo))
  assert.deepEqual(await A.staleWorktrees(repo), [])

  // what workers are told to run before installing: removes the link, never the packages behind it
  if (process.platform === 'win32') execFileSync('cmd', ['/c', 'rmdir', 'node_modules'], { cwd: b.worktree })
  else execFileSync('rm', ['node_modules'], { cwd: b.worktree })
  assert.ok(!existsSync(link), 'link removed')
  assert.ok(existsSync(join(repo, 'node_modules', 'pkg', 'index.js')), "the main folder's packages are still there")

  A.linkDeps(repo, b.worktree)
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(await A.cleanUp(b), null, 'cleanUp removes the worktree and the branch')
  assert.ok(!existsSync(b.worktree))
  assert.ok(existsSync(join(repo, 'node_modules', 'pkg', 'index.js')), 'unlinkDeps did not recurse into the packages')
  assert.equal(run(repo, 'branch', '--list', 'task-151-*').trim(), '')
})

test('a link git does not ignore gets /node_modules in the repo\'s local exclude file, once', { skip: !gitOk && 'git not found' }, async () => {
  const repo = join(tmp, 'NoRule')
  mkdirSync(join(repo, 'node_modules'), { recursive: true })
  writeFileSync(join(repo, 'README.md'), 'test\n')
  const run = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  run(repo, 'init', '-q', '-b', 'main')
  run(repo, 'add', 'README.md')
  run(repo, 'commit', '-q', '-m', 'first')
  const tree = join(tmp, 'NoRule-worktrees', 'task-9-x')
  run(repo, 'worktree', 'add', '-q', '-b', 'task-9-x', tree, 'main')
  A.linkDeps(repo, tree)
  // the POSIX branch, run here whatever the OS: git doesn't ignore node_modules yet, so it is added
  assert.equal(await A.ignoreDepsLink(tree, 'linux'), true)
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8')
  assert.ok(exclude.endsWith('/node_modules\n'), exclude)
  assert.equal(run(tree, 'status', '--porcelain').trim(), '')
  assert.equal(await A.ignoreDepsLink(tree, 'linux'), false, 'already ignored: nothing added twice')
  assert.equal(await A.ignoreDepsLink(tree, 'win32'), false, 'Windows git sees the junction as a folder')
  A.unlinkDeps(tree)
  assert.ok(existsSync(join(repo, 'node_modules')))
})
