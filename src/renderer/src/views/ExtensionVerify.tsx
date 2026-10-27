import { useEffect, useState, type ReactNode } from 'react'
import { BadgeCheck, CircleAlert, ClipboardCopy, FileDown, PencilLine, Share2, ShieldQuestion, TriangleAlert, X } from 'lucide-react'
import { EFFORT_WORDS, type ExtensionRecord } from '@shared/extensions'
import { isVerified, VERIFY_HONESTY, type SharePreview, type VerifyCheck, type VerifyPrompt } from '@shared/extensionVerify'
import { coreArea, TIER_WORDS } from '@shared/extensionTiers'
import { displayModel } from '@shared/models'
import { fmtTokens } from '@shared/costEstimate'
import { api } from '../api'
import { toast } from '../store'
import { relTime } from '../format'
import { editExtension } from '../components/PackagerWizard'
import { CostDetail } from './ExtensionCost'
import '../extensionVerify.css'

// Verify and Share on an extension's page (#101, docs/EXTENSIONS.md "Verifying and sharing"). Verify test-builds the
// text on a clean throwaway copy of Corvid after the estimate's Confirm; Share writes the verified text to a file the
// user picks, or copies it. Both are only reachable from here; nothing is uploaded.

const BASE_WORDS = { 'built-on': "the extension's built_on commit", 'before-feature': 'the commit before your own feature', main: 'the current main' }

