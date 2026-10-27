import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Download, FolderOpen, FolderSearch, Hammer, ListChecks, RotateCcw, X } from 'lucide-react'
import type { CorvidStatus, SetupItem } from '@shared/types'
import { api } from '../api'
import { toast, useStore } from '../store'
import { relTime } from '../format'

// Corvid's own project (#78): the installed build, its source, rebuild-and-restart and rollback.

export const shortCommit = (c: string): string => (c ? c.slice(0, 7) : 'unknown')

export function useCorvidStatus(pollMs: number): [CorvidStatus | null, () => void] {
  const [s, setS] = useState<CorvidStatus | null>(null)
  const load = (): void => void api.corvidStatus().then(setS)
  useEffect(() => {
    load()
    const t = setInterval(load, pollMs)
    return () => clearInterval(t)
  }, [pollMs])
  return [s, load]
}

export function CorvidPanel(): ReactNode {
  const [deploying, setDeploying] = useState(false)
  const [s, reload] = useCorvidStatus(deploying ? 2000 : 30_000)
  const [setup, setSetup] = useState<SetupItem[] | null>(null)
  const [checking, setChecking] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [wait, setWait] = useState(true)
  const [log, setLog] = useState('')
  const [installing, setInstalling] = useState(false)
  const [installLog, setInstallLog] = useState<string[]>([])
  const [busy, setBusy] = useState('')
  // select the stable list and filter outside: a selector that builds a new array each call loops forever (React #185, #83)
  const running = useStore((st) => st.assistant.workers).filter((w) => w.state === 'running')

  useEffect(() => setDeploying(!!s?.deploy), [s?.deploy])
  useEffect(() => {
    if (!deploying) return
    const tick = (): void => void api.corvidDeployLog().then(setLog)
    tick()
    const t = setInterval(tick, 1500)
    return () => clearInterval(t)
  }, [deploying])
  useEffect(() => api.onCorvidInstallLine((l) => setInstallLog((x) => [...x.slice(-200), l])), [])

  if (!s) return <div className="card corvid-panel muted">Checking Corvid's install…</div>

  const check = async (): Promise<void> => {
    setChecking(true)
    setSetup(await api.corvidCheckSetup().finally(() => setChecking(false)))
  }
  const clone = async (): Promise<void> => {
    if (!window.confirm(`Get Corvid's source?\n\nThis runs your own git to clone\n${s.cloneUrl}\ninto a folder you pick next. Nothing else is downloaded, and no password is asked for here.`)) return
    const dir = await api.corvidPickCloneFolder()
    if (!dir) return
    setBusy('Cloning…')
    const r = await api.corvidClone(dir).finally(() => setBusy(''))
    if ('error' in r) toast(r.error, 'error')
    else toast("Corvid's source is set up. Next: Check setup, then Install dependencies.")
    reload()
  }
  const useExisting = async (): Promise<void> => {
    const dir = await api.pickFolder()
    if (!dir) return
    const r = await api.corvidSetSource(dir)
    if ('error' in r) toast(r.error, 'error')
    reload()
  }
  const installDeps = async (): Promise<void> => {
    setInstallLog([])
    setInstalling(true)
    const r = await api.corvidInstall().finally(() => setInstalling(false))
    if (r.error) toast(r.error, 'error')
    else if (r.code === 0) toast('Dependencies installed.')
    else toast(r.code === null ? 'The install was cancelled.' : `npm install ended with code ${r.code}; see its output.`, 'error')
  }
  const rebuild = async (): Promise<void> => {
    setConfirm(false)
    const r = await api.corvidRebuild(wait)
    if (r.error) toast(r.error, 'error')
    reload()
  }
  const rollback = async (): Promise<void> => {
    const prev = s.previous[0]
    if (!window.confirm(`Roll back to the previous build (${shortCommit(prev?.commit ?? '')}, ${relTime(prev?.at ?? 0)})?\n\nCorvid restarts, which ends every agent running inside it.`)) return
    const r = await api.corvidRollback()
    if (r.error) toast(r.error, 'error')
    reload()
  }

  const failed = /Deploy failed|Rollback failed/.test(log)
  const behind = s.git?.installedBehind

  return (
    <div className="card corvid-panel">
      {s.notice && (
        <div className="risk serious corvid-notice">
          <CircleAlert size={14} />
          <div className="txt">{s.notice}</div>
          <button className="btn sm ghost" onClick={() => void api.corvidDismissNotice().then(reload)}>
            Dismiss
          </button>
        </div>
      )}
      <div className="corvid-build">
        <span>
          Installed <b>v{s.version}</b>
        </span>
        <span className="mono" title={s.commit || 'This build has no commit baked in'}>
          build {shortCommit(s.commit)}
          {s.dirty ? ' (with uncommitted changes)' : ''}
        </span>
        {s.builtAt > 0 && <span className="muted">built {relTime(s.builtAt)}</span>}
        {!s.packaged && <span className="chip">dev run</span>}
        {s.source && behind !== undefined && (
          <span className={behind > 0 ? 'corvid-behind' : 'muted'}>
            {behind > 0 ? `The installed app is ${behind} commit${behind === 1 ? '' : 's'} behind main` : 'Up to date with main'}
          </span>
        )}
      </div>

      {s.source ? (
        <div className="corvid-source">
          <span className="muted">Source</span>
          <span className="mono">{s.source}</span>
          {s.git &&
            (s.git.error ? (
              <span className="muted">git: {s.git.error}</span>
            ) : (
              <span className="muted">
                on {s.git.branch} · {s.git.changed ? `${s.git.changed} uncommitted` : 'clean'}
                {s.git.ahead ? ` · ↑${s.git.ahead}` : ''}
                {s.git.behind ? ` · ↓${s.git.behind}` : ''}
              </span>
            ))}
        </div>
      ) : (
        <div className="corvid-nosource">
          <b>Source not set up</b>
          <p>Corvid is installed, but to change it with Corvid you need its source code on this machine.</p>
          {!s.canClone && <p className="muted">Corvid's source isn't available for this install.</p>}
        </div>
      )}

      <div className="actions corvid-actions">
        {s.source ? (
          <>
            <button className="btn primary" disabled={deploying || !s.packaged} title={s.packaged ? 'Build from main, install, restart' : 'A dev run has no install to replace'} onClick={() => setConfirm(true)}>
              <Hammer size={14} /> Rebuild and restart Corvid
            </button>
            <button className="btn" onClick={() => void api.openFolder(s.source!)}>
              <FolderOpen size={14} /> Open source folder
            </button>
          </>
        ) : (
          s.canClone && (
            <button className="btn primary" disabled={!!busy} onClick={() => void clone()}>
              <Download size={14} /> {busy || "Get Corvid's source"}
            </button>
          )
        )}
        <button className="btn" title="Point Corvid's project at a checkout of its source" onClick={() => void useExisting()}>
          <FolderSearch size={14} /> {s.source ? 'Change source folder' : 'Use an existing checkout'}
        </button>
        <button className="btn" disabled={checking} onClick={() => void check()}>
          <ListChecks size={14} /> {checking ? 'Checking…' : 'Check setup'}
        </button>
        {s.source &&
          (installing ? (
            <button className="btn" onClick={() => void api.corvidCancelInstall()}>
              <X size={14} /> Cancel install
            </button>
          ) : (
            <button className="btn" title="npm install in the source folder" onClick={() => void installDeps()}>
              <Download size={14} /> Install dependencies
            </button>
          ))}
        {s.previous.length > 0 && (
          <button className="btn" disabled={deploying} title={`${s.previous.length} earlier build${s.previous.length === 1 ? '' : 's'} kept beside the install`} onClick={() => void rollback()}>
            <RotateCcw size={14} /> Roll back to the previous build
          </button>
        )}
      </div>

      {confirm && (
        <div className="corvid-confirm">
          <b>Rebuild and restart Corvid?</b>
          <p>
            This builds Corvid from the main branch of the source, installs it and restarts Corvid. Restarting ends every agent running inside it. If the build fails, nothing is stopped. If the
            new build doesn't start, the previous one is put back.
          </p>
          {running.length > 0 ? (
            <>
              <p>
                {running.length} agent{running.length === 1 ? ' is' : 's are'} running: {running.map((w) => `${w.agentName ?? 'agent'} (#${w.taskId})`).join(', ')}.
              </p>
              <label className="corvid-radio">
                <input type="radio" checked={wait} onChange={() => setWait(true)} /> Wait until they finish, then rebuild
              </label>
              <label className="corvid-radio">
                <input type="radio" checked={!wait} onChange={() => setWait(false)} /> Rebuild now and end them
              </label>
            </>
          ) : (
            <p className="muted">No agents are running.</p>
          )}
          <div className="actions">
            <button className="btn primary" onClick={() => void rebuild()}>
              {running.length && wait ? 'Rebuild when they finish' : 'Rebuild and restart'}
            </button>
            <button className="btn" onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {s.deploy?.waiting && (
        <div className="corvid-progress">
          Waiting for {running.length} agent{running.length === 1 ? '' : 's'} to finish before rebuilding.{' '}
          <a className="link" onClick={() => void api.corvidCancelRebuild().then(reload)}>
            Cancel
          </a>
        </div>
      )}
      {s.deploy?.error && <div className="corvid-progress error">{s.deploy.error}</div>}
      {deploying && !s.deploy?.waiting && (
        <div className={`corvid-progress${failed ? ' error' : ''}`}>
          <b>{failed ? 'The build failed. Corvid kept running; nothing was stopped.' : 'Rebuilding… Corvid restarts when the build is done.'}</b>
          <pre className="mono">{log || 'Starting the deploy script…'}</pre>
        </div>
      )}

      {setup && (
        <div className="corvid-setup">
          {setup.map((i) => (
            <div key={i.name} className={`corvid-check${i.ok ? ' ok' : ' bad'}`}>
              {i.ok ? <CheckCircle2 size={14} /> : <CircleAlert size={14} />}
              <b>{i.name}</b>
              <span className="muted">{i.detail}</span>
              {i.fix && <span>{i.fix}</span>}
            </div>
          ))}
        </div>
      )}
      {(installing || installLog.length > 0) && (
        <div className="corvid-progress">
          <b>{installing ? 'Installing dependencies…' : 'Install output'}</b>
          <pre className="mono">{installLog.slice(-30).join('\n')}</pre>
        </div>
      )}
    </div>
  )
}
