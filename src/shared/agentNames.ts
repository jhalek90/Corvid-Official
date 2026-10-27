// Names for the agents the dashboard spawns: goofy job titles ("Senior Pixel Plumber"), or with Goofy agent
// names off plain ones ("Text Selector Agent"). Everything a name can contain comes from the word lists
// below, never from the task text, so every possible output can be reviewed here. Free and offline: no
// model is asked.

/** Matched against the task as whole words; a trailing * matches any ending ("screenshot*"). */
interface NameTheme {
  keys: string[]
  words: string[]
  /** the plain name's subject ("Git" makes "Git Agent") */
  plain: string
  /** narrower subjects, used instead of `plain` when one of their keys matches the task */
  plainBy?: [string, string[]][]
}

// Order matters only for ties in how well two themes match: the earlier theme wins, so the more
// specific ones come first and the catch-all agents/tasks theme last.
const THEMES: NameTheme[] = [
  { keys: ['name', 'naming', 'rename*', 'title', 'label', 'nickname'], words: ['Nametag', 'Label', 'Moniker', 'Title Card'], plain: 'Naming' },
  { keys: ['new project', 'git init', 'scaffold*', 'bootstrap*', 'starter'], words: ['Blank Slate', 'Cornerstone', 'Ribbon-Cutting', 'Fresh Start'], plain: 'Project Setup' },
  {
    keys: ['git', 'github', 'commit*', 'push*', 'pull', 'merge*', 'branch*', 'rebase*', 'repo', 'repos', 'repository', 'stash*', 'cherry-pick*'],
    words: ['Commit', 'Branch', 'Merge', 'Repository', 'Diff'],
    plain: 'Git'
  },
  {
    keys: ['build*', 'compile*', 'bundl*', 'zip*', 'package*', 'installer*', 'release*', 'dist', 'deploy*', 'ship*', 'version*'],
    words: ['Build', 'Bundle', 'Zip File', 'Release', 'Installer'],
    plain: 'Build',
    plainBy: [['Release', ['release*', 'version*', 'ship*', 'deploy*', 'dist']]]
  },
  { keys: ['crow', 'mascot', 'bird', 'hat', 'hats', 'feather*', 'beak'], words: ['Feather', 'Birdseed', 'Nest', 'Plumage'], plain: 'Mascot' },
  {
    keys: ['sprite*', 'pixel*', 'icon*', 'image*', 'png', 'svg', 'animation*', 'animate*', 'avatar*', 'logo*', 'art', 'artwork', 'drawing*'],
    words: ['Pixel', 'Sprite', 'Icon', 'Bitmap', 'Animation Frame'],
    plain: 'Art',
    plainBy: [['Icon', ['icon*', 'logo*']], ['Animation', ['animation*', 'animate*']]]
  },
  {
    keys: ['theme*', 'colour*', 'color*', 'palette*', 'dark mode', 'light mode', 'css', 'style*', 'font*', 'typography', 'glow*', 'gradient*'],
    words: ['Palette', 'Colour', 'Hue', 'Gradient', 'Swatch'],
    plain: 'Theme'
  },
  {
    keys: ['terminal*', 'shell*', 'pty', 'console*', 'powershell', 'bash', 'cli', 'xterm', 'command line'],
    words: ['Terminal', 'Shell', 'Cursor', 'Keystroke'],
    plain: 'Terminal'
  },
  {
    keys: ['server*', 'ssh', 'remote*', 'network*', 'connect*', 'ping*', 'host*', 'port', 'ports', 'api', 'apis', 'endpoint*', 'socket*', 'proxy', 'dns', 'vpn', 'latency', 'offline', 'online'],
    words: ['Packet', 'Socket', 'Bandwidth', 'Handshake', 'Router'],
    plain: 'Network',
    plainBy: [['API', ['api', 'apis', 'endpoint*']], ['Remote', ['ssh', 'remote*', 'server*']]]
  },
  {
    keys: ['test*', 'typecheck*', 'lint*', 'qa', 'verify*', 'assert*'],
    words: ['Test Suite', 'Assertion', 'Edge Case', 'Checkmark'],
    plain: 'Test'
  },
  {
    keys: ['fix*', 'bug*', 'crash*', 'error*', 'broken', 'regression*', 'glitch*', 'freez*', 'hang*', 'leak*', 'debug*', 'flaky'],
    words: ['Bug', 'Glitch', 'Gremlin', 'Stack Trace', 'Hotfix'],
    plain: 'Bug Fixer'
  },
  {
    keys: ['doc', 'docs', 'document*', 'note', 'readme', 'spec', 'specs', 'guide*', 'write-up', 'writeup', 'changelog', 'tutorial*', 'wiki', 'explain*'],
    words: ['Footnote', 'Paragraph', 'Readme', 'Docstring', 'Margin Note'],
    plain: 'Docs'
  },
  {
    keys: ['screenshot*', 'capture*', 'snapshot*', 'recording*', 'preview*', 'thumbnail*'],
    words: ['Screenshot', 'Snapshot', 'Viewport', 'Thumbnail'],
    plain: 'Screenshot'
  },
  {
    keys: ['search*', 'find', 'finder', 'filter*', 'query', 'queries', 'index*', 'lookup*'],
    words: ['Haystack', 'Query', 'Index', 'Breadcrumb'],
    plain: 'Search'
  },
  {
    keys: ['voice*', 'dictat*', 'speech', 'microphone*', 'mic', 'audio', 'sound*', 'transcri*', 'tts'],
    words: ['Microphone', 'Decibel', 'Vowel', 'Echo'],
    plain: 'Voice'
  },
  {
    keys: ['usage', 'report*', 'stats', 'statistic*', 'chart*', 'metric*', 'quota*', 'cost*', 'spreadsheet*', 'csv', 'analytic*', 'kpi*'],
    words: ['Spreadsheet', 'Pie Chart', 'Decimal', 'Bar Chart', 'Pivot Table'],
    plain: 'Report',
    plainBy: [['Usage', ['usage', 'quota*', 'cost*']]]
  },
  {
    keys: ['notif*', 'toast*', 'alert*', 'badge*', 'tray', 'reminder*', 'popup*'],
    words: ['Toast', 'Doorbell', 'Banner', 'Notification'],
    plain: 'Notification'
  },
  {
    keys: ['setting*', 'config*', 'option*', 'preference*', 'toggle*', 'hotkey*', 'shortcut*', 'keybinding*'],
    words: ['Toggle', 'Checkbox', 'Dropdown', 'Preference'],
    plain: 'Settings',
    plainBy: [['Shortcut', ['hotkey*', 'shortcut*', 'keybinding*']]]
  },
  {
    keys: ['session*', 'history', 'transcript*', 'resume*', 'fork*', 'conversation*', 'chat*'],
    words: ['Transcript', 'Chat Log', 'Bookmark', 'Conversation'],
    plain: 'Session'
  },
  {
    keys: ['login*', 'auth*', 'password*', 'credential*', 'secret*', 'permission*', 'encrypt*', 'security', 'secure', 'scan*'],
    words: ['Padlock', 'Keyring', 'Permission Slip', 'Firewall'],
    plain: 'Login',
    plainBy: [['Security', ['security', 'secure', 'scan*', 'encrypt*', 'secret*', 'permission*']]]
  },
  {
    keys: ['file', 'files', 'folder*', 'director*', 'explorer*', 'path', 'paths', 'upload*', 'download*', 'drag'],
    words: ['Folder', 'Filing Cabinet', 'File Path', 'Directory'],
    plain: 'File'
  },
  {
    keys: ['slow*', 'performance', 'speed*', 'faster', 'lag*', 'memory', 'cpu', 'optimi*', 'cache*', 'startup'],
    words: ['Stopwatch', 'Cache', 'Millisecond', 'Turbo Button'],
    plain: 'Performance'
  },
  { keys: ['database*', 'db', 'storage', 'json', 'persist*', 'sqlite', 'migrat*'], words: ['Database', 'Byte', 'Record', 'Ledger'], plain: 'Storage' },
  {
    keys: ['refactor*', 'cleanup', 'clean up', 'tidy*', 'remov*', 'delet*', 'unused', 'dead code', 'leftover*', 'simplif*', 'drop'],
    words: ['Clutter', 'Dust Bunny', 'Leftover', 'Loose Thread'],
    plain: 'Cleanup'
  },
  { keys: ['time*', 'clock*', 'schedul*', 'date*', 'calendar*', 'deadline*', 'limit*'], words: ['Calendar', 'Hourglass', 'Timestamp', 'Deadline'], plain: 'Scheduling' },
  {
    keys: ['game*', 'unity', 'driving', 'car', 'cars', 'level*', 'physics', 'player*', 'neural', 'training', 'track*'],
    words: ['Joystick', 'Hitbox', 'Speedrun', 'Neuron'],
    plain: 'Game'
  },
  { keys: ['email*', 'mail', 'message*', 'inbox*', 'reply', 'replies'], words: ['Inbox', 'Envelope', 'Carrier Pigeon', 'Postage Stamp'], plain: 'Messaging' },
  // before the spelling theme: "make text selectable" is about selecting, not wording
  {
    keys: ['keyboard*', 'right-click', 'context menu', 'clipboard*', 'copy', 'paste*', 'mouse', 'click*', 'selectable', 'select*'],
    words: ['Keyboard', 'Right-Click', 'Clipboard', 'Mouse Pointer'],
    plain: 'Input',
    plainBy: [
      ['Text Selector', ['select*', 'selectable']],
      ['Clipboard', ['clipboard*', 'copy', 'paste*']],
      ['Context Menu', ['right-click', 'context menu']]
    ]
  },
  { keys: ['spell*', 'typo*', 'grammar', 'wording', 'text', 'writing'], words: ['Typo', 'Semicolon', 'Apostrophe', 'Comma'], plain: 'Wording' },
  {
    keys: ['layout*', 'sidebar*', 'panel*', 'pane', 'panes', 'card', 'cards', 'ui', 'ux', 'button*', 'menu*', 'modal*', 'dialog*', 'tab', 'tabs', 'toolbar*', 'column*', 'grid*', 'declutter*', 'view', 'views'],
    words: ['Sidebar', 'Layout', 'Button', 'Widget', 'Margin'],
    plain: 'Layout'
  },
  {
    keys: ['agent*', 'worker*', 'automat*', 'assistant*', 'spawn*', 'queue*', 'cron', 'bot', 'bots'],
    words: ['Workflow', 'To-Do List', 'Task Queue', 'Org Chart'],
    plain: 'Automation'
  }
]

