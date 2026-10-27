import type { ActivityEvent, SessionActivity } from '@shared/types'

const MAX_EVENTS = 60
const MAX_AGENTS = 12
const MINUTES_KEPT = 30
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

export function newActivity(sessionId: string): SessionActivity {
  return {
    sessionId,
    turnStartedAt: 0,
    turnPrompt: '',
    turnFiles: [],
    turnTools: 0,
    turnOutput: 0,
    lastText: '',
    lastTextAt: 0,
    agents: [],
    minutes: {},
    events: []
  }
}

const base = (p: unknown): string => (typeof p === 'string' ? p.split(/[\\/]/).filter(Boolean).pop() ?? p : '')
const clip = (s: string, n = 120): string => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? one.slice(0, n - 1) + '…' : one
}

/** Human-readable one-liner for a tool call. */
export function toolLabel(name: string, input: any): string {
  const i = input ?? {}
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return clip(i.description || i.command || name)
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return base(i.file_path || i.notebook_path) || name
    case 'Grep':
      return `“${clip(String(i.pattern ?? ''), 60)}”${i.glob ? ` in ${i.glob}` : ''}`
    case 'Glob':
      return clip(String(i.pattern ?? ''))
    case 'WebFetch':
      try {
        return new URL(i.url).host
      } catch {
        return 'web page'
      }
    case 'WebSearch':
      return clip(`“${i.query ?? ''}”`)
    case 'Agent':
    case 'Task':
      return clip(i.description || i.prompt || 'subagent')
    case 'AskUserQuestion':
      return clip(i.questions?.[0]?.question ?? 'question')
    case 'Skill':
      return i.skill ?? name
    case 'ToolSearch':
      return 'loading tools'
    case 'ScheduleWakeup':
      return clip(i.reason || `wake in ${i.delaySeconds}s`)
    default:
      if (name.startsWith('mcp__')) {
        const parts = name.split('__')
        return parts.slice(1).join(' · ')
      }
      return name
  }
}

function push(a: SessionActivity, e: ActivityEvent): void {
  a.events.push(e)
  if (a.events.length > MAX_EVENTS) a.events.splice(0, a.events.length - MAX_EVENTS)
}

export function onPrompt(a: SessionActivity, ts: number, text: string): void {
  a.turnStartedAt = ts
  a.turnPrompt = text.slice(0, 400)
  a.turnFiles = []
  a.turnTools = 0
  a.turnOutput = 0
  push(a, { ts, kind: 'prompt', label: clip(text, 140) })
}

export function onOutput(a: SessionActivity, ts: number, output: number): void {
  a.turnOutput += output
  const key = Math.floor(ts / 60_000) * 60_000
  a.minutes[key] = (a.minutes[key] ?? 0) + output
  const cutoff = key - MINUTES_KEPT * 60_000
  for (const k of Object.keys(a.minutes)) if (Number(k) < cutoff) delete a.minutes[k]
}

export function onTool(a: SessionActivity, ts: number, name: string, input: any, agent?: { id: string; type: string; description: string }): void {
  const label = toolLabel(name, input)
  if (agent) {
    let ag = a.agents.find((x) => x.id === agent.id)
    if (!ag) {
      ag = { ...agent, lastTs: ts, lastLabel: label }
      a.agents.push(ag)
      if (a.agents.length > MAX_AGENTS) a.agents.shift()
    }
    ag.lastTs = Math.max(ag.lastTs, ts)
    ag.lastLabel = `${name === 'Bash' || name === 'PowerShell' ? '' : name + ' '}${label}`
    push(a, { ts, kind: 'tool', tool: name, label, agent: agent.description || agent.type })
    return
  }
  a.turnTools++
  if (EDIT_TOOLS.has(name)) {
    const f = input?.file_path || input?.notebook_path
    if (f && !a.turnFiles.includes(f)) a.turnFiles.push(f)
    if (a.turnFiles.length > 50) a.turnFiles.shift()
  }
  push(a, { ts, kind: 'tool', tool: name, label })
}

export function onSay(a: SessionActivity, ts: number, text: string): void {
  a.lastText = text.slice(0, 600)
  a.lastTextAt = ts
  push(a, { ts, kind: 'say', label: clip(text, 160) })
}
