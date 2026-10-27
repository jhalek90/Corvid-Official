import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { DailyModelTokens, MinuteBucket } from '@shared/types'
import { compact } from '../format'

export const FAMILY_ORDER = ['opus', 'sonnet', 'haiku', 'fable', 'other'] as const
export const FAMILY_LABEL: Record<string, string> = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  other: 'Other'
}
export const familyColor = (fam: string): string => `var(--${FAMILY_ORDER.includes(fam as never) ? fam : 'other'})`

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

function niceMax(v: number): number {
  if (v <= 0) return 1
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p
  return 10 * p
}

interface Tip {
  x: number
  y: number
  content: ReactNode
}

function TipBox({ tip }: { tip: Tip | null }): ReactNode {
  if (!tip) return null
  return (
    <div className="chart-tip" style={{ left: tip.x, top: tip.y }}>
      {tip.content}
    </div>
  )
}

// ---------- live minutes (single series: area + line, crosshair) ----------

export function MinuteChart({ data, height = 170 }: { data: MinuteBucket[]; height?: number }): ReactNode {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const padL = 40
  const padB = 22
  const padT = 8
  const w = Math.max(0, width - padL)
  const h = height - padB - padT
  const max = niceMax(Math.max(...data.map((d) => d.output), 0))
  const x = (i: number): number => padL + (data.length <= 1 ? 0 : (i / (data.length - 1)) * w)
  const y = (v: number): number => padT + h - (v / max) * h
  const line = data.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.output).toFixed(1)}`).join('')
  const area = data.length ? `${line}L${x(data.length - 1)},${padT + h}L${x(0)},${padT + h}Z` : ''
  const ticks = [0, max / 2, max]
  // every 15 minutes, or every 30 when the chart is too narrow for five labels
  const labelStep = w < 260 ? 30 : 15
  const labelIdx = data.map((_, i) => i).filter((i) => i % labelStep === 0 || i === data.length - 1)

  const onMove = (e: React.MouseEvent<SVGRectElement>): void => {
    const r = e.currentTarget.getBoundingClientRect()
    const i = Math.round(((e.clientX - r.left) / r.width) * (data.length - 1))
    setHover(Math.max(0, Math.min(data.length - 1, i)))
  }
  const hd = hover !== null ? data[hover] : null

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height}>
          <g className="grid">
            {ticks.map((t) => (
              <line key={t} x1={padL} x2={padL + w} y1={y(t)} y2={y(t)} />
            ))}
          </g>
          <g className="axis">
            {ticks.map((t) => (
              <text key={t} x={padL - 8} y={y(t) + 3.5} textAnchor="end">
                {compact(t)}
              </text>
            ))}
            {labelIdx.map((i) => (
              <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>
                {i === data.length - 1 ? 'now' : `-${data.length - 1 - i}m`}
              </text>
            ))}
          </g>
          <path d={area} fill="var(--accent)" opacity={0.1} />
          <path d={line} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {data.length > 0 && (
            <circle
              cx={x(data.length - 1)}
              cy={y(data[data.length - 1].output)}
              r={4}
              fill="var(--accent)"
              stroke="var(--bg-1)"
              strokeWidth={2}
              style={{ filter: 'drop-shadow(0 0 4px color-mix(in srgb, var(--accent) 70%, transparent))' }}
            />
          )}
          {hd && hover !== null && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + h} stroke="var(--line-3)" />
              <circle cx={x(hover)} cy={y(hd.output)} r={4} fill="var(--accent)" stroke="var(--bg-1)" strokeWidth={2} />
            </g>
          )}
          <rect
            x={padL}
            y={padT}
            width={w}
            height={h}
            fill="transparent"
            onMouseMove={onMove}
            onMouseLeave={() => setHover(null)}
          />
        </svg>
      )}
      <TipBox
        tip={
          hd && hover !== null
            ? {
                x: x(hover),
                y: y(hd.output),
                content: (
                  <>
                    <div className="tt">
                      {new Date(hd.t).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}
                    </div>
                    <div className="tr">
                      Output tokens <b>{hd.output.toLocaleString()}</b>
                    </div>
                    <div className="tr">
                      Context processed <b>{compact(hd.input)}</b>
                    </div>
                  </>
                )
              }
            : null
        }
      />
    </div>
  )
}

// ---------- daily stacked columns by model family ----------

export function DailyBars({
  data,
  height = 200,
  order = FAMILY_ORDER as readonly string[],
  color = familyColor,
  label = (k: string) => FAMILY_LABEL[k] ?? k,
  labelEvery = 2
}: {
  data: DailyModelTokens[]
  height?: number
  order?: readonly string[]
  color?: (key: string) => string
  label?: (key: string) => string
  labelEvery?: number
}): ReactNode {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<number | null>(null)
  const padL = 40
  const padB = 22
  const padT = 8
  const w = Math.max(0, width - padL)
  const h = height - padB - padT
  const totals = data.map((d) => Object.values(d.byModel).reduce((a, b) => a + b, 0))
  const max = niceMax(Math.max(...totals, 0))
  const band = data.length ? w / data.length : 0
  const barW = Math.min(24, band * 0.62)
  const y = (v: number): number => padT + h - (v / max) * h
  const ticks = [0, max / 2, max]
  const GAP = 2
  // date labels are ~44px wide; skip more of them when the bands get narrower than that
  const every = Math.max(labelEvery, Math.ceil(44 / Math.max(1, band)))

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height}>
          <g className="grid">
            {ticks.map((t) => (
              <line key={t} x1={padL} x2={padL + w} y1={y(t)} y2={y(t)} />
            ))}
          </g>
          <g className="axis">
            {ticks.map((t) => (
              <text key={t} x={padL - 8} y={y(t) + 3.5} textAnchor="end">
                {compact(t)}
              </text>
            ))}
            {data.map((d, i) =>
              (data.length - 1 - i) % every === 0 ? (
                <text key={d.date} x={padL + band * i + band / 2} y={height - 6} textAnchor="middle">
                  {i === data.length - 1
                    ? 'Today'
                    : new Date(`${d.date}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                </text>
              ) : null
            )}
          </g>
          {data.map((d, i) => {
            const cx = padL + band * i + band / 2
            let base = padT + h
            const segs = order.filter((f) => (d.byModel[f] ?? 0) > 0)
            return (
              <g key={d.date} opacity={hover === null || hover === i ? 1 : 0.55}>
                {segs.map((f, si) => {
                  const segH = ((d.byModel[f] ?? 0) / max) * h
                  const top = base - segH
                  const isTop = si === segs.length - 1
                  const drawH = Math.max(0, segH - (si > 0 ? GAP : 0))
                  const el = (
                    <path
                      key={f}
                      d={roundedTop(cx - barW / 2, top, barW, drawH, isTop ? Math.min(4, drawH) : 0)}
                      fill={color(f)}
                    />
                  )
                  base = top
                  return el
                })}
                <rect
                  x={padL + band * i}
                  y={padT}
                  width={band}
                  height={h}
                  fill="transparent"
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover(null)}
                />
              </g>
            )
          })}
        </svg>
      )}
      <TipBox
        tip={
          hover !== null
            ? {
                x: padL + band * hover + band / 2,
                y: y(totals[hover]),
                content: (
                  <>
                    <div className="tt">
                      {new Date(`${data[hover].date}T12:00`).toLocaleDateString(undefined, {
                        weekday: 'short',
                        month: 'short',
                        day: 'numeric'
                      })}
                    </div>
                    {order.filter((f) => data[hover].byModel[f]).map((f) => (
                      <div className="tr" key={f}>
                        <span className="model-swatch" style={{ background: color(f) }} />
                        {label(f)} <b>{compact(data[hover].byModel[f])}</b>
                      </div>
                    ))}
                    {!totals[hover] && <div className="tr muted">No activity</div>}
                  </>
                )
              }
            : null
        }
      />
    </div>
  )
}