/** When nothing matches. */
const PLAIN_GENERIC = 'Task'
const GENERIC = ['Synergy', 'Paperclip', 'Rubber Duck', 'Loose End', 'Odd Job', 'Sticky Note', 'Stapler', 'Miscellany']

const SENIORITY = ['Junior', 'Senior', 'Principal', 'Chief', 'Associate', 'Interim', 'Regional', 'Deputy', 'Lead', 'Acting', 'Staff', 'Head']

const ROLE = [
  'Wrangler',
  'Plumber',
  'Custodian',
  'Whisperer',
  'Architect',
  'Coordinator',
  'Specialist',
  'Technician',
  'Liaison',
  'Curator',
  'Shepherd',
  'Sommelier',
  'Concierge',
  'Steward',
  'Mechanic',
  'Tamer',
  'Inspector',
  'Archivist',
  'Navigator',
  'Officer',
  'Consultant',
  'Juggler'
]

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const keyRes = (keys: string[]): RegExp[] =>
  keys.map((k) => new RegExp(`(?:^|[^a-z0-9])${k.endsWith('*') ? `${escape(k.slice(0, -1))}[a-z]*` : `${escape(k)}(?:s|es)?`}(?![a-z0-9])`, 'g'))
const KEY_RES = THEMES.map((t) => keyRes(t.keys))
const PLAIN_BY_RES = THEMES.map((t) => (t.plainBy ?? []).map(([, keys]) => keyRes(keys)))

