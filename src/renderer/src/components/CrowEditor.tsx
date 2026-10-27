import { useState, type ReactNode } from 'react'
import { SettingLabel } from './Tooltip'
import type { CrowLook } from '@shared/types'
import { CROW_EXTRAS, CROW_HATS, CROW_PARTS, HAT_LABEL, type CrowPartDef } from '@shared/crowParts'
import { CrowHead, CrowPreview, Hat, type CrowMood } from './Crow'
import { eyeHidden, hardToSee } from '../crowLook'
import { setCrowLook, useStore } from '../store'

const POSES: ['idle' | 'fly' | 'land', string][] = [
  ['idle', 'Perched'],
  ['fly', 'Flying'],
  ['land', 'Landing']
]
const MOODS: [CrowMood, string][] = [
  ['idle', 'Ready'],
  ['thinking', 'Thinking'],
  ['tool', 'Working'],
  ['waiting', 'Waiting'],
  ['error', 'Error']
]

export const DEFAULT_LOOK: CrowLook = { hat: 'none', extra: 'none' }

/**
 * Settings → Appearance: the crow's colours, hat and accessory, with a live preview of the mascot
 * and of the avatar at its real size. Changes apply everywhere as they're made.
 */
export function CrowEditor(): ReactNode {
  const look = useStore((s) => s.config?.crowLook) ?? DEFAULT_LOOK
  const on = useStore((s) => s.config?.crow ?? false)
  // read so the contrast note is rechecked when the theme changes
  useStore((s) => s.config?.theme)
  const [pose, setPose] = useState<'idle' | 'fly' | 'land'>('idle')
  const [mood, setMood] = useState<CrowMood>('idle')
  const set = (patch: Partial<CrowLook>): void => setCrowLook({ ...look, ...patch })
  const custom = !!(look.body || look.beak || look.eye || look.accent) || look.hat !== 'none' || look.extra !== 'none'

  return (
    <div className="card crow-editor">
      <div className="ce-head">
        <SettingLabel label="Crow look" tip="Colours, a hat and an accessory, for the crow on the app and Corvid’s avatar on the message board.">
          {!on && <div className="d">The crow is off, so this only shows here.</div>}
        </SettingLabel>
        <button className="btn sm" disabled={!custom} onClick={() => setCrowLook(DEFAULT_LOOK)}>
          Reset to default
        </button>
      </div>

      <div className="ce-body">
        <div className="ce-stage">
          <div className="ce-perch">
            <CrowPreview pose={pose} />
          </div>
          <div className="seg xs">
            {POSES.map(([p, label]) => (
              <button key={p} className={pose === p ? 'on' : ''} onClick={() => setPose(p)}>
                {label}
              </button>
            ))}
          </div>
          <div className="ce-avatars">
            <CrowHead mood={mood} size={34} label="Avatar preview, actual size" />
            <CrowHead mood={mood} size={64} label="Avatar preview, enlarged" />
          </div>
          <div className="seg xs">
            {MOODS.map(([m, label]) => (
              <button key={m} className={mood === m ? 'on' : ''} onClick={() => setMood(m)}>
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="ce-controls">
          {CROW_PARTS.map((p) => (
            <ColourRow key={p.key} part={p} value={look[p.key]} onChange={(v) => set({ [p.key]: v })} />
          ))}

          <div className="ce-row">
            <span className="ce-label">Hat</span>
            <div className="ce-hats crow-tint">
              {CROW_HATS.map((h) => (
                <button key={h} className={`ce-hat${look.hat === h ? ' on' : ''}`} title={HAT_LABEL[h]} aria-label={HAT_LABEL[h]} onClick={() => set({ hat: h })}>
                  <svg viewBox="23 -1.5 17 12" width="34" height="24" aria-hidden>
                    {h === 'none' ? <path className="ce-none" d="M27 4.5 L36 4.5" /> : <Hat hat={h} />}
                  </svg>
                </button>
              ))}
            </div>
          </div>

          <div className="ce-row">
            <span className="ce-label">Accessory</span>
            <div className="seg">
              {CROW_EXTRAS.map(([x, label]) => (
                <button key={x} className={look.extra === x ? 'on' : ''} onClick={() => set({ extra: x })}>
                  {label}
                </button>
              ))}
            </div>
          </div>

          {hardToSee(look) && (
            <div className="ce-note">
              Those feathers are close to this theme’s background, so the crow gets a firmer outline here to keep it visible.
            </div>
          )}
          {eyeHidden(look) && <div className="ce-note">The eye is hard to make out against the feathers. A lighter or darker eye will read better.</div>}
        </div>
      </div>
    </div>
  )
}

function ColourRow({
  part,
  value,
  onChange
}: {
  part: CrowPartDef
  value: string | undefined
  onChange: (v: string | undefined) => void
}): ReactNode {
  const preset = !value || part.presets.some(([, c]) => c === value)
  return (
    <div className="ce-row">
      <span className="ce-label">{part.label}</span>
      <div className="ce-swatches">
        <button className={`ce-sw${!value ? ' on' : ''}`} style={{ background: `var(${part.cssVar})` }} title="Theme default" onClick={() => onChange(undefined)} />
        {part.presets.map(([name, c]) => (
          <button key={c} className={`ce-sw${value === c ? ' on' : ''}`} style={{ background: c }} title={name} onClick={() => onChange(c)} />
        ))}
        <label className={`ce-sw ce-custom${preset ? '' : ' on'}`} style={preset ? undefined : { background: value }} title="Custom colour">
          <input type="color" value={value ?? part.fallback} onChange={(e) => onChange(e.target.value)} />
        </label>
      </div>
    </div>
  )
}
