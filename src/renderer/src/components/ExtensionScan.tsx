import { useState, type ReactNode } from 'react'
import { LoaderCircle, RefreshCw, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion, TriangleAlert } from 'lucide-react'
import type { ExtensionRecord } from '@shared/extensions'
import {
  BLOCKING_CATEGORIES,
  CLASSIFIER_VERSION,
  RISK_WORDS,
  SKIP_PHRASE,
  VERDICT_WORDS,
  WARN_PHRASE,
  reviewGate,
  scanCostEstimate,
  type CitedLine,
  type ScanFlag,
  type ScanReport
} from '@shared/extensionScan'
import { TIER_WORDS, type ExtensionTier } from '@shared/extensionTiers'
import type { AssistantModel } from '@shared/types'
import { api } from '../api'
import { toast, useStore } from '../store'
import { ModelOptions } from './ModelOptions'
import { displayModel } from '@shared/models'
import { relTime } from '../format'
import '../extension-scan.css'

// The safety scan on an extension's page (#96, docs/EXTENSIONS.md "Safety scanning"): start a scan after a cost
// confirmation, then the report. Everything the classifier wrote is shown as plain text, never as HTML.

const NOT_A_GUARANTEE =
  'The scan is not a guarantee: careful wording can fool both the text checks and the classifier. The build runs on its own branch, its diff is scanned, and you review it before anything is merged.'

const tierWord = (t: ExtensionTier): string => `Tier ${t}: ${TIER_WORDS[t]}`

/** `part` lets the extension's page (#119) show the controls and verdict at the top and the long report in a
 *  collapsed section; without it, everything shows together as before. */
