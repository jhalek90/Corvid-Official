import { useState, type ReactNode } from 'react'
import { Sparkles, User } from 'lucide-react'
import type { BoardMessage } from '@shared/board'
import type { CrowLook, Worker } from '@shared/types'
import { agentLook, PLAIN_LOOK } from '@shared/agentAvatar'
import { useStore } from '../store'
import { CrowBadge } from './Crow'
import { EmojiText } from '../emoji'
import { hasUserName, userInitial, userLabel } from '@shared/userName'

// Who shows which face. Agents get their own random crow, made by the main process when the worker
// started and stored on the worker and on every message it posts, so it stays after the worker ends.
// Anything older than that (or a damaged one) is derived from the task id, the same seed main uses,
// so there's never a blank. The user's own crow look stays the assistant's. The user's messages get
// their profile picture, or a round marker in the accent tint with the first letter of their name
// (a person until they set one),
// on the right with their bubbles, so it's never a crow. Only messages the window posted are the
// user's (an agent can't post as them), and old ones show the current picture, as with the name.

/** The avatar sizes, all set in one place: the --av-* lengths at the top of crow.css. */
export const AV = {
  /** the board's chat */
  chat: 'var(--av-chat)',
  /** the agent cards */
  card: 'var(--av-card)',
  /** the open agent's terminal bar */
  bar: 'var(--av-bar)',
  /** the board composer's @ popup */
  mention: 'var(--av-mention)'
} as const

type Size = number | string

const derived = new Map<string, CrowLook>()

/** The seeded crow for a task (or a name, for an agent without one), cached so memoised badges stay put. */
export function seededLook(seed: string | number): CrowLook {
  const key = String(seed)
  let look = derived.get(key)
  if (!look) derived.set(key, (look = agentLook(seed)))
  return look
}

/** A worker's crow: the one main gave it, else its task's seeded one. */
export const workerLook = (w: Worker | undefined, name?: string): CrowLook =>
  w?.avatar ?? seededLook(w?.taskId ?? name ?? 'agent')

/** The crow a board message shows: the one stored with it when the agent posted. */
export const messageLook = (m: BoardMessage): CrowLook => m.avatar ?? seededLook(m.taskId ?? m.agentName ?? 'agent')

/**
 * An agent's crow, or with Random agent avatars off the theme's plain crow with no hat. Decoration:
 * the name always shows as text beside it, and the label repeats it for screen readers.
 */
export function AgentAvatar({ look, name, size = 20, moving }: { look: CrowLook; name: string; size?: Size; moving?: boolean }): ReactNode {
  const on = useStore((s) => s.config?.agentAvatars ?? true)
  return <CrowBadge look={on ? look : PLAIN_LOOK} size={size} label={`Avatar of ${name}`} moving={on && moving} />
}

/** The assistant on the board: the user's own crow look, or a plain marker with the mascot off (as the Corvid strip shows its orb). */
export function AssistantBadge({ size = 20 }: { size?: Size }): ReactNode {
  const crow = useStore((s) => s.config?.crow ?? false)
  const look = useStore((s) => s.config?.crowLook) ?? PLAIN_LOOK
  if (crow) return <CrowBadge look={look} size={size} label="Avatar of Corvid" />
  return (
    <span className="plain-badge" role="img" aria-label="Avatar of Corvid" style={{ width: size, height: size }}>
      <Sparkles aria-hidden />
    </span>
  )
}

/**
 * The user's own face: their profile picture, round with the same rim as the crows, or without one
 * the marker in the accent tint, the colour of their bubbles: their name's first letter, or a person.
 * The picture is decoded once in the store; one that fails here falls back to the marker.
 */
export function UserBadge({ name, size = 20 }: { name?: string; size?: Size }): ReactNode {
  const url = useStore((s) => s.userAvatar)
  const [broken, setBroken] = useState<string | null>(null)
  const named = hasUserName(name)
  const label = named ? userLabel(name) : 'You'
  if (url && url !== broken)
    return (
      <span className="user-pic" role="img" aria-label={label} style={{ width: size, height: size }}>
        <img src={url} alt="" draggable={false} onError={() => setBroken(url)} />
      </span>
    )
  return (
    <span
      className={`plain-badge you${named ? ' initial' : ''}`}
      role="img"
      aria-label={label}
      style={{ width: size, height: size, ...(named ? { fontSize: `calc(${typeof size === 'number' ? `${size}px` : size} * 0.46)` } : {}) }}
    >
      {named ? <EmojiText text={userInitial(name)} /> : <User aria-hidden />}
    </span>
  )
}