/** The Verify / Share section. */
export function VerifyShare({ record }: { record: ExtensionRecord }): ReactNode {
  const [check, setCheck] = useState<VerifyCheck | null>(null)
  const [prompt, setPrompt] = useState<VerifyPrompt | null>(null)
  const [why, setWhy] = useState(false)
  const [share, setShare] = useState<SharePreview | null>(null)
  const verified = isVerified(record)
  const v = record.verification
  const run = record.verify?.hash === record.hash ? record.verify : undefined
  const building = run?.state === 'building'
  useEffect(() => {
    let live = true
    void api.extensionVerifyCheck(record.key).then((r) => live && setCheck('error' in r ? null : r))
    return () => void (live = false)
  }, [record.key, record.updatedAt])

  const openVerify = async (base: 'built-on' | 'main'): Promise<void> => {
    const r = await api.extensionPrepareVerify(record.key, base)
    if ('error' in r) return toast(r.error, 'error')
    setWhy(false)
    setPrompt(r)
  }
  const openShare = async (): Promise<void> => {
    if (!verified) return setWhy(true)
    const r = await api.extensionSharePreview(record.key)
    if ('error' in r) return toast(r.error, 'error')
    setShare(r)
  }
  const findings = run?.state === 'failed' ? [...(run.reasons ?? []), run.report?.notDone ? `Not done: ${run.report.notDone}` : '', run.report?.summary ? `The build report: ${run.report.summary}` : ''].filter(Boolean).join('\n') : ''
  const canVerify = !!check?.ok && !building

  return (
    <section className="ext-sec vfy">
      <h3>Verify and share</h3>
      {verified && v ? (
        <div className="vfy-ok">
          <p>
            <BadgeCheck size={14} /> <b>Verified</b> on Corvid {v.baseVersion} at {v.baseCommit.slice(0, 7)} ({BASE_WORDS[v.baseKind]}), {relTime(v.at)}, with {displayModel(v.model)}: {v.minutes} min,{' '}
            {fmtTokens(v.tokens)} output tokens, {v.files} files, all {v.checks} acceptance checks passed. Real effort: {EFFORT_WORDS[v.effort]}.
          </p>
          <p className="ext-small">{VERIFY_HONESTY}</p>
        </div>
      ) : (
        <p className="ext-small">
          {record.source.kind === 'created'
            ? 'Not verified. To share an extension you created, verify it first: Corvid test-builds this text on a clean copy of Corvid without your own feature, to prove the text alone rebuilds it.'
            : 'Not verified by your Corvid. You can verify it for your own confidence: a test build on a clean copy of Corvid, never merged.'}
        </p>
      )}

      {building && run && (
        <p className="vfy-run">
          <ShieldQuestion size={14} /> Verifying as #{run.taskId} on a clean throwaway copy at {run.baseCommit?.slice(0, 7)} ({BASE_WORDS[run.baseKind ?? 'built-on']}). It is never merged; the copy is
          removed when it ends.
        </p>
      )}
      {run?.state === 'failed' || run?.state === 'cancelled' ? (
        <div className="vfy-fail">
          <p>
            <CircleAlert size={14} /> <b>The last verify {run.state === 'cancelled' ? 'was stopped' : 'failed'}</b>
            {run.endedAt ? `, ${relTime(run.endedAt)}` : ''}:
          </p>
          <ul>
            {(run.reasons ?? []).map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
          {run.report && (
            <details>
              <summary>The build report</summary>
              <p className="ext-small">{run.report.summary}</p>
              {run.report.notDone && <p className="ext-small">Not done: {run.report.notDone}</p>}
              <ul className="ext-small">
                {run.report.tests.map((t, i) => (
                  <li key={i}>
                    {t.name}: {t.result}
                    {t.detail ? ` (${t.detail})` : ''}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ) : null}
      {run?.cleanupNote && (
        <p className="vfy-warn">
          <TriangleAlert size={13} /> {run.cleanupNote}
        </p>
      )}

      {check && !check.ok && !building && (
        <div className="vfy-block">
          {check.blockers.map((b, i) => (
            <p key={i}>
              <CircleAlert size={13} /> {b}
            </p>
          ))}
        </div>
      )}

      <div className="ext-buttons">
        {!verified && (
          <button className="btn sm" disabled={!canVerify} onClick={() => void openVerify('error' in (check?.bases['built-on'] ?? { error: '' }) ? 'main' : 'built-on')} title="See the estimate and pick the clean copy before anything runs">
            <ShieldQuestion size={13} /> {run?.state === 'failed' ? 'Verify again…' : 'Verify…'}
          </button>
        )}
        <button className={`btn sm${verified ? ' primary' : ''}`} onClick={() => void openShare()} title={verified ? 'Save the verified text as a .corvid file, or copy it' : 'Only a verified extension can be shared'}>
          <Share2 size={13} /> Share…
        </button>
        {findings && record.source.kind === 'created' && (
          <button className="btn sm" onClick={() => editExtension(record.key, record.name, findings)} title="Open the packaging wizard on this text with the verify's findings, to fix it">
            <PencilLine size={13} /> Fix in Edit
          </button>
        )}
      </div>

      {why && (
        <div className="vfy-why">
          <p>
            <b>Only a verified extension can be shared.</b> Sharing passes on text that someone else's Corvid will build, so Corvid first checks that this exact text rebuilds the
            feature on a clean copy. Any edit makes it unverified again.
          </p>
          <p className="ext-small">
            There is no way around this here. The extension is a plain text file, so an advanced user could still copy it from "The whole file" below by hand; it would carry no verification.
          </p>
          <div className="ext-buttons">
            <button className="btn sm primary" disabled={!canVerify} onClick={() => void openVerify('error' in (check?.bases['built-on'] ?? { error: '' }) ? 'main' : 'built-on')}>
              <ShieldQuestion size={13} /> Verify…
            </button>
            <button className="btn ghost sm" onClick={() => setWhy(false)}>
              Close
            </button>
          </div>
        </div>
      )}

      {record.shares?.length ? (
        <details className="vfy-shares">
          <summary>Shared {record.shares.length === 1 ? 'once' : `${record.shares.length} times`} (on this PC only)</summary>
          <ul className="ext-small">
            {record.shares
              .slice()
              .reverse()
              .map((s, i) => (
                <li key={i}>
                  {relTime(s.at)}: {s.where} · <span className="mono">{s.fileHash.slice(0, 12)}</span>
                  {s.hash !== record.hash ? ' (an earlier version)' : ''}
                </li>
              ))}
          </ul>
        </details>
      ) : null}

      {prompt && check && <VerifyDialog record={record} check={check} prompt={prompt} onBase={(b) => void openVerify(b)} onClose={() => setPrompt(null)} />}
      {share && <ShareDialog record={record} p={share} onClose={() => setShare(null)} />}
    </section>
  )
}

function VerifyDialog({ record, check, prompt, onBase, onClose }: { record: ExtensionRecord; check: VerifyCheck; prompt: VerifyPrompt; onBase: (b: 'built-on' | 'main') => void; onClose: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const chosen = prompt.base.kind === 'main' ? 'main' : 'built-on'
  const confirm = async (): Promise<void> => {
    setBusy(true)
    const r = await api.extensionConfirmVerify(record.key, prompt.token)
    setBusy(false)
    onClose()
    if ('error' in r) return toast(r.error, 'error')
    toast(`Verifying as #${r.taskId} on a clean throwaway copy. Nothing is merged.`, 'info')
  }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog cost-confirm vfy-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3>Verify “{record.name}”?</h3>
        <p>
          An agent test-builds this extension from its text alone, on a clean throwaway copy of Corvid, with the same rules, deny rules, diff scan and acceptance checks as an install.
          It is never merged, deploys nothing and never touches your main; the copy is removed afterwards and the report kept.
        </p>
        <fieldset className="vfy-bases">
          <legend>The clean copy</legend>
          {(['built-on', 'main'] as const).map((k) => {
            const b = check.bases[k]
            return (
              <label key={k} className={'error' in b ? 'off' : ''}>
                <input type="radio" name="vfy-base" checked={chosen === k} disabled={'error' in b || busy} onChange={() => onBase(k)} />
                <span>{'error' in b ? `${k === 'main' ? 'The current main' : 'Its built_on commit'}: ${b.error}` : `${b.label[0].toUpperCase()}${b.label.slice(1)}, Corvid ${b.version}`}</span>
              </label>
            )
          })}
        </fieldset>
        <CostDetail e={prompt.estimate} />
        <p className="cost-cap">
          <b>Soft cap:</b> {prompt.capMultiple}× the likely estimate, about {fmtTokens(prompt.capTokens)} output tokens. Past it, Corvid asks whether to continue or stop.
        </p>
        <p className="cost-warn">
          <TriangleAlert size={13} /> A verify uses your Claude usage like a build.
        </p>
        {prompt.usage && (
          <p className="cost-over">
            <TriangleAlert size={13} /> {prompt.usage.text}
          </p>
        )}
        <div className="actions">
          <button className="btn ghost" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !!prompt.usage?.block} onClick={() => void confirm()}>
            {prompt.usage && !prompt.usage.block ? 'Verify anyway' : 'Confirm and verify'}
          </button>
        </div>
      </div>
    </div>
  )
}

function ShareDialog({ record, p, onClose }: { record: ExtensionRecord; p: SharePreview; onClose: () => void }): ReactNode {
  const [read, setRead] = useState(false)
  const [busy, setBusy] = useState(false)
  const c = record.header.capabilities
  const v = p.verification
  const go = async (how: 'file' | 'copy'): Promise<void> => {
    setBusy(true)
    const r = await api.extensionShare(record.key, how, read)
    setBusy(false)
    if ('cancelled' in r) return
    if ('error' in r) return toast(r.error, 'error')
    toast(r.message, 'info')
    onClose()
  }
  const blocked = p.leaks.length > 0 && !read
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog vfy-dialog" role="dialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          Share “{record.name}”
          <button className="btn ghost icon sm vfy-x" title="Close" onClick={onClose}>
            <X size={14} />
          </button>
        </h3>
        <dl className="ext-dl vfy-summary">
          <dt>Extension</dt>
          <dd>
            {record.name} {record.version} <span className="mono">({record.id})</span>
            {record.header.author ? `, by ${record.header.author}` : ', no author'}
          </dd>
          <dt>Tier</dt>
          <dd>
            <span className={`ext-tier t${c.tier}`}>{TIER_WORDS[c.tier]}</span>
            {c.coreAreas.length ? ` · ${c.coreAreas.map((a) => coreArea(a)?.label ?? a).join(', ')}` : ''}
          </dd>
          <dt>Capabilities</dt>
          <dd>
            Packages: {c.packages.map((x) => `${x.name}@${x.version}`).join(', ') || 'none'} · hosts: {c.hosts.join(', ') || 'none'} · data: {c.data ?? 'none'} ·{' '}
            {c.rebuild ? 'needs a rebuild' : 'no rebuild'}
          </dd>
          <dt>Effort</dt>
          <dd>
            {EFFORT_WORDS[v.effort]}, measured: {v.minutes} min, {fmtTokens(v.tokens)} output tokens, {v.files} files, {displayModel(v.model)}
          </dd>
          <dt>Verification</dt>
          <dd>
            On Corvid {v.baseVersion} at {v.baseCommit.slice(0, 7)}, {new Date(v.at).toISOString().slice(0, 10)}, all {v.checks} checks passed
          </dd>
        </dl>
        <div className={p.leaks.length ? 'vfy-leaks bad' : 'vfy-leaks'}>
          {p.leaks.length ? (
            <>
              <p>
                <TriangleAlert size={13} /> <b>The final leak check found {p.leaks.length === 1 ? 'something' : `${p.leaks.length} things`} specific to this PC:</b>
              </p>
              <ul>
                {p.leaks.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
              </ul>
              <p className="ext-small">Fix the text through Edit (it then needs a new verify), or, if it's fine to share as it is:</p>
              <label>
                <input type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} /> I've read these and the file is fine to share as it is
              </label>
            </>
          ) : (
            <p>
              <BadgeCheck size={13} /> The final leak check found no local paths, names, hosts or keys. The author field is what you chose.
            </p>
          )}
        </div>
        <details className="ext-raw">
          <summary>The full text ({p.fileName})</summary>
          <pre className="ext-pre">{p.text}</pre>
        </details>
        <p className="ext-small">Nothing is uploaded anywhere: Share saves a file or copies the text, and you send it yourself. {VERIFY_HONESTY}</p>
        <div className="actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" disabled={busy || blocked} onClick={() => void go('copy')}>
            <ClipboardCopy size={13} /> Copy as text
          </button>
          <button className="btn primary" disabled={busy || blocked} onClick={() => void go('file')}>
            <FileDown size={13} /> Save as .corvid…
          </button>
        </div>
      </div>
    </div>
  )
}
