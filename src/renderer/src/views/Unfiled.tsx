// The Unfiled inbox (#74): folders Claude sessions ran in that match no project, on the Projects board.
// Main builds the list with #73's skip rules; this only shows it and passes the user's choices back.
// Nothing is added on its own: Add as project, Add to a project (as an alias), Ignore, or just look.

import { useEffect, useState, type ReactNode } from 'react'
import { ChevronRight, EyeOff, FolderPlus, GitBranch, Inbox, Link2, MessageSquare, Plus, RotateCcw, X } from 'lucide-react'
import type { UnfiledEntry } from '@shared/types'
import { api } from '../api'
import { openProject, toast, useStore } from '../store'
import { relTime } from '../format'
import { locateFolder } from '../components/RelocateDialog'
import { primaryFolder } from '@shared/projectList'
import '../unfiled.css'
import { keyLabel } from '../keys'

const OPEN_KEY = 'unfiledOpen'

function readOpen(): boolean | null {
  try {
    const v = localStorage.getItem(OPEN_KEY)
    return v === null ? null : v === '1'
  } catch {
    return null
  }
}

/** New since the inbox was last looked at: what the Projects badge counts. */
export function useUnfiledNew(): number {
  const u = useStore((s) => s.unfiled)
  return u.entries.filter((e) => e.lastActivity > u.seenAt).length
}

const fail = (e: unknown): void => toast(String((e as Error)?.message ?? e), 'error')

async function addAsProject(path: string, name?: string, pinned?: boolean): Promise<boolean> {
  const r = await api.addProjectPath({ path, name, pinned })
  if ('error' in r) {
    toast(r.error, 'error')
    return false
  }
  toast(`Added ${r.project.name} to Projects.`)
  return true
}

