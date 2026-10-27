import { app } from 'electron'
import { execFile } from 'node:child_process'
import type { QuotaBar, UsageQuota } from '@shared/types'
import { CLAUDE_NOT_FOUND, resolveClaude } from './claudeBin'
import { getConfig } from './config'
import { isTestCopy } from './dataDir'

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

/** "Oct 19, 3:19am (America/Chicago)" -> epoch ms in local time. */
export function parseReset(text: string, now = new Date()): number | undefined {
  const m = /(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text)
  if (!m) return undefined
  let hour = parseInt(m[3], 10) % 12
  if (m[5].toLowerCase() === 'pm') hour += 12
  const minute = m[4] ? parseInt(m[4], 10) : 0
  const d = new Date(now)
  d.setSeconds(0, 0)
  if (m[1]) {
    const month = MONTHS.indexOf(m[1].toLowerCase())
    if (month < 0) return undefined
    d.setMonth(month, parseInt(m[2], 10))
  }
  d.setHours(hour, minute)
  if (d.getTime() < now.getTime() - 86400_000) d.setFullYear(d.getFullYear() + 1)
  else if (!m[1] && d.getTime() < now.getTime()) d.setDate(d.getDate() + 1)
  return d.getTime()
}

export function parseUsage(out: string): UsageQuota {
  const q: UsageQuota = { fetchedAt: Date.now(), weeks: [], notes: [] }
  const re = /^\s*Current (session|week(?:\s*\(([^)]+)\))?):\s*(\d+)%\s*used\s*\S?\s*resets\s+(.+?)\s*$/gim
  let m: RegExpExecArray | null
  while ((m = re.exec(out))) {
    const resetsAt = m[4].replace(/\s*\([^)]*\)\s*$/, '')
    const bar: QuotaBar = {
      label: m[1].toLowerCase() === 'session' ? 'Current session' : m[2] ? m[2][0].toUpperCase() + m[2].slice(1) : 'All models',
      pct: parseInt(m[3], 10),
      resetsAt,
      resetsAtMs: parseReset(resetsAt)
    }
    if (m[1].toLowerCase() === 'session') q.session = bar
    else q.weeks.push(bar)
  }
  // "Last 24h · 66 requests · 1 session" followed by indented detail lines.
  let section: { heading: string; lines: string[] } | null = null
  for (const line of out.split(/\r?\n/)) {
    if (/^Last \d+\s*[hdw]\b/.test(line.trim())) {
      section = { heading: line.trim(), lines: [] }
      q.notes.push(section)
    } else if (section && /^\s+\S/.test(line)) section.lines.push(line.trim())
    else if (!line.trim()) section = null
  }
  if (!q.session && !q.weeks.length) q.error = out.trim().split(/\r?\n/).slice(0, 3).join(' ') || 'No output'
  return q
}

let latest: UsageQuota | null = null
let timer: NodeJS.Timeout | null = null
let inflight: Promise<UsageQuota> | null = null

/** A test copy can fake the Fable weekly limit (#127): DASH_FAKE_FABLE=<pct> adds or sets it, "none" removes it. */
function fakeFable(q: UsageQuota): UsageQuota {
  const fake = isTestCopy() ? process.env.DASH_FAKE_FABLE : undefined
  if (!fake) return q
  const weeks = q.weeks.filter((w) => !/fable/i.test(w.label))
  if (fake !== 'none') weeks.push({ label: 'Fable', pct: Number(fake), resetsAt: 'Oct 28, 9am', resetsAtMs: Date.now() + 6 * 86400_000 })
  return { ...q, weeks }
}

export function getQuota(): UsageQuota | null {
  return latest
}

export function fetchQuota(onUpdate: (q: UsageQuota) => void): Promise<UsageQuota> {
  if (inflight) return inflight
  inflight = (async () => {
    const bin = await resolveClaude(getConfig().claudePath)
    if (!bin) {
      latest = { fetchedAt: Date.now(), weeks: [], notes: [], error: CLAUDE_NOT_FOUND }
    } else {
      latest = await new Promise<UsageQuota>((resolve) => {
        // --no-session-persistence: a status lookup shouldn't leave a transcript behind.
        execFile(
          bin.path,
          ['--no-session-persistence', '/usage'],
          { cwd: app.getPath('userData'), timeout: 60_000, windowsHide: true, env: { ...process.env, NO_COLOR: '1' } },
          (err, stdout) => {
            if (err && !stdout) resolve({ fetchedAt: Date.now(), weeks: [], notes: [], error: String(err.message) })
            else resolve(fakeFable(parseUsage(stdout)))
          }
        )
      })
    }
    onUpdate(latest)
    return latest
  })().finally(() => (inflight = null))
  return inflight
}

export function startQuotaPolling(onUpdate: (q: UsageQuota) => void): void {
  if (timer) clearInterval(timer)
  void fetchQuota(onUpdate)
  timer = setInterval(() => void fetchQuota(onUpdate), Math.max(60, getConfig().usagePollSec) * 1000)
}
