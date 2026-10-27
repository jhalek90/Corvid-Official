// Decides whether a remote command is read-only, for systems set to "approve writes".
//
// Allowlist, not denylist: a command is read-only only if every part of it is a known
// inspection command with arguments that can't write, and the line uses nothing that can run
// code or write files behind the command's back. Anything not understood counts as a write and
// waits for the user. In detail:
//
// - Pipelines and lists (| || && ; newline) are fine when every command in them is read-only.
// - Redirections: only `< file`, and `>`/`>>`/`2>`/`&>` to /dev/null, and fd copies like 2>&1.
// - Refused outright: command substitution ($( ) and backticks), parentheses (subshells,
//   process substitution, zsh glob qualifiers, fish substitution), ${…}, $'…', heredocs,
//   background &, env assignments before a command (LD_PRELOAD=…), paths as the command name
//   (/tmp/ls), backslashes inside single quotes, control characters, unterminated quotes.
// - Each command name is checked against READ_ONLY below; some only in certain forms
//   (systemctl status, git log, docker ps, find without -exec/-delete, sort without -o, …).
//   sudo, sed, awk, xargs, tee, curl, wget and editors are never read-only.

export interface Classification {
  readOnly: boolean
  /** short, user-facing */
  reason: string
}

type Tok = { op: string } | { word: string }

class Unsure extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let word = ''
  let inWord = false
  const end = (): void => {
    if (inWord) out.push({ word })
    word = ''
    inWord = false
  }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (/[\x00-\x08\x0b-\x1f\x7f]/.test(c)) throw new Unsure('control characters')
    if (c === ' ' || c === '\t') {
      end()
    } else if (c === '\n') {
      end()
      out.push({ op: ';' })
    } else if (c === '#' && !inWord) {
      // comment to end of line, as the shell sees it
      while (i + 1 < src.length && src[i + 1] !== '\n') i++
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      if (close < 0) throw new Unsure('an unterminated quote')
      const body = src.slice(i + 1, close)
      if (body.includes('\\')) throw new Unsure('a backslash inside single quotes')
      word += body
      inWord = true
      i = close
    } else if (c === '"') {
      let j = i + 1
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\') j++
        else if (src[j] === '`' || (src[j] === '$' && (src[j + 1] === '(' || src[j + 1] === '{')))
          throw new Unsure('command substitution or ${…} inside quotes')
      }
      if (j >= src.length) throw new Unsure('an unterminated quote')
      word += src.slice(i + 1, j).replace(/\\(.)/g, '$1')
      inWord = true
      i = j
    } else if (c === '\\') {
      if (next === undefined || next === '\n') throw new Unsure('a line continuation')
      word += next
      inWord = true
      i++
    } else if (c === '`') {
      throw new Unsure('command substitution')
    } else if (c === '$' && (next === '(' || next === '{' || next === "'" || next === '"')) {
      throw new Unsure(next === '(' ? 'command substitution' : 'shell expansion syntax')
    } else if (c === '(' || c === ')') {
      throw new Unsure('parentheses (subshell or substitution)')
    } else if (c === '|' || c === ';' || c === '&') {
      // `&>` is a redirection, handled with the others below
      if (c === '&' && next === '>') {
        end()
        let op = '&>'
        i++
        if (src[i + 1] === '>') (op += '>'), i++
        out.push({ op })
        continue
      }
      end()
      if ((c === '|' || c === '&') && next === c) {
        out.push({ op: c + c })
        i++
      } else if (c === '&') throw new Unsure('a background job (&)')
      else if (c === ';' && next === ';') throw new Unsure(';;')
      else out.push({ op: c })
    } else if (c === '>' || c === '<') {
      // a word of digits right before is the file descriptor: 2>, 1>&2
      let op = /^\d+$/.test(word) && inWord ? word : ''
      if (op) (word = ''), (inWord = false)
      end()
      op += c
      if (next === c) (op += c), i++
      if (op.endsWith('<<')) throw new Unsure('a heredoc')
      if (src[i + 1] === '(') throw new Unsure('process substitution')
      if (src[i + 1] === '&') {
        op += '&'
        i++
      }
      out.push({ op })
    } else {
      word += c
      inWord = true
    }
  }
  end()
  return out
}

const SEPARATORS = new Set(['|', '||', '&&', ';'])