export function ExtensionScan({ record, bytes, part }: { record: ExtensionRecord; bytes: number; part?: 'controls' | 'report' }): ReactNode {
  const model = useStore((s) => s.config?.scanModel) ?? 'haiku'
  const [asking, setAsking] = useState<null | { over: string | null }>(null)
  const [skipping, setSkipping] = useState(false)
  const [phrase, setPhrase] = useState('')
  const [busy, setBusy] = useState(false)
  const scan = record.scan
  const gate = reviewGate(scan, record.hash)
  const est = scanCostEstimate(bytes, model)

  // the confirmation shows at once; the usage check (which may refresh usage first) fills in when it answers
  const askScan = async (): Promise<void> => {
    setAsking({ over: null })
    const over = await api.extensionScanUsage().catch(() => null)
    setAsking((a) => (a ? { over } : a))
  }
  const runScan = async (): Promise<void> => {
    setAsking(null)
    setBusy(true)
    const r = await api.extensionScan(record.key)
    setBusy(false)
    if (!('state' in r)) toast(r.error, 'error')
  }
  const confirmWarn = async (): Promise<void> => {
    const r = await api.extensionConfirmWarning(record.key, phrase)
    if (!('state' in r)) return toast(r.error, 'error')
    setPhrase('')
    toast('Warning confirmed and recorded')
  }
  const skip = async (): Promise<void> => {
    const r = await api.extensionSkipScan(record.key, phrase)
    if (!('state' in r)) return toast(r.error, 'error')
    setPhrase('')
    setSkipping(false)
    toast('Recorded: reviewing without the AI scan')
  }

  const scanning = busy || scan?.state === 'scanning'
  const report = scan?.state === 'done' ? scan.report : undefined
  const stale = report && report.classifierVersion !== CLASSIFIER_VERSION
  const controls = part !== 'report'
  const showReport = part !== 'controls'

  return (
    <section className="ext-sec xscan">
      {controls && (
        <>
          <div className="xscan-head">
            <h3>Safety scan</h3>
            <label className="xscan-model" title="The model the classifier runs on. Haiku keeps scans cheap; a larger model costs more, Fable the most.">
              Classifier
              <select className="select" value={model} onChange={(e) => void api.setConfig({ scanModel: e.target.value as AssistantModel })}>
                <ModelOptions />
              </select>
            </label>
          </div>

          {scanning ? (
            <div className="xscan-state">
              <LoaderCircle size={15} className="spin" /> Scanning… text checks, then two classifier runs with no tools.
            </div>
          ) : !scan || (scan.state !== 'done' && scan.state !== 'failed') ? (
            <div className="xscan-state">
              <ShieldQuestion size={15} />
              <span>Not scanned yet. Every extension is scanned before it can be reviewed for install.</span>
              <button className="btn primary sm" onClick={() => void askScan()}>
                Scan…
              </button>
            </div>
          ) : scan.state === 'failed' ? (
            <div className="xscan-state bad">
              <ShieldOff size={15} />
              <span>
                <b>The scan failed</b>, so this extension has no verdict (a failed scan never counts as clear). {scan.error}
              </span>
              <button className="btn sm" onClick={() => void askScan()}>
                <RefreshCw size={13} /> Scan again
              </button>
            </div>
          ) : null}
        </>
      )}

      {asking && (
        <div className="xscan-confirm card">
          <p>
            A scan makes two short, isolated classifier calls on your Claude plan with {model[0].toUpperCase() + model.slice(1)}: roughly <b>{est.words}</b> for this
            {' '}{Math.max(1, Math.round(bytes / 1024))} KB extension. Results are kept, so the same text isn't scanned twice.
          </p>
          {asking.over && (
            <p className="xscan-over">
              <TriangleAlert size={13} /> {asking.over} Corvid will ask again in its own dialog.
            </p>
          )}
          <div className="xscan-row">
            <button className="btn primary sm" onClick={() => void runScan()}>
              Scan now
            </button>
            <button className="btn ghost sm" onClick={() => setAsking(null)}>
              Later
            </button>
          </div>
        </div>
      )}

      {showReport && report && !scanning && <Report report={report} record={record} stale={!!stale} onRescan={() => void askScan()} />}
      {!controls ? null : (
        <>
          {!scanning && <Gate gate={gate} report={report} />}

          {!scanning && gate.ok === false && gate.need === 'warn-confirm' && (
            <div className="xscan-type">
              <span>
                To continue to install review despite the warnings above, type <code>{WARN_PHRASE}</code>
              </span>
              <input className="input" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={WARN_PHRASE} aria-label="Confirmation phrase" />
              <button className="btn sm" disabled={phrase.trim().toLowerCase() !== WARN_PHRASE.toLowerCase()} onClick={() => void confirmWarn()}>
                Confirm
              </button>
            </div>
          )}

          {!scanning && !scan?.skipped && gate.ok === false && ['scan', 'failed', 'rescan'].includes(gate.need) && (
            <div className="xscan-skip">
              {!skipping ? (
                <button className="btn ghost sm" onClick={() => setSkipping(true)}>
                  Review without the AI scan…
                </button>
              ) : (
                <div className="xscan-type warnbox">
                  <span>
                    <TriangleAlert size={13} /> Without the classifier, only the text checks have looked at this extension, and nothing has checked what its wording is trying
                    to do. This choice is recorded. Type <code>{SKIP_PHRASE}</code> to continue.
                  </span>
                  <input className="input" value={phrase} onChange={(e) => setPhrase(e.target.value)} placeholder={SKIP_PHRASE} aria-label="Skip phrase" />
                  <button className="btn danger sm" disabled={phrase.trim().toLowerCase() !== SKIP_PHRASE.toLowerCase()} onClick={() => void skip()}>
                    Review without scan
                  </button>
                  <button className="btn ghost sm" onClick={() => setSkipping(false)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          )}
          {scan?.skipped && gate.ok && gate.via === 'skipped' && (
            <p className="xscan-note">
              <TriangleAlert size={12} /> You chose to review this without the AI scan {relTime(scan.skipped.at)}.
            </p>
          )}
        </>
      )}
    </section>
  )
}

function Gate({ gate, report }: { gate: ReturnType<typeof reviewGate>; report?: ScanReport }): ReactNode {
  if (gate.ok) {
    const how = gate.via === 'clear' ? 'The scan is clear.' : gate.via === 'warn-confirmed' ? 'You confirmed the warnings.' : 'You chose to skip the AI scan.'
    return <p className="xscan-gate ok">{how} It can go on to install review when installing arrives (Extensions 4/8).</p>
  }
  if (gate.need === 'blocked')
    return (
      <p className="xscan-gate bad">
        <ShieldAlert size={13} /> Blocked: this extension can't be installed. It was flagged for{' '}
        {(report?.blockingCategories.length ? report.blockingCategories : ['a verdict of block from the classifier']).map((c) => RISK_WORDS[c as keyof typeof RISK_WORDS] ?? c).join(', ')}
        , which can't be overridden here. You can read the report or delete it.
      </p>
    )
  if (gate.need === 'rescan') return <p className="xscan-gate">The classifier has changed since this scan. Scan again before install review.</p>
  return null
}

function Report({ report, record, stale, onRescan }: { report: ScanReport; record: ExtensionRecord; stale: boolean; onRescan: () => void }): ReactNode {
  const v = report.verdict
  const c = report.classifier
  const declared = record.header.capabilities
  const det = report.deterministic
  const Icon = v === 'clear' ? ShieldCheck : v === 'warn' ? TriangleAlert : ShieldAlert
  return (
    <div className="xscan-report">
      <div className="xscan-verdict-row">
        <span className={`xscan-badge v-${v}`}>
          <Icon size={13} /> {VERDICT_WORDS[v]}
        </span>
        <span className="muted">
          Scanned {relTime(report.at)} · {displayModel(report.model)}, {report.runs} run{report.runs === 1 ? '' : 's'} · cost ${report.cost.usd.toFixed(4)}
          {stale ? ' · out of date' : ''}
        </span>
        <button className="btn ghost sm" onClick={onRescan} title="Scan again (the same text and classifier come from the cache)">
          <RefreshCw size={12} /> Rescan
        </button>
      </div>
      <p className="xscan-disclaimer">{NOT_A_GUARANTEE}</p>

      <h4>What the classifier says it would do</h4>
      <p className="xscan-summary">{c.summary}</p>

      <h4>Tier</h4>
      <ul className="xscan-list">
        <li>Declared: {tierWord(det.declaredTier)}</li>
        {det.forcedTier !== det.declaredTier && <li className="extra">From the text: {tierWord(det.forcedTier)} (it mentions protected core)</li>}
        <li className={c.tier > det.declaredTier ? 'extra' : ''}>Inferred: {tierWord(c.tier)}</li>
        <li>
          Effort {c.effort}, complexity {c.complexity}/10
        </li>
      </ul>

      <h4>Capabilities: declared and inferred</h4>
      <div className="xscan-caps">
        <div className="xscan-caps-h">Declared</div>
        <div className="xscan-caps-h">Inferred</div>
        <CapRow label="Packages" declared={declared.packages.map((p) => p.name)} inferred={c.capabilities.packages} extra={report.gap.packages} />
        <CapRow label="Hosts" declared={declared.hosts} inferred={c.capabilities.hosts} extra={report.gap.hosts} />
        <CapRow label="Core areas" declared={declared.coreAreas} inferred={c.capabilities.core_areas} extra={report.gap.coreAreas} />
        <CapRow label="Data" declared={declared.data ? [declared.data] : []} inferred={c.capabilities.data} extra={[]} />
        <CapRow label="Protected paths" declared={[]} inferred={c.capabilities.protected_paths} extra={c.capabilities.protected_paths} />
      </div>

      <h4>Risk flags {report.flags.length ? `(${report.flags.length})` : ''}</h4>
      {report.flags.length === 0 ? <p className="muted">None.</p> : report.flags.map((f, i) => <Flag key={i} f={f} />)}

      {det.oddities.length > 0 && (
        <>
          <h4>Worth a look</h4>
          {det.oddities.map((o, i) => (
            <div key={i} className="xscan-flag">
              <div className="xscan-flag-h">{o.label}</div>
              <Lines lines={o.lines} />
            </div>
          ))}
        </>
      )}

      <h4>Found in the text</h4>
      <dl className="ext-dl xscan-found">
        <Found label="URLs" items={det.mentions.urls} />
        <Found label="Hosts" items={det.mentions.hosts} extra={det.mentions.undeclaredHosts} />
        <Found label="E-mail addresses" items={det.mentions.emails} />
        <Found label="Packages" items={det.mentions.packages} extra={det.mentions.undeclaredPackages} />
        <Found label="File paths" items={det.mentions.paths} />
      </dl>
    </div>
  )
}

function CapRow({ label, declared, inferred, extra }: { label: string; declared: string[]; inferred: string[]; extra: string[] }): ReactNode {
  const ex = new Set(extra.map((x) => x.toLowerCase()))
  return (
    <>
      <div className="xscan-caps-label">{label}</div>
      <div>{declared.length ? declared.join(', ') : <span className="muted">none</span>}</div>
      <div>
        {inferred.length ? (
          inferred.map((x, i) => (
            <span key={i} className={[...ex].some((e) => x.toLowerCase().includes(e)) ? 'extra' : ''}>
              {i ? ', ' : ''}
              {x}
            </span>
          ))
        ) : (
          <span className="muted">none</span>
        )}
      </div>
    </>
  )
}

function Flag({ f }: { f: ScanFlag }): ReactNode {
  const blocks = BLOCKING_CATEGORIES.includes(f.category)
  return (
    <div className={`xscan-flag${blocks ? ' blocks' : ''}`}>
      <div className="xscan-flag-h">
        <span className={`chip xscan-cat${blocks ? ' blocks' : ''}`}>{RISK_WORDS[f.category]}</span>
        <span>{f.label}</span>
        <span className="muted xscan-src">{f.source === 'text' ? 'text check' : 'classifier'}</span>
      </div>
      <Lines lines={f.lines} />
    </div>
  )
}

function Lines({ lines }: { lines: CitedLine[] }): ReactNode {
  if (!lines.length) return null
  return (
    <pre className="xscan-lines">
      {lines.map((l, i) => (
        <div key={i}>
          <span className="ln">{l.line ? l.line : '?'}</span>
          {l.text}
        </div>
      ))}
    </pre>
  )
}

function Found({ label, items, extra = [] }: { label: string; items: string[]; extra?: string[] }): ReactNode {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {items.length ? (
          items.map((x, i) => (
            <span key={i} className={extra.includes(x) ? 'extra' : ''} title={extra.includes(x) ? 'Not declared in the header' : undefined}>
              {i ? ', ' : ''}
              {x}
            </span>
          ))
        ) : (
          <span className="muted">none</span>
        )}
      </dd>
    </>
  )
}
