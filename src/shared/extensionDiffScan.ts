// The diff scan of an extension build (#98, docs/EXTENSIONS.md "The install pipeline"). Deterministic and text only:
// it reads the real result of the build (`git diff` of the build branch against main, parsed here) and holds it
// against what the extension declared (its packages, hosts, core areas and tier, and whether the user ticked the
// tier-3 confirmation). Anything the extension didn't declare is flagged; a change to a protected path that wasn't
// confirmed, a read of secrets or Corvid's data, or a new install script BLOCKS the merge.
//
// THESE RULES ARE NOT EXHAUSTIVE. Code can hide what it does from any fixed list (string building, aliases, indirect
// calls). The scan is one layer: the text scan (#96), the deny rules the build ran under, and the user's own review
// of the diff are the others. Every rule has a test in scripts/test-diff-scan.mjs.

import { coreArea, CORE_AREAS, isProtectedPath, type ExtensionTier } from './extensionTiers'
import { hostDeclared } from './extensionScan'
import { diffShape, REGISTRATION_FILES, SOCKETS_DIR, type ChangedFile } from '../extensions/sockets/diffShape'

export type DiffRule =
  | 'dependency'
  | 'install-script'
  | 'network-host'
  | 'network-code'
  | 'dynamic-code'
  | 'process'
  | 'write-outside'
  | 'secrets'
  | 'protected-path'
  | 'machinery'
  | 'obfuscation'
  | 'binary'
  | 'undeclared-area'

export const DIFF_RULE_WORDS: Record<DiffRule, string> = {
  dependency: 'Dependency',
  'install-script': 'Install script',
  'network-host': 'Network host',
  'network-code': 'Network code',
  'dynamic-code': 'Dynamic code',
  process: 'Runs programs',
  'write-outside': 'Writes outside the app',
  secrets: 'Secrets or Corvid data',
  'protected-path': 'Protected path',
  machinery: 'Deploy, updater or start-up',
  obfuscation: 'Encoded or obfuscated',
  binary: 'Binary or large file',
  'undeclared-area': 'Outside the declared areas'
}

export interface DiffFlag {
  rule: DiffRule
  /** block: can't be merged; flag: shown, the user acknowledges before merging */
  severity: 'block' | 'flag'
  file: string
  /** the line number in the new file, when the flag is about one line */
  line?: number
  /** what was found, in plain words */
  text: string
  /** the line itself, trimmed and cut to 160 characters */
  excerpt?: string
}

/** One file of the diff, with its added lines and their numbers in the new file. */
export interface DiffFile extends ChangedFile {
  binary?: boolean
  /** lines added, with their line number in the new file */
  lines: { n: number; text: string }[]
  /** bytes of added text */
  addedBytes: number
}

export interface DeclaredCapabilities {
  id: string
  tier: ExtensionTier
  packages: { name: string; version: string }[]
  hosts: string[]
  coreAreas: string[]
  /** the user ticked "This extension changes protected parts of Corvid" before the build */
  tier3Confirmed: boolean
}

export interface AreaSummary {
  area: string
  label: string
  files: number
  added: number
  removed: number
}

export interface DiffScanResult {
  verdict: 'clear' | 'flag' | 'block'
  flags: DiffFlag[]
  areas: AreaSummary[]
  tier1Shape: boolean
  files: string[]
  at: number
}

// ---------- parsing git output ----------

