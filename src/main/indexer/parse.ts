import { promises as fsp } from 'node:fs'
import { basename } from 'node:path'
import type { SessionActivity, SessionSummary, TokenTotals } from '@shared/types'
import { addTokens, emptyTokens, estimateCost, modelFamily } from '@shared/models'
import { newActivity, onOutput, onPrompt, onSay, onTool } from './activity'

export interface AgentRef {
  id: string
  type: string
  description: string
}

/** Persisted per-session parse state. Everything needed to resume parsing from `offsets`. */
export interface SessionState {
  summary: SessionSummary
  offsets: Record<string, number>
  mtime: number
  recentIds: string[]
  titles: { custom?: string; ai?: string; summary?: string }
  tokensByModel: Record<string, TokenTotals>
  /** local date -> model family (the model itself for a local session) -> tokens + assistant message count */
  daily: Record<string, Record<string, TokenTotals & { msgs: number }>>
  /** local "YYYY-MM-DDTHH" -> assistant messages */
  hourly: Record<string, number>
  /** characters the user typed before the first reply, to back their prompt out of baseContext */
  preReplyChars: number
  activity: SessionActivity
}

export interface ParseSink {
  /** Called for every new assistant message with usage, for live minute buckets. */
  onUsage?: (ts: number, t: TokenTotals) => void
  /** Called with transcript text to append to the search store. */
  onText?: (role: 'u' | 'a', ts: number, text: string) => void
}

const SKIP_PREFIXES = [
  '{"type":"api-request',
  '{"type":"file-history',
  '{"type":"queue-operation',
  '{"type":"atis-latch',
  '{"type":"mode"',
  '{"type":"bridge-session'
]

const STRIP_TAGS =
  /<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics|local-command-caveat|local-command-stdout|local-command-stderr|command-message|user-prompt-submit-hook|bash-stdout|bash-stderr|bash-input)>[\s\S]*?<\/\1>/g

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const MAX_ENTRY = 6000
const MAX_PROMPT = 600

export function localDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function localHour(ts: number): string {
  return `${localDay(ts)}T${String(new Date(ts).getHours()).padStart(2, '0')}`
}

export function newState(id: string, file: string, projectDir: string, local = false): SessionState {
  return {
    summary: {
      id,
      file,
      projectDir,
      ...(local ? { local: true } : {}),
      cwd: '',
      projectName: projectDir,
      title: '',
      firstPrompt: '',
      lastPrompt: '',
      startedAt: 0,
      lastActivity: 0,
      userTurns: 0,
      assistantMsgs: 0,
      toolCalls: 0,
      tools: {},
      models: {},
      tokens: emptyTokens(),
      costUsd: 0,
      context: 0,
      peakContext: 0,
      baseContext: 0,
      subagents: [],
      editedFiles: {},
      dailyOutput: {},
      activeHours: 0,
      sizeBytes: 0,
      deleted: false,
      junk: true
    },
    offsets: {},
    mtime: 0,
    recentIds: [],
    titles: {},
    tokensByModel: {},
    daily: {},
    hourly: {},
    preReplyChars: 0,
    activity: newActivity(id)
  }
}

export function cleanUserText(raw: string): string {
  let text = raw
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, (_, n: string) => n.trim())
    .replace(/<command-args>([\s\S]*?)<\/command-args>/g, (_, a: string) => (a.trim() ? ` ${a.trim()}` : ''))
    .replace(STRIP_TAGS, '')
    .replace(/<\/?pasted_content[^>]*>/g, '')
  text = text.trim()
  return text
}

function blocksText(content: unknown): { text: string; hasToolResult: boolean } {
  if (typeof content === 'string') return { text: content, hasToolResult: false }
  if (!Array.isArray(content)) return { text: '', hasToolResult: false }
  let text = ''
  let hasToolResult = false
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'tool_result') hasToolResult = true
    else if (b.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text
  }
  return { text, hasToolResult }
}

function usageTotals(u: Record<string, number> | undefined): TokenTotals {
  if (!u) return emptyTokens()
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0
  }
}

