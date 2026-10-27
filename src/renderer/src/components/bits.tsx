import type { ReactNode } from 'react'
import { Layers, TriangleAlert } from 'lucide-react'
import type { LiveSession, SessionSummary } from '@shared/types'
import { modelFamily, modelLabel } from '@shared/models'
import { BASE_TIP, baseHigh, CONTEXT_TIP, contextHigh } from '@shared/context'
import { compact } from '../format'
import { familyColor } from './charts'

export function StatusDot({ live, title }: { live?: LiveSession; title?: string }): ReactNode {
  if (!live) return <span className="dot off" title={title} />
  return <span className={`dot ${live.status}`} title={title ?? statusLabel(live)} />
}

export function statusLabel(live: LiveSession): string {
  switch (live.status) {
    case 'busy':
      return 'Working'
    case 'waiting':
      return live.waitingFor ? `Needs you · ${live.waitingFor}` : 'Needs you'
    case 'blocked':
      return 'Blocked'
    case 'idle':
      return 'Idle · ready for input'
    default:
      return live.status
  }
}

export function whereLabel(entrypoint?: string, termId?: string): string {
  if (termId) return 'this dashboard'
  if (!entrypoint) return 'another window'
  if (entrypoint.includes('vscode')) return 'VS Code'
  if (entrypoint === 'cli') return 'a terminal'
  if (entrypoint.includes('desktop')) return 'Claude desktop'
  if (entrypoint.startsWith('sdk')) return 'an SDK process'
  return entrypoint
}

export function primaryModel(models: Record<string, number>): string | undefined {
  let best: string | undefined
  let n = -1
  for (const [m, c] of Object.entries(models)) if (c > n) ((best = m), (n = c))
  return best
}

export function ModelTag({ model }: { model?: string }): ReactNode {
  if (!model) return null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span className="model-swatch" style={{ background: familyColor(modelFamily(model)) }} />
      {modelLabel(model)}
    </span>
  )
}

export function contextTitle(s: SessionSummary): string {
  const lines = [`Context ${s.context.toLocaleString()} tokens (peak ${compact(s.peakContext)})`]
  if (contextHigh(s)) lines.push(CONTEXT_TIP)
  if (s.baseContext) lines.push('', `Always-on ${compact(s.baseContext)}`)
  if (baseHigh(s)) lines.push(BASE_TIP)
  return lines.join('\n')
}

/** Current context size, amber past the warning line, plus a flag for heavy always-on context. */
export function ContextTag({ s }: { s: SessionSummary }): ReactNode {
  if (!s.context && !s.baseContext) return null
  const high = contextHigh(s)
  return (
    <span className={`ctx-tag${high ? ' high' : ''}`} title={contextTitle(s)}>
      {high && <TriangleAlert size={11} />}
      {s.context ? `${compact(s.context)} ctx` : 'compacted'}
      {baseHigh(s) && <Layers size={11} className="base" />}
    </span>
  )
}
