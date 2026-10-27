import { useEffect, useState, type ReactNode } from 'react'
import { FolderSearch, TriangleAlert } from 'lucide-react'
import type { RelocateCheck } from '@shared/types'
import { normKey } from '@shared/projectList'
import { api } from '../api'
import { setState, toast, useStore } from '../store'

// Locate folder… / Move folder… (4/5): point a project's folder at its new place. The old path joins the folder's
// past paths, so its sessions, tasks and notes stay with the project. Nothing on disk is moved, copied or deleted.

/** Open the dialog for one folder of a project, from anywhere (project page, Projects list, Files, git panels); `to` picks a place up front. */
export function locateFolder(projectId: string, path: string, to?: string): void {
  setState({ relocating: { projectId, path, to } })
}

/** "Locate folder…" for a missing one, "Move folder…" for one that's still there. */
export function LocateButton({ projectId, path, missing, sm = true }: { projectId: string; path: string; missing: boolean; sm?: boolean }): ReactNode {
  return (
    <button
      className={`btn${sm ? ' sm' : ''}${missing ? ' primary' : ''}`}
      title={missing ? 'The folder was moved, renamed or is on a drive that isn’t connected: pick where it is now' : 'You moved or copied this folder somewhere else: point the project at the new place'}
      onClick={(e) => {
        e.stopPropagation()
        locateFolder(projectId, path)
      }}
    >
      <FolderSearch size={13} /> {missing ? 'Locate folder…' : 'Move folder…'}
    </button>
  )
}

export function RelocateDialog(): ReactNode {
  const r = useStore((s) => s.relocating)
  const project = useStore((s) => s.projects.projects.find((p) => p.id === r?.projectId))
  const missingKeys = useStore((s) => s.projects.missingFolders)
  const [clones, setClones] = useState<string[]>([])
  const [picked, setPicked] = useState<{ path: string; check: RelocateCheck } | null>(null)
  const [busy, setBusy] = useState(false)
  /** after a move: agents' task worktrees still linked to the old place */
  const [stale, setStale] = useState<string[] | null>(null)

  useEffect(() => {
    setPicked(null)
    setClones([])
    setStale(null)
    if (!r) return
    void api.cloneSuggestions(r.projectId).then(setClones).catch(() => setClones([]))
    if (r.to) void choose(r.to)
  }, [r?.projectId, r?.path, r?.to])

  async function choose(path: string): Promise<void> {
    if (!r) return
    setBusy(true)
    try {
      setPicked({ path, check: await api.relocateCheck(r.projectId, r.path, path) })
    } finally {
      setBusy(false)
    }
  }

  if (!r || !project) return null
  const missing = (missingKeys ?? []).includes(normKey(r.path))
  const close = (): void => setState({ relocating: undefined })
  const browse = async (): Promise<void> => {
    const path = await api.pickFolder(missing ? undefined : r.path)
    if (path) await choose(path)
  }
  const apply = async (): Promise<void> => {
    if (!picked) return
    setBusy(true)
    try {
      const res = await api.relocateFolder(project.id, r.path, picked.path)
      if ('error' in res) return toast(res.error, 'error')
      toast(`${project.name} now uses ${picked.path}. Sessions from ${r.path} stay with it and resume in the new folder.`)
      if (res.staleWorktrees.length) setStale(res.staleWorktrees)
      else close()
    } finally {
      setBusy(false)
    }
  }
  const check = picked?.check

  if (stale)
    return (
      <div className="overlay" onMouseDown={close}>
        <div className="dialog relocate" onMouseDown={(e) => e.stopPropagation()}>
          <h3>
            <TriangleAlert size={17} color="var(--warn)" /> Agent worktrees need attention
          </h3>
          <p className="muted">
            {project.name} now uses <span className="mono">{picked?.path}</span>. Git still links {stale.length === 1 ? 'this task worktree' : `these ${stale.length} task worktrees`} to the old
            place, so an agent on {stale.length === 1 ? 'its task' : 'their tasks'} can’t use {stale.length === 1 ? 'it' : 'them'} yet:
          </p>
          <div className="relocate-check warn">
            {stale.map((t) => (
              <div key={t} className="mono">
                {t}
              </div>
            ))}
          </div>
          <p className="muted small">
            To fix the links, run <span className="mono">git worktree repair</span> in the new folder, followed by the new path of each worktree you moved too. Corvid
            doesn’t change git’s files itself. Tasks without a worktree, and everything else, already work from the new folder.
          </p>
          <div className="actions">
            <button className="btn primary" onClick={close}>
              OK
            </button>
          </div>
        </div>
      </div>
    )

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog relocate" onMouseDown={(e) => e.stopPropagation()}>
        <h3>
          <FolderSearch size={17} /> {missing ? 'Locate folder' : 'Move folder'}: {project.name}
        </h3>
        <p className="muted">
          {missing ? 'Corvid can’t find ' : 'This project uses '}
          <span className="mono">{r.path}</span>
          {missing
            ? '. If it was moved or renamed, pick where it is now. If it’s on a drive that isn’t connected, just plug it back in; nothing needs doing.'
            : '. If you moved or copied it, pick the new place. Corvid doesn’t move anything itself.'}
        </p>
        <p className="muted small">
          The old path stays on record, so its sessions, tasks and notes stay with {project.name}. Old sessions resume from the new folder:
          Claude Code finds a session by its id from any folder, so no files are copied.
        </p>
        {clones.length > 0 && (
          <div className="relocate-clones">
            <div className="section-label">
              <span>Same git remote, found in</span>
            </div>
            {clones.map((c) => (
              <button key={c} className={`btn ghost sm mono${picked?.path === c ? ' on' : ''}`} disabled={busy} onClick={() => void choose(c)}>
                {c}
              </button>
            ))}
          </div>
        )}
        {picked && check && (
          <div className={`relocate-check${'error' in check ? ' bad' : check.same ? ' ok' : ' warn'}`}>
            <div className="mono">{picked.path}</div>
            {'error' in check ? (
              <div>{check.error}</div>
            ) : check.same ? (
              <div>Looks like the same project ({check.why}).</div>
            ) : (
              <div>
                <TriangleAlert size={13} color="var(--warn)" /> {check.why} You can still use it.
              </div>
            )}
          </div>
        )}
        <div className="actions">
          <button className="btn ghost" onClick={close}>
            Cancel
          </button>
          <button className="btn" disabled={busy} onClick={() => void browse().catch((e) => toast(String(e), 'error'))}>
            Choose folder…
          </button>
          {picked && check && !('error' in check) && (
            <button className="btn primary" disabled={busy} onClick={() => void apply()}>
              {check.same ? 'Use this folder' : 'Use it anyway'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
