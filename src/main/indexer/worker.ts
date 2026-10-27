import { parentPort, workerData } from 'node:worker_threads'
import { promises as fsp, watch, existsSync, mkdirSync, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import type {
  LiveTokens,
  MinuteBucket,
  SearchHit,
  SessionActivity,
  SessionSummary,
  TokenTotals,
  TranscriptEntry,
  UsageStats
} from '@shared/types'
import { addTokens, emptyTokens, estimateCost } from '@shared/models'
import { applyRecord, finalize, localDay, newState, parseLine, readLines, type SessionState } from './parse'

interface Init {
  projectsRoot: string
  cacheDir: string
}

const { projectsRoot, cacheDir } = workerData as Init
const CACHE_VERSION = 6
/** Activity is only streamed for sessions touched this recently. */
const ACTIVITY_WINDOW = 6 * 3600_000
const indexFile = join(cacheDir, 'index.json')
const textDir = join(cacheDir, 'text')
mkdirSync(textDir, { recursive: true })

const RS = '\u001e'
const US = '\u001f'

const states = new Map<string, SessionState>()
const textCache = new Map<string, TranscriptEntry[]>()
const minutes = new Map<number, MinuteBucket>()

const post = (msg: unknown): void => parentPort!.postMessage(msg)

// ---------- persistence ----------

async function loadCache(): Promise<void> {
  try {
    const raw = JSON.parse(await fsp.readFile(indexFile, 'utf8'))
    if (raw.version !== CACHE_VERSION) return
    for (const st of raw.states as SessionState[]) states.set(st.summary.id, st)
    for (const b of (raw.minutes ?? []) as MinuteBucket[]) minutes.set(b.t, b)
  } catch {
    /* first run or corrupt cache: full scan */
  }
}

let saveTimer: NodeJS.Timeout | null = null
function scheduleSave(delay = 8000): void {
  if (saveTimer) return
  saveTimer = setTimeout(async () => {
    saveTimer = null
    const tmp = indexFile + '.tmp'
    await fsp.writeFile(
      tmp,
      JSON.stringify({ version: CACHE_VERSION, states: [...states.values()], minutes: [...minutes.values()] })
    )
    await fsp.rename(tmp, indexFile)
  }, delay)
}

// ---------- parsing ----------

function minuteSink(ts: number, t: TokenTotals): void {
  const now = Date.now()
  if (ts < now - 2 * 3600_000 || ts > now + 60_000) return
  const key = Math.floor(ts / 60_000) * 60_000
  const b = minutes.get(key) ?? { t: key, output: 0, input: 0 }
  b.output += t.output
  b.input += t.input + t.cacheRead + t.cacheWrite
  minutes.set(key, b)
  liveDirty = true
}

function textPath(id: string): string {
  return join(textDir, `${id}.txt`)
}

async function parseSession(projectDir: string, id: string, file: string): Promise<SessionState | null> {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch {
    return null
  }
  let st = states.get(id)
  const fresh = !st || stat.size < (st.offsets[file] ?? 0)
  if (st && !fresh && st.mtime === stat.mtimeMs && st.summary.sizeBytes === stat.size && !st.summary.deleted) {
    return st
  }
  if (fresh) {
    st = newState(id, file, projectDir)
    textCache.delete(id)
    await fsp.rm(textPath(id), { force: true })
  }
  const state = st!
  state.summary.deleted = false
  state.summary.file = file

  const pending: string[] = []
  const sink = {
    onUsage: minuteSink,
    onText: (role: 'u' | 'a', ts: number, text: string) => {
      pending.push(`${role}${US}${ts}${US}${text.replaceAll(RS, ' ').replaceAll(US, ' ')}${RS}`)
    }
  }

  state.offsets[file] = await readLines(file, state.offsets[file] ?? 0, (line) => {
    const rec = parseLine(line)
    if (rec) applyRecord(state, rec, sink)
  })

  // Subagent transcripts: tokens count toward the parent session, tool calls feed its activity.
  const subDir = join(projectsRoot, projectDir, id, 'subagents')
  if (existsSync(subDir)) {
    const names = await fsp.readdir(subDir).catch(() => [] as string[])
    for (const name of names.filter((n) => n.endsWith('.meta.json'))) {
      const agentId = name.replace('.meta.json', '')
      if (state.summary.subagents.some((a) => a.id === agentId)) continue
      try {
        const meta = JSON.parse(await fsp.readFile(join(subDir, name), 'utf8'))
        state.summary.subagents.push({ id: agentId, type: meta.agentType || 'agent', description: meta.description || '' })
      } catch {
        /* meta not written yet */
      }
    }
    for (const name of names.filter((n) => n.endsWith('.jsonl'))) {
      const p = join(subDir, name)
      const agentId = name.slice(0, -6)
      const agent = state.summary.subagents.find((a) => a.id === agentId) ?? { id: agentId, type: 'agent', description: '' }
      state.offsets[p] = await readLines(p, state.offsets[p] ?? 0, (line) => {
        const rec = parseLine(line)
        if (rec) applyRecord(state, rec, sink, agent)
      }).catch(() => state.offsets[p] ?? 0)
    }
  }

  state.mtime = stat.mtimeMs
  state.summary.sizeBytes = stat.size
  finalize(state)
  states.set(id, state)

  if (pending.length) {
    await fsp.appendFile(textPath(id), pending.join(''))
    const cached = textCache.get(id)
    if (cached) for (const p of pending) cached.push(decodeEntry(p.slice(0, -1)))
  }
  return state
}

async function listSessionFiles(): Promise<{ projectDir: string; id: string; file: string }[]> {
  const out: { projectDir: string; id: string; file: string }[] = []
  const dirs = await fsp.readdir(projectsRoot, { withFileTypes: true }).catch(() => [])
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const names = await fsp.readdir(join(projectsRoot, d.name)).catch(() => [] as string[])
    for (const n of names) {
      if (n.endsWith('.jsonl')) out.push({ projectDir: d.name, id: n.slice(0, -6), file: join(projectsRoot, d.name, n) })
    }
  }
  return out
}

