// The user's own name on the board, from Settings ("Your name"). Only ever what the user typed there,
// never anything from the machine. The stored author and address stay 'user', so old messages, and
// agents that still write @user, keep working; the name is only how 'user' shows and one more way to
// address them. Changing it changes how history reads: nothing stored is rewritten.

import { charCount, chars } from './text'

export const USER_NAME_DEFAULT = 'user'
export const USER_NAME_MAX = 24

/** Names nobody may take, so a mention is never ambiguous and nothing passes for Corvid or the app.
 *  Compared the way mentions are (no case, spaces, hyphens or underscores), so "Dashboard-Notice" counts. */
export const RESERVED_USER_NAMES = ['corvid', 'assistant', 'the assistant', 'all', 'everyone', 'dashboard', 'notice', 'dashboard notice', 'system']

/** The same comparison as the board's nameKey, kept here so this file has no import cycle with board.ts. */
const key = (s: string): string => s.toLowerCase().replace(/^@/, '').replace(/[\s_\-'".]+/g, '')

/** How the board shows the user: the name from Settings, or "user". */
export const userLabel = (name: string | undefined): string => (typeof name === 'string' && name.trim()) || USER_NAME_DEFAULT

/** Whether a custom name is set (anything but the default). */
export const hasUserName = (name: string | undefined): boolean => key(userLabel(name)) !== USER_NAME_DEFAULT

/** The marker's letter: the first character of the name, upper-cased (an emoji stays itself). */
export const userInitial = (name: string | undefined): string => (chars(userLabel(name))[0] ?? 'U').toUpperCase()

// Letters (with their accents), numbers, spaces, hyphens, underscores and emoji with their joiners and modifiers.
// Emoji_Component also covers # and *, which are left out: @#12 already means the agent on task 12.
const ALLOWED = /^[\p{L}\p{M}\p{N} _\-\p{Extended_Pictographic}\p{Emoji_Component}\u200d\ufe0f\u20e3]+$/u

/**
 * Check a name typed in Settings. `agents` are the names in use: running agents and every agent named on the board.
 * Returns the name to store ('' for the default "user") or a short, friendly reason it can't be used.
 */
export function checkUserName(raw: string, agents: string[]): { name: string } | { error: string } {
  const name = String(raw ?? '').trim()
  if (!name) return { name: '' }
  if (/[\r\n]/.test(name)) return { error: 'Keep it on one line.' }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f-\x9f]/.test(name)) return { error: 'That has a hidden control character in it. Try typing it again.' }
  if (name.startsWith('@')) return { error: 'Leave off the @: it gets added when someone mentions you.' }
  const n = charCount(name)
  if (n > USER_NAME_MAX) return { error: `That's ${n} characters; ${USER_NAME_MAX} is the most.` }
  if (!ALLOWED.test(name) || /[#*]/.test(name)) return { error: 'Letters, numbers, spaces, hyphens, underscores and emoji only.' }
  const k = key(name)
  if (!k) return { error: 'It needs at least one letter, number or emoji.' }
  // "user" (or "you") is the default, and it is the user anyway
  if (k === USER_NAME_DEFAULT || k === 'you') return { name: '' }
  if (RESERVED_USER_NAMES.some((r) => key(r) === k)) return { error: `"${name}" is taken by Corvid or the app, so a mention could mean either. Pick another.` }
  const agent = agents.find((a) => key(a) === k)
  if (agent) return { error: `An agent is called ${agent}, so a mention could mean either of you. Pick another.` }
  // inner runs of spaces become one, the way names show everywhere else
  return { name: name.replace(/ {2,}/g, ' ') }
}
