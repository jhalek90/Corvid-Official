import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, GitBranch } from 'lucide-react'
import type { ImportCandidate } from '@shared/types'
import { api } from '../api'
import { addProjectPath, toast } from '../store'
import { relTime } from '../format'

/**
 * The import preview (#73): the folders the old model showed, real ones pre-checked. Corvid's own and
 * temporary folders aren't offered; they sit in a collapsed Skipped list with the reason. Cancel is safe,
 * and running it again never adds a project twice.
 */
export function ImportPreview({ onClose }: { onClose: () => void }): ReactNode {
  const [list, setList] = useState<ImportCandidate[] | null>(null)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [skippedOpen, setSkippedOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void api.importPreview().then((l) => {
      setList(l)
      setChecked(new Set(l.filter((c) => c.checked).map((c) => c.path)))
    })
  }, [])

  const offered = (list ?? []).filter((c) => !c.skip && !c.already)
  const already = (list ?? []).filter((c) => !c.skip && c.already)
  const skipped = (list ?? []).filter((c) => c.skip)

  const cancel = (): void => {
    void api.importCancel()
    onClose()
  }
  const run = async (): Promise<void> => {
    setBusy(true)
    const picks = offered.filter((c) => checked.has(c.path)).map((c) => ({ path: c.path, pinned: c.pinned }))
    const r = await api.importProjects(picks).finally(() => setBusy(false))
    toast(`Imported ${r.added} project${r.added === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} already on the list` : ''}.`)
    onClose()
  }
  const toggle = (path: string): void =>
    setChecked((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })

  return (
    <div className="import-backdrop" onClick={cancel}>
      <div className="card import-dialog" onClick={(e) => e.stopPropagation()}>
        <h3>Import projects</h3>
        <p className="muted">
          Projects are now a list you keep. These are the folders Corvid showed before; pick the ones to keep. Nothing on disk changes.
        </p>
        {!list && <div className="muted">Looking at your session folders…</div>}
        <div className="import-list">
          {offered.map((c) => (
            <label key={c.path} className="import-row">
              <input type="checkbox" checked={checked.has(c.path)} onChange={() => toggle(c.path)} />
              <span className="n">
                {c.name}
                {c.pinned && <span className="chip">pinned</span>}
                {!c.exists && <span className="chip warn-chip">missing</span>}
              </span>
              <span className="mono muted p">{c.path}</span>
              <span className="muted">
                {c.isRepo ? (
                  <>
                    <GitBranch size={11} /> {c.branch ?? 'git'}
                    {c.remote ? '' : ' · no remote'}
                  </>
                ) : (
                  'no git'
                )}
              </span>
              <span className="muted num">
                {c.sessions} session{c.sessions === 1 ? '' : 's'}
                {c.lastActivity ? ` · ${relTime(c.lastActivity)}` : ''}
              </span>
            </label>
          ))}
          {list && !offered.length && <div className="muted">Nothing new to import.</div>}
        </div>
        {already.length > 0 && <div className="muted" style={{ fontSize: 12 }}>{already.length} already on your list.</div>}
        {skipped.length > 0 && (
          <div>
            <button className="archive-head" onClick={() => setSkippedOpen(!skippedOpen)}>
              <ChevronRight size={14} style={{ transform: skippedOpen ? 'rotate(90deg)' : 'none' }} />
              <span>Skipped ({skipped.length})</span>
            </button>
            {skippedOpen &&
              skipped.map((c) => (
                <div key={c.path} className="import-row skipped">
                  <span />
                  <span className="n">{c.name}</span>
                  <span className="mono muted p">{c.path}</span>
                  <span className="muted">{c.skip}</span>
                  <button className="btn sm ghost" title="Add it anyway" onClick={() => void addProjectPath(c.path)}>
                    Add
                  </button>
                </div>
              ))}
          </div>
        )}
        <div className="import-actions">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" disabled={!list || busy || !offered.some((c) => checked.has(c.path))} onClick={() => void run()}>
            Import {offered.filter((c) => checked.has(c.path)).length}
          </button>
        </div>
      </div>
    </div>
  )
}