/** Split into simple commands, checking and dropping redirections on the way. */
function commands(toks: Tok[]): string[][] {
  const cmds: string[][] = [[]]
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]
    if ('word' in t) {
      cmds[cmds.length - 1].push(t.word)
      continue
    }
    if (SEPARATORS.has(t.op)) {
      cmds.push([])
      continue
    }
    const target = toks[i + 1]
    if (!target || !('word' in target)) throw new Unsure(`a redirection (${t.op}) without a target`)
    i++
    if (t.op.endsWith('&')) {
      if (!/^\d+$|^-$/.test(target.word)) throw new Unsure(`redirection ${t.op}${target.word}`)
    } else if (t.op.includes('<')) {
      /* reading a file in is fine */
    } else if (target.word !== '/dev/null') {
      throw new Unsure(`output redirected to ${target.word}`)
    }
  }
  return cmds.filter((c) => c.length)
}

// ---------- the allowlist ----------

type Check = true | ((args: string[]) => boolean)

const positional = (args: string[]): string[] => args.filter((a) => !a.startsWith('-'))
const firstWord = (args: string[]): string | undefined => positional(args)[0]
const onlyFrom = (allowed: string[]) => (args: string[]): boolean => args.every((a) => allowed.includes(a))
const subcommandIn = (subs: string[], allowNone = false) => (args: string[]): boolean => {
  const s = firstWord(args)
  return s === undefined ? allowNone : subs.includes(s)
}
/** a short-option cluster or long option that writes, e.g. sort -o, sort -ro, --output=x */
const hasOption = (args: string[], short: string, long: string[]): boolean =>
  args.some(
    (a) =>
      (short && /^-[^-]/.test(a) && [...a.slice(1)].some((ch) => short.includes(ch))) ||
      long.some((l) => a === l || a.startsWith(l + '='))
  )
/** own keys only: a lookup like table['constructor'] must not find Object's */
const lookup = (table: Record<string, Check>, key: string | undefined): Check | undefined =>
  key !== undefined && Object.hasOwn(table, key) ? table[key] : undefined
const VERSION = ['-v', '-V', '--version', '-version']

const GIT_READ: Record<string, Check> = {
  status: true,
  log: true,
  show: true,
  diff: true,
  'rev-parse': true,
  'ls-files': true,
  'ls-tree': true,
  'ls-remote': true,
  describe: true,
  shortlog: true,
  blame: true,
  grep: true,
  'cat-file': true,
  'count-objects': true,
  'show-ref': true,
  'name-rev': true,
  'merge-base': true,
  branch: (a) => positional(a).length === 0,
  tag: (a) => a.length === 0 || a[0] === '-l' || a[0] === '--list',
  remote: (a) => a.length === 0 || onlyFrom(['-v', '--verbose'])(a) || a[0] === 'get-url' || a[0] === 'show',
  stash: (a) => a[0] === 'list' || a[0] === 'show',
  config: (a) => a.some((x) => ['--get', '--get-all', '--get-regexp', '--list', '-l'].includes(x)) && !hasOption(a, '', ['--add', '--unset', '--unset-all', '--replace-all', '--rename-section', '--remove-section', '--edit', '-e']),
  reflog: (a) => a.length === 0 || a[0] === 'show' || a[0].startsWith('-'),
  worktree: (a) => a[0] === 'list',
  submodule: (a) => a[0] === 'status'
}

function gitCheck(args: string[]): boolean {
  // Global options can point git at commands (-c core.pager=…); only -C <dir> and --no-pager pass.
  let i = 0
  while (args[i]?.startsWith('-')) {
    if (args[i] === '-C') i += 2
    else if (args[i] === '--no-pager') i++
    else return false
  }
  const sub = args[i]
  const rest = args.slice(i + 1)
  if (!sub || hasOption(rest, '', ['--output'])) return false
  const check = lookup(GIT_READ, sub)
  return check === true || (!!check && check(rest))
}