export function Unfiled({ needle }: { needle: string }): ReactNode {
  const u = useStore((s) => s.unfiled)
  const fresh = useUnfiledNew()
  const [open, setOpenRaw] = useState<boolean>(() => readOpen() ?? true)
  const [ignoredOpen, setIgnoredOpen] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const setOpen = (v: boolean): void => {
    setOpenRaw(v)
    try {
      localStorage.setItem(OPEN_KEY, v ? '1' : '0')
    } catch {
      /* ignore */
    }
  }
  const shown = open || !!needle

  // Looking at the list clears the badge; only folders active after this count again.
  useEffect(() => {
    if (shown && fresh > 0) void api.unfiledSeen()
  }, [shown, fresh])

  const match = (e: { path: string }): boolean => !needle || e.path.toLowerCase().includes(needle)
  const entries = u.entries.filter(match)
  const scratch = u.entries.filter((e) => e.scratch)
  const pickedList = entries.filter((e) => picked.has(e.path))
  if (!u.ready && !u.entries.length) return null
  if (!u.entries.length && !u.ignored.length) return null

  const toggle = (path: string): void =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(path)) n.delete(path)
      else n.add(path)
      return n
    })
  const ignore = (paths: string[]): void => {
    void api.unfiledIgnore(paths).catch(fail)
    setPicked(new Set())
  }
  const addPicked = async (): Promise<void> => {
    setBusy(true)
    let added = 0
    for (const e of pickedList) if (await addAsProject(e.path).catch(() => false)) added++
    setBusy(false)
    setPicked(new Set())
    if (pickedList.length > 1) toast(`Added ${added} of ${pickedList.length} folders to Projects.`)
  }

  return (
    <div className="card archive unfiled">
      <button className="archive-head" onClick={() => setOpen(!open)} aria-expanded={shown}>
        <ChevronRight size={15} style={{ transform: shown ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
        <Inbox size={14} />
        <span>Unfiled</span>
        <span className="muted">{u.entries.length} folder{u.entries.length === 1 ? '' : 's'}</span>
        {fresh > 0 && <span className="chip uf-new">{fresh} new</span>}
        <span className="muted uf-hint">sessions in folders that aren't a project yet</span>
      </button>
      {shown && (
        <div className="uf-body">
          {u.entries.length > 0 && (
            <div className="uf-bulk">
              <label className="uf-check" title="Pick all">
                <input
                  type="checkbox"
                  checked={entries.length > 0 && pickedList.length === entries.length}
                  onChange={(e) => setPicked(new Set(e.target.checked ? entries.map((x) => x.path) : []))}
                />
              </label>
              {pickedList.length > 0 ? (
                <>
                  <span className="muted">{pickedList.length} picked</span>
                  <button className="btn sm" disabled={busy} onClick={() => void addPicked()}>
                    <FolderPlus size={12} /> Add as projects
                  </button>
                  <button className="btn sm ghost" onClick={() => ignore(pickedList.map((e) => e.path))}>
                    <EyeOff size={12} /> Ignore
                  </button>
                </>
              ) : (
                <span className="muted">Pick folders to add or ignore several at once</span>
              )}
              {scratch.length > 0 && (
                <button
                  className="btn sm ghost uf-scratch"
                  title={scratch.map((e) => e.path).join('\n')}
                  onClick={() => window.confirm(`Ignore ${scratch.length} folder${scratch.length === 1 ? '' : 's'} that look like scratch?\n\n${scratch.map((e) => e.path).join('\n')}`) && ignore(scratch.map((e) => e.path))}
                >
                  <EyeOff size={12} /> Ignore all that look like scratch ({scratch.length})
                </button>
              )}
            </div>
          )}
          {entries.map((e) => (
            <Row key={e.path} e={e} picked={picked.has(e.path)} onPick={() => toggle(e.path)} />
          ))}
          {u.entries.length === 0 && <div className="muted uf-empty">Nothing unfiled. Every folder with real work is a project or ignored.</div>}
          {u.quiet > 0 && (
            <div className="muted uf-foot">
              {u.quiet} more folder{u.quiet === 1 ? '' : 's'} with a single short session wait{u.quiet === 1 ? 's' : ''} here quietly; they show up after more work. Their sessions
              are still in search ({keyLabel('K')}).
            </div>
          )}
          {u.ignored.length > 0 && (
            <div className="uf-ignored">
              <button className="uf-ignored-head" onClick={() => setIgnoredOpen(!ignoredOpen)} aria-expanded={ignoredOpen}>
                <ChevronRight size={12} style={{ transform: ignoredOpen ? 'rotate(90deg)' : 'none', transition: 'transform .15s' }} />
                Ignored · {u.ignored.length}
              </button>
              {ignoredOpen &&
                u.ignored.filter(match).map((i) => (
                  <div className="uf-ig-row" key={i.path}>
                    <span className="mono r" title={i.path}>
                      {i.path}
                    </span>
                    <span className="muted">{i.sessions ? `${i.sessions} session${i.sessions === 1 ? '' : 's'}` : ''}</span>
                    <span className="muted num">ignored {relTime(i.at)}</span>
                    <button className="btn sm ghost" title="Show it in Unfiled again" onClick={() => void api.unfiledRestore([i.path]).catch(fail)}>
                      <RotateCcw size={12} /> Restore
                    </button>
                  </div>
                ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

type Mode = 'idle' | 'add' | 'to'

function Row({ e, picked, onPick }: { e: UnfiledEntry; picked: boolean; onPick: () => void }): ReactNode {
  const projects = useStore((s) => s.projects.projects)
  const missing = useStore((s) => s.projects.missing)
  // a clone of a project whose folder went missing is probably where it moved to (4/5)
  const movedTo = e.exists && e.suggestion?.id.startsWith('clone:') ? projects.find((p) => p.id === e.suggestion!.projectId && missing.includes(p.id)) : undefined
  const [mode, setMode] = useState<Mode>('idle')
  const [name, setName] = useState(e.name)
  const [pin, setPin] = useState(false)
  const listed = projects.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name))
  const [target, setTarget] = useState(e.suggestion?.projectId ?? listed[0]?.id ?? '')

  return (
    <div className={`uf-entry${picked ? ' picked' : ''}`}>
      <div className="uf-row">
        <label className="uf-check" title="Pick">
          <input type="checkbox" checked={picked} onChange={onPick} />
        </label>
        <div className="uf-main">
          <div className="uf-name">
            <b>{e.name}</b>
            {!e.exists && <span className="chip warn-chip">folder gone</span>}
            {e.isRepo ? (
              <span className="chip" title={e.remote ?? 'No remote'}>
                <GitBranch size={11} /> {e.branch ?? 'git'}
                {e.remote ? '' : ' · no remote'}
              </span>
            ) : (
              e.exists && <span className="chip">no git</span>
            )}
          </div>
          <div className="mono muted uf-path" title={e.path}>
            {e.path}
          </div>
          {e.suggestion && (
            <div className="uf-suggest">
              <span>{e.suggestion.text}</span>
              {movedTo && (
                <button className="btn sm" title={`${movedTo.name}'s folder is missing: use this folder as its new place`} onClick={() => locateFolder(movedTo.id, primaryFolder(movedTo), e.path)}>
                  Locate {movedTo.name} here…
                </button>
              )}
              <button className="btn ghost icon sm" title="Dismiss this suggestion" onClick={() => void api.unfiledDismiss(e.path, e.suggestion!.id).catch(fail)}>
                <X size={11} />
              </button>
            </div>
          )}
        </div>
        <div className="uf-stats muted">
          <span>
            {e.sessions} session{e.sessions === 1 ? '' : 's'}
          </span>
          <span className="num">{relTime(e.lastActivity)}</span>
        </div>
        <div className="uf-actions">
          <button className="btn sm ghost" title="See the sessions that ran here, and resume one" onClick={() => openProject(e.path)}>
            <MessageSquare size={12} /> Sessions
          </button>
          <button className={`btn sm${mode === 'add' ? ' on' : ''}`} disabled={!e.exists} title={e.exists ? 'Put this folder on your project list' : 'The folder no longer exists'} onClick={() => setMode(mode === 'add' ? 'idle' : 'add')}>
            <Plus size={12} /> Add as project
          </button>
          <button
            className={`btn sm ghost${mode === 'to' ? ' on' : ''}`}
            disabled={!listed.length}
            title="File its sessions under a project you already have"
            onClick={() => setMode(mode === 'to' ? 'idle' : 'to')}
          >
            <Link2 size={12} /> Add to…
          </button>
          <button className="btn sm ghost icon" title="Ignore this folder: never show it here again (restore it from Ignored)" onClick={() => void api.unfiledIgnore([e.path]).catch(fail)}>
            <EyeOff size={12} />
          </button>
        </div>
      </div>
      {mode === 'add' && (
        <form
          className="uf-form"
          onSubmit={(ev) => {
            ev.preventDefault()
            void addAsProject(e.path, name, pin).then((ok) => ok && setMode('idle'))
          }}
        >
          <input className="input" value={name} onChange={(ev) => setName(ev.target.value)} placeholder="Name" spellCheck={false} autoFocus />
          <label className="uf-pin">
            <input type="checkbox" checked={pin} onChange={(ev) => setPin(ev.target.checked)} /> Pin
          </label>
          <button className="btn sm primary" type="submit">
            <FolderPlus size={12} /> Add
          </button>
          <button className="btn sm ghost" type="button" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </form>
      )}
      {mode === 'to' && (
        <form
          className="uf-form"
          onSubmit={(ev) => {
            ev.preventDefault()
            void api
              .unfiledAddTo(target, e.path)
              .then((r) => {
                if ('error' in r) toast(r.error, 'error')
                else toast(`${e.name}'s sessions now file under ${r.project.name}.`)
              })
              .catch(fail)
          }}
        >
          <select className="input" value={target} onChange={(ev) => setTarget(ev.target.value)}>
            {listed.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="muted uf-note">As an alias: the folder stays where it is and its sessions count under that project.</span>
          <button className="btn sm primary" type="submit" disabled={!target}>
            <Link2 size={12} /> Add
          </button>
          <button className="btn sm ghost" type="button" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </form>
      )}
    </div>
  )
}