async function fullScan(): Promise<void> {
  const files = await listSessionFiles()
  const seen = new Set<string>()
  let done = 0
  let lastPost = 0
  for (const f of files) {
    seen.add(f.id)
    try {
      await parseSession(f.projectDir, f.id, f.file)
    } catch (e) {
      console.error('[indexer] failed', f.file, e)
    }
    done++
    if (Date.now() - lastPost > 150) {
      lastPost = Date.now()
      post({ type: 'progress', progress: { done, total: files.length, ready: false } })
    }
  }
  for (const [id, st] of states) {
    if (seen.has(id)) continue
    if (st.summary.junk) states.delete(id)
    else st.summary.deleted = true
  }
  post({ type: 'progress', progress: { done, total: files.length, ready: true } })
  post({ type: 'sessions', sessions: summaries() })
  post({ type: 'activity', items: recentActivity(), replace: true })
  pushStats()
  liveDirty = true
  scheduleSave(500)
}

function recentActivity(): SessionActivity[] {
  const cutoff = Date.now() - ACTIVITY_WINDOW
  return [...states.values()].filter((s) => !s.summary.junk && s.summary.lastActivity >= cutoff).map((s) => s.activity)
}

function summaries(): SessionSummary[] {
  return [...states.values()].map((s) => s.summary).filter((s) => !s.junk)
}

// ---------- live updates ----------

const pendingFiles = new Map<string, NodeJS.Timeout>()
let watcher: FSWatcher | null = null
/** No projects folder yet (Claude Code not installed or never run): the safety-net poll starts the watch once it
 *  appears, instead of a failed watch and a stack trace at every start (#178). */
let waitingForFolder = false

function startWatch(): void {
  waitingForFolder = !existsSync(projectsRoot)
  if (waitingForFolder) {
    console.log(`[indexer] ${projectsRoot} doesn't exist yet; watching it once it does`)
    return
  }
  try {
    watcher = watch(projectsRoot, { recursive: true }, (_evt, filename) => {
      if (!filename || !filename.endsWith('.jsonl')) return
      const parts = filename.split(/[\\/]/)
      if (parts.length < 2) return
      const projectDir = parts[0]
      const id = parts.length === 2 ? parts[1].slice(0, -6) : parts[1]
      const key = `${projectDir}/${id}`
      clearTimeout(pendingFiles.get(key))
      pendingFiles.set(
        key,
        setTimeout(() => {
          pendingFiles.delete(key)
          void updateOne(projectDir, id)
        }, 350)
      )
    })
  } catch (e) {
    console.error(`[indexer] watch failed, falling back to polling: ${e instanceof Error ? e.message : e}`)
  }
}

