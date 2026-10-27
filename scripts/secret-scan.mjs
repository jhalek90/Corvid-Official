// Secret scan for commits. Corvid stores SSH passwords and key paths for its users, so nothing
// that looks like a credential, key or connection file may reach the repo. It also blocks what belongs in
// .gitignore (node_modules, build output, OS junk) and files over 5 MB that aren't listed in BIG_FILES_OK.
//
//   node scripts/secret-scan.mjs            scan what's staged (the pre-commit hook runs this)
//   node scripts/secret-scan.mjs --history  scan every commit on every branch, once
//
// gitleaks runs as well when it's on PATH (https://github.com/gitleaks/gitleaks). This scanner is
// the floor that works without it. A line that is a known false positive can carry
// "secret-scan: allow" to be skipped.
import { execFileSync, spawnSync } from 'node:child_process'

const history = process.argv.includes('--history')

// Files that should never be committed, whatever they contain.
const BAD_FILES = [
  /(^|\/)connections[^/]*\.json$/i,
  /(^|\/)secrets[^/]*$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /\.ppk$/i,
  /\.key$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|\/)known_hosts$/i,
  /(^|\/)\.env(\.[^/]*)?$/i
]

// Files that belong in .gitignore, not the repo: dependencies, build output, packed apps, OS junk (#184).
const UNTRACKED_FILES = [
  /(^|\/)node_modules(\/|$)/,
  /^(out|dist|release)\//,
  /\.asar$/i,
  /(^|\/)(\.DS_Store|Thumbs\.db|Desktop\.ini)$/i
]

// Files bigger than this are blocked unless listed in BIG_FILES_OK (repo paths of intended assets).
const MAX_BYTES = 5 * 1024 * 1024
const BIG_FILES_OK = []

const RULES = [
  ['private key', /-----BEGIN ([A-Z]+ )*PRIVATE KEY( BLOCK)?-----/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['GitHub token', /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/],
  ['Anthropic API key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['OpenAI-style key', /\bsk-(proj-)?[A-Za-z0-9]{32,}\b/],
  ['Slack token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['credentials in URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]+:[^\s/@'"]{3,}@[^\s'"]+/i],
  // e.g. password = "..." with a literal of 6+ characters (secret-scan: allow)
  ['hard-coded password', /\b(pass(word|wd|phrase)?|secret|api[_-]?key|token)\b["']?\s*[:=]\s*["'][^"'\s]{6,}["']/i]
]

function git(args, input) {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { encoding: 'utf8', maxBuffer: 1 << 30, input })
}

const findings = []

function scanDiff(diff, where) {
  let file = ''
  let commit = where
  for (const line of diff.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19)
    else if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '')
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      if (line.includes('secret-scan: allow')) continue
      for (const [rule, re] of RULES) if (re.test(line)) findings.push({ commit, file, rule })
    }
  }
}

// File names are checked from git's name lists, not the diff: binary files (keys, .asar) have no +++ line.
function scanPaths(list) {
  let commit = 'staged'
  for (const line of list.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 19)
    else if (!line) continue
    else if (BAD_FILES.some((r) => r.test(line))) findings.push({ commit, file: line, rule: 'file that must not be committed' })
    else if (UNTRACKED_FILES.some((r) => r.test(line))) findings.push({ commit, file: line, rule: 'dependency, build output or OS file (belongs in .gitignore)' })
  }
}

// Blobs over MAX_BYTES: what's staged, or every blob in history. Input lines are "<object> <path>".
function scanSizes(objects) {
  if (!objects.trim()) return
  for (const line of git(['cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)'], objects).split('\n')) {
    const [type, size, ...rest] = line.split(' ')
    const file = rest.join(' ')
    if (type === 'blob' && Number(size) > MAX_BYTES && !BIG_FILES_OK.includes(file))
      findings.push({ commit: history ? '' : 'staged', file, rule: `file over ${MAX_BYTES / 1024 / 1024} MB (add it to BIG_FILES_OK if it's an intended asset)` })
  }
}

if (history) {
  scanDiff(git(['log', '-p', '--all', '--no-color', '--format=commit %H']), '')
  scanPaths(git(['log', '--all', '--name-only', '--diff-filter=ACMR', '--format=commit %H']))
  scanSizes(git(['rev-list', '--objects', '--all']))
} else {
  scanDiff(git(['diff', '--cached', '--no-color', '--diff-filter=ACMR']), 'staged')
  scanPaths(git(['diff', '--cached', '--name-only', '--diff-filter=ACMR']))
  // --raw lines are ":<mode> <mode> <old> <new> <status>\t<path>"; cat-file wants "<new> <path>"
  scanSizes(git(['diff', '--cached', '--raw', '--no-abbrev', '--diff-filter=ACMR']).replace(/^:\S+ \S+ \S+ (\S+) \S+\t/gm, '$1 '))
}

const gitleaks = spawnSync('gitleaks', ['version'], { encoding: 'utf8' })
let leaksFailed = false
if (!gitleaks.error) {
  const args = history ? ['git', '--redact', '--no-banner', '.'] : ['git', '--pre-commit', '--staged', '--redact', '--no-banner', '.']
  leaksFailed = spawnSync('gitleaks', args, { stdio: 'inherit' }).status !== 0
}

if (findings.length || leaksFailed) {
  for (const f of findings) console.error(`secret-scan: ${f.rule} in ${f.file}${f.commit && f.commit !== 'staged' ? ` (commit ${f.commit})` : ''}`)
  console.error(
    history
      ? '\nsecret-scan: possible secrets or files that must not be tracked in history. Values are not printed; inspect the commits above.'
      : '\nsecret-scan: commit blocked. Remove the secret or unstage the file (git rm --cached), or mark a false positive with "secret-scan: allow".'
  )
  process.exit(1)
}
console.log(`secret-scan: clean${history ? ' (full history)' : ''}${gitleaks.error ? ' (gitleaks not installed; built-in rules only)' : ''}`)
