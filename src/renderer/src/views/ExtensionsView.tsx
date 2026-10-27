import { useEffect, useState, type ReactNode } from 'react'
import { ExtensionSockets } from './ExtensionSockets'
import { ArrowLeft, ArrowUpCircle, BadgeCheck, Blocks, ChevronRight, ClipboardPaste, Copy, FileUp, PencilLine, ShieldAlert, ShieldCheck, ShieldQuestion, Sparkles, Trash2, TriangleAlert, X } from 'lucide-react'
import { EFFORT_WORDS, MAX_BYTES, type ExtensionDetail, type ExtensionRecord, type ImportOutcome } from '@shared/extensions'
import { coreArea, TIER_DETAIL, TIER_WORDS } from '@shared/extensionTiers'
import { api } from '../api'
import { ExtensionScan } from '../components/ExtensionScan'
import { setState, toast, useStore } from '../store'
import { relTime } from '../format'
import '../extensions.css'
import { editExtension, openPackager, PackagerWizard, usePackager } from '../components/PackagerWizard'
import { BudgetBar, CostChip, CostLine, CostSection, InstallButton } from './ExtensionCost'
import { BuildPanel, InstallChecks } from './ExtensionInstall'
import { BuildChip, BuildProgressPanel } from '../components/BuildProgress'
import { LifecycleChips, LifecyclePanel, useShowRemoved } from './ExtensionLifecycle'
import { VerifyShare } from './ExtensionVerify'
import { claimText } from '@shared/extensionVerify'
import { updateFor } from '@shared/extensionLifecycle'
import { BUTTON_WORDS, pageLayout, shortText, type PageButtonId } from '@shared/extensionPage'
import { InfoTip } from '../components/Tooltip'
import { LearnMore } from './DocsView'

// The Extensions tab (#95): the extensions in the ledger as cards, each with a read-only page. Extensions are text
// (.corvid files, docs/EXTENSIONS.md); importing only validates and stores them. Installing comes with #98.

const INSTALL_SOON = 'After you confirm, a build agent builds it on its own branch and you review the result here before anything is merged.'

let cache: ExtensionRecord[] = []
const listeners = new Set<(l: ExtensionRecord[]) => void>()
let subscribed = false
function useExtensions(): ExtensionRecord[] {
  const [list, setList] = useState(cache)
  useEffect(() => {
    listeners.add(setList)
    if (!subscribed) {
      subscribed = true
      const set = (l: ExtensionRecord[]): void => {
        cache = l
        listeners.forEach((f) => f(l))
      }
      api.onExtensions(set)
      void api.extensionsList().then(set)
    } else void api.extensionsList().then((l) => ((cache = l), setList(l)))
    return () => void listeners.delete(setList)
  }, [])
  return list
}

/** Shows an import's outcome: one new extension opens on its page with the review prompt; anything else (several
 *  files, errors, a same-id choice) gets the results dialog. */
export async function runImport(outcomes: Promise<ImportOutcome[]>): Promise<void> {
  let out: ImportOutcome[]
  try {
    out = await outcomes
  } catch (e) {
    return toast(`Import failed: ${(e as Error).message}`, 'error')
  }
  if (!out.length) return
  const added = out.filter((o): o is Extract<ImportOutcome, { ok: true }> => o.ok)
  if (out.length === 1 && added.length === 1) return setState({ view: 'extensions', extensionsFocus: { key: added[0].key, review: true }, extensionImports: undefined })
  setState({ view: 'extensions', extensionsFocus: undefined, extensionImports: out })
}

/** Dropping .corvid files anywhere on the window imports them (#95). Other files get a clear message and nothing
 *  else; drags that carry no files (tabs, cards, text) are left to whoever handles them. */
export function useExtensionDrop(): void {
  useEffect(() => {
    const hasFiles = (e: DragEvent): boolean => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files')
    const over = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      e.dataTransfer!.dropEffect = 'copy'
    }
    const drop = (e: DragEvent): void => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const files = [...(e.dataTransfer?.files ?? [])]
      if (!files.length) return
      if (!files.some((f) => /\.corvid$/i.test(f.name)))
        return toast(`${files.length === 1 ? `“${files[0].name}” isn't a .corvid extension file` : "These aren't .corvid extension files"}, so nothing was imported.`)
      void runImport(api.extensionsImportDropped(files, MAX_BYTES))
    }
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])
}

