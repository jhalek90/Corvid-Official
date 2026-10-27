import { useEffect, useState, type ReactNode } from 'react'
import { Ban, Check, CircleAlert, FolderOpen, GitMerge, RotateCcw, Send, Trash2, TriangleAlert } from 'lucide-react'
import type { ExtensionRecord, Preflight } from '@shared/extensions'
import { rebuilding } from '@shared/extensionLifecycle'
import { DIFF_RULE_WORDS } from '@shared/extensionDiffScan'
import { fmtTokens } from '@shared/costEstimate'
import { api } from '../api'
import { setState, toast } from '../store'
import { relTime } from '../format'
import '../extensionInstall.css'

// The install pipeline's part of an extension's page (#98): the checks before an install (requirements in order,
// conflicts, the build tools, the tier-3 confirmation), the build's progress, and the review screen with its actions.
// Merging happens only here, on the user's click: no agent, tool or board message reaches these calls.

const INSTALLABLE: ExtensionRecord['status'][] = ['not-installed', 'ready', 'failed']

/** The checks before an install, shown above Install. `onReady` says whether Install may be pressed. */
export function InstallChecks({ record, onReady }: { record: ExtensionRecord; onReady: (ok: boolean) => void }): ReactNode {
  const [p, setP] = useState<Preflight | null>(null)
  const [ticked, setTicked] = useState<string[]>([])
  const installable = INSTALLABLE.includes(record.status) || rebuilding(record)
  useEffect(() => {
    if (!installable) return void onReady(false)
    let live = true
    void api.extensionPreflight(record.key).then((r) => {
      if (!live) return
      if ('error' in r) {
        setP(null)
        onReady(false)
        return
      }
      setP(r)
      onReady(r.ok)
    })
    return () => void (live = false)
  }, [record.key, record.updatedAt, record.status, installable])
  if (!installable || !p) return null
  const confirmT3 = async (): Promise<void> => {
    const r = await api.extensionConfirmTier3(record.key, ticked)
    if ('error' in r) toast(r.error, 'error')
  }
  const ordered = p.requires.filter((q) => q.state === 'available')
  return (
    <section className="ext-sec inst-checks">
      <h3>Before installing</h3>
      {p.ok && !p.warnings.length && (
        <p className="inst-ok">
          <Check size={13} /> Ready to install. The build runs as a task in the Corvid project, on its own branch, and waits for your review. Nothing is
          merged, pushed or deployed on its own.
        </p>
      )}
      {p.blockers.map((b, i) => (
        <p key={i} className="inst-block">
          <Ban size={13} /> {b}
        </p>
      ))}
      {ordered.length > 0 && (
        <div className="inst-order">
          Install these first, in this order (each has its own scan, estimate and confirmation):
          <ol>
            {ordered.map((q) => (
              <li key={q.key}>
                <button className="btn sm" onClick={() => setState({ extensionsFocus: { key: q.key!, review: true } })}>
                  {q.id} {q.version}
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}
      {p.warnings.map((w, i) => (
        <p key={i} className="inst-warn">
          <TriangleAlert size={13} /> {w}
        </p>
      ))}
      {p.tier === 3 && !p.tier3Confirmed && (
        <div className="inst-t3">
          <b>This extension changes protected parts of Corvid:</b>
          {p.protectedAreas.map((a) => (
            <label key={a.id}>
              <input
                type="checkbox"
                checked={ticked.includes(a.id)}
                onChange={(e) => setTicked((t) => (e.target.checked ? [...t, a.id] : t.filter((x) => x !== a.id)))}
              />{' '}
              {a.label}
            </label>
          ))}
          <p className="ext-small">
            Without this, the build agent's file tools are denied these paths and the diff scan blocks any change to them. With it, they are allowed for
            the areas above only. Tick each area to confirm.
          </p>
          <button className="btn sm danger" disabled={!p.protectedAreas.every((a) => ticked.includes(a.id))} onClick={() => void confirmT3()}>
            I understand: allow these protected changes
          </button>
        </div>
      )}
      {p.tier === 3 && p.tier3Confirmed && (
        <p className="inst-warn">
          <TriangleAlert size={13} /> You confirmed protected changes to: {p.protectedAreas.map((a) => a.label).join('; ')}.
        </p>
      )}
      <p className="ext-small">Extensions are never pushed after the merge: the install is local to this PC.</p>
    </section>
  )
}

const RESULT: Record<string, string> = Object.fromEntries([['pass', 'passed'], ['fail', 'failed'], ['not-run', 'not run']])

/** The build's state: building, the review screen, failed, or merged. */
export function BuildPanel({ record }: { record: ExtensionRecord }): ReactNode {
  const b = record.build
  const [diff, setDiff] = useState<string | null>(null)
  const [flagsRead, setFlagsRead] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setDiff(null)
    setFlagsRead(false)
  }, [b?.tip])
  if (!b || b.state === 'discarded') return null
  const scan = b.diffScan
  const act = async (fn: () => Promise<{ error?: string; message?: string } | { ok: true }>): Promise<void> => {
    setBusy(true)
    const r = (await fn()) as { error?: string; message?: string }
    setBusy(false)
    if (r.error) toast(r.error, 'error')
    else if (r.message) toast(r.message, 'info')
  }
  const showDiff = async (): Promise<void> => {
    const r = await api.extensionDiff(record.key)
    setDiff('error' in r ? r.error : r.text + (r.truncated ? '\n\n(cut off at 2 MB)' : ''))
  }
  const openBranch = (): void => {
    const dir = b.worktree ?? b.repo
    if (dir) void api.openFolder(dir)
  }
  const est = record.cost?.estimate
  const actual = record.cost?.actual
  const discard = (): void => {
    if (window.confirm(`Discard this build of "${record.name}"? It goes back to "Not installed yet". The branch is kept in the Corvid project.`))
      void act(() => api.extensionDiscard(record.key))
  }
  const merge = (): void => {
    if (window.confirm(`Merge the build of "${record.name}" ${record.version} into Corvid's main branch? Nothing is pushed or deployed.`))
      void act(() => api.extensionMerge(record.key, { tip: b.tip ?? '', flagsRead }))
  }
  const rebuild = (): void => {
    if (window.confirm('Rebuild and restart Corvid now? This ends every running agent. If the new build fails to start, the deploy rolls back to the previous one.'))
      void api.corvidRebuild(false).then((r) => r.error && toast(r.error, 'error'))
  }
  return (
    <section className={`ext-sec inst-build s-${b.state}`}>
      <h3>
        {b.state === 'building' ? 'Building' : b.state === 'needs-review' ? 'Review the build' : b.state === 'failed' ? 'The build failed' : 'Installed'}
      </h3>
      <p className="ext-small">
        {b.taskId !== undefined && <>Task #{b.taskId} in the Corvid project</>}
        {b.branch && <> · branch <code>{b.branch}</code></>}
        {b.startedAt && <> · started {relTime(b.startedAt)}</>}
        {b.tip && <> · tip <code>{b.tip.slice(0, 10)}</code></>}
      </p>
      {b.state === 'building' && (
        <p>
          A build agent is working on its own branch. When it sends its report, Corvid scans the diff and this page becomes the review. You can follow it on
          the Agents page.
        </p>
      )}
      {b.error && (
        <p className="inst-block">
          <CircleAlert size={13} /> {b.error}
        </p>
      )}
      {b.state === 'merged' && (
        <>
          <p>
            Merged into main as <code>{b.mergeCommit?.slice(0, 10)}</code> {b.mergedAt && relTime(b.mergedAt)}, {b.filesTouched?.length ?? 0} files. Not
            pushed: the install is local.
          </p>
          {b.needsDeploy && (
            <div className="inst-deploy">
              <span>Installed, needs a rebuild: the running Corvid doesn't have it yet. Nothing is deployed on its own.</span>
              <button className="btn sm primary" onClick={rebuild}>
                <RotateCcw size={13} /> Rebuild and restart Corvid
              </button>
            </div>
          )}
        </>
      )}

      {(est || actual) && b.state !== 'building' && (
        <p className="ext-small">
          Cost: {actual ? `${fmtTokens(actual.amount)} output tokens` : 'not measured'}
          {est ? ` against an estimate of ${fmtTokens(est.likely ?? est.low)} (${fmtTokens(est.low)} to ${fmtTokens(est.high)})` : ''}
          {actual?.capHit ? ', past the budget cap' : ''}.
        </p>
      )}

      {b.report && (
        <div className="inst-report">
          <h4>Build report (the agent's own account)</h4>
          <p className="inst-pre">{b.report.summary}</p>
          {b.report.tests.length > 0 && (
            <ul className="inst-results">
              {b.report.tests.map((t, i) => (
                <li key={i} className={`r-${t.result}`}>
                  {t.name}: {RESULT[t.result]}
                  {t.detail ? ` (${t.detail})` : ''}
                </li>
              ))}
            </ul>
          )}
          {b.report.acceptance.length > 0 && (
            <>
              <h4>Acceptance checks</h4>
              <ul className="inst-results">
                {b.report.acceptance.map((a, i) => (
                  <li key={i} className={`r-${a.result}`}>
                    {a.check}. {RESULT[a.result]}
                    {a.how ? `: ${a.how}` : ''}
                  </li>
                ))}
              </ul>
            </>
          )}
          {b.report.notDone && <p className="inst-warn">Not done: {b.report.notDone}</p>}
          {b.report.flag && <p className="ext-small">Gated behind the flag: {b.report.flag}</p>}
        </div>
      )}

      {scan && (
        <div className="inst-scan">
          <h4>
            Diff scan:{' '}
            <span className={`inst-verdict v-${scan.verdict}`}>
              {scan.verdict === 'clear' ? 'nothing flagged' : scan.verdict === 'flag' ? `${scan.flags.length} flagged` : 'blocked'}
            </span>
            {scan.tier1Shape && <span className="chip">tier-1 shape</span>}
          </h4>
          <table className="inst-areas">
            <tbody>
              {scan.areas.map((a) => (
                <tr key={a.area}>
                  <td>{a.label}</td>
                  <td>
                    {a.files} file{a.files === 1 ? '' : 's'}
                  </td>
                  <td className="add">+{a.added}</td>
                  <td className="del">-{a.removed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {scan.flags.length > 0 && (
            <ul className="inst-flags">
              {scan.flags.map((f, i) => (
                <li key={i} className={`sev-${f.severity}`}>
                  <span className="inst-rule">{f.severity === 'block' ? 'Blocks' : DIFF_RULE_WORDS[f.rule]}</span>
                  <code>
                    {f.file}
                    {f.line ? `:${f.line}` : ''}
                  </code>{' '}
                  {f.text}
                  {f.excerpt && <pre>{f.excerpt}</pre>}
                </li>
              ))}
            </ul>
          )}
          <p className="ext-small">The diff scan is deterministic and not exhaustive: read the diff too.</p>
        </div>
      )}

      {b.tip && b.state !== 'merged' && (
        <div className="inst-diff">
          <button className="btn sm" onClick={() => (diff === null ? void showDiff() : setDiff(null))}>
            {diff === null ? 'Show the full diff' : 'Hide the diff'}
          </button>
          {diff !== null && <pre className="inst-diff-text">{diff}</pre>}
        </div>
      )}

      {b.state === 'needs-review' && (
        <div className="inst-actions">
          {scan?.verdict === 'flag' && (
            <label className="inst-ack">
              <input type="checkbox" checked={flagsRead} onChange={(e) => setFlagsRead(e.target.checked)} /> I've read the flags
            </label>
          )}
          <div className="ext-buttons">
            <button
              className="btn primary sm"
              disabled={busy || scan?.verdict === 'block' || (scan?.verdict === 'flag' && !flagsRead)}
              title={scan?.verdict === 'block' ? 'A blocked diff scan can never be merged' : 'Merge into main with a merge commit; nothing is pushed'}
              onClick={merge}
            >
              <GitMerge size={13} /> Approve and merge
            </button>
            <button className="btn sm" onClick={openBranch} disabled={!b.worktree && !b.repo}>
              <FolderOpen size={13} /> Open the branch
            </button>
            <button className="btn danger sm" onClick={discard} disabled={busy}>
              <Trash2 size={13} /> Discard the build
            </button>
          </div>
        </div>
      )}
      {(b.state === 'needs-review' || b.state === 'failed') && (
        <div className="inst-sendback">
          <textarea
            className="input"
            rows={2}
            maxLength={2000}
            placeholder="A note for the build agent: what to change. It continues on the same branch."
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="ext-buttons">
            <button className="btn sm" disabled={busy || !note.trim()} onClick={() => void act(() => api.extensionSendBack(record.key, note)).then(() => setNote(''))}>
              <Send size={13} /> Send back
            </button>
            {b.state === 'failed' && (
              <>
                <button className="btn sm" onClick={openBranch} disabled={!b.worktree && !b.repo}>
                  <FolderOpen size={13} /> Open the branch
                </button>
                <button className="btn danger sm" onClick={discard} disabled={busy}>
                  <Trash2 size={13} /> Discard
                </button>
              </>
            )}
          </div>
          {b.state === 'failed' && <p className="ext-small">Retry with Install above: it shows a fresh estimate and starts a new build from main.</p>}
        </div>
      )}
      {b.sendBacks && b.sendBacks.length > 0 && (
        <p className="ext-small">
          Sent back {b.sendBacks.length} time{b.sendBacks.length === 1 ? '' : 's'}, last: “{b.sendBacks[b.sendBacks.length - 1].note}”
        </p>
      )}
    </section>
  )
}
