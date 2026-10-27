import { useEffect, useState, type ReactNode } from 'react'
import { ArrowDownToLine, X } from 'lucide-react'
import { bannerCount, bannerText, checkSummary, type UpdateView } from '@shared/updateCheck'
import { api } from '../api'
import { toast } from '../store'
import { SettingLabel } from './Tooltip'

/**
 * The update notice (#143): one calm banner when the public repo has changes this copy doesn't. It never installs
 * anything; "Create update task" puts a task on the board for the user to start, and Dismiss hides it until upstream
 * moves on.
 */
export function UpdateBanner(): ReactNode {
  const [view, setView] = useState<UpdateView>()
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void api.updateView().then(setView)
    return api.on('update:view', setView)
  }, [])
  const count = bannerCount(view?.state, view?.dismissed)
  if (!count) return null

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api.updateCreateTask()
      if (r.error || !r.task) toast(r.error ?? "Couldn't create the update task.", 'error')
      else toast(r.existed ? `The update task is already on the board as #${r.task.id}.` : `Added #${r.task.id} "${r.task.title}" to Up next in the Corvid project. Start it when you're ready.`)
      setView(await api.updateView())
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="update-banner" role="status">
      <ArrowDownToLine size={14} className="update-banner-icon" />
      <span className="txt">{bannerText(count)}</span>
      <button className="btn sm" disabled={busy} onClick={() => void create()}>
        Create update task
      </button>
      <button className="btn sm ghost" disabled={busy} onClick={() => void api.updateDismiss().then(setView)} title="Hide this until the public repo changes again">
        <X size={12} /> Dismiss
      </button>
    </div>
  )
}

/** Settings' row (#143): the launch check's switch, and Check now with its result inline. */
export function UpdateCheckSetting({ on, set }: { on: boolean; set: (on: boolean) => void }): ReactNode {
  const [result, setResult] = useState<string>()
  const [checking, setChecking] = useState(false)
  const check = async (): Promise<void> => {
    setChecking(true)
    setResult(checkSummary({ status: 'checking' }))
    try {
      setResult(checkSummary((await api.updateCheck()).state))
    } finally {
      setChecking(false)
    }
  }
  return (
    <div className="setting">
      <SettingLabel
        label="Check for updates on launch"
        tip="On launch, Corvid runs a git fetch against the public Corvid repo (the upstream remote that npm run setup made) and nothing else, then tells you when there are new changes. It never pulls, merges, pushes or installs anything: an update is a task you start. Off, only Check now contacts the public repo."
      >
        {result && <div className="d">{result}</div>}
      </SettingLabel>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button className="btn sm" disabled={checking} onClick={() => void check()}>
          Check now
        </button>
        <div className={`toggle${on ? ' on' : ''}`} onClick={() => set(!on)} />
      </div>
    </div>
  )
}
