import { useState, type ReactNode } from 'react'
import { ArrowDown, ArrowUp, FolderPlus, Star, Undo2, X } from 'lucide-react'
import type { MergePreview } from '@shared/types'
import type { FolderView, Project } from '@shared/projectModel'
import { api } from '../api'
import { toast, useStore } from '../store'
import { gitSummary } from '../views/ProjectsView'
import { LocateButton } from './RelocateDialog'

// A project's folders (3/5): add (with an optional label), remove, primary, order, and merging a folder that is a
// project of its own. Nothing here touches the disk; removing a folder only takes it off the project.

const fail = (e: unknown): void => toast(String((e as Error)?.message ?? e), 'error')

export function ProjectFolders({ p }: { p: Project }): ReactNode {
  const [label, setLabel] = useState('')
  const [merge, setMerge] = useState<MergePreview | null>(null)
  const [removing, setRemoving] = useState<FolderView | null>(null)
  const [naming, setNaming] = useState<{ path: string; text: string } | null>(null)

  const add = async (): Promise<void> => {
    const path = await api.pickFolder(p.path)
    if (!path) return
    const r = await api.addFolder(p.id, path, label)
    if ('error' in r) return toast(r.error, 'error')
    if ('merge' in r) {
      const preview = await api.mergePreview(p.id, r.merge)
      if ('error' in preview) return toast(preview.error, 'error')
      return setMerge(preview)
    }
    setLabel('')
    toast(r.warning ?? `Added ${path} to ${p.name}.`, r.warning ? 'error' : 'info')
  }

  const remove = (f: FolderView, newPrimary?: string): void => {
    if (f.primary && !newPrimary) return setRemoving(f)
    if (!f.primary && !window.confirm(`Take ${f.name} off ${p.name}? The folder, its sessions and tasks stay as they are on disk.`)) return
    void api
      .removeFolder(p.id, f.path, newPrimary)
      .then((r) => ('error' in r ? toast(r.error, 'error') : toast(`${f.name} is no longer part of ${p.name}.`)))
      .catch(fail)
    setRemoving(null)
  }
  const edit = (f: FolderView, patch: { primary?: boolean; label?: string; move?: number }): void => void api.editFolder(p.id, f.path, patch).catch(fail)

  return (
    <div className="card panel pfolders">
      <div className="section-label">
        <span>Folders</span>
        <span>{p.folders.length}</span>
      </div>
      {p.folders.map((f, i) => (
        <div key={f.path} className={`pfolder${f.missing ? ' missing' : ''}`}>
          <button
            className={`btn ghost icon sm${f.primary ? ' on' : ''}`}
            title={f.primary ? 'Primary folder: new sessions and tasks with no folder chosen work here' : 'Make this the primary folder'}
            onClick={() => !f.primary && edit(f, { primary: true })}
          >
            <Star size={13} fill={f.primary ? 'currentColor' : 'none'} />
          </button>
          <div className="pf-main">
            <div className="pf-name">
              {naming?.path === f.path ? (
                <input
                  className="input sm"
                  autoFocus
                  value={naming.text}
                  placeholder="label, e.g. app or website"
                  onChange={(e) => setNaming({ path: f.path, text: e.target.value })}
                  onBlur={() => setNaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') setNaming(null)
                    if (e.key === 'Enter') {
                      edit(f, { label: naming.text })
                      setNaming(null)
                    }
                  }}
                />
              ) : (
                <b className="link" title="Click to set a label" onClick={() => setNaming({ path: f.path, text: f.label ?? '' })}>
                  {f.name}
                </b>
              )}
              {f.primary && <span className="chip">primary</span>}
              {f.missing && <span className="chip warn-chip">missing</span>}
              <span className="muted">
                {f.sessions} session{f.sessions === 1 ? '' : 's'}
              </span>
            </div>
            <div className="mono muted pf-path" title={f.path}>
              {f.path}
            </div>
          </div>
          <div className="pf-git">{f.missing ? <span className="muted">The folder isn’t there</span> : gitSummary(f.git)}</div>
          <div className="pf-btns">
            <LocateButton projectId={p.id} path={f.path} missing={f.missing} />
            <button className="btn ghost icon sm" title="Move up" disabled={i === 0} onClick={() => edit(f, { move: -1 })}>
              <ArrowUp size={13} />
            </button>
            <button className="btn ghost icon sm" title="Move down" disabled={i === p.folders.length - 1} onClick={() => edit(f, { move: 1 })}>
              <ArrowDown size={13} />
            </button>
            <button className="btn ghost icon sm" title="Take this folder off the project (nothing on disk is deleted)" disabled={p.folders.length < 2} onClick={() => remove(f)}>
              <X size={13} />
            </button>
          </div>
        </div>
      ))}
      <div className="pf-add">
        <input className="input sm" value={label} placeholder="label (optional), e.g. website" onChange={(e) => setLabel(e.target.value)} />
        <button className="btn sm" onClick={() => void add().catch(fail)}>
          <FolderPlus size={13} /> Add folder
        </button>
      </div>
      {removing && (
        <div className="import-backdrop" onClick={() => setRemoving(null)}>
          <div className="card import-dialog narrow" onClick={(e) => e.stopPropagation()}>
            <h3>Remove the primary folder</h3>
            <p className="muted">
              {removing.name} is {p.name}'s primary folder. Choose which folder becomes primary. Nothing on disk changes.
            </p>
            {p.folders
              .filter((f) => f !== removing)
              .map((f) => (
                <button key={f.path} className="btn" onClick={() => remove(removing, f.path)}>
                  Make {f.name} primary and remove {removing.name}
                </button>
              ))}
            <div className="import-actions">
              <button className="btn ghost" onClick={() => setRemoving(null)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      {merge && <MergeDialog preview={merge} onClose={() => setMerge(null)} />}
    </div>
  )
}

function MergeDialog({ preview: m, onClose }: { preview: MergePreview; onClose: () => void }): ReactNode {
  const [busy, setBusy] = useState(false)
  const go = (): void => {
    setBusy(true)
    void api
      .mergeProjects(m.into.id, m.from.id)
      .then((r) => {
        if ('error' in r) return toast(r.error, 'error')
        toast(`Merged ${m.from.name} into ${m.into.name}.`, 'info', { label: 'Undo', run: () => void undoMerge() })
        onClose()
      })
      .catch(fail)
      .finally(() => setBusy(false))
  }
  return (
    <div className="import-backdrop" onClick={onClose}>
      <div className="card import-dialog narrow" onClick={(e) => e.stopPropagation()}>
        <h3>
          Merge {m.from.name} into {m.into.name}?
        </h3>
        <p className="muted">
          {m.from.name} is a project of its own. Merging makes its folder part of {m.into.name} and takes {m.from.name} off the list. Nothing on disk moves,
          and you can undo it for 10 minutes.
        </p>
        <div className="merge-list">
          <div>
            <b>Folders</b> {m.folders.map((f) => <div key={f} className="mono muted">{f}</div>)}
          </div>
          <div>
            <b>Sessions</b> {m.sessions} (they stay where they are and now count under {m.into.name})
          </div>
          <div>
            <b>Tasks</b> {m.tasks.length ? '' : 'none'}
            {m.tasks.map((t) => (
              <div key={t.id} className="muted">
                #{t.id} {t.title} <span className="chip">keeps working in its folder</span>
              </div>
            ))}
          </div>
          <div>
            <b>Notes</b> {m.notes.length ? '' : 'none'}
            {m.notes.map((n) => (
              <div key={n.id} className="muted">
                {n.id} {n.name}
              </div>
            ))}
          </div>
          <div>
            <b>Settings</b> {m.settings.length ? '' : 'nothing to carry over'}
            {m.settings.map((s) => (
              <div key={s} className="muted">
                {s}
              </div>
            ))}
          </div>
        </div>
        <div className="import-actions">
          <button className="btn ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={go}>
            Merge
          </button>
        </div>
      </div>
    </div>
  )
}

export async function undoMerge(): Promise<void> {
  const r = await api.undoMerge()
  if (r.error) toast(r.error, 'error')
  else toast('Merge undone: both projects are back as they were.')
}

/** Shown on the merged project while the merge can still be undone. */
export function UndoMergeBar({ p }: { p: Project }): ReactNode {
  const undo = useStore((s) => s.projects.undoMerge)
  if (!undo || undo.into !== p.id || undo.until < Date.now()) return null
  return (
    <div className="risk warn">
      <Undo2 size={14} />
      <div className="txt">
        <span>A project was merged into {p.name}. You can undo it until {new Date(undo.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</span>
      </div>
      <button className="btn sm ghost" onClick={() => void undoMerge()}>
        Undo merge
      </button>
    </div>
  )
}
