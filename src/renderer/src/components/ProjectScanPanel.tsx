import { useEffect, useState, type ReactNode } from 'react'
import { KeyRound, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import { findingKey, type SecretFinding, type SecretScan } from '@shared/secretRules'
import { projectKey } from '@shared/projects'
import { api } from '../api'
import { setState, snooze, toast, useStore } from '../store'
import { InfoTip } from './Tooltip'
import '../security.css'

// The project page's secret scan (#91). The scan runs in the main process on this project's folder only;
// what comes back is file, line and kind, never a value. A quiet scan on opening the page feeds the flag;
// the button opens the full list with the choices.

const cache = new Map<string, SecretScan>()
const FRESH_MS = 10 * 60_000

const where = (f: SecretFinding): string => (f.line ? `${f.file}:${f.line}` : f.file)

export function SecretScanPanel({ root, missing }: { root: string; missing: boolean }): ReactNode {
  const config = useStore((s) => s.config)
  const [scan, setScan] = useState<SecretScan | undefined>(cache.get(root))
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const s = await api.scanSecrets(root)
      cache.set(root, s)
      setScan(s)
    } catch (e) {
      toast(`The scan didn't finish: ${(e as Error).message}`, 'error')
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    setScan(cache.get(root))
    setOpen(false)
    const c = cache.get(root)
    if (!missing && (!c || Date.now() - c.at > FRESH_MS)) void run()
  }, [root, missing])

  if (!config || missing) return null
  const ignored = new Set(config.secretIgnore?.[projectKey(root)] ?? [])
  const findings = (scan?.findings ?? []).filter((f) => !ignored.has(findingKey(f)))
  const readable = findings.filter((f) => f.readable)
  const flagId = `${projectKey(root)}:secrets`
  const snoozed = (config.snoozed[flagId] ?? 0) > Date.now()

  const ignore = (f: SecretFinding): void => {
    const k = projectKey(root)
    const list = config.secretIgnore?.[k] ?? []
    void api.setConfig({ secretIgnore: { ...config.secretIgnore, [k]: [...list, findingKey(f)] } })
  }
  const allowed = config.agentDenyAllow ?? []
  const isAllowed = (f: SecretFinding): boolean => allowed.some((a) => projectKey(a.project) === projectKey(root) && a.file === f.file)
  const allowOne = (f: SecretFinding): void => {
    // a file blocked by its own ./path here is let through by dropping that pattern
    const extra = (config.agentDenyExtra ?? []).filter((p) => p !== `./${f.file}`)
    void api.setConfig({ agentDenyAllow: [...allowed, { project: root, file: f.file }], agentDenyExtra: extra }).then(run)
    toast(`Agents started from now on may read ${f.file}. Running agents keep their rules. Settings → Files agents may not read lists it.`)
  }
  const blockOne = (f: SecretFinding): void => {
    const pattern = `./${f.file}`
    const extra = config.agentDenyExtra ?? []
    if (!extra.includes(pattern)) void api.setConfig({ agentDenyExtra: [...extra, pattern] }).then(run)
    toast(`Agents started from now on can't read or edit ${f.file}. Running agents keep their rules.`)
  }
  // the Connections tab's Add wizard; removing the value from the file and rotating it stay with the user
  const addConnection = (): void => {
    setState({ view: 'connections', connectionsFocus: { area: 'add' } })
    toast("Save the secret as a connection here, then remove it from the file yourself, and rotate it if it was ever committed or shared.")
  }

  return (
    <>
      {readable.length > 0 && !snoozed && (
        <div className="risk warn">
          <TriangleAlert size={14} />
          <div className="txt link" onClick={() => setOpen(true)}>
            <span>
              {readable.length} possible secret{readable.length === 1 ? '' : 's'} in files agents can read
            </span>
          </div>
          <button className="btn sm ghost" onClick={() => setOpen(true)}>
            Show
          </button>
          <button className="btn sm ghost" title="Hide this for a week" onClick={() => snooze(flagId)}>
            Snooze
          </button>
        </div>
      )}
      {open ? (
        <div className="card scan-card">
          <div className="scan-head">
            <ShieldAlert size={15} />
            <div className="scan-title">
              <div>Secrets in this project</div>
              <div className="d muted" style={{ fontSize: 12 }}>
                {busy
                  ? 'Scanning…'
                  : scan
                    ? `${findings.length ? `${findings.length} possible secret${findings.length === 1 ? '' : 's'}` : 'Nothing found'} in ${scan.files} file${scan.files === 1 ? '' : 's'}${scan.partial ? ' (stopped at the file limit)' : ''}. Values are never shown.`
                    : ''}
              </div>
            </div>
            <button className="btn sm" disabled={busy} onClick={() => void run()}>
              Scan again
            </button>
            <button className="btn sm ghost icon" title="Close" onClick={() => setOpen(false)}>
              <X size={14} />
            </button>
          </div>
          {findings.length > 0 && (
            <div className="scan-list">
              {findings.map((f) => (
                <div key={`${f.file}|${f.line}|${f.kind}`} className="scan-row">
                  <span className="where">{where(f)}</span>
                  <span className="kind">
                    {f.kind}
                    {f.hint ? ` (${f.hint})` : ''}
                  </span>
                  {f.readable ? <span className="tag warn">agents can read it</span> : <span className="tag">agents can't read it</span>}
                  {f.tracked && <span className="tag warn" title="git tracks this file, so the value may already be in history: rotate it">in git</span>}
                  <span className="acts">
                    <button className="btn sm ghost" title="Save the secret in Corvid, where agents never see it" onClick={addConnection}>
                      <KeyRound size={12} /> Add to Corvid
                    </button>
                    {f.readable && !isAllowed(f) ? (
                      <button className="btn sm ghost" onClick={() => blockOne(f)}>
                        Block for agents
                      </button>
                    ) : (
                      !isAllowed(f) && (
                        <button className="btn sm ghost" title="Let agents in this project read this one file, on purpose" onClick={() => allowOne(f)}>
                          Allow this one
                        </button>
                      )
                    )}
                    <button className="btn sm ghost" title="Don't show this finding again" onClick={() => ignore(f)}>
                      Ignore
                    </button>
                  </span>
                </div>
              ))}
            </div>
          )}
          {findings.some((f) => f.tracked) && (
            <div className="scan-note muted">
              A secret that was ever committed, pushed or pasted somewhere should be rotated: change it where it's issued, since removing it from the file
              doesn't remove it from history.
            </div>
          )}
          <div className="scan-note muted">
            The scan changes nothing{' '}
            <InfoTip tip="The scan reads this project's files on this PC only, skips node_modules and build folders, doesn't look at git history, and changes nothing." />
          </div>
        </div>
      ) : (
        !(readable.length && !snoozed) && (
          <div className="scan-quiet">
            <button className="btn sm ghost" disabled={busy} onClick={() => setOpen(true)}>
              <ShieldAlert size={13} /> {busy ? 'Scanning for secrets…' : 'Scan for secrets'}
            </button>
          </div>
        )
      )}
    </>
  )
}
