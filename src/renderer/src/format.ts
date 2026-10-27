export { relTime } from '@shared/time'

export function compact(n: number): string {
  if (!Number.isFinite(n)) return '–'
  const abs = Math.abs(n)
  if (abs < 1000) return String(Math.round(n))
  if (abs < 1e6) return `${(n / 1e3).toFixed(abs < 1e4 ? 1 : 0)}K`
  if (abs < 1e9) return `${(n / 1e6).toFixed(abs < 1e7 ? 1 : 0)}M`
  return `${(n / 1e9).toFixed(1)}B`
}

export function usd(n: number): string {
  if (n >= 1000) return `$${compact(n)}`
  if (n >= 100) return `$${n.toFixed(0)}`
  return `$${n.toFixed(2)}`
}

export function until(ts: number | undefined, now = Date.now()): string {
  if (!ts) return ''
  const m = Math.max(0, Math.round((ts - now) / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

export function duration(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}