async function updateOne(projectDir: string, id: string): Promise<void> {
  const file = join(projectsRoot, projectDir, `${id}.jsonl`)
  const st = await parseSession(projectDir, id, file).catch(() => null)
  if (!st) return
  if (!st.summary.junk) {
    post({ type: 'updated', sessions: [st.summary] })
    post({ type: 'activity', items: [st.activity] })
  }
  statsDirty = true
  scheduleSave()
}

let liveDirty = true
let statsDirty = false

function liveTokens(): LiveTokens {
  const now = Date.now()
  const cutoff = Math.floor((now - 60 * 60_000) / 60_000) * 60_000
  for (const k of minutes.keys()) if (k < now - 2 * 3600_000) minutes.delete(k)
  const list: MinuteBucket[] = []
  for (let t = cutoff; t <= now; t += 60_000) list.push(minutes.get(t) ?? { t, output: 0, input: 0 })

  const today = localDay(now)
  const tot = emptyTokens()
  let costUsd = 0
  let messages = 0
  let sessions = 0
  for (const st of states.values()) {
    const day = st.daily[today]
    if (!day) continue
    sessions++
    for (const [fam, b] of Object.entries(day)) {
      addTokens(tot, b)
      messages += b.msgs
      costUsd += estimateCost(fam, b)
    }
  }
  return { minutes: list, today: { ...tot, costUsd, messages, sessions } }
}

function computeStats(): UsageStats {
  const now = new Date()
  const days: string[] = []
  for (let i = 13; i >= 0; i--) days.push(localDay(now.getTime() - i * 86400_000))
  const dayIndex = new Map(days.map((d, i) => [d, i]))
  const daily = days.map((date) => ({ date, byModel: {} as Record<string, number> }))

  const HEAT_DAYS = 28
  const heatCut = localDay(now.getTime() - (HEAT_DAYS - 1) * 86400_000)
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0))
  const projCut = localDay(now.getTime() - 29 * 86400_000)
  const projects = new Map<string, { name: string; cwd: string; output: number; costUsd: number; sessions: number }>()
  const totals = { sessions: 0, costUsd: 0, output: 0, messages: 0 }

  for (const st of states.values()) {
    const s = st.summary
    if (s.junk) continue
    totals.sessions++
    totals.costUsd += s.costUsd
    totals.output += s.tokens.output
    totals.messages += s.assistantMsgs
    let touched = false
    for (const [date, fams] of Object.entries(st.daily)) {
      const i = dayIndex.get(date)
      for (const [fam, b] of Object.entries(fams)) {
        if (i !== undefined) daily[i].byModel[fam] = (daily[i].byModel[fam] || 0) + b.output
        if (date >= projCut) {
          const key = (s.cwd || s.projectDir).toLowerCase()
          const p = projects.get(key) ?? { name: s.projectName, cwd: s.cwd, output: 0, costUsd: 0, sessions: 0 }
          p.output += b.output
          p.costUsd += estimateCost(fam, b)
          if (!touched) {
            p.sessions++
            touched = true
          }
          projects.set(key, p)
        }
      }
    }
    for (const [hk, n] of Object.entries(st.hourly)) {
      if (hk.slice(0, 10) < heatCut) continue
      const d = new Date(`${hk}:00:00`)
      heatmap[d.getDay()][d.getHours()] += n
    }
  }
  const topProjects = [...projects.values()].sort((a, b) => b.costUsd - a.costUsd).slice(0, 8)
  return { daily, heatmap, heatmapDays: HEAT_DAYS, topProjects, totals }
}

function pushStats(): void {
  statsDirty = false
  post({ type: 'stats', stats: computeStats() })
}

setInterval(() => {
  if (liveDirty) {
    liveDirty = false
    post({ type: 'live', live: liveTokens() })
  }
}, 1000)
// Slide the minute window even when nothing is happening.
setInterval(() => (liveDirty = true), 15_000)
setInterval(() => statsDirty && pushStats(), 5000)

