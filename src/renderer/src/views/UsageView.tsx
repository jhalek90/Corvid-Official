import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import type { QuotaBar } from '@shared/types'
import { refreshQuota, useStore } from '../store'
import { useInScope, useScope } from '../scope'
import { compact, relTime, until, usd } from '../format'
import { DailyBars, FAMILY_LABEL, FAMILY_ORDER, familyColor, Heatmap, Meter, MinuteChart, severity, Sparkline } from '../components/charts'
import { InfoTip } from '../components/Tooltip'
import { localModelLabel } from '@shared/customModels'

const FIVE_H = 5 * 3600_000
const WEEK = 7 * 86400_000

function elapsedPct(bar: QuotaBar | undefined, windowMs: number, now: number): number | undefined {
  if (!bar?.resetsAtMs) return undefined
  return Math.max(0, Math.min(100, (1 - (bar.resetsAtMs - now) / windowMs) * 100))
}

export function useNow(ms = 30_000): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(t)
  }, [ms])
  return now
}

export function UsageView(): ReactNode {
  const quota = useStore((s) => s.quota)
  const loading = useStore((s) => s.quotaLoading)
  const live = useStore((s) => s.liveTokens)
  const stats = useStore((s) => s.stats)
  const liveSessions = useStore((s) => s.liveSessions)
  const customModels = useStore((s) => s.config?.models)
  const now = useNow(15_000)
  // usage is account wide; the project switcher (#77) only marks its project in Top projects
  const scope = useScope()
  const inScope = useInScope()

  const session = quota?.session
  const sessionElapsed = elapsedPct(session, FIVE_H, now)
  const minutes = live?.minutes ?? []
  const last5 = minutes.slice(-5).reduce((a, b) => a + b.output, 0) / 5
  const lastHour = minutes.reduce((a, b) => a + b.output, 0)
  const busy = liveSessions.filter((l) => l.status === 'busy').length

  const families = useMemo(() => {
    const present = new Set<string>()
    for (const d of stats?.daily ?? []) for (const [f, v] of Object.entries(d.byModel)) if (v > 0) present.add(f)
    return FAMILY_ORDER.filter((f) => present.has(f))
  }, [stats])

  const projMax = Math.max(1e-9, ...(stats?.topProjects ?? []).map((p) => p.costUsd))

  return (
    <div className="usage" data-tour="usage.view">
      <div className="usage-inner">
        <div className="span-12 page-head">
          <div>
            <h2>Usage</h2>
            <p>
              Costs are API-equivalent estimates{' '}
              <InfoTip tip="Quota comes from claude /usage. Token counts are read live from your local transcripts. Costs are API-equivalent estimates." />
            </p>
          </div>
          <button className="btn" onClick={() => void refreshQuota()} disabled={loading}>
            <RefreshCw size={14} className={loading ? 'spin' : ''} /> {loading ? 'Checking…' : 'Refresh quota'}
          </button>
        </div>

        <div className="card quota-hero span-12">
          <div className="quota-main">
            <div className="section-label">Current 5-hour session</div>
            <div className="hero-num">
              {session ? session.pct : '–'}
              <small>%</small>
            </div>
            <Meter pct={session?.pct ?? 0} large elapsedPct={sessionElapsed} />
            <div className="muted quota-resets">
              {session ? (
                <>
                  Resets in <b style={{ color: 'var(--text)' }}>{until(session.resetsAtMs, now)}</b> · {session.resetsAt}
                </>
              ) : quota?.error ? (
                <span style={{ color: 'var(--danger)' }}>{quota.error}</span>
              ) : (
                'Fetching…'
              )}
            </div>
          </div>
          <div className="quota-rows">
            {(quota?.weeks ?? []).map((w) => (
              <div className="quota-row" key={w.label}>
                <div className="top">
                  <span className="quota-row-label">
                    Week · {w.label} <span className="muted">· resets in {until(w.resetsAtMs, now)}</span>
                  </span>
                  <b style={{ color: w.pct >= 70 ? severity(w.pct) : 'var(--text)' }}>{w.pct}%</b>
                </div>
                <Meter pct={w.pct} elapsedPct={elapsedPct(w, WEEK, now)} />
              </div>
            ))}
            {quota && quota.notes.length > 0 && <UsageNotes notes={quota.notes} />}
            <div className="muted quota-foot">
              {quota ? `Checked ${relTime(quota.fetchedAt, now)} ` : ''}
              <InfoTip tip="The tick on each bar marks time elapsed, so a fill to the right of the tick means you're ahead of pace." />
            </div>
          </div>
        </div>

        <div className="card tile span-3">
          <div className="label">Output tokens / min</div>
          <div className="value" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {compact(last5)}
            {busy > 0 && <span className="dot busy" title={`${busy} session(s) working`} />}
          </div>
          <Sparkline values={minutes.slice(-20).map((m) => m.output)} width={140} height={22} />
          <div className="sub">5-min average · {compact(lastHour)} in the last hour</div>
        </div>
        <div className="card tile span-3">
          <div className="label">Output today</div>
          <div className="value">{compact(live?.today.output ?? 0)}</div>
          <div className="sub">
            {compact((live?.today.cacheRead ?? 0) + (live?.today.input ?? 0) + (live?.today.cacheWrite ?? 0))} context tokens
            processed
          </div>
        </div>
        <div className="card tile span-3">
          <div className="label">Replies today</div>
          <div className="value">{(live?.today.messages ?? 0).toLocaleString()}</div>
          <div className="sub">across {live?.today.sessions ?? 0} sessions</div>
        </div>
        <div className="card tile span-3">
          <div className="label">Est. value today</div>
          <div className="value">{usd(live?.today.costUsd ?? 0)}</div>
          <div className="sub">API-equivalent · {usd(stats?.totals.costUsd ?? 0)} all indexed time</div>
        </div>

        <div className="card chart-card span-12">
          <div className="head">
            <div>
              <h3>Live output</h3>
              <p>Output tokens per minute across all sessions, last 60 minutes</p>
            </div>
            <span className="chip">
              <span className="dot busy" style={{ width: 6, height: 6 }} /> live
            </span>
          </div>
          <MinuteChart data={minutes} />
        </div>

        <div className="card chart-card span-7">
          <div className="head">
            <div>
              <h3>Daily output by model</h3>
              <p>Output tokens, last 14 days</p>
            </div>
            <div className="legend">
              {families.map((f) => (
                <span key={f}>
                  <span className="model-swatch" style={{ background: familyColor(f) }} />
                  {FAMILY_LABEL[f]}
                </span>
              ))}
            </div>
          </div>
          {stats && <DailyBars data={stats.daily} />}
        </div>

        <div className="card chart-card span-5">
          <div className="head">
            <div>
              <h3>When you work</h3>
              <p>Replies by weekday and hour, last {stats?.heatmapDays ?? 28} days</p>
            </div>
          </div>
          {stats && <Heatmap data={stats.heatmap} days={stats.heatmapDays} />}
        </div>

        <div className="card chart-card span-7">
          <div className="head">
            <div>
              <h3>Top projects</h3>
              <p>Est. API-equivalent value, last 30 days</p>
            </div>
          </div>
          <div className="barlist usage-projects">
            {(stats?.topProjects ?? []).map((p) => (
              <div className={`item${scope && inScope(p.cwd) ? ' scope-hit' : ''}`} key={p.cwd}>
                <div className="label" title={p.cwd}>
                  {p.name}
                </div>
                <div className="track">
                  <div className="fill" style={{ width: `${(p.costUsd / projMax) * 100}%`, background: 'var(--opus)' }} />
                </div>
                <div className="val">
                  {usd(p.costUsd)} <span className="muted">· {compact(p.output)}</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="card chart-card span-5">
          <div className="head">
            <div>
              <h3>All indexed time</h3>
              <p>Everything in your local transcripts, including sessions Claude Code has since deleted</p>
            </div>
          </div>
          <div className="usage-figures">
            <Figure label="Sessions" value={(stats?.totals.sessions ?? 0).toLocaleString()} />
            <Figure label="Replies" value={compact(stats?.totals.messages ?? 0)} />
            <Figure label="Output tokens" value={compact(stats?.totals.output ?? 0)} />
            <Figure label="Est. value" value={usd(stats?.totals.costUsd ?? 0)} />
          </div>
        </div>

        {/* sessions on the user's own models (#317): kept out of every figure above, one quiet line per model */}
        {(stats?.local ?? []).length > 0 && (
          <div className="span-12 muted usage-local">
            {stats!.local.map((l) => (
              <div key={l.model}>
                {localModelLabel(customModels, l.model)}: {compact(l.tokens)} tokens this week, no plan usage
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Figure({ label, value }: { label: string; value: string }): ReactNode {
  return (
    <div className="usage-figure">
      <div className="muted" style={{ fontSize: 12 }}>
        {label}
      </div>
      <div className="num">{value}</div>
    </div>
  )
}

// The notes are parsed from `claude /usage` text, whose wording can change: only a leading "Last <n><unit>"
// becomes the title and only a leading "NN%" a number; anything else is shown as it came.
const NOTE_HEAD = /^(Last\s+\d+\s*[a-z]+)\b[\s·•,:;|–—-]*(.*)$/i
const NOTE_PCT = /^(\d{1,3}(?:[.,]\d+)?\s?%)\s*(\S.*)$/

function UsageNotes({ notes }: { notes: { heading: string; lines: string[] }[] }): ReactNode {
  return (
    <div className="usage-notes">
      {notes.map((n, i) => {
        const head = NOTE_HEAD.exec(n.heading)
        return (
          <section className="usage-note-group" key={i}>
            <div className="usage-note-head">
              <span className="usage-note-title">{head ? head[1] : n.heading}</span>
              {head?.[2] && <span className="usage-note-facts">{head[2]}</span>}
            </div>
            {n.lines.length > 0 && (
              <ul className="usage-note-lines">
                {n.lines.map((l, j) => {
                  const m = NOTE_PCT.exec(l)
                  return m ? (
                    <li key={j}>
                      <span className="usage-note-pct">{m[1]}</span>
                      <span>{m[2]}</span>
                    </li>
                  ) : (
                    <li key={j} className="plain">
                      {l}
                    </li>
                  )
                })}
              </ul>
            )}
          </section>
        )
      })}
    </div>
  )
}