/**
 * Parses `git diff --no-color --find-renames -U0 <base>...<tip>` (the unified diff). Works without --numstat: binary
 * files show as "Binary files ... differ". Paths are repo-relative with forward slashes.
 */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let f: DiffFile | undefined
  let n = 0
  const unq = (p: string): string => p.replace(/^"|"$/g, '').replace(/^[ab]\//, '')
  for (const raw of text.split('\n')) {
    const l = raw.replace(/\r$/, '')
    const head = /^diff --git (\S+|"[^"]+") (\S+|"[^"]+")$/.exec(l)
    if (head) {
      f = { path: unq(head[2]), status: 'M', lines: [], added: [], removed: [], addedBytes: 0 }
      files.push(f)
      continue
    }
    if (!f) continue
    if (l.startsWith('new file mode')) f.status = 'A'
    else if (l.startsWith('deleted file mode')) f.status = 'D'
    else if (l.startsWith('rename from ')) {
      f.status = 'R'
      f.from = l.slice(12)
    } else if (l.startsWith('rename to ')) f.path = l.slice(10)
    else if (/^Binary files .* differ$/.test(l) || l === 'GIT binary patch') f.binary = true
    else if (l.startsWith('@@')) n = Number(/\+(\d+)/.exec(l)?.[1] ?? 0)
    else if (l.startsWith('+++') || l.startsWith('---')) continue
    else if (l.startsWith('+')) {
      f.lines.push({ n: n++, text: l.slice(1) })
      f.added!.push(l.slice(1))
      f.addedBytes += l.length
    } else if (l.startsWith('-')) f.removed!.push(l.slice(1))
    else if (l.startsWith(' ')) n++
  }
  return files
}

// ---------- the rules ----------

