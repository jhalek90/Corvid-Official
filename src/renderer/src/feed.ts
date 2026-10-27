// The activity feed across sessions and agents: what the ticker shows one at a time and its panel
// lists in full. Built from the activity the main process already sends (no polling of its own),
// plus one "needs you" row per session waiting on the user, from the live registry.

import { useMemo } from 'react'
import {
  Bot,
  CircleHelp,
  CornerDownRight,
  FilePen,
  FileText,
  Globe,
  Hourglass,
  MessageSquare,
  Plug,
  Search,
  Sparkles,
  Terminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import type { ActivityEvent } from '@shared/types'
import { baseName } from '@shared/projects'
import { openTerminal, showSession, useStore } from './store'

export const FEED_MS = 3 * 3600_000
/** the most rows kept, as the Live view had */
export const FEED_MAX = 150

export function toolIcon(e: ActivityEvent): LucideIcon {
  if (e.kind === 'prompt') return CornerDownRight
  if (e.kind === 'say') return MessageSquare
  const t = e.tool ?? ''
  if (t === 'Bash' || t === 'PowerShell') return Terminal
  if (t === 'Read') return FileText
  if (t === 'Edit' || t === 'Write' || t === 'MultiEdit' || t === 'NotebookEdit') return FilePen
  if (t === 'Grep' || t === 'Glob' || t === 'ToolSearch') return Search
  if (t === 'WebFetch' || t === 'WebSearch') return Globe
  if (t === 'Agent' || t === 'Task') return Bot
  if (t === 'AskUserQuestion') return CircleHelp
  if (t === 'Skill') return Sparkles
  if (t.startsWith('mcp__')) return Plug
  return Wrench
}

export const itemIcon = (f: FeedItem): LucideIcon => (f.e ? toolIcon(f.e) : Hourglass)

// Categorical slots, the theme's lane colours. A session keeps its slot for the app's lifetime.
const LANES = [0, 1, 2, 3, 4, 5, 6, 7].map((i) => `var(--lane-${i})`)
const laneOf = new Map<string, string>()
export function lane(id: string): string {
  let c = laneOf.get(id)
  if (!c) {
    c = LANES[laneOf.size % LANES.length]
    laneOf.set(id, c)
  }
  return c
}

export interface FeedItem {
  key: string
  ts: number
  sessionId: string
  /** the agent's name when Corvid started it with one, otherwise the project */
  who: string
  /** the session's title, for tooltips and the filter */
  title: string
  cwd: string
  /** its terminal here, when it runs in the Agents view */
  termId?: string
  /** an action; unset for a needs-you row */
  e?: ActivityEvent
  /** repeats of the same action, collapsed */
  n: number
  /** set when the session waits on the user: what it waits on, in words */
  needs?: string
}

/** What a row says after who: "Edit app.ts", "npm test", "You: …", or "Needs you: waiting on Bash". */
export function whatOf(f: FeedItem): string {
  if (f.needs) return `Needs you: ${f.needs}`
  const e = f.e!
  if (e.kind === 'prompt') return `You: ${e.label}`
  const tool = e.kind === 'tool' && e.tool && !['Bash', 'PowerShell'].includes(e.tool) && !e.tool.startsWith('mcp__') ? `${e.tool} ` : ''
  return `${e.agent ? `${e.agent}: ` : ''}${tool}${e.label}`
}

/** The last 3 hours across every session, newest first, repeats collapsed, at most FEED_MAX rows. */
export function useFeed(): FeedItem[] {
  const activity = useStore((s) => s.activity)
  const sessions = useStore((s) => s.sessions)
  const liveSessions = useStore((s) => s.liveSessions)
  const terminals = useStore((s) => s.terminals)
  const workers = useStore((s) => s.assistant.workers)

  return useMemo(() => {
    const now = Date.now()
    const liveBySession = new Map(liveSessions.map((l) => [l.sessionId, l]))
    const nameOf = (termId?: string): string | undefined =>
      termId ? (workers.find((w) => w.termId === termId)?.agentName ?? terminals.find((t) => t.termId === termId)?.agentName) : undefined
    const termOf = (sessionId: string): string | undefined =>
      liveBySession.get(sessionId)?.termId ?? terminals.find((t) => t.sessionId === sessionId && t.exited === undefined && !t.side)?.termId

    const rows: FeedItem[] = []
    for (const a of Object.values(activity)) {
      const s = sessions[a.sessionId]
      if (!s || (!liveBySession.has(s.id) && now - s.lastActivity > FEED_MS)) continue
      const termId = termOf(s.id)
      const who = nameOf(termId) ?? s.projectName
      for (const e of a.events)
        if (now - e.ts < FEED_MS) rows.push({ key: `${s.id}-${e.ts}-${e.kind}`, ts: e.ts, sessionId: s.id, who, title: s.title, cwd: s.cwd, termId, e, n: 1 })
    }
    for (const l of liveSessions) {
      if (l.status !== 'waiting' && l.status !== 'blocked') continue
      const s = sessions[l.sessionId]
      const ts = l.statusUpdatedAt || now
      rows.push({
        key: `${l.sessionId}-${ts}-needs`,
        ts,
        sessionId: l.sessionId,
        who: nameOf(l.termId) ?? s?.projectName ?? baseName(l.cwd) ?? 'session',
        title: s?.title ?? l.name ?? 'New session',
        cwd: s?.cwd || l.cwd,
        termId: l.termId,
        n: 1,
        needs: l.waitingFor ? `waiting on ${l.waitingFor}` : 'waiting for your input'
      })
    }
    rows.sort((x, y) => y.ts - x.ts)
    // Collapse runs of the same action ("Edit App.tsx" ×6) into one row.
    const merged: FeedItem[] = []
    for (const r of rows) {
      const prev = merged[merged.length - 1]
      const same = prev && prev.sessionId === r.sessionId && prev.e && r.e && prev.e.kind === r.e.kind && prev.e.tool === r.e.tool && prev.e.label === r.e.label && prev.e.agent === r.e.agent
      if (same) prev.n++
      else merged.push(r)
      if (merged.length > FEED_MAX) break
    }
    return merged.slice(0, FEED_MAX)
  }, [activity, sessions, liveSessions, terminals, workers])
}

/** Where a row leads: the agent's card and terminal here, otherwise the session on its project page. */
export function goTo(f: { sessionId: string; termId?: string; cwd?: string }): void {
  if (f.termId) openTerminal(f.termId)
  else showSession(f.sessionId, f.cwd)
}