/** Rect with only the top corners rounded (data end), square at the baseline. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return ''
  r = Math.min(r, w / 2, h)
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`
}

// ---------- weekday x hour heatmap ----------

const RAMP = [1, 2, 3, 4, 5].map((i) => `var(--heat-${i})`)
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

export function Heatmap({ data, days }: { data: number[][]; days: number }): ReactNode {
  const [ref, width] = useWidth<HTMLDivElement>()
  const [hover, setHover] = useState<[number, number] | null>(null)
  const padL = 34
  const padB = 18
  // a narrow panel gets thinner gaps and smaller cells, so the 24 columns always fit
  const gap = width - padL < 260 ? 1 : 3
  const order = [1, 2, 3, 4, 5, 6, 0] // Monday first
  const cell = width > 0 ? Math.max(2, Math.min(22, (width - padL - gap * 23) / 24)) : 0
  const max = Math.max(1, ...data.flat())
  const color = (v: number): string => {
    if (v <= 0) return 'var(--bg-3)'
    const t = Math.sqrt(v / max)
    return RAMP[Math.min(RAMP.length - 1, Math.floor(t * RAMP.length))]
  }
  const height = order.length * (cell + gap) + padB

  return (
    <div className="chart" ref={ref}>
      {width > 0 && (
        <svg width={width} height={height}>
          <g className="axis">
            {order.map((d, r) => (
              <text key={d} x={0} y={r * (cell + gap) + cell / 2 + 3.5}>
                {DAYS[d]}
              </text>
            ))}
            {[0, 6, 12, 18, 23].map((hr) => (
              <text key={hr} x={padL + hr * (cell + gap) + cell / 2} y={height - 4} textAnchor="middle">
                {hr === 0 ? '12a' : hr === 12 ? '12p' : hr < 12 ? `${hr}a` : `${hr - 12}p`}
              </text>
            ))}
          </g>
          {order.map((d, r) =>
            data[d].map((v, hr) => (
              <rect
                key={`${d}-${hr}`}
                x={padL + hr * (cell + gap)}
                y={r * (cell + gap)}
                width={cell}
                height={cell}
                rx={3}
                fill={color(v)}
                stroke={hover && hover[0] === d && hover[1] === hr ? 'var(--text)' : 'none'}
                strokeWidth={1.5}
                onMouseEnter={() => setHover([d, hr])}
                onMouseLeave={() => setHover(null)}
              />
            ))
          )}
        </svg>
      )}
      <TipBox
        tip={
          hover
            ? {
                x: padL + hover[1] * (cell + gap) + cell / 2,
                y: order.indexOf(hover[0]) * (cell + gap),
                content: (
                  <>
                    <div className="tt">
                      {DAYS[hover[0]]}s, {hover[1]}:00–{hover[1] + 1}:00
                    </div>
                    <div className="tr">
                      Messages ({days}d) <b>{data[hover[0]][hover[1]].toLocaleString()}</b>
                    </div>
                  </>
                )
              }
            : null
        }
      />
    </div>
  )
}

// ---------- small pieces ----------

export function Sparkline({ values, width = 64, height = 18 }: { values: number[]; width?: number; height?: number }): ReactNode {
  const max = Math.max(1, ...values)
  const pts = values.map((v, i) => `${(i / Math.max(1, values.length - 1)) * width},${height - 1 - (v / max) * (height - 3)}`)
  return (
    // the viewBox lets it shrink with a narrow parent instead of spilling out; the stroke keeps its width
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ display: 'block', maxWidth: '100%' }}>
      <polyline
        points={pts.join(' ')}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        opacity={0.9}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

export function severity(pct: number): string {
  return pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)'
}

export function Meter({ pct, large, elapsedPct }: { pct: number; large?: boolean; elapsedPct?: number }): ReactNode {
  const p = Math.max(0, Math.min(100, pct))
  return (
    <div className={`meter${large ? ' lg' : ''}`}>
      <div className="fill" style={{ width: `${p}%`, background: severity(p), boxShadow: p > 0 ? `0 0 8px ${severity(p)}` : 'none' }} />
      {elapsedPct !== undefined && elapsedPct > 0 && elapsedPct < 100 && (
        <div className="tick" style={{ left: `${elapsedPct}%` }} title="Time elapsed in this window" />
      )}
    </div>
  )
}