const DATA_FOLDER = /getPath\(\s*['"](userData|appData)['"]\s*\)|\bAPPDATA\b|corvid-dashboard|claude-dashboard|['"`]\.claude['"`/\\]|\.claude[\\/]/
const SECRET_READ = [
  { re: /\ballConnectionSecrets\b|\bconnectors[\\/]store\b|\bremote[\\/]store\b|connections\.json|secrets\.bin|\bsafeStorage\s*\.\s*decryptString\b/, why: "reads Corvid's connections or secret store" },
  { re: /\.ssh[\\/]|\bid_(rsa|ed25519|ecdsa)\b|\.aws[\\/]|\.azure[\\/]|\.kube[\\/]|\.docker[\\/]config|\.npmrc\b|\.pypirc\b|\.netrc\b|\.git-credentials\b|\.gnupg\b|\.credentials\.json\b/, why: 'reads a credential file' },
  { re: /(['"`/\\])\.env(\.[\w-]+)?['"`]|\bdotenv\b|process\.env\s*\[\s*[^\]'"]/, why: 'reads .env files or computed environment variables' }
]
const NETWORK_CODE = /\bfetch\s*\(|\bXMLHttpRequest\b|\bnew\s+WebSocket\b|\bhttps?\s*\.\s*(request|get)\s*\(|\bnet\s*\.\s*(connect|createConnection)\s*\(|\bnet\.request\b|\bfrom\s+['"](node:)?(https?|net|tls|dgram)['"]|require\(\s*['"](node:)?(https?|net|tls|dgram)['"]\s*\)|\baxios\b|\bnode-fetch\b|\bundici\b|\bsendBeacon\b|\bEventSource\b/
const URL_RE = /\b(?:https?|wss?):\/\/([a-z0-9.-]+)/gi
const DYNAMIC = [
  { re: /(?<![\w$.])eval\s*\(/, why: 'eval()' },
  { re: /\bnew\s+Function\s*\(|(?<![\w$.])Function\s*\(\s*['"`]/, why: 'builds a function from text (new Function)' },
  { re: /\brequire\s*\(\s*(?!['"][^'"]*['"]\s*\))[^)]/, why: 'require() of a computed name' },
  { re: /\bimport\s*\(\s*(?!['"][^'"`$]*['"]\s*\))[^)]/, why: 'import() of a computed name' },
  { re: /\bvm\s*\.\s*(runIn\w*Context|Script|compileFunction)\b|\bfrom\s+['"](node:)?vm['"]/, why: 'runs code with the vm module' },
  { re: /\bsetTimeout\s*\(\s*['"`]|\bsetInterval\s*\(\s*['"`]/, why: 'a timer given code as text' }
]
const PROCESS = /\bchild_process\b|\b(spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(|\bshell\s*:\s*true\b|\bpowershell(\.exe)?\b|\bcmd(\.exe)?\s+\/[ck]\b|\bshell\s*\.\s*(openPath|openExternal)\s*\(|\butilityProcess\b/
const WRITE_FS = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|symlink|symlinkSync)\s*\(/
const OUTSIDE_TARGET = /\bhomedir\s*\(|\bUSERPROFILE\b|\bProgramData\b|\bPROGRAMFILES\b|\btmpdir\s*\(|['"`][A-Za-z]:[\\/]|['"`]~[\\/]|getPath\(\s*['"](home|desktop|documents|downloads|temp|appData|exe|startup)['"]\s*\)/
const MACHINERY = [
  { re: /\bautoUpdater\b|\belectron-updater\b|\bupdate-electron-app\b|\bSquirrel\b/i, why: 'touches an updater' },
  { re: /\bsetLoginItemSettings\b|CurrentVersion\\\\?Run\b|\bStartup\b.*\.lnk|\breg(\.exe)?\s+add\b|\bschtasks\b|\bRegistry\b|\bwinreg\b/i, why: 'registers something at start-up or in the registry' },
  { re: /\bscripts[\\/]deploy\.mjs\b|\bnpm\s+run\s+deploy\b/, why: 'refers to the deploy script' }
]
// The macOS and Linux equivalents (#161), kept apart so the Windows rules above stay exactly as they were.
const DATA_FOLDER_POSIX = /Library[\\/]+Application Support|\bXDG_CONFIG_HOME\b|\.config[\\/]+(corvid|claude[ _-]?dashboard)\b/i
const SECRET_READ_POSIX = [
  { re: /\.config[\\/]+(gcloud|gh|op|doctl)\b|Library[\\/]+Keychains\b|\blogin\.keychain\b|\bsecurity\s+(find|dump)-(generic|internet)-password\b|\bdump-keychain\b|\bsecret-tool\b|\bkwallet-query\b|\bkeytar\b/, why: 'reads a credential file, the Keychain or the keyring' },
  { re: /\/proc\/(self|\d+|\$\{?\w+\}?)\/(environ|mem|maps|cmdline)\b|['"`]\/proc\/['"`]?\s*\+/, why: "reads a process's environment or memory through /proc" }
]
const PROCESS_POSIX = [
  { re: /\b(osascript|launchctl|systemctl|crontab|pkexec|sudo|doas)\b|\/bin\/(ba|z|da)?sh\b|['"`](ba|z|da)?sh['"`]\s*,\s*\[\s*['"`]-c['"`]/, why: 'Starts a program or a shell command.' },
  { re: /\b(curl|wget)\b[^\n]{0,80}\|\s*(sudo\s+)?(sh|bash|zsh|dash|python3?|node|perl|ruby)\b|\b(sh|bash|zsh)\s+<\(\s*(curl|wget)\b|\$\(\s*(curl|wget)\b|\bbase64\s+(-d|-D|--decode)\b[^\n]{0,40}\|\s*(sh|bash|zsh)\b/, why: 'Downloads or decodes a script and runs it.' },
  { re: /\bchmod(Sync)?\s*\([^)]*,\s*0o?[0-7]*[1357][0-7]*\s*\)|\bchmod\s+(-[a-zA-Z]+\s+)*([ugoa]*\+[rwXst]*x|[0-7]*[1357][0-7]*)(\s|['"`]|$)/, why: 'Makes a file executable (chmod +x).' },
  { re: /\/dev\/(tcp|udp)\/|\b(nc|ncat|netcat)\s+(-\S+\s+)*-[a-z]*e\b/, why: 'Opens a network connection from the shell (/dev/tcp, nc -e).' }
]
const OUTSIDE_TARGET_POSIX = /['"`]\/(etc|usr|bin|sbin|lib|lib64|boot|opt|var|System|Library|Applications)\/|\$\{?HOME\}?[\\/]|\bprocess\.env\.(HOME|XDG_\w+|TMPDIR)\b/
const MACHINERY_POSIX = { re: /\bLaunch(Agents|Daemons)\b|\blaunchctl\b|<key>RunAtLoad<\/key>|\bcrontab\b|\/etc\/(cron|systemd|init\.d|rc\.local|profile|ld\.so\.preload)|\bsystemctl\b[^\n]{0,40}\b(enable|start|link|daemon-reload)\b|\.config[\\/]+(autostart|systemd)\b|\bX-GNOME-Autostart|^\s*WantedBy\s*=|(^|[\s'"`~\\/(])\.(bashrc|zshrc|bash_profile|bash_login|zprofile|zshenv|zlogin|profile|xprofile|xinitrc)\b(?!\s*\()/, why: 'registers something at start-up (launchd, cron, systemd, autostart or a shell profile)' }
const OBFUSCATED = [
  { re: /[A-Za-z0-9+/]{80,}={0,2}/, why: 'a long base64-like run' },
  { re: /\b[0-9a-f]{65,}\b/i, why: 'a long hex run' },
  { re: /(\\x[0-9a-f]{2}){6,}|(\\u[0-9a-f]{4}){6,}|(%[0-9a-f]{2}){8,}/i, why: 'a run of escaped bytes' },
  { re: /\bString\s*\.\s*fromCharCode\s*\(|\batob\s*\(|Buffer\s*\.\s*from\s*\([^)]*['"](base64|hex)['"]/, why: 'decodes text at run time' }
]
const LARGE_FILE = 200 * 1024
const LONG_LINE = 2000
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepublish', 'preprepare', 'postprepare']

const cut = (s: string): string => (s.trim().length > 160 ? s.trim().slice(0, 157) + '...' : s.trim())

/** Files whose changes are code (rules about code run on these); docs and tests are still checked for secrets. */
const isCode = (p: string): boolean => /\.(m?[jt]sx?|cjs|cts|mts|json|ps1|bat|cmd|sh|html)$/i.test(p) || isPosixScript(p)
/** macOS and Linux scripts and start-up files (#161): code too, so the code rules run on them. */
const isPosixScript = (p: string): boolean => /\.(bash|zsh|command|plist|service|timer|desktop)$/i.test(p)
const isTestFile = (p: string): boolean => /^tests\//.test(p) || /^scripts\/test-[\w-]+\.mjs$/.test(p) || /\.test\.[jt]sx?$/.test(p)

/** The area a repo path belongs to: a core area id, the extension's own folder, a registration index, tests, docs. */
export function areaOf(path: string, id: string): string {
  if (path.startsWith(`${SOCKETS_DIR}/${id}/`)) return 'own'
  if (REGISTRATION_FILES.includes(path)) return 'registration'
  // the protected areas first: a protected file can also be inside a tier-2 folder
  for (const a of [...CORE_AREAS.filter((x) => x.protected), ...CORE_AREAS.filter((x) => !x.protected)])
    if (a.paths.some((q) => (q.endsWith('/') ? path.startsWith(q) : path === q))) return a.id
  if (isTestFile(path)) return 'tests'
  if (/^(docs\/|README\.md$|SPEC\.md$)/.test(path)) return 'docs'
  return 'core'
}

const AREA_LABELS: Record<string, string> = {
  own: "The extension's own folder",
  registration: 'Registration lines',
  tests: 'Tests',
  docs: 'Documentation',
  core: 'Other core files'
}
export const areaLabel = (a: string): string => AREA_LABELS[a] ?? coreArea(a)?.label ?? a

/** package.json's dependencies before and after, from the full text of both versions. */
export function packageChanges(before: string | null, after: string | null): { added: { name: string; version: string }[]; changed: { name: string; from: string; to: string }[]; scripts: string[] } {
  const parse = (t: string | null): { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; scripts?: Record<string, string> } => {
    try {
      return t ? JSON.parse(t) : {}
    } catch {
      return {}
    }
  }
  const a = parse(before)
  const b = parse(after)
  const deps = (p: typeof a): Record<string, string> => ({ ...p.dependencies, ...p.devDependencies, ...p.optionalDependencies })
  const da = deps(a)
  const db = deps(b)
  const added = Object.keys(db).filter((n) => !(n in da)).map((name) => ({ name, version: db[name] }))
  const changed = Object.keys(db).filter((n) => n in da && da[n] !== db[n]).map((name) => ({ name, from: da[name], to: db[name] }))
  const scripts = INSTALL_SCRIPTS.filter((s) => b.scripts?.[s] !== undefined && b.scripts?.[s] !== a.scripts?.[s])
  return { added, changed, scripts }
}

/**
 * Scan a build's diff against what the extension declared. `pkg` is package.json's text on main and on the build tip
 * (null when missing), read by the caller with `git show`, so a dependency change is judged on the whole file.
 */
export function scanDiff(files: DiffFile[], d: DeclaredCapabilities, pkg?: { before: string | null; after: string | null }, now = Date.now()): DiffScanResult {
  const flags: DiffFlag[] = []
  const add = (rule: DiffRule, severity: DiffFlag['severity'], file: string, text: string, line?: { n: number; text: string }): void => {
    if (flags.some((x) => x.rule === rule && x.file === file && x.line === line?.n && x.text === text)) return
    flags.push({ rule, severity, file, text, ...(line && { line: line.n, excerpt: cut(line.text) }) })
  }
  const declaredAreas = new Set(d.coreAreas)
  const protectedOk = (area: string): boolean => d.tier === 3 && d.tier3Confirmed && declaredAreas.has(area)

  for (const f of files) {
    const p = f.path
    const area = areaOf(p, d.id)

    // ---- where the change is
    for (const q of [p, ...(f.from ? [f.from] : [])]) {
      if (q.includes('..') || /^[A-Za-z]:|^\//.test(q)) add('write-outside', 'block', p, `The path ${q} leaves the repository.`)
      if (q.startsWith('.claude/') || q === '.mcp.json' || q.startsWith('.git/') || q === '.gitattributes' || q.startsWith('.husky/') || q.startsWith('.github/'))
        add('machinery', 'block', p, `Changes ${q}, which configures agents, git hooks or automation.`)
    }
    if (isProtectedPath(p) || (f.from && isProtectedPath(f.from))) {
      const a = areaOf(isProtectedPath(p) ? p : f.from!, d.id)
      if (!protectedOk(a))
        add('protected-path', 'block', p,
          d.tier < 3 ? `Changes a protected file (${areaLabel(a)}); this extension is tier ${d.tier}, so it may not.`
            : !d.tier3Confirmed ? `Changes a protected file (${areaLabel(a)}) without your tier-3 confirmation.`
            : `Changes a protected file (${areaLabel(a)}), an area the extension didn't declare.`)
    } else if (area !== 'own' && area !== 'registration' && area !== 'tests' && area !== 'docs') {
      if (d.tier === 1) add('undeclared-area', 'flag', p, `A tier-1 extension only adds files, but this changes ${area === 'core' ? 'a core file' : areaLabel(area)}.`)
      else if (area === 'core') add('undeclared-area', 'flag', p, 'Changes a core file that is in none of the listed areas.')
      else if (!declaredAreas.has(area)) add('undeclared-area', 'flag', p, `Changes ${areaLabel(area)}, which the extension didn't declare.`)
    }
    if (f.binary) add('binary', 'flag', p, 'A binary file.')
    else if (f.addedBytes > LARGE_FILE) add('binary', 'flag', p, `A large change (${Math.round(f.addedBytes / 1024)} KB added), likely generated.`)

    // ---- what the added lines do
    const code = isCode(p) && !isTestFile(p)
    for (const line of f.lines) {
      const t = line.text
      if (t.length > LONG_LINE) add('binary', 'flag', p, `A ${t.length}-character line, likely generated or minified.`, line)
      for (const s of [...SECRET_READ, ...SECRET_READ_POSIX]) if (s.re.test(t)) add('secrets', isTestFile(p) || !isCode(p) ? 'flag' : 'block', p, `Looks like it ${s.why}.`, line)
      if (code && (DATA_FOLDER.test(t) || DATA_FOLDER_POSIX.test(t))) add('secrets', 'flag', p, "Refers to Corvid's data folder or Claude's folder.", line)
      for (const o of OBFUSCATED) if (o.re.test(t) && !/^\s*(\/\/|\*|#)/.test(t)) add('obfuscation', 'flag', p, `Contains ${o.why}.`, line)
      if (!code) continue
      for (const m of t.matchAll(URL_RE)) {
        const host = m[1].toLowerCase().replace(/\.$/, '')
        if (/^(localhost|127\.0\.0\.1|example\.(com|org)|www\.w3\.org)$/.test(host)) continue
        if (!hostDeclared(host, d.hosts)) add('network-host', 'flag', p, `A host the extension didn't declare: ${host}.`, line)
      }
      if (NETWORK_CODE.test(t)) add('network-code', 'flag', p, d.hosts.length ? 'New network code (check it only reaches the declared hosts).' : 'New network code, and the extension declared no hosts.', line)
      for (const x of DYNAMIC) if (x.re.test(t)) add('dynamic-code', 'flag', p, `Dynamic code: ${x.why}.`, line)
      if (PROCESS.test(t)) add('process', 'flag', p, 'Starts a program or a shell command.', line)
      for (const x of PROCESS_POSIX) if (x.re.test(t)) add('process', 'flag', p, x.why, line)
      if (WRITE_FS.test(t) && (OUTSIDE_TARGET.test(t) || OUTSIDE_TARGET_POSIX.test(t))) add('write-outside', 'flag', p, "Writes to a folder outside the app's own.", line)
      for (const x of [...MACHINERY, MACHINERY_POSIX]) if (x.re.test(t) && !protectedOk('deploy')) add('machinery', 'flag', p, `Looks like it ${x.why}.`, line)
    }
  }

  // ---- dependencies, judged on the whole package.json
  if (pkg) {
    const c = packageChanges(pkg.before, pkg.after)
    const declared = new Map(d.packages.map((x) => [x.name.toLowerCase(), x.version]))
    for (const a of c.added) {
      const v = declared.get(a.name.toLowerCase())
      if (v === undefined) add('dependency', 'flag', 'package.json', `New dependency ${a.name}@${a.version}, not declared.`)
      else if (v !== a.version && !a.version.endsWith(v.replace(/^[\^~]/, ''))) add('dependency', 'flag', 'package.json', `New dependency ${a.name}@${a.version}; the extension declared ${v}.`)
    }
    for (const ch of c.changed) add('dependency', 'flag', 'package.json', `Changes the version of ${ch.name} from ${ch.from} to ${ch.to}.`)
    for (const s of c.scripts) add('install-script', 'block', 'package.json', `Adds or changes the "${s}" install script, which runs on every npm install.`)
  }

  const touched = files.map((f) => f.path)
  // the tier-1 shape (#102), leaving out the acceptance tests and docs a build is asked to write
  const shape = diffShape(d.id, files.filter((f) => !['tests', 'docs'].includes(areaOf(f.path, d.id))))
  const byArea = new Map<string, AreaSummary>()
  for (const f of files) {
    const a = areaOf(f.path, d.id)
    const s = byArea.get(a) ?? { area: a, label: areaLabel(a), files: 0, added: 0, removed: 0 }
    s.files++
    s.added += f.added?.length ?? 0
    s.removed += f.removed?.length ?? 0
    byArea.set(a, s)
  }
  const verdict = flags.some((x) => x.severity === 'block') ? 'block' : flags.length ? 'flag' : 'clear'
  return { verdict, flags, areas: [...byArea.values()].sort((a, b) => b.files - a.files), tier1Shape: shape.tier1, files: touched, at: now }
}

// ---------- requirements and conflicts (#98, kept simple) ----------

/** Whether `version` satisfies a range: space-separated comparators that must all hold (>=, <=, >, <, =, ^, ~, *).
 *  A prerelease only satisfies a comparator with the same major.minor.patch, as npm does. */
export function satisfies(version: string, range: string, compare: (a: string, b: string) => number): boolean {
  const core = (v: string): number[] => v.split(/[-+]/)[0].split('.').map(Number)
  const [M, m, p] = core(version)
  const pre = /-/.test(version.split('+')[0])
  return range.trim().split(/\s+/).every((c) => {
    if (!c || c === '*') return !pre
    const op = /^(>=|<=|>|<|=|\^|~)?(.+)$/.exec(c)!
    const v = op[2]
    const [vM, vm, vp] = core(v)
    if (pre && !(M === vM && m === vm && p === vp && /-/.test(v))) return false
    const k = compare(version, v)
    switch (op[1]) {
      case '>=': return k >= 0
      case '<=': return k <= 0
      case '>': return k > 0
      case '<': return k < 0
      case '^': return k >= 0 && (vM > 0 ? M === vM : vm > 0 ? M === 0 && m === vm : M === 0 && m === 0 && p === vp)
      case '~': return k >= 0 && M === vM && m === vm
      default: return k === 0
    }
  })
}
