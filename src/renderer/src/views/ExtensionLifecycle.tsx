import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUpCircle, Ban, Bot, Check, FileDiff, FolderOpen, GitMerge, Hammer, History, Power, RotateCcw, Send, Square, Trash2, TriangleAlert } from 'lucide-react'
import type { ExtensionRecord } from '@shared/extensions'
import {
  CONFLICT_WHY,
  lifecycleState,
  STATE_WORDS,
  textDiff,
  updateFor,
  type ConflictHold,
  type LifecycleInfo,
  type LifecycleResult,
  type PendingChange,
  type ResolvePrompt
} from '@shared/extensionLifecycle'
import { fmtTokens } from '@shared/costEstimate'
import { api } from '../api'
import { setState, toast } from '../store'
import { relTime } from '../format'
import { CostDetail } from './ExtensionCost'
import '../extensionLifecycle.css'

// The lifecycle of an installed extension on its card and page (#99): Disable and Enable, Remove, Re-install (re-apply
// the stored build, or rebuild from the text), Update, the change waiting for review and the history. Merging happens
// only from Approve and merge here, on the user's click; nothing deploys on its own.

/** On a card: the lifecycle state when it says more than the status, and "Update available". */
export function LifecycleChips({ record, list }: { record: ExtensionRecord; list: ExtensionRecord[] }): ReactNode {
  const s = lifecycleState(record)
  const up = updateFor(record, list)
  const shown = s === 'installed-needs-deploy' || s === 'changed-outside' || s === 'pending-review' || s === 'needs-rebuild' || s === 'conflicted' || s === 'resolving'
  if (!shown && !up) return null
  return (
    <div className="lc-card-chips">
      {shown && <span className={`chip lc-chip lc-${s}`}>{STATE_WORDS[s]}</span>}
      {up && <span className="chip lc-chip lc-up">Update available: {record.version} → {up.version}</span>}
    </div>
  )
}

/** Removed extensions are hidden by default; a toggle in the list shows them. */
export function useShowRemoved(): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return localStorage.getItem('ext.showRemoved') === '1'
    } catch {
      return false
    }
  })
  const set = (x: boolean): void => {
    setV(x)
    try {
      localStorage.setItem('ext.showRemoved', x ? '1' : '0')
    } catch {
      /* per-window convenience only */
    }
  }
  return [v, set]
}

const CONFIRM_AGAIN = 'Go on anyway?'

