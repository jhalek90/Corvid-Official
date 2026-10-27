import { useEffect, useState, type ReactNode } from 'react'
import { SettingLabel } from './Tooltip'
import { X } from 'lucide-react'
import type { AppConfig } from '@shared/types'
import { cleanDenyPattern, DENY_DEFAULTS, denyDefaultsFor } from '@shared/secretRules'
import { baseName } from '@shared/projects'
import { api } from '../api'
import { toast } from '../store'
import '../security.css'

/** Settings → Files agents may not read (#91): the defaults, the user's own patterns and the files allowed back. */
export function AgentDenyList({ config }: { config: AppConfig }): ReactNode {
  const [dataFolders, setDataFolders] = useState<string[]>([])
  // the defaults for the OS Corvid runs on; until it answers, the ones every platform has
  const [defaults, setDefaults] = useState(DENY_DEFAULTS.filter((d) => !d.platforms))
  const [draft, setDraft] = useState('')
  useEffect(
    () =>
      void api.denyInfo().then((d) => {
        setDataFolders(d.dataFolders)
        setDefaults(denyDefaultsFor(d.platform))
      }),
    []
  )
  const off = new Set(config.agentDenyOff ?? [])
  const extra = config.agentDenyExtra ?? []
  const allow = config.agentDenyAllow ?? []
  const set = (patch: Partial<AppConfig>): void => void api.setConfig(patch)
  const toggle = (p: string): void => set({ agentDenyOff: off.has(p) ? [...off].filter((x) => x !== p) : [...off, p] })
  const add = (): void => {
    const p = cleanDenyPattern(draft)
    if (!p) return toast('A pattern is a path or glob such as **/*.secret or ~/.myapp/token, with no brackets.', 'error')
    if (!extra.includes(p)) set({ agentDenyExtra: [...extra, p] })
    setDraft('')
  }
  const changed = off.size > 0 || extra.length > 0 || allow.length > 0

  return (
    <div className="card deny-card">
      <div className="deny-head">
        <div style={{ flex: 1, minWidth: 0 }}>
          <SettingLabel
            label="Files agents may not read"
            tip="Every agent Corvid starts, and Corvid's own chat, gets these as Claude Code deny rules for reading and editing, added on top of your own Claude settings (which Corvid never changes). They stop Claude Code's file tools and the shell commands it recognises, like cat or type. Agents already running keep the rules they started with."
          >
            <div className="d muted">A script an agent writes can still read a file, so keep real secrets in Corvid&apos;s connections.</div>
          </SettingLabel>
        </div>
        {changed && (
          <button className="btn sm" title="Back to the defaults: every default on, no own patterns, no allowed files" onClick={() => set({ agentDenyOff: [], agentDenyExtra: [], agentDenyAllow: [] })}>
            Reset
          </button>
        )}
      </div>

      <div className="deny-list">
        {dataFolders.map((f) => (
          <label key={f} className="deny-row fixed" title="Corvid's data folder holds the secrets, connections and backups, so this one can't be switched off">
            <input type="checkbox" checked disabled />
            <span className="mono">{f}</span>
            <span className="muted">Corvid's data folder</span>
          </label>
        ))}
        {defaults.map((d) => (
          <label key={d.pattern} className="deny-row">
            <input type="checkbox" checked={!off.has(d.pattern)} onChange={() => toggle(d.pattern)} />
            <span className="mono">{d.pattern}</span>
            <span className="muted">
              {d.label}
              {d.project ? ', in the project' : ''}
            </span>
          </label>
        ))}
        {extra.map((p) => (
          <div key={p} className="deny-row">
            <input type="checkbox" checked disabled />
            <span className="mono">{p}</span>
            <span className="muted">yours</span>
            <button className="btn sm ghost icon" title="Remove this pattern" onClick={() => set({ agentDenyExtra: extra.filter((x) => x !== p) })}>
              <X size={13} />
            </button>
          </div>
        ))}
      </div>

      <div className="deny-add">
        <input
          className="input sm"
          placeholder="Add a pattern: **/*.secret or ~/.myapp/token"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && add()}
        />
        <button className="btn sm" disabled={!draft.trim()} onClick={add}>
          Add
        </button>
      </div>

      {allow.length > 0 && (
        <>
          <div className="d muted" style={{ marginTop: 10 }}>
            Allowed on purpose: agents in that project may read these files. Add one with "Allow this one" in a project's secret scan.
          </div>
          <div className="deny-list">
            {allow.map((a) => (
              <div key={`${a.project}|${a.file}`} className="deny-row">
                <span className="mono">{a.file}</span>
                <span className="muted">in {baseName(a.project)}</span>
                <button
                  className="btn sm ghost icon"
                  title="Block it again"
                  onClick={() => set({ agentDenyAllow: allow.filter((x) => !(x.project === a.project && x.file === a.file)) })}
                >
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
