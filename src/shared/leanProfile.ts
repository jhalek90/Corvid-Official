// The lean worker profile for small-context custom models (#318, step 6 of the plan in N175, section 5, decisions 3
// and 4), and the start-up size check every custom-model worker passes. Lean drops Corvid extras and Claude Code's
// optional tools, never a safety rule: the system line, the board safety rule, the secrets rules, the note data
// warning, the git and merge rules, the Corvid-project rules, the done post, the deny file and Claude Code's own
// prompts and system prompt all stay. Claude workers and full-profile custom workers never come through here.

import type { BoardVoice } from './boardVoice'
import { DEFAULT_MAX_OUTPUT, type CustomModel, type CustomModelProfile } from './customModels'

/**
 * Claude Code's side of a lean session, checked against Claude Code 2.1.312's --help: only the MCP servers from
 * --mcp-config (Corvid's), only the built-in tools a worker needs, and no skills or slash commands.
 */
export const LEAN_CLI_FLAGS = ['--strict-mcp-config', '--tools', 'Bash,Read,Edit,Write,Glob,Grep', '--disable-slash-commands']

/** The board voice a lean worker posts in: plain, whatever Settings say (decision 4). */
export const LEAN_VOICE: BoardVoice = 'plain'

/** Corvid tools a lean worker doesn't get: rewriting and deleting notes, and reading board attachments. */
export const LEAN_DROPPED_TOOLS = ['update_note', 'delete_note', 'read_attachment']

/** `tools` without the ones a lean worker doesn't get. */
export const leanTools = <T extends { name: string }>(tools: T[]): T[] => tools.filter((t) => !LEAN_DROPPED_TOOLS.includes(t.name))

/**
 * Claude Code's own start-up prompt in tokens, per profile: its system prompt and built-in tool descriptions. Full was
 * measured in the QwenTesting spike (N174, about 13.6k). Lean is a guess (N175 guessed 9k to 10k) until the user's own
 * run (step 10 of the plan) measures it; then this number is the one to change.
 */
export const CLAUDE_CODE_START_TOKENS: Record<CustomModelProfile, number> = { full: 13_600, lean: 10_000 }

/** A start is refused when the estimate plus the output reserve is over this share of the server's context. */
export const START_SHARE = 0.7

/** Characters to tokens, the rough way N171 measured Corvid's prompts. */
export const charsToTokens = (chars: number): number => Math.ceil(chars / 4)

/** What a session on `m` would start with, in tokens: Claude Code's side for its profile plus Corvid's `corvidChars`. */
export const startupTokens = (profile: CustomModelProfile, corvidChars: number): number => CLAUDE_CODE_START_TOKENS[profile] + charsToTokens(corvidChars)

const n = (v: number): string => v.toLocaleString('en-US')
const roughly = (v: number): string => n(Math.round(v / 100) * 100)

/**
 * Why a worker on `m` for task #taskId can't start with `corvidChars` of Corvid's prompts, tools and the project's
 * CLAUDE.md, or null. Refused when the start-up estimate plus the output reserve is over START_SHARE of the context:
 * such a worker would overflow on its first file.
 */
export function startupProblem(m: CustomModel, profile: CustomModelProfile, corvidChars: number, taskId: number): string | null {
  const start = startupTokens(profile, corvidChars)
  const reserve = m.maxOutputTokens ?? DEFAULT_MAX_OUTPUT
  const allowed = Math.floor(m.contextTokens * START_SHARE)
  if (start + reserve <= allowed) return null
  return (
    `${m.label} has a context of ${n(m.contextTokens)} tokens, and a worker on #${taskId} needs about ${roughly(start)} just to start plus ${n(reserve)} for its answers, ` +
    `more than the ${Math.round(START_SHARE * 100)}% (${n(allowed)}) Corvid allows. Give the server a bigger context (-c) and the entry with it, or pick another model for #${taskId}.`
  )
}