/** Apply one parsed transcript record to the state. `agent` is set for subagent transcripts. */
export function applyRecord(st: SessionState, rec: any, sink: ParseSink, agent?: AgentRef): void {
  const s = st.summary
  const type = rec.type
  const tokensOnly = !!agent
  if (!tokensOnly) {
    if (type === 'ai-title' && rec.aiTitle) st.titles.ai = rec.aiTitle
    else if (type === 'custom-title' && rec.customTitle) st.titles.custom = rec.customTitle
    else if (type === 'summary' && rec.summary) st.titles.summary = rec.summary
    if (rec.cwd && !s.cwd) s.cwd = rec.cwd
    if (rec.gitBranch) s.gitBranch = rec.gitBranch
    if (rec.entrypoint && !s.entrypoint) s.entrypoint = rec.entrypoint
    // Unknown until the next reply reports the compacted size.
    if (type === 'system' && rec.subtype === 'compact_boundary') s.context = 0
  }
  if (type !== 'user' && type !== 'assistant') return

  const ts = Date.parse(rec.timestamp)
  const hasTs = Number.isFinite(ts)
  const msg = rec.message
  if (!msg || typeof msg !== 'object') return

  if (type === 'user') {
    if (tokensOnly || rec.isMeta || rec.isSidechain) return
    const { text, hasToolResult } = blocksText(msg.content)
    if (hasToolResult) return
    const clean = cleanUserText(text)
    if (!clean) return
    s.userTurns++
    if (!s.baseContext) st.preReplyChars += clean.length
    if (!s.firstPrompt) s.firstPrompt = clean.slice(0, MAX_PROMPT)
    s.lastPrompt = clean.slice(0, MAX_PROMPT)
    if (hasTs) touch(s, ts)
    sink.onText?.('u', hasTs ? ts : 0, clean.slice(0, MAX_ENTRY))
    onPrompt(st.activity, hasTs ? ts : s.lastActivity, clean)
    return
  }

  // assistant
  const model: string = msg.model || 'unknown'
  if (model === '<synthetic>') return
  const id: string | undefined = msg.id
  const isNew = !id || !st.recentIds.includes(id)
  if (isNew) {
    if (id) {
      st.recentIds.push(id)
      if (st.recentIds.length > 24) st.recentIds.shift()
    }
    const t = usageTotals(msg.usage)
    if (!tokensOnly && !rec.isSidechain && msg.usage) {
      const ctx = t.input + t.cacheRead + t.cacheWrite
      // ~4 chars per token; whatever is left over is what every turn pays for regardless.
      if (!s.baseContext) s.baseContext = Math.max(1, ctx - Math.round(st.preReplyChars / 4))
      s.context = ctx
      if (ctx > s.peakContext) s.peakContext = ctx
    }
    addTokens(s.tokens, t)
    addTokens((st.tokensByModel[model] ??= emptyTokens()), t)
    if (!tokensOnly) {
      s.assistantMsgs++
      s.models[model] = (s.models[model] || 0) + 1
    }
    if (hasTs) {
      const day = (st.daily[localDay(ts)] ??= {})
      // a local model's name says nothing about a Claude family, and the Usage page lists local ones by model (#317)
      const fam = s.local ? model : modelFamily(model)
      const b = (day[fam] ??= { ...emptyTokens(), msgs: 0 })
      addTokens(b, t)
      b.msgs++
      const hk = localHour(ts)
      st.hourly[hk] = (st.hourly[hk] || 0) + 1
      sink.onUsage?.(ts, t)
      onOutput(st.activity, ts, t.output)
    }
  }
  if (hasTs && !tokensOnly) touch(s, ts)
  if (rec.isSidechain && !agent) return
  if (!Array.isArray(msg.content)) return
  const evTs = hasTs ? ts : s.lastActivity

  if (agent) {
    for (const b of msg.content) {
      if (b?.type === 'tool_use' && b.name) onTool(st.activity, evTs, b.name, b.input, agent)
    }
    return
  }

  let text = ''
  for (const b of msg.content) {
    if (b?.type === 'text' && typeof b.text === 'string') text += (text ? '\n' : '') + b.text
    else if (b?.type === 'tool_use' && b.name) {
      s.toolCalls++
      s.tools[b.name] = (s.tools[b.name] || 0) + 1
      onTool(st.activity, evTs, b.name, b.input)
      const edited = EDIT_TOOLS.has(b.name) ? b.input?.file_path || b.input?.notebook_path : undefined
      if (typeof edited === 'string') s.editedFiles[edited] = (s.editedFiles[edited] || 0) + 1
    }
  }
  if (text.trim()) {
    sink.onText?.('a', evTs, text.slice(0, MAX_ENTRY))
    onSay(st.activity, evTs, text)
  }
}

function touch(s: SessionSummary, ts: number): void {
  if (!s.startedAt || ts < s.startedAt) s.startedAt = ts
  if (ts > s.lastActivity) s.lastActivity = ts
}

/** Derive the display fields after records were applied. */
export function finalize(st: SessionState): void {
  const s = st.summary
  s.title =
    st.titles.custom ||
    st.titles.ai ||
    st.titles.summary ||
    (s.firstPrompt ? s.firstPrompt.split('\n')[0].slice(0, 80) : '') ||
    'Untitled session'
  if (s.cwd) s.projectName = basename(s.cwd.replace(/[\\/]+$/, '')) || s.cwd
  s.dailyOutput = {}
  for (const [date, fams] of Object.entries(st.daily)) {
    s.dailyOutput[date] = Object.values(fams).reduce((a, b) => a + b.output, 0)
  }
  s.activeHours = Object.keys(st.hourly).length
  // a local model has no API price; estimateCost would price its unknown name like Sonnet (#317)
  s.costUsd = s.local ? 0 : Object.entries(st.tokensByModel).reduce((acc, [m, t]) => acc + estimateCost(m, t), 0)
  s.junk = s.assistantMsgs === 0
}

/**
 * Stream a JSONL file from `offset`, calling `onLine` with each complete line as a Buffer.
 * Returns the offset just past the last complete line (a partial trailing line is left
 * for next time, since the writer may still be mid-line).
 */
export async function readLines(file: string, offset: number, onLine: (line: Buffer) => void): Promise<number> {
  const fh = await fsp.open(file, 'r')
  try {
    const size = (await fh.stat()).size
    if (offset > size) offset = 0
    let pos = offset
    let carry: Buffer | null = null
    const chunk = Buffer.allocUnsafe(1 << 20)
    while (pos < size) {
      const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos)
      if (!bytesRead) break
      pos += bytesRead
      const view = chunk.subarray(0, bytesRead)
      const data: Buffer = carry ? Buffer.concat([carry, view]) : view
      let start = 0
      let nl: number
      while ((nl = data.indexOf(10, start)) !== -1) {
        if (nl > start) onLine(data.subarray(start, nl))
        start = nl + 1
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : null
    }
    return pos - (carry?.length ?? 0)
  } finally {
    await fh.close()
  }
}

export function parseLine(line: Buffer): any | null {
  const head = line.toString('latin1', 0, Math.min(40, line.length))
  for (const p of SKIP_PREFIXES) if (head.startsWith(p)) return null
  try {
    return JSON.parse(line.toString('utf8'))
  } catch {
    return null
  }
}
