// Slash commands in the board's message box (#71). They go to Corvid only: a leading "/name" that is in the list runs
// that command, anything else is a normal message. Two kinds: the dashboard's own few (handled in main, no Claude turn),
// and the commands of Corvid's headless Claude session, read from its `initialize` reply and kept in assistant/commands.json.

/** extension: a command an extension registered through its socket (#102), run by the dashboard like its own */
export type CommandSource = 'builtin' | 'custom' | 'skill' | 'dashboard' | 'extension'

export interface SlashCommand {
  name: string
  description?: string
  argumentHint?: string
  aliases?: string[]
  source: CommandSource
}

/** What the popup offers and what main recognises: `from` says where Claude's part came from. */
export interface CommandList {
  commands: SlashCommand[]
  /** session: Corvid's running session; cache: its last session (it isn't running now); fallback: never seen one yet */
  from: 'session' | 'cache' | 'fallback'
  at?: number
}

/** Handled by the dashboard itself. /clear, /model and /usage are also Claude commands: the dashboard's take wins, since
 *  it does what the matching button or setting does (a saved model, the quota it already has), or starts a new conversation. */
export const DASHBOARD_COMMANDS: SlashCommand[] = [
  { name: 'clear', description: 'Start a new conversation with Corvid', aliases: ['new', 'reset'], source: 'dashboard' },
  { name: 'stop', description: "Stop Corvid's current turn", source: 'dashboard' },
  { name: 'mode', description: 'Plan & ask, or Auto', argumentHint: 'ask | auto', source: 'dashboard' },
  { name: 'model', description: "Corvid's model", argumentHint: 'haiku | sonnet | opus | fable', source: 'dashboard' },
  { name: 'usage', description: 'Plan usage, from what the dashboard already has', aliases: ['cost', 'stats'], source: 'dashboard' },
  // 'disccus' is the typo the command was asked for with (#200): it finds /discuss and shows nowhere
  { name: 'discuss', description: 'A few read-only panelists discuss a topic on the board; /discuss stop ends it', argumentHint: '<agents> [turns] <topic>', aliases: ['disccus'], source: 'dashboard' },
  { name: 'help', description: 'List the commands this chat takes', source: 'dashboard' }
]

/**
 * Claude's built-in commands checked to work in Corvid's headless session (claude -p, stream-json, Read/Glob/Grep only),
 * tested with Claude Code 2.1.306. Every other built-in is left out of the popup and answered "not available in this
 * chat": terminal-only ones (/color, /focus), ones the SDK refuses (/fast), ones with side effects outside the chat
 * (/usage-credits opens a browser, /heapdump writes to the Desktop, /design grants access), and ones that need tools
 * Corvid doesn't have (Bash, Edit, Write, agents), such as /init, /code-review, /batch or /doctor.
 */
export const HEADLESS_BUILTINS = new Set([
  'compact',
  'context',
  'effort',
  'advisor',
  'autocompact',
  'output-style',
  'rename',
  'recap',
  'mcp',
  'reload-skills',
  'skill-doctor',
  'list-agents',
  'config'
])

/** Shown before Corvid has ever started: the two that matter most, so the popup isn't empty. */
export const FALLBACK_COMMANDS: SlashCommand[] = [
  { name: 'compact', description: 'Free up context by summarizing the conversation so far', argumentHint: '<optional custom summarization instructions>', source: 'builtin' },
  { name: 'context', description: 'Show current context usage', source: 'builtin' }
]

/** "/name" at the very start, then a space, a line break or the end: "/etc/hosts", "/ hi" and "//x" don't count. */
const LEADING = /^\/([A-Za-z][\w:.-]*)(?=\s|$)/

/** The name a message starts with, if it starts like a command at all (known or not), lowercased. */
export function leadingCommand(text: string): string | null {
  return LEADING.exec(text)?.[1].toLowerCase() ?? null
}

export function findCommand(name: string, list: SlashCommand[]): SlashCommand | undefined {
  const n = name.toLowerCase()
  return list.find((c) => c.name.toLowerCase() === n) ?? list.find((c) => c.aliases?.some((a) => a.toLowerCase() === n))
}

/** The command a message runs: a known name first thing in the box, and what follows it. */
export function parseCommand(text: string, list: SlashCommand[]): { cmd: SlashCommand; typed: string; args: string } | null {
  const m = LEADING.exec(text)
  if (!m) return null
  const cmd = findCommand(m[1], list)
  return cmd ? { cmd, typed: m[1], args: text.slice(m[0].length).trim() } : null
}

/** The popup's query: only while the caret is in a "/word" that starts the box. */
export function commandAt(text: string, caret: number): { start: number; query: string } | null {
  if (text[0] !== '/' || caret < 1) return null
  const query = text.slice(1, caret)
  if (!/^[\w:.-]*$/.test(query)) return null
  // the rest of the word after the caret mustn't hold another "/" either (a path being edited)
  if (/^\S*\//.test(text.slice(caret))) return null
  return { start: 0, query }
}

/** One row of /help, and the "/name args" label. */
export const commandLabel = (c: SlashCommand): string => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ''}`

export const SOURCE_LABEL: Record<CommandSource, string> = { builtin: 'built in', custom: 'custom', skill: 'skill', dashboard: 'dashboard', extension: 'extension' }