const DOCKER_READ: Record<string, Check> = {
  ps: true,
  images: true,
  logs: true,
  inspect: true,
  version: true,
  info: true,
  top: true,
  port: true,
  stats: true,
  history: true,
  diff: true,
  container: subcommandIn(['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'port', 'stats', 'diff']),
  image: subcommandIn(['ls', 'list', 'inspect', 'history']),
  network: subcommandIn(['ls', 'list', 'inspect']),
  volume: subcommandIn(['ls', 'list', 'inspect']),
  system: subcommandIn(['df', 'info']),
  compose: subcommandIn(['ps', 'logs', 'config', 'ls', 'images', 'top', 'version'])
}

const READ_ONLY: Record<string, Check> = {
  // files and text
  ls: true,
  cat: true,
  tac: true,
  head: true,
  tail: true,
  grep: true,
  egrep: true,
  fgrep: true,
  zgrep: true,
  zcat: true,
  wc: true,
  cut: true,
  tr: true,
  nl: true,
  rev: true,
  column: true,
  comm: true,
  diff: true,
  cmp: true,
  stat: true,
  du: true,
  df: true,
  strings: true,
  od: true,
  hexdump: true,
  jq: true,
  realpath: true,
  readlink: true,
  basename: true,
  dirname: true,
  md5sum: true,
  sha1sum: true,
  sha256sum: true,
  sha512sum: true,
  cksum: true,
  locate: true,
  file: (a) => !hasOption(a, 'C', ['--compile']),
  tree: (a) => !hasOption(a, 'o', []),
  sort: (a) => !hasOption(a, 'o', ['--output', '--compress-program']),
  uniq: (a) => positional(a).length <= 1,
  find: (a) => !a.some((x) => ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls'].includes(x)),
  // shell basics
  cd: true,
  pwd: true,
  echo: true,
  printf: true,
  test: true,
  '[': true,
  true: true,
  false: true,
  sleep: true,
  which: true,
  whereis: true,
  type: true,
  printenv: true,
  locale: true,
  env: (a) => a.length === 0,
  // system state
  uname: true,
  uptime: true,
  free: true,
  whoami: true,
  id: true,
  groups: true,
  w: true,
  who: true,
  last: true,
  lastlog: true,
  nproc: true,
  arch: true,
  ps: true,
  pgrep: true,
  pstree: true,
  vmstat: true,
  iostat: true,
  mpstat: true,
  lscpu: true,
  lsblk: true,
  lsmem: true,
  lspci: true,
  lsusb: true,
  lsof: true,
  top: (a) => a.some((x) => /^-[a-zA-Z]*b/.test(x)),
  hostname: onlyFrom(['-f', '-i', '-I', '-s', '-d', '-a', '-A', '-y', '--fqdn', '--short', '--all-ip-addresses', '--ip-address', '--domain', '--all-fqdns']),
  date: (a) => !hasOption(a, 's', ['--set']) && positional(a).every((x) => x.startsWith('+')),
  mount: (a) => a.length === 0,
  dmesg: (a) => !hasOption(a, 'cCDEn', ['--clear', '--read-clear', '--console-off', '--console-on', '--console-level']),
  timedatectl: subcommandIn(['status', 'show', 'list-timezones', 'timesync-status', 'show-timesync'], true),
  hostnamectl: subcommandIn(['status'], true),
  // network
  ss: true,
  netstat: true,
  getent: true,
  dig: true,
  nslookup: true,
  host: true,
  ping: true,
  traceroute: true,
  tracepath: true,
  ip: (a) => {
    const obj = firstWord(a)
    const objects = ['addr', 'address', 'a', 'route', 'r', 'ro', 'link', 'l', 'neigh', 'n', 'rule', 'ru', 'maddr']
    const writes = ['add', 'del', 'delete', 'change', 'replace', 'set', 'flush', 'append', 'prepend', 'save', 'restore', 'exec', 'up', 'down', 'update']
    return (obj === undefined || objects.includes(obj)) && !a.some((x) => writes.includes(x))
  },
  iptables: (a) => a.some((x) => /^-[nvx]*[LS][nvx]*$|^--list$/.test(x)) && a.every((x) => /^(-[LSnvxt]+|--list|--line-numbers|--numeric|--verbose|filter|nat|mangle|raw|security|[A-Z][A-Z0-9_-]*)$/.test(x)),
  ip6tables: (a) => READ_ONLY_FN('iptables', a),
  nft: (a) => a[0] === 'list',
  ufw: (a) => a[0] === 'status' && a.length <= 2,
  // services and logs
  systemctl: subcommandIn(['status', 'is-active', 'is-enabled', 'is-failed', 'is-system-running', 'list-units', 'list-unit-files', 'list-timers', 'list-sockets', 'list-dependencies', 'list-jobs', 'show', 'cat', 'get-default', 'show-environment'], true),
  service: (a) => a[1] === 'status' || (a.length === 1 && a[0] === '--status-all'),
  journalctl: (a) => !hasOption(a, '', ['--vacuum-size', '--vacuum-time', '--vacuum-files', '--rotate', '--flush', '--sync', '--relinquish-var', '--smart-relinquish-var', '--setup-keys', '--update-catalog', '--cursor-file']),
  crontab: (a) => a.includes('-l') && a.every((x, i) => x === '-l' || x === '-u' || a[i - 1] === '-u'),
  // containers
  docker: (a) => {
    const check = lookup(DOCKER_READ, a[0])
    return check === true || (!!check && check(a.slice(1)))
  },
  kubectl: (a) => {
    const sub = firstWord(a)
    const rest = positional(a).slice(1)
    if (sub === 'config') return ['view', 'get-contexts', 'current-context'].includes(rest[0])
    if (sub === 'rollout') return ['status', 'history'].includes(rest[0])
    if (sub === 'auth') return rest[0] === 'can-i'
    return ['get', 'describe', 'logs', 'top', 'version', 'explain', 'api-resources', 'api-versions', 'cluster-info'].includes(sub ?? '')
  },
  git: gitCheck,
  // packages and versions
  'apt-cache': subcommandIn(['show', 'policy', 'search', 'depends', 'rdepends', 'showpkg', 'stats', 'madison']),
  apt: subcommandIn(['list', 'show', 'search', 'policy', 'depends', 'rdepends']),
  dpkg: (a) => a.length > 0 && ['-l', '--list', '-L', '--listfiles', '-s', '--status', '-S', '--search', '-p', '--print-avail', '--get-selections', '--print-architecture', '--version'].includes(a[0]),
  rpm: (a) => /^(-q[a-zA-Z]*|--query)$/.test(a[0] ?? '') && !hasOption(a, 'eiUF', ['--erase', '--install', '--upgrade', '--freshen']),
  yum: subcommandIn(['list', 'info', 'search', 'repolist', 'provides', 'check-update']),
  dnf: subcommandIn(['list', 'info', 'search', 'repolist', 'provides', 'check-update']),
  snap: subcommandIn(['list', 'info', 'version']),
  pip: subcommandIn(['list', 'show', 'freeze']),
  pip3: subcommandIn(['list', 'show', 'freeze']),
  nginx: onlyFrom(['-t', '-T', '-v', '-V']),
  node: (a) => a.length > 0 && onlyFrom(VERSION)(a),
  python: (a) => a.length > 0 && onlyFrom(VERSION)(a),
  python3: (a) => a.length > 0 && onlyFrom(VERSION)(a),
  java: (a) => a.length > 0 && onlyFrom(VERSION)(a),
  go: (a) => a.length === 1 && a[0] === 'version',
  php: (a) => a.length > 0 && onlyFrom(VERSION)(a),
  ruby: (a) => a.length > 0 && onlyFrom(VERSION)(a),
  npm: (a) => a.length > 0 && onlyFrom(VERSION)(a)
}

function READ_ONLY_FN(name: string, args: string[]): boolean {
  const check = lookup(READ_ONLY, name)
  return check === true || (!!check && check(args))
}

export function classify(command: string): Classification {
  const cmd = command.trim()
  if (!cmd) return { readOnly: false, reason: 'empty command' }
  let cmds: string[][]
  try {
    cmds = commands(tokenize(cmd))
  } catch (e) {
    if (e instanceof Unsure) return { readOnly: false, reason: `uses ${e.message}` }
    throw e
  }
  if (!cmds.length) return { readOnly: false, reason: 'nothing to run' }
  for (const [name, ...args] of cmds) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(name)) return { readOnly: false, reason: 'sets environment variables for a command' }
    if (name.includes('/')) return { readOnly: false, reason: `runs a program by path (${name})` }
    if (!lookup(READ_ONLY, name)) return { readOnly: false, reason: `${name} is not on the read-only list` }
    if (!READ_ONLY_FN(name, args)) return { readOnly: false, reason: `this use of ${name} may change things` }
  }
  return { readOnly: true, reason: `read-only (${[...new Set(cmds.map((c) => c[0]))].join(', ')})` }
}
