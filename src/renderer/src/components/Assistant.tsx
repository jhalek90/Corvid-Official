import type { ReactNode } from 'react'
import { CircleStop } from 'lucide-react'
import type { AssistantSnapshot, AssistantState, Worker, WorkerModel } from '@shared/types'
import type { CustomModel, CustomModelRef } from '@shared/customModels'
import { api } from '../api'
import { useStore } from '../store'
import { CrowHead, type CrowMood } from './Crow'
import { ContextRing } from './CorvidContext'
import { corvidCanUse, corvidCustomTitle, fableTitle, useFableNote } from './ModelOptions'
import { effectiveAssistantMode, isCustomModelRef } from '@shared/customModels'
import { choiceLabel, MODEL_CHOICES } from '@shared/models'
import { effortLabel } from '@shared/reasoningEffort'

// Corvid used to live in a dock on the right. It now lives on the message board (the user writes to it there,
// untagged or with "@corvid …"), so this file holds the pieces the dock had that still matter: the Corvid strip at the top of the board
// (avatar, state, context ring, mode, model, Stop); a new conversation is /clear on the board or Clear on the ring. The Agents view's approvals and its summary line (limits,
// Stop all) are in Approvals.tsx and AgentsSummary.tsx.

const cap = (s: string): string => s[0].toUpperCase() + s.slice(1)

/** "opus[1m]" -> "Opus 1M"; "claude-sonnet-5" -> "Sonnet 5" */
export function prettyModel(m: string | undefined): string {
  if (!m) return 'Claude Code default'
  const ctx = /\[1m\]/i.test(m) ? ' 1M' : ''
  const base = m.replace(/\[.*?\]/g, '').replace(/^claude-/, '')
  const [fam, ...ver] = base.split('-')
  return `${cap(fam)}${ver.length ? ' ' + ver.join('.') : ''}${ctx}`
}

export function workerModelLabel(m: WorkerModel | CustomModelRef, claudeDefault?: string, models?: readonly CustomModel[]): string {
  return m === 'default' ? `Default (${prettyModel(claudeDefault)})` : choiceLabel(m, models)
}

const STATE_LABEL: Record<AssistantState, string> = {
  offline: 'Ready',
  starting: 'Starting…',
  idle: 'Ready',
  thinking: 'Thinking…',
  tool: 'Working…',
  error: 'Error'
}

export const corvidBusy = (a: AssistantSnapshot): boolean => a.state === 'thinking' || a.state === 'tool' || a.state === 'starting'

// ---------- avatar ----------

const workerColor = (w: Worker, busy = 'var(--orb-hi)'): string =>
  w.liveStatus === 'waiting' || w.liveStatus === 'blocked' ? 'var(--warn)' : w.liveStatus === 'busy' ? busy : 'var(--text-3)'

/** The crow's head while the crow is switched on, otherwise the orb. The crow also shows an approval waiting on
 *  you, once Corvid has stopped working. */
function Avatar({ a, size }: { a: AssistantSnapshot; size?: number }): ReactNode {
  const crow = useStore((s) => s.config?.crow ?? false)
  if (!crow) return <Orb state={a.state} workers={a.workers} size={size} />
  const mood: CrowMood = a.state === 'error' ? 'error' : corvidBusy(a) ? (a.state as CrowMood) : a.proposals.length > 0 ? 'waiting' : 'idle'
  const label = mood === 'waiting' ? 'Corvid: waiting for your approval' : `Corvid: ${STATE_LABEL[a.state]}`
  return (
    <CrowHead
      mood={mood}
      beak={0}
      // the orb's pale busy dot vanishes on the light disc
      pips={a.workers.filter((w) => w.state === 'running').map((w) => workerColor(w, 'var(--accent)'))}
      size={size}
      label={label}
    />
  )
}

