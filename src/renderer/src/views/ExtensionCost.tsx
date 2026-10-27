import { useEffect, useState, type ReactNode } from 'react'
import { rebuilding } from '@shared/extensionLifecycle'
import { Gauge, Hammer, TriangleAlert } from 'lucide-react'
import { CAP_MULTIPLE, cleanCapMultiple, fmtPct, fmtTokens, type CostEstimate, type Range } from '@shared/costEstimate'
import type { ExtensionRecord, InstallPrompt } from '@shared/extensions'
import { TIER_WORDS } from '@shared/extensionTiers'
import { displayModel } from '@shared/models'
import { api } from '../api'
import { toast, useStore } from '../store'
import '../extensionCost.css'

// Corvid's own estimate for building an extension (#97), on the card, the extension's page and the confirmation
// before an install. The numbers come from the main process (src/main/extensionBudget.ts); the author's claim is shown
// next to them, never used as the estimate.

const CONFIDENCE = { low: 'Low confidence: little history on this PC, so the range is wide', medium: 'Medium confidence', high: 'High confidence' }

function useEstimate(key: string, refresh: unknown): CostEstimate | null | undefined {
  const [e, setE] = useState<CostEstimate | null | undefined>(undefined)
  useEffect(() => void api.extensionEstimate(key).then(setE), [key, refresh])
  return e
}

const range = (r: Range, f: (n: number) => string): string => `${f(r.low)} – ${f(r.high)}`
const mins = (n: number): string => (n >= 90 ? `${(n / 60).toFixed(1)} h` : `${Math.round(n)} min`)

/** "~8% of the 5-hour window (now 72%, about 80% after)". */
function shareLine(r: Range & { now?: number }, what: string): string {
  const end = r.now === undefined ? 0 : Math.round(r.now + r.likely)
  const after = r.now === undefined ? '' : end > 100 ? ` (now ${Math.round(r.now)}%: it may not fit in what's left)` : ` (now ${Math.round(r.now)}%, about ${end}% after)`
  return `about ${fmtPct(r.likely)} of ${what}${after}`
}

/** The small version, on a card. */
export function CostChip({ record }: { record: ExtensionRecord }): ReactNode {
  const e = useEstimate(record.key, record.updatedAt)
  if (!e) return null
  return (
    <span className="cost-chip" title={`${e.label}. ${e.basis}.`}>
      <Gauge size={11} /> ~{fmtTokens(e.tokens.likely)} tokens · {fmtPct(e.share.fiveHour.likely)} of 5h
      {e.mismatch && <TriangleAlert size={11} className="cost-flag" />}
    </span>
  )
}

/** One line at the top of the extension's page (#119): the effort class, the estimate and, once built, the actual. */
export function CostLine({ record, effort }: { record: ExtensionRecord; effort: string }): ReactNode {
  const e = useEstimate(record.key, record.updatedAt)
  const actual = record.cost?.actual
  return (
    <p className="ext-costline" title={e ? `${e.label}. ${e.basis}.` : undefined}>
      <Gauge size={12} /> {effort} effort
      {e && <> · {shareLine(e.share.fiveHour, 'your 5-hour window')} (~{fmtTokens(e.tokens.likely)} output tokens)</>}
      {actual && <> · the last build used {fmtTokens(actual.amount)}{actual.capHit ? ', past its cap' : ''}</>}
      {e?.mismatch && <TriangleAlert size={12} className="cost-flag" />}
    </p>
  )
}

/** The full estimate: on the extension's page and in the confirmation. */
export function CostDetail({ e }: { e: CostEstimate }): ReactNode {
  const a = e.author
  const claim = [a.tokens !== undefined && `${a.tokens.toLocaleString()} tokens`, a.cost && `${a.cost} cost`, a.minutes !== undefined && `${a.minutes} min`, a.model].filter(Boolean)
  return (
    <div className="cost-detail">
      <div className="cost-label">{e.label}</div>
      <div className="cost-big">
        ~{fmtTokens(e.tokens.likely)} <span>output tokens</span>
      </div>
      <dl className="cost-dl">
        <dt>Range</dt>
        <dd>
          {range(e.tokens, fmtTokens)} output tokens · {CONFIDENCE[e.confidence]}
        </dd>
        <dt>Usage</dt>
        <dd>
          {shareLine(e.share.fiveHour, 'your 5-hour window')}; {shareLine(e.share.week, 'your weekly quota')}
        </dd>
        <dt>Time</dt>
        <dd>
          about {mins(e.minutes.likely)} ({range(e.minutes, mins)})
        </dd>
        <dt>Model</dt>
        <dd>{displayModel(e.model)}</dd>
        <dt>Based on</dt>
        <dd>{e.basis}</dd>
        <dt>The author's claim</dt>
        <dd>{claim.length ? `${claim.join(', ')} (a hint only, not used for the estimate)` : 'None given'}</dd>
      </dl>
      {e.mismatch && (
        <div className="cost-mismatch">
          <TriangleAlert size={13} /> {e.mismatch}
        </div>
      )}
    </div>
  )
}