/** The page's lifecycle section, for an extension that is or was installed. */
export function LifecyclePanel({ record, list }: { record: ExtensionRecord; list: ExtensionRecord[] }): ReactNode {
  const [info, setInfo] = useState<LifecycleInfo | null>(null)
  const [busy, setBusy] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  const [removing, setRemoving] = useState(false)
  const [conflict, setConflict] = useState<{ files: string[]; reinstall: boolean } | null>(null)
  const pending = record.lifecycle?.pending
  const held = record.lifecycle?.conflict
  useEffect(() => {
    let live = true
    void api.extensionLifecycle(record.key).then((i) => live && !('error' in i) && setInfo(i))
    return () => {
      live = false
    }
  }, [record.key, record.status, record.updatedAt])
  useEffect(() => setDiff(null), [pending?.tip])
  const installed = record.status === 'installed' || record.status === 'disabled'
  // removed but kept (Not installed yet): the stored build can be re-applied for free
  const stored = !installed && record.status === 'not-installed' && !!record.build?.mergeCommit
  if (!installed && !pending && !held && !stored && !record.lifecycle?.history?.length) return null

  /** runs an action; a guard (uncommitted changes, agents mid-task) asks once more, never silently */
  const act = async (fn: (confirmed: boolean) => Promise<LifecycleResult>): Promise<void> => {
    setBusy(true)
    setConflict(null)
    let r = await fn(false)
    if ('error' in r && r.needsConfirm && window.confirm(`${r.error}\n\n${CONFIRM_AGAIN}`)) r = await fn(true)
    setBusy(false)
    if ('error' in r) {
      // a held Disable or Remove conflict (#117) shows in its own box, from the record; Enable and Re-apply here
      if (r.conflict?.length && !r.resolvable) setConflict({ files: r.conflict, reinstall: !!r.offerReinstall })
      if (!r.needsConfirm && !r.resolvable) toast(r.error, 'error', undefined, { extension: record.name })
    } else toast(r.message, 'info')
    void api.extensionLifecycle(record.key).then((i) => !('error' in i) && setInfo(i))
  }
  const instant = info?.disableMode === 'instant'
  const disable = (): void => {
    const text = instant
      ? `Disable "${record.name}"? Its flag goes off at once, with no rebuild. New agents get the change; running ones keep their tools until they restart.`
      : `Disable "${record.name}"? Corvid reverts its merge on a new branch with git alone (no agent, no usage), runs the typecheck, and shows you the change to approve. A rebuild and restart afterwards ends running agents.`
    if (window.confirm(text)) void act((c) => api.extensionDisable(record.key, c))
  }
  const enable = (): void => {
    const text =
      record.lifecycle?.disabledBy === 'flag'
        ? `Enable "${record.name}"? Its flag goes back on at once.`
        : `Enable "${record.name}"? Corvid re-applies the same stored commits (a revert of the revert) on a new branch: no agent, no usage. You review it before it's merged.`
    if (window.confirm(text)) void act((c) => api.extensionEnable(record.key, c))
  }
  const reapply = (): void => {
    if (window.confirm(`Re-apply the stored build of "${record.name}" onto the current main? Free: git alone, no agent. You review the result before it's merged.`))
      void act((c) => api.extensionReapply(record.key, c))
  }
  const rebuild = (): void => {
    if (
      window.confirm(
        `Rebuild "${record.name}" from its text against the current Corvid? That's a new build by an agent: Install shows a new estimate and asks you to confirm. The old build stays until you approve the new one.`
      )
    )
      void act(() => api.extensionRebuild(record.key))
  }
  const approve = (): void => {
    if (!pending) return
    if (window.confirm(`Merge this change into Corvid's main branch? Nothing is pushed or deployed. A rebuild and restart afterwards ends running agents.`))
      void act(() => api.extensionApprovePending(record.key, pending.tip))
  }
  const discard = (): void => {
    const text = pending?.resolved ? "Discard this change? main stays as it is; the agent's branch and its worktree are deleted." : 'Discard this change? main stays as it is; the branch is kept.'
    if (window.confirm(text)) void act(() => api.extensionDiscardPending(record.key))
  }
  const state = info?.state ?? lifecycleState(record)

  return (
    <section className="ext-sec lc">
      <h3>
        Manage <span className={`chip lc-chip lc-${state}`}>{STATE_WORDS[state] || record.status}</span>
      </h3>
      {state === 'changed-outside' && (
        <p className="lc-warn">
          <TriangleAlert size={14} /> Its merge commit is no longer in main's history: it was reverted, reset or rebased outside Corvid. The record is kept. Re-apply
          the stored build, rebuild it from the text, or remove it.
        </p>
      )}
      {info?.guards.dirty && (
        <p className="lc-warn">
          <TriangleAlert size={14} /> Corvid's main branch has uncommitted changes. Actions that change git ask you to confirm, and merging waits until main is clean.
        </p>
      )}
      {!!info?.guards.agents.length && (
        <p className="lc-warn">
          <TriangleAlert size={14} /> Agents are working in the Corvid project ({info.guards.agents.slice(0, 4).join(', ')}). A rebuild and restart ends them.
        </p>
      )}

      {pending ? (
        <div className="lc-pending card">
          <b>
            {{ disable: 'Disable', enable: 'Enable', remove: 'Remove', reapply: 'Re-apply' }[pending.op]} is ready for review
          </b>
          <p className="ext-small">
            Branch <code>{pending.branch}</code> · {pending.files.length} file{pending.files.length === 1 ? '' : 's'} ·{' '}
            {pending.resolved ? <>conflict resolved by an agent as #{pending.resolved.taskId}, checked by Corvid</> : 'made with git alone, no agent, no usage'} · {relTime(pending.at)}
          </p>
          {pending.resolved && <ResolvedNotes record={record} resolved={pending.resolved} busy={busy} />}
          <p className={pending.check ? (pending.check.ok ? 'lc-ok' : 'lc-bad') : 'muted'}>
            {pending.check ? pending.check.ok ? <><Check size={14} /> Typecheck passed</> : <><Ban size={14} /> Typecheck failed</> : 'The typecheck could not run in the branch (no dependencies there); the deploy builds it and rolls back if it fails.'}
          </p>
          {pending.check && !pending.check.ok && <pre className="lc-out">{pending.check.output}</pre>}
          <ul className="lc-files">
            {pending.files.slice(0, 40).map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
            {pending.files.length > 40 && <li className="muted">and {pending.files.length - 40} more</li>}
          </ul>
          {pending.op === 'remove' && <p className="ext-small">{pending.deleteText ? 'The stored extension text is deleted once merged.' : 'The extension goes back to "Not installed yet" once merged.'}</p>}
          <div className="ext-buttons lc-actions">
            <button className="btn primary sm" disabled={busy || pending.resolved?.scan === 'block'} onClick={approve}>
              <GitMerge size={13} /> Approve and merge
            </button>
            <button className="btn sm" disabled={busy} onClick={() => void api.extensionPendingDiff(record.key).then((r) => setDiff('error' in r ? r.error : r.text))}>
              <FileDiff size={13} /> Show the diff
            </button>
            <button className="btn sm" disabled={busy} onClick={discard}>
              <Trash2 size={13} /> Discard
            </button>
          </div>
          {diff !== null && <pre className="lc-diff">{diff}</pre>}
        </div>
      ) : stored ? (
        <div className="ext-buttons lc-actions">
          <button className="btn sm" disabled={busy} onClick={reapply} title="Re-merge the recorded build onto the current main. Free. Or Install for a new build from the text.">
            <RotateCcw size={13} /> Re-apply the stored build
          </button>
        </div>
      ) : (
        installed && (
          <div className="ext-buttons lc-actions">
            {record.status === 'installed' && (
              <button className="btn sm" disabled={busy || !info} onClick={disable} title={instant ? `The flag ${info?.flag?.name} is read in the code: switched off at once` : 'No flag the code reads: a revert on a branch, then a rebuild'}>
                <Power size={13} /> {instant ? 'Disable (instant)' : 'Disable (needs a rebuild)'}
              </button>
            )}
            {record.status === 'disabled' && (
              <button className="btn primary sm" disabled={busy} onClick={enable}>
                <Power size={13} /> Enable
              </button>
            )}
            <button className="btn danger sm" disabled={busy} onClick={() => setRemoving(true)}>
              <Trash2 size={13} /> Remove…
            </button>
            <button className="btn sm" disabled={busy} onClick={reapply} title="Re-merge the recorded build onto the current main. Free.">
              <RotateCcw size={13} /> Re-apply the stored build
            </button>
            <button className="btn sm" disabled={busy} onClick={rebuild} title="A new build from the text against the current Corvid: new estimate and confirmation">
              <Hammer size={13} /> Rebuild from the text
            </button>
          </div>
        )
      )}
      {info?.flag && (
        <p className="ext-small muted">
          Flag <code>{info.flag.name}</code>: {info.flag.readInCode ? 'read in the code, so Disable is instant.' : "named in the build report but not found in the code, so Disable reverts the merge."}
        </p>
      )}
      {held && !pending && <ConflictBox record={record} hold={held} />}
      {conflict && !held && (
        <div className="lc-conflict card">
          <b>
            <TriangleAlert size={14} /> It conflicts with later changes to Corvid
          </b>
          <ul className="lc-files">
            {conflict.files.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
          {conflict.reinstall ? (
            <p>
              The stored commits no longer apply. <button className="btn sm" onClick={rebuild}><Hammer size={13} /> Rebuild from the text</button> builds it again against
              the current Corvid (an agent, with an estimate and your confirmation first).
            </p>
          ) : (
            <p>Nothing was changed. {CONFLICT_WHY}</p>
          )}
        </div>
      )}

      {removing && info && <RemoveDialog record={record} info={info} list={list} onClose={() => setRemoving(false)} onRemove={(del) => void act((c) => api.extensionRemove(record.key, del, c)).then(() => setRemoving(false))} />}

      {info?.update && <UpdateBox record={record} newKey={info.update.key} newVersion={info.update.version} />}

      <HistoryList record={record} />
    </section>
  )
}

function RemoveDialog({ record, info, list, onClose, onRemove }: { record: ExtensionRecord; info: LifecycleInfo; list: ExtensionRecord[]; onClose: () => void; onRemove: (deleteText: boolean) => void }): ReactNode {
  const [del, setDel] = useState(false)
  const alreadyOut = record.status === 'disabled' && record.lifecycle?.disabledBy === 'revert'
  const files = record.build?.filesTouched ?? []
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog lc-modal" role="dialog" aria-label={`Remove ${record.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <h3>Remove “{record.name}” {record.version}?</h3>
        {info.dependents.length > 0 ? (
          <>
            <p className="lc-warn">
              <TriangleAlert size={14} /> Other installed extensions need it. Remove them first, in this order (newest first):
            </p>
            <ol>
              {info.removalOrder.map((x) => (
                <li key={x.key}>
                  {x.key === record.key ? (
                    <b>{x.name} (this one)</b>
                  ) : (
                    <button className="btn link sm" onClick={() => setState({ extensionsFocus: { key: x.key } })}>
                      {x.name}
                    </button>
                  )}
                </li>
              ))}
            </ol>
            <p className="ext-small muted">Open each one and remove it; this one can go once nothing needs it.</p>
          </>
        ) : (
          <>
            <p>
              {alreadyOut
                ? 'Its changes were already reverted on main when it was disabled, so only the record changes.'
                : `Corvid reverts its merge on a new branch with git alone and shows you the change; you approve the merge. ${files.length} file${files.length === 1 ? '' : 's'} were touched by the build. If later changes to Corvid conflict with the revert, you're told which files, and nothing changes.`}
            </p>
            <p>
              <b>Cost:</b> none. No agent and no usage, unless a conflict needs an agent to resolve it, which would ask you first with an estimate.
            </p>
            {info.dataLeft.length > 0 ? (
              <div className="lc-note">
                <b>Left in Corvid's data folder</b> (not deleted automatically; delete them yourself if you don't want them):
                <ul className="lc-files">
                  {info.dataLeft.map((f) => (
                    <li key={f}>
                      <code>{f}</code>
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="ext-small muted">No data of this extension was found in Corvid's data folder. Anything it stored elsewhere is not deleted.</p>
            )}
            <label className="lc-check">
              <input type="checkbox" checked={del} onChange={(e) => setDel(e.target.checked)} /> Remove and delete the extension (its stored text). Otherwise it goes back to “Not
              installed yet” so you can install it again.
            </label>
            {list.filter((x) => x.id === record.id && x.key !== record.key).length > 0 && <p className="ext-small muted">Other versions of it in the list stay.</p>}
          </>
        )}
        <div className="ext-buttons">
          {info.dependents.length === 0 && (
            <button className="btn danger sm" onClick={() => onRemove(del)}>
              <Trash2 size={13} /> {del ? 'Remove and delete the extension' : 'Remove'}
            </button>
          )}
          <button className="btn sm" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

/** Update available: the version change and a diff of the TEXT (spec and prompt). The update itself is the newer
 *  version's own install: a fresh scan, estimate, build and approval on its page, built on top of this one. */
function UpdateBox({ record, newKey, newVersion }: { record: ExtensionRecord; newKey: string; newVersion: string }): ReactNode {
  const [lines, setLines] = useState<ReturnType<typeof textDiff> | null>(null)
  const show = async (): Promise<void> => {
    const [a, b] = await Promise.all([api.extensionTextOf(record.key), api.extensionTextOf(newKey)])
    setLines(textDiff(a ?? '', b ?? ''))
  }
  return (
    <div className="lc-update card">
      <b>
        <ArrowUpCircle size={14} /> Update available: {record.version} → {newVersion}
      </b>
      <p className="ext-small">
        Updating is a new build of the new text: its own scan, estimate and confirmation, then your review. It's built on top of this version (the agent changes what's
        there), and this one is marked replaced only when you merge the new build.
      </p>
      <div className="ext-buttons">
        <button className="btn sm" onClick={() => void show()}>
          <FileDiff size={13} /> Show what changed in the text
        </button>
        <button className="btn primary sm" onClick={() => setState({ extensionsFocus: { key: newKey } })}>
          Open {newVersion} to scan and install
        </button>
      </div>
      {lines && (
        <pre className="lc-diff">
          {lines
            .filter((l, i, all) => l.kind !== ' ' || all.slice(Math.max(0, i - 2), i + 3).some((x) => x.kind !== ' '))
            .map((l, i) => (
              <span key={i} className={l.kind === '+' ? 'lc-add' : l.kind === '-' ? 'lc-del' : ''}>
                {l.kind} {l.line}
                {'\n'}
              </span>
            ))}
        </pre>
      )}
    </div>
  )
}

function HistoryList({ record }: { record: ExtensionRecord }): ReactNode {
  const h = record.lifecycle?.history ?? []
  if (!h.length) return null
  return (
    <details className="lc-history">
      <summary>
        <History size={13} /> History ({h.length})
      </summary>
      <ol>
        {[...h].reverse().map((e, i) => (
          <li key={i}>
            <span className="lc-when" title={new Date(e.at).toLocaleString()}>
              {relTime(e.at)}
            </span>{' '}
            <b>{e.what}</b> <span className="muted">by {e.who === 'user' ? 'you' : 'Corvid'}</span>
            {e.commits?.length ? (
              <>
                {' '}
                · {e.commits.map((c) => <code key={c}>{c.slice(0, 7)} </code>)}
              </>
            ) : null}
            {e.detail && <div className="ext-small muted">{e.detail}</div>}
          </li>
        ))}
      </ol>
    </details>
  )
}

const OP_NOUN = { disable: 'Disable', remove: 'Remove' } as const

/** A conflicted Disable or Remove, kept on its branch (#117): why, the estimate, and Resolve with an agent or Leave it. */
function ConflictBox({ record, hold }: { record: ExtensionRecord; hold: ConflictHold }): ReactNode {
  const [prompt, setPrompt] = useState<ResolvePrompt | null>(null)
  const [why, setWhy] = useState<string | null>(null)
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const waiting = hold.state === 'held' || hold.state === 'failed' || hold.state === 'interrupted'
  const fetchPrompt = (live: () => boolean = () => true): void =>
    void api.extensionPrepareResolve(record.key).then((p) => live() && ('error' in p ? (setWhy(p.error), setPrompt(null)) : (setWhy(null), setPrompt(p))))
  useEffect(() => {
    let live = true
    if (waiting) fetchPrompt(() => live)
    return () => {
      live = false
    }
  }, [record.key, hold.state, waiting]) // eslint-disable-line react-hooks/exhaustive-deps
  const run = async (fn: () => Promise<LifecycleResult>): Promise<void> => {
    setBusy(true)
    const r = await fn()
    setBusy(false)
    toast('error' in r ? r.error : r.message, 'error' in r ? 'error' : 'info')
  }
  const leave = (): void => {
    const text =
      hold.state === 'held'
        ? `Leave "${record.name}" as it is? Nothing changes on main; the conflict's branch and worktree are deleted. You can run ${OP_NOUN[hold.op]} again later.`
        : `Discard this resolution? Nothing changes on main; the branch ${hold.branch} and its worktree are deleted, with any work the agent did on it.`
    if (window.confirm(text)) void run(() => api.extensionLeaveConflict(record.key))
  }
  const stop = (): void => {
    if (window.confirm('Stop the agent? The branch and its work so far are kept.')) void run(() => api.extensionStopResolve(record.key))
  }
  const title = { held: 'It conflicts with later changes to Corvid', resolving: 'An agent is resolving the conflict', failed: 'The resolution failed', interrupted: 'Resolution interrupted' }[hold.state]
  return (
    <div className={`lc-conflict card lc-hold-${hold.state}`}>
      <b>
        {hold.state === 'resolving' ? <Bot size={14} /> : <TriangleAlert size={14} />} {title}
      </b>
      <p className="ext-small">
        {OP_NOUN[hold.op]}
        {hold.op === 'remove' && (hold.deleteText ? ' and delete the extension' : ' (the text is kept)')} · branch <code>{hold.branch}</code> · {relTime(hold.at)}
      </p>
      <ul className="lc-files">
        {hold.files.map((f) => (
          <li key={f}>
            <code>{f}</code>
            {hold.protectedFiles.includes(f) && <span className="chip lc-chip lc-prot">protected</span>}
          </li>
        ))}
      </ul>
      {hold.state === 'held' && <p>Nothing was changed on main. {CONFLICT_WHY}</p>}
      {hold.state === 'resolving' && (
        <p>
          #{hold.taskId} works on the branch only, in the Corvid project. When it reports, Corvid checks the commit itself (the files, protected paths, the diff scan and the
          typecheck) before showing it to you. Nothing is merged on its own.{' '}
          <button className="btn link sm" onClick={() => setState({ view: 'tasks' })}>
            Open #{hold.taskId} on the board
          </button>
        </p>
      )}
      {(hold.state === 'failed' || hold.state === 'interrupted') && (
        <ul className="lc-reasons">
          {(hold.reasons ?? ['No reason was recorded.']).map((x, i) => (
            <li key={i}>{x}</li>
          ))}
        </ul>
      )}
      {waiting && prompt && (
        <p className="ext-small">
          <b>Estimated cost:</b> about {fmtTokens(prompt.estimate.tokens.likely)} output tokens ({fmtTokens(prompt.estimate.tokens.low)}–{fmtTokens(prompt.estimate.tokens.high)}), around{' '}
          {Math.max(1, Math.round(prompt.estimate.minutes.likely))} min. You confirm before anything starts.
        </p>
      )}
      {waiting && why && <p className="ext-small muted">{why}</p>}
      <div className="ext-buttons lc-actions">
        {waiting && (
          <button className="btn primary sm" disabled={busy || !prompt} onClick={() => setAsking(true)}>
            <Bot size={13} /> {hold.state === 'held' ? 'Resolve with an agent…' : 'Retry…'}
          </button>
        )}
        {hold.state === 'resolving' ? (
          <button className="btn sm" disabled={busy} onClick={stop}>
            <Square size={13} /> Stop
          </button>
        ) : (
          <>
            {hold.state !== 'held' && (
              <button className="btn sm" onClick={() => void api.openFolder(hold.worktree)}>
                <FolderOpen size={13} /> Open the branch
              </button>
            )}
            <button className="btn sm" disabled={busy} onClick={leave}>
              <Trash2 size={13} /> {hold.state === 'interrupted' ? 'Discard' : hold.state === 'failed' ? 'Leave it' : 'Leave it as it is'}
            </button>
          </>
        )}
      </div>
      {asking && prompt && (
        <ResolveDialog
          record={record}
          hold={hold}
          prompt={prompt}
          onClose={() => {
            setAsking(false)
            // a token is used once: a fresh one for the next time
            setPrompt(null)
            fetchPrompt()
          }}
        />
      )}
    </div>
  )
}

/** The confirmation (#97): the estimate, the soft cap, the usage limit (#93), and the protected-path tick. */
function ResolveDialog({ record, hold, prompt, onClose }: { record: ExtensionRecord; hold: ConflictHold; prompt: ResolvePrompt; onClose: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [prot, setProt] = useState(false)
  const needProt = prompt.protectedFiles.length > 0
  const confirm = async (): Promise<void> => {
    setBusy(true)
    const r = await api.extensionConfirmResolve(record.key, prompt.token, prot)
    setBusy(false)
    onClose()
    if ('error' in r) return toast(r.error, 'error', undefined, { extension: record.name })
    toast(`Resolving as #${r.taskId}, on its own branch. Corvid checks the result before you review it.`, 'info')
  }
  return (
    <div className="overlay" onMouseDown={onClose}>
      <div className="dialog cost-confirm lc-modal" role="dialog" aria-modal="true" aria-label={`Resolve the conflict of ${record.name}`} onMouseDown={(e) => e.stopPropagation()}>
        <h3>Resolve with an agent?</h3>
        <p>
          An agent edits {prompt.files.join(', ')} on the conflict's branch to take “{record.name}” out by hand and keep everything Corvid gained since. It commits there and
          stops; it can't merge, approve or change the extension's record. Corvid checks the result itself, then you review the diff and merge it, or not.
        </p>
        <CostDetail e={prompt.estimate} />
        <p className="cost-cap">
          <b>Soft cap:</b> {prompt.capMultiple}× the likely estimate, about {fmtTokens(prompt.capTokens)} output tokens. Past it, Corvid asks whether to continue or stop.
        </p>
        {prompt.usage && (
          <p className="cost-over">
            <TriangleAlert size={13} /> {prompt.usage.text}
          </p>
        )}
        {needProt && (
          <label className="lc-check">
            <input type="checkbox" checked={prot} onChange={(e) => setProt(e.target.checked)} /> The conflict is in protected parts of Corvid ({prompt.protectedFiles.join(', ')}). Let
            the agent edit {prompt.protectedFiles.length === 1 ? 'that file' : 'those files'} for this resolution only.
          </label>
        )}
        <p className="ext-small muted">
          {OP_NOUN[hold.op]}
          {hold.op === 'remove'
            ? hold.deleteText
              ? ': the extension and its text are deleted once you merge.'
              : ': it goes back to “Not installed yet”, text kept, once you merge.'
            : ': it is marked Disabled once you merge.'}
        </p>
        <div className="actions">
          <button className="btn ghost" onClick={onClose} autoFocus>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !!prompt.usage?.block || (needProt && !prot)} onClick={() => void confirm()}>
            {prompt.usage && !prompt.usage.block ? 'Resolve anyway' : 'Confirm and resolve'}
          </button>
        </div>
      </div>
    </div>
  )
}

type Resolved = NonNullable<PendingChange['resolved']>

/** On the review screen, for a change an agent made: the diff scan, its report, and Send back with a note. */
function ResolvedNotes({ record, resolved, busy }: { record: ExtensionRecord; resolved: Resolved; busy: boolean }): ReactNode {
  const [note, setNote] = useState('')
  const [open, setOpen] = useState(false)
  const send = async (): Promise<void> => {
    const r = await api.extensionSendBackResolved(record.key, note)
    toast('error' in r ? r.error : r.message, 'error' in r ? 'error' : 'info')
    if (!('error' in r)) setOpen(false)
  }
  const n = resolved.flags.length
  return (
    <>
      <p className={resolved.scan === 'block' ? 'lc-bad' : resolved.scan === 'flag' ? 'lc-warn' : 'lc-ok'}>
        {resolved.scan === 'clear' ? <Check size={14} /> : <TriangleAlert size={14} />} Diff scan: {resolved.scan === 'clear' ? 'clear' : resolved.scan === 'flag' ? `${n} flag${n === 1 ? '' : 's'}` : 'blocked'}
      </p>
      {n > 0 && (
        <ul className="lc-reasons">
          {resolved.flags.map((f, i) => (
            <li key={i}>{f}</li>
          ))}
        </ul>
      )}
      <details className="lc-report">
        <summary>The agent's report (its own word; Corvid's checks are above)</summary>
        <p className="ext-small">{resolved.report}</p>
      </details>
      {open ? (
        <div className="lc-sendback">
          <textarea value={note} maxLength={2000} rows={3} placeholder="What should the agent change?" onChange={(e) => setNote(e.target.value)} />
          <div className="ext-buttons">
            <button className="btn sm" disabled={busy || !note.trim()} onClick={() => void send()}>
              <Send size={13} /> Send back
            </button>
            <button className="btn ghost sm" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="ext-buttons">
          <button className="btn sm" onClick={() => setOpen(true)}>
            <Send size={13} /> Send back with a note
          </button>
        </div>
      )}
    </>
  )
}