// Safety net for missed watch events (and deletions by Claude's cleanup).
setInterval(async () => {
  if (waitingForFolder && existsSync(projectsRoot)) startWatch()
  const files = await listSessionFiles()
  const seen = new Set(files.map((f) => f.id))
  const changed: SessionSummary[] = []
  for (const f of files) {
    const before = states.get(f.id)
    const prev = before ? before.summary.sizeBytes : -1
    const st = await parseSession(f.projectDir, f.id, f.file).catch(() => null)
    if (st && st.summary.sizeBytes !== prev && !st.summary.junk) changed.push(st.summary)
  }
  for (const st of states.values()) {
    if (!seen.has(st.summary.id) && !st.summary.deleted && !st.summary.junk) {
      st.summary.deleted = true
      changed.push(st.summary)
    }
  }
  if (changed.length) {
    post({ type: 'updated', sessions: changed })
    post({ type: 'activity', items: changed.map((s) => states.get(s.id)!.activity) })
    statsDirty = true
    scheduleSave()
  }
}, 90_000)

// ---------- search & transcript ----------

function decodeEntry(raw: string): TranscriptEntry {
  const a = raw.indexOf(US)
  const b = raw.indexOf(US, a + 1)
  return { role: raw[0] === 'u' ? 'user' : 'assistant', ts: Number(raw.slice(a + 1, b)) || 0, text: raw.slice(b + 1) }
}

async function entries(id: string): Promise<TranscriptEntry[]> {
  let list = textCache.get(id)
  if (list) return list
  try {
    const raw = await fsp.readFile(textPath(id), 'utf8')
    list = raw.split(RS).filter(Boolean).map(decodeEntry)
  } catch {
    list = []
  }
  textCache.set(id, list)
  return list
}

async function search(q: string, limit = 120): Promise<SearchHit[]> {
  const needle = q.trim().toLowerCase()
  if (needle.length < 2) return []
  const sessions = summaries().sort((a, b) => b.lastActivity - a.lastActivity)
  const hits: SearchHit[] = []
  for (const s of sessions) {
    const list = await entries(s.id)
    let perSession = 0
    for (let i = list.length - 1; i >= 0 && perSession < 3; i--) {
      const e = list[i]
      const idx = e.text.toLowerCase().indexOf(needle)
      if (idx === -1) continue
      const start = Math.max(0, idx - 60)
      const end = Math.min(e.text.length, idx + needle.length + 140)
      const prefix = start > 0 ? '…' : ''
      const snippet = prefix + e.text.slice(start, end).replace(/\s+/g, ' ')
      // offset of the match inside the whitespace-collapsed snippet
      const before = (prefix + e.text.slice(start, idx)).replace(/\s+/g, ' ')
      hits.push({ sessionId: s.id, role: e.role, ts: e.ts, snippet, matchStart: before.length, matchLength: needle.length })
      perSession++
    }
    if (hits.length >= limit) break
  }
  return hits
}

async function transcript(id: string, limit: number): Promise<TranscriptEntry[]> {
  const list = await entries(id)
  const merged: TranscriptEntry[] = []
  for (const e of list) {
    const last = merged[merged.length - 1]
    if (last && last.role === e.role && e.role === 'assistant') last.text += '\n\n' + e.text
    else merged.push({ ...e })
  }
  return merged.slice(-limit)
}

parentPort!.on('message', async (msg: any) => {
  try {
    if (msg.type === 'search') post({ type: 'result', reqId: msg.reqId, data: await search(msg.q) })
    else if (msg.type === 'transcript')
      post({ type: 'result', reqId: msg.reqId, data: await transcript(msg.id, msg.limit ?? 30) })
    else if (msg.type === 'refresh') await fullScan()
  } catch (e) {
    post({ type: 'result', reqId: msg.reqId, error: String(e) })
  }
})

void (async () => {
  await loadCache()
  if (states.size) {
    post({ type: 'sessions', sessions: summaries() })
    post({ type: 'activity', items: recentActivity(), replace: true })
  }
  startWatch()
  await fullScan()
})()

process.on('exit', () => watcher?.close())