/** The estimate section on the extension's page. */
export function CostSection({ record }: { record: ExtensionRecord }): ReactNode {
  const e = useEstimate(record.key, record.updatedAt)
  if (!e) return null
  const actual = record.cost?.actual
  return (
    <section className="ext-sec">
      <h3>Estimated cost</h3>
      <CostDetail e={e} />
      {actual && (
        <p className="ext-small">
          The last build used {fmtTokens(actual.amount)} output tokens{actual.minutes !== undefined ? ` in ${actual.minutes} min` : ''}
          {actual.capHit ? ', passing its budget cap' : ''}.
        </p>
      )}
    </section>
  )
}

/** The Install button and its confirmation. Nothing starts without the user's Confirm here. */
export function InstallButton({ record, blocked, label = 'Install…', primary = true }: { record: ExtensionRecord; blocked?: boolean; label?: string; primary?: boolean }): ReactNode {
  const [p, setP] = useState<InstallPrompt | null>(null)
  const [busy, setBusy] = useState(false)
  // blocked: the install pipeline's checks (#98) found something in the way, listed above the button
  const can = (record.status === 'not-installed' || record.status === 'ready' || record.status === 'failed' || rebuilding(record)) && !blocked
  const open = async (): Promise<void> => {
    const r = await api.extensionPrepareInstall(record.key)
    if ('error' in r) return toast(r.error, 'error')
    setP(r)
  }
  const confirm = async (): Promise<void> => {
    if (!p) return
    setBusy(true)
    const r = await api.extensionConfirmInstall(record.key, p.token)
    setBusy(false)
    setP(null)
    if ('error' in r) return toast(r.error, 'error')
    toast(r.message, 'info')
  }
  const e = p?.estimate
  return (
    <>
      <button className={`btn sm${primary ? ' primary' : ''}`} disabled={!can} onClick={() => void open()} title={can ? 'See the estimate and confirm before anything is built' : blocked ? 'See "Before installing" on this page' : `It is ${record.status}`}>
        <Hammer size={13} /> {label}
      </button>
      {p && e && (
        <div className="overlay" onMouseDown={() => setP(null)}>
          <div className="dialog cost-confirm" role="dialog" aria-modal="true" onMouseDown={(ev) => ev.stopPropagation()}>
            <h3>Build “{record.name}” into your Corvid?</h3>
            <p>
              An agent will follow this extension's seed prompt to build it on a feature branch: {record.header.description} Its tier:{' '}
              <span className={`ext-tier t${record.header.capabilities.tier}`}>{TIER_WORDS[record.header.capabilities.tier]}</span>
              {record.header.capabilities.tier === 3 ? ', which gets extra review and costs more.' : '.'}
            </p>
            <CostDetail e={e} />
            <p className="cost-cap">
              <b>Soft cap:</b> {p.capMultiple}× the likely estimate, about {fmtTokens(p.capTokens)} output tokens. If the build passes it, Corvid asks you
              whether to continue or stop; Stop ends the agent and keeps its branch and the work so far.
            </p>
            <p className="cost-warn">
              <TriangleAlert size={13} /> This build uses your Claude usage, and it may stall if your plan's limit is reached.
            </p>
            {p.usage && (
              <p className="cost-over">
                <TriangleAlert size={13} /> {p.usage.text}
              </p>
            )}
            <div className="actions">
              <button className="btn ghost" onClick={() => setP(null)} autoFocus>
                Cancel
              </button>
              <button className="btn primary" disabled={busy || !!p.usage?.block} onClick={() => void confirm()}>
                {p.usage && !p.usage.block ? 'Build anyway' : 'Confirm and build'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

/** On the Extensions tab: how far off the estimates have been, and the soft cap setting. */
export function BudgetBar({ count }: { count: number }): ReactNode {
  const config = useStore((s) => s.config)
  const [acc, setAcc] = useState<{ offBy: number; n: number } | null>(null)
  useEffect(() => void api.extensionsAccuracy().then(setAcc), [count])
  if (!config) return null
  const steps: number[] = []
  for (let v = CAP_MULTIPLE.min; v <= CAP_MULTIPLE.max; v += 0.5) steps.push(v)
  return (
    <div className="cost-bar">
      <span>
        {acc ? `Estimates have been off by about ${acc.offBy}% over the last ${acc.n} builds.` : 'Every build is estimated first and needs your confirmation.'}
      </span>
      <label>
        Soft budget cap
        <select
          className="select"
          value={config.extensionCapMultiple}
          onChange={(ev) => void api.setConfig({ extensionCapMultiple: cleanCapMultiple(Number(ev.target.value)) })}
          title="Corvid asks whether to continue once a build uses this multiple of its likely estimate"
        >
          {steps.map((v) => (
            <option key={v} value={v}>
              {v}× the estimate{v === CAP_MULTIPLE.default ? ' (default)' : ''}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
