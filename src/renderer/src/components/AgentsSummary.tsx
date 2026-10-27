import type { ReactNode } from 'react'
import { Octagon } from 'lucide-react'
import { gateLabel, overFableGate, overGates, SUGGESTED_WORKERS } from '@shared/workerLimits'
import { allModelsWeek, fableWeek } from '@shared/models'
import { api } from '../api'
import { useStore } from '../store'

// The Agents page's one summary line, under its heading: what's running, working and waiting on the user, and usage
// against the usage limit past which a new worker asks first (or is blocked), with Stop all and the over-limit note. Each count shows once on
// the page; the cards below say the rest.

interface Limits {
  /** running workers, every project: the max is for all of them */
  workers: number
  max: number
  five?: number
  week?: number
  /** "70%", or "no limit" for a gate that's off */
  gate5h: string
  gateWeek: string
  over5h: boolean
  overWeek: boolean
  /** Fable's own weekly limit (#127), when the account has one */
  fable?: number
  /** new workers run on Fable and its weekly limit is at or past the weekly gate */
  overFable: boolean
  over: boolean
  /** above the limit, new agents are refused rather than asking first */
  block: boolean
}

function useLimits(): Limits {
  const a = useStore((s) => s.assistant)
  const limits = useStore((s) => s.config?.limits)
  const workerModel = useStore((s) => s.config?.workerModel)
  const quota = useStore((s) => s.quota)
  const fresh = a.liveQuota && (!quota || a.liveQuota.at > quota.fetchedAt)
  const five = fresh ? a.liveQuota!.fiveHour : quota?.session?.pct
  const week = fresh ? a.liveQuota!.week : allModelsWeek(quota?.weeks)?.pct
  const over = limits ? overGates(limits, five, week) : { five: false, week: false }
  const fable = fableWeek(quota?.weeks)?.pct
  const overFable = !!limits && workerModel === 'fable' && overFableGate(limits, fable)
  return {
    workers: a.workers.filter((w) => w.state === 'running').length,
    max: limits?.maxWorkers ?? SUGGESTED_WORKERS,
    five,
    week,
    gate5h: limits ? gateLabel(limits, '5h') : '–',
    gateWeek: limits ? gateLabel(limits, 'week') : '–',
    over5h: over.five,
    overWeek: over.week,
    fable,
    overFable,
    over: over.five || over.week || overFable,
    block: limits?.overLimit === 'block'
  }
}

const Pct = ({ v, over }: { v?: number; over: boolean }): ReactNode => <b style={{ color: over ? 'var(--danger)' : undefined }}>{v ?? '–'}%</b>

/**
 * "3/8 running · 1 working · 1 needs you · 5h 41% / 70% · wk 20% / 80%". The counts are the cards' (in the chosen
 * project, #77); the max is for workers in every project, so when those differ from the cards' running count (sessions
 * you resumed, or workers elsewhere) the workers get their own "2/8 workers".
 */
export function AgentsSummary({ running, busy, needs, empty, scoped }: { running: number; busy: number; needs: number; empty?: string; scoped: boolean }): ReactNode {
  const l = useLimits()
  const same = !scoped && running === l.workers
  return (
    <p className="ag-summary" title={`Agents running here, and usage against the limit past which a new agent ${l.block ? "can't start" : 'asks you first'} (Settings)`}>
      {empty ? (
        <span>{empty}</span>
      ) : (
        <>
          <span>
            {running}
            {same && `/${l.max}`} running
          </span>
          {!same && (
            <span title="Running workers in every project, against the most at once (Settings)">
              {l.workers}/{l.max} workers
            </span>
          )}
          <span>{busy} working</span>
          {needs > 0 && (
            <b className="ag-needs-count">
              {needs} need{needs === 1 ? 's' : ''} you
            </b>
          )}
        </>
      )}
      <span>
        5h <Pct v={l.five} over={l.over5h} /> / {l.gate5h}
      </span>
      <span>
        wk <Pct v={l.week} over={l.overWeek} /> / {l.gateWeek}
      </span>
      {l.fable !== undefined && (
        <span title="Fable's own weekly limit: the weekly limit applies to it for agents that run on Fable">
          Fable <Pct v={l.fable} over={l.overFable} /> / {l.gateWeek}
        </span>
      )}
    </p>
  )
}

/** Stop every running worker, beside the heading while any runs. */
export function StopAll(): ReactNode {
  const n = useStore((s) => s.assistant.workers.filter((w) => w.state === 'running').length)
  if (!n) return null
  return (
    <button className="btn sm kill" onClick={() => void api.stopAllWorkers()} title={`Stop every running worker (${n}), in every project`}>
      <Octagon size={12} /> Stop all
    </button>
  )
}

/** Past the usage limit: new agents ask first (or, with "Block new agents", don't start), and the running ones carry on. */
export function OverLimit(): ReactNode {
  const l = useLimits()
  if (!l.over) return null
  return (
    <div className="ag-over" role="status">
      {l.overFable && !l.over5h && !l.overWeek ? 'Fable usage is past your weekly limit, so new Fable agents' : 'Usage is past your limit, so new agents'}
      {l.block ? ' will not start' : ' will ask you first before they start'}
      {l.workers ? `, but ${l.workers === 1 ? 'the one running is' : `the ${l.workers} running are`} still using it.` : '.'}
    </div>
  )
}