export function ExtensionsView(): ReactNode {
  const list = useExtensions()
  const focus = useStore((s) => s.extensionsFocus)
  const wizard = usePackager()
  if (wizard.open && !focus?.key) return <PackagerWizard s={wizard} />
  if (focus?.key) return <ExtensionPage key={focus.key} extKey={focus.key} review={!!focus.review} />
  return <ExtensionList list={list} />
}


function ExtensionList({ list: all }: { list: ExtensionRecord[] }): ReactNode {
  // removed extensions (#99) are kept as history and hidden unless asked for
  const [showRemoved, setShowRemoved] = useShowRemoved()
  const removed = all.filter((r) => r.status === 'removed').length
  const list = showRemoved ? all : all.filter((r) => r.status !== 'removed')
  return (
    <div className="ext-view">
      <div className="tasks-head ext-head">
        <div>
          <h2>Extensions</h2>
          <p className="muted">
            {list.length ? `${list.length} extension${list.length === 1 ? '' : 's'} · ` : ''}Importing never runs anything{' '}
            <InfoTip tip="Drop a .corvid file anywhere on Corvid to import it. Importing never runs or builds anything." />{' '}
            <LearnMore page="extensions/overview" />
          </p>
        </div>
        <div className="ext-actions">
          <button className="btn sm primary" onClick={openPackager} title="Package a feature you built, or a new idea, as a .corvid file in a guided chat">
            <Sparkles size={13} /> New extension
          </button>
          <button className="btn sm" onClick={() => void runImport(api.extensionsPick())} title="Choose .corvid files to import">
            <FileUp size={13} /> Import
          </button>
          <button className="btn sm" onClick={() => void runImport(api.extensionsPaste())} title="Import the text of a .corvid file from the clipboard">
            <ClipboardPaste size={13} /> Paste
          </button>
          {removed > 0 && (
            <label className="ext-showremoved">
              <input type="checkbox" checked={showRemoved} onChange={(e) => setShowRemoved(e.target.checked)} /> Show removed ({removed})
            </label>
          )}
        </div>
      </div>
      <BudgetBar count={list.length} />
      {list.length === 0 ? (
        <div className="empty">
          <Blocks size={28} strokeWidth={1.5} />
          <h3>No extensions yet</h3>
          <p>
            Drop a .corvid file here, or use Import or Paste.{' '}
            <InfoTip tip="An extension is a .corvid text file: a description and a seed prompt your Corvid can build from." />
          </p>
        </div>
      ) : (
        <div className="ext-grid">
          {list.map((r) => {
            const lay = pageLayout(r, all)
            return (
              <button key={r.key} className="card ext-card" onClick={() => setState({ extensionsFocus: { key: r.key } })} title={r.header.description}>
                <div className="ext-card-top">
                  <span className="ext-name">{r.name}</span>
                  <span className="ext-ver">{r.version}</span>
                  {lay.verified && <BadgeCheck size={12} className="ext-verified" aria-label="Verified" />}
                  <span className={`chip ext-status s-${r.status}`}>{lay.status}</span>
                </div>
                <div className="ext-desc">{r.header.description}</div>
                <LifecycleChips record={r} list={all} />
                <div className="ext-meta">
                  {r.header.author && <span>{r.header.author}</span>}
                  <span className={`ext-tier t${r.header.capabilities.tier}`}>{lay.tier}</span>
                  <span>{EFFORT_WORDS[r.header.effort.class]} effort</span>
                  <CostChip record={r} />
                </div>
                <BuildChip record={r} />
              </button>
            )
          })}
        </div>
      )}
      <ExtensionSockets />
    </div>
  )
}

// The extension's page (#119): a short top (header, summary, permissions at a glance, cost, the state's buttons and
// any panel that needs the user), then everything long in collapsed sections. Which buttons and panels show is
// decided by pageLayout (src/shared/extensionPage.ts); the panels themselves are the components that always ran them.