export function Orb({ state, workers, size = 34 }: { state: AssistantState; workers: Worker[]; size?: number }): ReactNode {
  const running = workers.filter((w) => w.state === 'running')
  return (
    <div className={`orb orb-${state}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" width={size} height={size}>
        <defs>
          <radialGradient id="orbCore" cx="40%" cy="38%" r="65%">
            <stop offset="0%" stopColor="var(--orb-hi)" />
            <stop offset="45%" stopColor="var(--accent)" />
            <stop offset="100%" stopColor="var(--orb-lo)" />
          </radialGradient>
        </defs>
        <circle className="orb-halo" cx="50" cy="50" r="30" />
        <g className="orb-ring">
          <circle cx="50" cy="50" r="31" fill="none" stroke="var(--accent)" strokeWidth="2.2" strokeDasharray="30 16 6 16" strokeLinecap="round" />
        </g>
        <g className="orb-ring2">
          <circle cx="50" cy="50" r="38" fill="none" stroke="var(--accent)" strokeOpacity="0.35" strokeWidth="1.2" strokeDasharray="2 7" />
        </g>
        <circle className="orb-core" cx="50" cy="50" r="17" fill="url(#orbCore)" />
        <g className="orb-dot">
          <circle cx="50" cy="12" r="4" fill="var(--accent)" />
        </g>
        {running.map((w, i) => (
          <g key={w.id} className="orb-sat" style={{ animationDelay: `${(-i * 9) / Math.max(1, running.length)}s` }}>
            <circle cx="50" cy="4" r="4.5" fill={workerColor(w)} stroke="var(--bg-1)" strokeWidth="2" />
          </g>
        ))}
      </svg>
    </div>
  )
}

// ---------- the Corvid strip, at the top of the board ----------

/** `channel`: the board channel on show, where the context ring's Compact and Clear leave their notices (#326) */
export function CorvidStrip({ channel }: { channel: string }): ReactNode {
  const a = useStore((s) => s.assistant)
  const config = useStore((s) => s.config)
  const fableNote = useFableNote()
  const busy = corvidBusy(a)
  // on a custom model (#320) Corvid is always Plan & ask; the saved mode comes back on a Claude model
  const onCustom = isCustomModelRef(config?.assistantModel)
  const mode = config && effectiveAssistantMode(config)
  return (
    <div className="cv-strip" data-tour="messages.corvid">
      <div className="cv-row">
        <Avatar a={a} size={26} />
        <div className="cv-who">
          <span className="cv-name">Corvid</span>
          <span className={`dock-state ${a.state}`}>{STATE_LABEL[a.state]}</span>
        </div>
        <ContextRing channel={channel} />
        {busy && (
          <button className="btn sm stop" title="Stop Corvid's reply" onClick={() => void api.assistantInterrupt()}>
            <CircleStop size={13} /> Stop
          </button>
        )}
        <div className="cv-switches">
          <div className="seg" title="Plan & ask: workers need your approval. Auto: they start right away, within limits. Also /mode on the board.">
            <button className={mode === 'ask' ? 'on' : ''} onClick={() => void api.setConfig({ assistantMode: 'ask' })} title="Workers need your approval">
              Plan &amp; ask
            </button>
            <button
              className={mode === 'auto' ? 'on' : ''}
              disabled={onCustom}
              onClick={() => void api.setConfig({ assistantMode: 'auto' })}
              title={onCustom ? 'While Corvid runs on one of your own models, workers always need your approval' : 'Workers start right away, within limits'}
            >
              Auto
            </button>
          </div>
          <div className="seg" title="Model Corvid itself runs on. Also in Settings and /model.">
            {MODEL_CHOICES.map((m) => (
              <button
                key={m}
                className={config?.assistantModel === m ? 'on' : ''}
                title={m === 'fable' ? fableTitle(fableNote) : undefined}
                onClick={() => void api.setConfig({ assistantModel: m })}
              >
                {m === 'fable' ? 'Fable' : choiceLabel(m)}
              </button>
            ))}
            {/* the user's own models (#316): Corvid itself only on those of 64k context and up, experimental (#320) */}
            {config?.models?.map((m) => (
              <button
                key={m.id}
                className={config.assistantModel === `custom:${m.id}` ? 'on' : ''}
                disabled={!corvidCanUse(m)}
                title={corvidCustomTitle(m, config.models)}
                onClick={() => void api.setConfig({ assistantModel: `custom:${m.id}` })}
              >
                {m.label}
              </button>
            ))}
          </div>
          {config && config.assistantEffort !== 'default' && (
            <span className="cv-effort" title={`Corvid's effort: ${effortLabel(config.assistantEffort)}. Change it in Settings; it applies from Corvid's next session.`}>
              {config.assistantEffort}
            </span>
          )}
        </div>
      </div>
      {a.customDown && (
        <div className="cv-down" role="status">
          <span>{a.customDown}</span>
          {/* only the user's click changes Corvid's model (#320); nothing switches it on its own */}
          <button className="btn sm" onClick={() => void api.setConfig({ assistantModel: 'haiku' })} title="Switches Corvid's model to Haiku. Your own model stays in Settings → Models.">
            Run Corvid on Haiku instead
          </button>
        </div>
      )}
    </div>
  )
}