const hits = (text: string, res: RegExp[]): number => res.reduce((n, re) => n + (text.match(re)?.length ?? 0), 0)

/** "ClaudeNNDriving" or "my_game-2" -> "claude nn driving", "my game 2" */
const words = (s: string): string =>
  s
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()

/** FNV-1a with murmur3's finaliser: small and stable, so the same seed always picks the same words,
 *  and seeds that differ by a digit still spread across the lists. */
export function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

const pick = <T>(list: T[], seed: string): T => list[hash(seed) % list.length]

export interface NameInput {
  /** what makes it stable: the task id, or for agents without one something like the folder */
  seed: string | number
  title: string
  notes?: string
  /** a project folder; only its last part counts */
  project?: string
}

/** How well some keys match the task. The title counts three times as much as the notes or project. */
function scorer(input: NameInput): (res: RegExp[]) => number {
  const title = ` ${input.title.toLowerCase()} `
  const notes = ` ${(input.notes ?? '').toLowerCase()} `
  const project = ` ${words(input.project?.split(/[\\/]/).filter(Boolean).pop() ?? '')} `
  return (res) => hits(title, res) * 3 + hits(notes, res) + hits(project, res)
}

/** The theme that fits the task best, or -1 when none does. */
function bestTheme(score: (res: RegExp[]) => number): number {
  const scored = THEMES.map((_, i) => ({ i, score: score(KEY_RES[i]) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
  return scored[0]?.i ?? -1
}

/** Theme words for the task. */
function themeWords(input: NameInput): string[] {
  const i = bestTheme(scorer(input))
  return i < 0 ? GENERIC : THEMES[i].words
}

/**
 * A goofy job title for an agent, the same every time for the same seed. `taken` holds names already in
 * use by other agents; the next candidate is tried until one is free, so two agents never share one.
 */
export function agentName(input: NameInput, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()))
  const pool = themeWords(input)
  for (let k = 0; k < 64; k++) {
    // Theme words get spread across attempts first; the rest re-roll each time.
    const word = pool[(hash(`${input.seed}:w`) + k) % pool.length]
    const name = `${pick(SENIORITY, `${input.seed}:s:${k}`)} ${word} ${pick(ROLE, `${input.seed}:r:${k}`)}`
    if (!used.has(name.toLowerCase())) return name
  }
  // 64 clashes in a row can't really happen with a handful of agents, but never hand out a duplicate.
  const base = `${pick(SENIORITY, `${input.seed}:s`)} ${pick(GENERIC, `${input.seed}:g`)} ${pick(ROLE, `${input.seed}:r`)}`
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/**
 * A short plain name that says what the agent works on ("Text Selector Agent"), for when Goofy agent
 * names is off. Same rules as agentName: stable for a task, and never one in `taken` (a number is added).
 */
export function plainAgentName(input: NameInput, taken: Iterable<string> = []): string {
  const used = new Set([...taken].map((n) => n.toLowerCase()))
  const score = scorer(input)
  const i = bestTheme(score)
  let subject = i < 0 ? PLAIN_GENERIC : THEMES[i].plain
  // a narrower subject wins when its keys match; the best-matching one if several do
  let top = 0
  if (i >= 0)
    THEMES[i].plainBy?.forEach(([label], j) => {
      const s = score(PLAIN_BY_RES[i][j])
      if (s > top) [top, subject] = [s, label]
    })
  const base = `${subject} Agent`
  if (!used.has(base.toLowerCase())) return base
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`
}

/** Plain names end in "Agent", maybe with a number; goofy ones never do. */
export const isPlainName = (name: string): boolean => /\bAgent(?: \d+)?$/.test(name)

/** Every word a name can be made of, for reviewing the lists. */
export const NAME_WORDS = { themes: THEMES, generic: GENERIC, plainGeneric: PLAIN_GENERIC, seniority: SENIORITY, roles: ROLE }