function useOpenFolds(extKey: string): [Set<string>, (id: string, open?: boolean) => void] {
  const k = `ext.open.${extKey}`
  const [open, setOpen] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(sessionStorage.getItem(k) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const set = (id: string, v?: boolean): void =>
    setOpen((o) => {
      const n = new Set(o)
      if (v ?? !n.has(id)) n.add(id)
      else n.delete(id)
      try {
        sessionStorage.setItem(k, JSON.stringify([...n]))
      } catch {
        /* remembered for this session only, when it can be */
      }
      return n
    })
  return [open, set]
}

const firstLine = (t: string | undefined, n = 90): string => {
  const x = (t ?? '').trim().split(/\n|(?<=[.!?])\s/)[0] ?? ''
  return x.length > n ? `${x.slice(0, n).replace(/\s+\S*$/, '')}…` : x
}

function ExtensionPage({ extKey, review }: { extKey: string; review: boolean }): ReactNode {
  const list = useExtensions()
  const [d, setD] = useState<ExtensionDetail | null | undefined>(undefined)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [ready, setReady] = useState(false)
  const [moreSummary, setMoreSummary] = useState(false)
  const [open, setOpen] = useOpenFolds(extKey)
  const inList = list.some((r) => r.key === extKey)
  useEffect(() => void api.extensionDetail(extKey).then(setD), [extKey, inList])
  const back = (): void => setState({ extensionsFocus: undefined })
  if (d === undefined) return <div className="ext-view" />
  if (!d)
    return (
      <div className="ext-view">
        <div className="kempty">
          This extension is no longer in the list.
          <button className="btn sm" onClick={back}>
            <ArrowLeft size={13} /> All extensions
          </button>
        </div>
      </div>
    )
  // the list carries the live record (status, build); the detail the text
  const r = list.find((x) => x.key === extKey) ?? d.record
  const h = r.header
  const c = h.capabilities
  const o = h.effort.observed
  const sec = d.sections
  const lay = pageLayout(r, list)
  const top = new Set(lay.top)
  const bytes = new TextEncoder().encode(d.text ?? '').length
  const del = async (): Promise<void> => {
    const res = await api.extensionDelete(r.key)
    setConfirmDelete(false)
    if ('error' in res) return toast(res.error, 'error')
    toast(`Deleted “${r.name}”`)
    back()
  }
  const jump = (id: string): void => {
    setOpen(id, true)
    requestAnimationFrame(() => document.getElementById(`ext-fold-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
  const observed = [
    o.minutes !== undefined && `${o.minutes} min`,
    o.files !== undefined && `${o.files} file${o.files === 1 ? '' : 's'} touched`,
    o.checks !== undefined && `${o.checks} check${o.checks === 1 ? '' : 's'}`,
    o.model,
    o.cost && `${o.cost} cost`,
    o.tokens !== undefined && `${o.tokens.toLocaleString()} tokens`
  ].filter(Boolean)
  const summary = sec ? shortText(sec.summary) : null
  const update = updateFor(r, list)
  const b = r.build
  const acceptance = b?.report?.acceptance ?? []
  const passed = acceptance.filter((a) => a.result === 'pass').length
  const failedChecks = acceptance.filter((a) => a.result === 'fail').length
  const scanReport = r.scan?.state === 'done' ? r.scan.report : undefined
  const historyBuild = !!b && b.state !== 'discarded' && !top.has('build')
  const historyProgress = !!b && b.state !== 'discarded' && !top.has('progress')
  const historyLifecycle = !top.has('lifecycle') && !!r.lifecycle?.history?.length
  const touches = c.coreAreas.length ? c.coreAreas.map((a) => coreArea(a)?.label ?? a) : [c.tier === 1 ? 'New files only' : TIER_WORDS[c.tier]]
  const hosts = c.hosts.length ? (c.hosts.length > 2 ? `${c.hosts.slice(0, 2).join(', ')} +${c.hosts.length - 2}` : c.hosts.join(', ')) : null

  const rowButton = (id: PageButtonId, kind: 'primary' | 'normal' | 'quiet'): ReactNode => {
    switch (id) {
      case 'install':
      case 'retry':
        return <InstallButton key={id} record={r} blocked={!ready} label={BUTTON_WORDS[id]} primary={kind === 'primary'} />
      case 'edit':
        return (
          <button key={id} className="btn sm" onClick={() => editExtension(r.key, r.name)} title="Revise it in the packaging wizard: a new version, with a diff of the text">
            <PencilLine size={13} /> Edit
          </button>
        )
      case 'update':
        return update ? (
          <button key={id} className="btn sm" onClick={() => setState({ extensionsFocus: { key: update.key } })} title={`Open ${update.version} to scan and install it: a new build on top of this one`}>
            <ArrowUpCircle size={13} /> Update to {update.version}
          </button>
        ) : null
      case 'delete':
        return (
          <button key={id} className="btn ghost sm ext-quiet" onClick={() => setConfirmDelete(true)} title="Delete the extension and its stored text; asks first">
            <Trash2 size={13} /> Delete
          </button>
        )
    }
  }

  return (
    <div className="ext-view ext-page">
      <button className="btn ghost sm ext-back" onClick={back}>
        <ArrowLeft size={13} /> All extensions
      </button>

      <header className="ext-title">
        <h2>
          {h.name} <span className="ext-ver">{h.version}</span>
        </h2>
        <div className="ext-title-chips">
          <span className={`chip ext-status s-${r.status}`}>{lay.status}</span>
          {lay.verified && (
            <span className="chip ext-status s-verified">
              <BadgeCheck size={11} /> Verified
            </span>
          )}
          <span className={`ext-tier t${c.tier}`}>{lay.tier}</span>
          {h.author && <span className="muted">by {h.author}</span>}
        </div>
      </header>

      <div className="ext-summary">
        <p className="ext-lede">{h.description}</p>
        {summary && summary.short && (
          <p className="ext-text">
            {moreSummary ? sec!.summary : summary.short}
            {summary.more && (
              <>
                {' '}
                <button className="btn link sm ext-more" aria-expanded={moreSummary} onClick={() => setMoreSummary((v) => !v)}>
                  {moreSummary ? 'Show less' : 'Show more'}
                </button>
              </>
            )}
          </p>
        )}
      </div>

      {review && r.status === 'not-installed' && (
        <div className="ext-review card">
          <div>
            <b>Review and install?</b>
            <p>
              Read what it does, what it may change and the full seed prompt in the sections below: an agent would follow that prompt to build this into your Corvid.
              Nothing has run. Install shows Corvid's estimate and asks you to confirm first. {INSTALL_SOON}
            </p>
          </div>
          <button className="btn ghost icon sm" title="Dismiss" onClick={() => setState({ extensionsFocus: { key: r.key } })}>
            <X size={14} />
          </button>
        </div>
      )}
      {!sec && (
        <div className="ext-warn">
          <TriangleAlert size={14} /> The stored text of this extension is missing or no longer valid; only its header is shown.
        </div>
      )}

      <ul className="ext-perms" aria-label="Permissions at a glance">
        {touches.map((t) => (
          <li key={t}>
            <button className={`ext-perm${c.tier === 3 ? ' warn' : ''}`} onClick={() => jump('perms')} title="Open the permissions in detail">
              {t}
            </button>
          </li>
        ))}
        <li>
          <button className={`ext-perm${c.packages.length ? '' : ' none'}`} onClick={() => jump('perms')} title={c.packages.map((p) => `${p.name}@${p.version}`).join(', ') || undefined}>
            {c.packages.length ? `${c.packages.length} new package${c.packages.length === 1 ? '' : 's'}` : 'No new packages'}
          </button>
        </li>
        <li>
          <button className={`ext-perm${hosts ? '' : ' none'}`} onClick={() => jump('perms')} title={c.hosts.join(', ') || undefined}>
            {hosts ? `Network: ${hosts}` : 'No network'}
          </button>
        </li>
        <li>
          <button className={`ext-perm${c.data ? '' : ' none'}`} onClick={() => jump('perms')} title={c.data}>
            {c.data ? `Stores: ${firstLine(c.data, 40)}` : 'No stored data'}
          </button>
        </li>
        <li>
          <button className={`ext-perm${c.rebuild ? '' : ' none'}`} onClick={() => jump('perms')}>
            {c.rebuild ? 'Rebuild and restart' : 'No rebuild'}
          </button>
        </li>
        <li>
          <button className={`ext-perm scan t-${lay.scan.tone}`} onClick={() => jump(scanReport ? 'scan' : 'perms')} title="The safety scan's verdict">
            {lay.scan.tone === 'ok' ? <ShieldCheck size={12} /> : lay.scan.tone === 'muted' ? <ShieldQuestion size={12} /> : <ShieldAlert size={12} />} Scan: {lay.scan.word}
            {lay.scan.flags > 0 && (
              <b className="ext-flagcount">
                {lay.scan.flags} flag{lay.scan.flags === 1 ? '' : 's'}
              </b>
            )}
          </button>
        </li>
      </ul>

      <CostLine record={r} effort={EFFORT_WORDS[h.effort.class]} />

      {lay.buttons.length > 0 && <div className="ext-buttons ext-toprow">{lay.buttons.map((x) => rowButton(x.id, x.kind))}</div>}
      {r.source.kind === 'created' && (
        <p className="muted ext-created-note">Created here, a draft for sharing. Your own Corvid keeps the feature; this extension is only the packaged text.</p>
      )}

      {/* the state's own panels: what needs the user, and the actions that live with them */}
      {top.has('install-checks') && <InstallChecks record={r} onReady={setReady} />}
      {top.has('scan') && <ExtensionScan record={r} bytes={bytes} part={scanReport ? 'controls' : undefined} />}
      {top.has('progress') && <BuildProgressPanel record={r} checks={sec?.checks} />}
      {top.has('build') && <BuildPanel record={r} />}
      {top.has('lifecycle') && <LifecyclePanel record={r} list={list} />}
      {top.has('verify') && <VerifyShare record={r} />}

      <div className="ext-folds">
        {sec?.whatItDoes && (
          <Fold id="what" title="What it does" hint={firstLine(sec.whatItDoes)} open={open} onToggle={setOpen}>
            <div className="ext-text">{sec.whatItDoes}</div>
          </Fold>
        )}
        {sec?.seedPrompt && (
          <Fold id="prompt" title="Seed prompt" hint={`What the build agent will be told · ${sec.seedPrompt.split('\n').length} line${sec.seedPrompt.includes('\n') ? 's' : ''}`} open={open} onToggle={setOpen}>
            <p className="ext-small">Shown in full and read only: this is exactly what a build agent that can edit Corvid would be given.</p>
            <TextBox text={sec.seedPrompt} />
          </Fold>
        )}
        {sec && sec.checks.length > 0 && (
          <Fold
            id="checks"
            title={`Acceptance checks (${sec.checks.length})`}
            hint={acceptance.length ? `${passed} passed${failedChecks ? `, ${failedChecks} failed` : ''} in the last build` : 'What the build has to pass'}
            open={open}
            onToggle={setOpen}
          >
            <ol className="ext-checks">
              {sec.checks.map((ch, i) => (
                <li key={i}>{ch}</li>
              ))}
            </ol>
          </Fold>
        )}
        {(scanReport || !top.has('scan')) && (
          <Fold id="scan" title="Safety scan report" hint={scanReport ? `${lay.scan.word}${lay.scan.flags ? ` · ${lay.scan.flags} flagged` : ''} · flags with cited lines, declared and inferred capabilities, what's found in the text` : lay.scan.word} open={open} onToggle={setOpen}>
            <ExtensionScan record={r} bytes={bytes} part={top.has('scan') ? 'report' : undefined} />
          </Fold>
        )}
        <Fold id="perms" title="Permissions in detail" hint="The author's declarations: tier, core areas, packages, hosts, data, rebuild" open={open} onToggle={setOpen}>
          <dl className="ext-dl">
            <dt>Tier</dt>
            <dd>
              <span className={`ext-tier t${c.tier}`}>{TIER_WORDS[c.tier]}</span> — {TIER_DETAIL[c.tier]}
            </dd>
            <dt>Core areas</dt>
            <dd>{c.coreAreas.length ? c.coreAreas.map((a) => coreArea(a)?.label ?? a).join(', ') : 'None'}</dd>
            <dt>New packages</dt>
            <dd>{c.packages.length ? c.packages.map((p) => `${p.name}@${p.version}`).join(', ') : 'None'}</dd>
            <dt>Network hosts</dt>
            <dd>{c.hosts.length ? c.hosts.join(', ') : 'None'}</dd>
            <dt>Data it stores</dt>
            <dd>{c.data ?? 'None declared'}</dd>
            <dt>Rebuild</dt>
            <dd>{c.rebuild ? 'Needs a rebuild and restart of Corvid' : 'No rebuild declared'}</dd>
            <dt>Effort</dt>
            <dd>
              {EFFORT_WORDS[h.effort.class]}
              {observed.length ? ` · the author's build: ${observed.join(', ')}` : ''}
            </dd>
          </dl>
          <p className="ext-small">These are the author's declarations. Corvid's own scan (Extensions 2/8) will check them before any install.</p>
        </Fold>
        <Fold id="estimate" title="Estimate details" hint="Corvid's estimate against the author's claim, what it's based on" open={open} onToggle={setOpen}>
          <CostSection record={r} />
        </Fold>
        {(historyBuild || historyProgress) && (
          <Fold id="history" title="Build and verify history" hint="Stages with times, cost, check results, the build report and diff scan" open={open} onToggle={setOpen}>
            {historyProgress && <BuildProgressPanel record={r} checks={sec?.checks} />}
            {historyBuild && <BuildPanel record={r} />}
          </Fold>
        )}
        {historyLifecycle && (
          <Fold id="lifecycle" title="Lifecycle history" hint={`${r.lifecycle!.history!.length} event${r.lifecycle!.history!.length === 1 ? '' : 's'}: installs, disables and removes with their commits`} open={open} onToggle={setOpen}>
            <LifecyclePanel record={r} list={list} />
          </Fold>
        )}
        {!top.has('verify') && (
          <Fold id="verify" title="Verify and share" hint="Optional: a test build on a clean copy of Corvid, never merged" open={open} onToggle={setOpen}>
            <VerifyShare record={r} />
          </Fold>
        )}
        <Fold id="tech" title="Header and technical details" hint={`${h.id} · built on Corvid ${h.builtOn.version}${h.requires.length || h.conflicts.length ? ' · requires and conflicts' : ''}`} open={open} onToggle={setOpen}>
          <dl className="ext-dl">
            <dt>Id</dt>
            <dd className="mono">{h.id}</dd>
            <dt>Built on</dt>
            <dd className="mono">
              Corvid {h.builtOn.version} @ {h.builtOn.commit}
            </dd>
            <dt>Works with</dt>
            <dd className="mono">{h.worksWith ?? 'Not stated'}</dd>
            <dt>Verified</dt>
            <dd>{claimText(h) ?? 'Not claimed'}</dd>
            <dt>Source</dt>
            <dd>
              {r.source.kind === 'imported' ? `Imported${r.source.fileName ? ` from ${r.source.fileName}` : ''}` : 'Created here'} · {relTime(r.createdAt)}
            </dd>
            <dt>Hash</dt>
            <dd className="mono ext-hash">{r.hash}</dd>
            {(h.requires.length > 0 || h.conflicts.length > 0) && (
              <>
                <dt>Requires</dt>
                <dd>{h.requires.length ? h.requires.map((q) => `${q.id} ${q.range}`).join(', ') : 'Nothing'}</dd>
                <dt>Conflicts with</dt>
                <dd>{h.conflicts.length ? h.conflicts.join(', ') : 'Nothing'}</dd>
              </>
            )}
          </dl>
          {d.text && (
            <>
              <p className="ext-small">The whole file:</p>
              <TextBox text={d.text} />
            </>
          )}
        </Fold>
        {sec?.notes && (
          <Fold id="notes" title="Notes from the author" hint={firstLine(sec.notes)} open={open} onToggle={setOpen}>
            <div className="ext-text">{sec.notes}</div>
          </Fold>
        )}
      </div>

      {confirmDelete && (
        <div className="overlay" onMouseDown={() => setConfirmDelete(false)}>
          <div className="dialog" onMouseDown={(e) => e.stopPropagation()}>
            <h3>Delete “{h.name}”?</h3>
            <p>This removes the extension from the list and deletes its stored text. Nothing was installed, so nothing else changes. You can import the file again later.</p>
            <div className="actions">
              <button className="btn ghost" onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button className="btn danger" onClick={() => void del()}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/** A collapsed section: a title, a one-line hint and a chevron; the body renders only when open. */
function Fold({ id, title, hint, open, onToggle, children }: { id: string; title: string; hint?: string; open: Set<string>; onToggle: (id: string) => void; children: ReactNode }): ReactNode {
  const isOpen = open.has(id)
  return (
    <section className={`ext-fold${isOpen ? ' open' : ''}`} id={`ext-fold-${id}`}>
      <button className="ext-fold-head" aria-expanded={isOpen} aria-controls={`ext-fold-body-${id}`} onClick={() => onToggle(id)}>
        <ChevronRight size={14} className="ext-chev" aria-hidden />
        <span className="ext-fold-title">{title}</span>
        {hint && !isOpen && <span className="ext-fold-hint">{hint}</span>}
      </button>
      {isOpen && (
        <div className="ext-fold-body" id={`ext-fold-body-${id}`}>
          {children}
        </div>
      )}
    </section>
  )
}

const BOX_LIMIT = 6000

/** Long extension text, as plain text: monospaced, scrolling in its own box, with Copy and Show all past a limit. */
function TextBox({ text }: { text: string }): ReactNode {
  const [all, setAll] = useState(false)
  const long = text.length > BOX_LIMIT
  const copy = (): void =>
    void navigator.clipboard.writeText(text).then(
      () => toast('Copied'),
      () => toast("Couldn't copy to the clipboard", 'error')
    )
  return (
    <div className="ext-box">
      <div className="ext-box-tools">
        <button className="btn ghost sm" onClick={copy} title="Copy the full text">
          <Copy size={12} /> Copy
        </button>
      </div>
      <pre className={`ext-pre ext-scroll${all ? ' all' : ''}`} tabIndex={0}>
        {long && !all ? `${text.slice(0, BOX_LIMIT)}…` : text}
      </pre>
      {long && (
        <button className="btn link sm" onClick={() => setAll((v) => !v)}>
          {all ? 'Show less' : `Show all (${Math.round(text.length / 1024)} KB)`}
        </button>
      )}
    </div>
  )
}

/** The outcome of an import with more than one file, any problem, or a same-id choice to make. */
export function ImportResults(): ReactNode {
  const results = useStore((s) => s.extensionImports)
  if (!results) return null
  const close = (): void => setState({ extensionImports: undefined })
  const choose = async (i: number, token: string, choice: 'replace' | 'keep' | 'skip'): Promise<void> => {
    const r = await api.extensionsResolve(token, choice)
    setState((s) => ({ extensionImports: s.extensionImports?.map((x, j) => (j === i ? r : x)) }))
  }
  const added = results.filter((r) => r.ok).length
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog ext-results" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          {added ? `Imported ${added} of ${results.length}` : results.length === 1 ? 'Not imported' : `None of ${results.length} imported`}
        </h3>
        <ul>
          {results.map((r, i) => (
            <li key={i} className={r.ok ? 'ok' : 'conflict' in r ? 'ask' : 'bad'}>
              <b>{r.name}</b>
              {r.ok ? (
                <span>
                  {r.replaced ? 'Replaced the older version. ' : 'Added as “Not installed yet”. '}
                  <button className="btn ghost sm" onClick={() => setState({ extensionImports: undefined, extensionsFocus: { key: r.key, review: true } })}>
                    Review
                  </button>
                </span>
              ) : 'conflict' in r ? (
                <span>
                  An extension with this id is already in the list (version {r.conflict.existing.version}); this one is {r.conflict.incoming.version}.
                  <span className="ext-choices">
                    {r.conflict.canReplace && (
                      <button className="btn sm primary" onClick={() => void choose(i, r.conflict.token, 'replace')}>
                        Replace with {r.conflict.incoming.version}
                      </button>
                    )}
                    <button className="btn sm" onClick={() => void choose(i, r.conflict.token, 'keep')}>
                      Keep both
                    </button>
                    <button className="btn sm ghost" onClick={() => void choose(i, r.conflict.token, 'skip')}>
                      Skip
                    </button>
                  </span>
                </span>
              ) : (
                <ul className="ext-errors">
                  {r.errors.map((e, k) => (
                    <li key={k}>{e}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
        <div className="actions">
          <button className="btn" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
