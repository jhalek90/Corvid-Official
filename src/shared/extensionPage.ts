import { STATUS_WORDS, type ExtensionRecord } from './extensions'
import { TIER_WORDS } from './extensionTiers'
import { rebuilding, updateFor } from './extensionLifecycle'
import { CLASSIFIER_VERSION, reviewGate, VERDICT_WORDS } from './extensionScan'
import { isVerified } from './extensionVerify'

// How an extension's page is laid out (#119): the status label, the buttons in the top row and which panels stay open
// at the top for the extension's state. Presentation only: every action still lives in its own component and does
// exactly what it did; this decides where it shows. Later tasks add a button or a panel here, in one place.

/** Buttons the page itself renders in the top row. Approve, Disable, Remove, Stop and the rest stay in the panels
 *  that own them (build, progress, lifecycle), which this layout keeps open at the top when they apply. */
export type PageButtonId = 'install' | 'retry' | 'edit' | 'update' | 'delete'
export interface PageButton {
  id: PageButtonId
  /** one primary per page at most; quiet is for the destructive ones */
  kind: 'primary' | 'normal' | 'quiet'
}

/** Panels that hold the state's own actions or something that needs the user, shown open at the top. */
export type TopPanel = 'install-checks' | 'scan' | 'progress' | 'build' | 'lifecycle' | 'verify'

export type Tone = 'ok' | 'warn' | 'bad' | 'muted'

export interface PageLayout {
  status: string
  verified: boolean
  tier: string
  scan: { word: string; tone: Tone; flags: number }
  buttons: PageButton[]
  /** in page order */
  top: TopPanel[]
  /** the one primary action, which may live in a panel (Approve and merge, Enable…) */
  primary?: string
}

const PRE_INSTALL: ExtensionRecord['status'][] = ['not-installed', 'ready', 'failed', 'scanning']

/** The safety scan at a glance: its word, colour and flag count. */
export function scanGlance(r: Pick<ExtensionRecord, 'scan' | 'hash'>): PageLayout['scan'] {
  const s = r.scan
  if (!s) return { word: 'Not scanned', tone: 'muted', flags: 0 }
  if (s.state === 'scanning') return { word: 'Scanning', tone: 'muted', flags: 0 }
  if (s.state === 'failed') return { word: s.skipped ? 'Scan skipped' : 'Scan failed', tone: 'warn', flags: 0 }
  const rep = s.report
  if (!rep || rep.hash !== r.hash) return { word: s.skipped ? 'Scan skipped' : 'Not scanned', tone: 'muted', flags: 0 }
  const flags = rep.flags.length
  const word = `${VERDICT_WORDS[rep.verdict]}${rep.classifierVersion !== CLASSIFIER_VERSION ? ', out of date' : ''}`
  return { word, tone: rep.verdict === 'clear' ? 'ok' : rep.verdict === 'warn' ? 'warn' : 'bad', flags }
}

export function pageLayout(r: ExtensionRecord, list: ExtensionRecord[] = []): PageLayout {
  const b = r.build
  const l = r.lifecycle
  const created = r.source.kind === 'created'
  const verified = isVerified(r)
  const scanning = r.status === 'scanning' || r.scan?.state === 'scanning'
  const installed = r.status === 'installed' || r.status === 'disabled'
  const stored = r.status === 'not-installed' && !!b?.mergeCommit
  const installable = ['not-installed', 'ready', 'failed'].includes(r.status) || rebuilding(r)
  const run = r.verify?.hash === r.hash ? r.verify : undefined
  const buildLive = !!b && (b.state === 'building' || b.state === 'needs-review' || b.state === 'failed')

  const top: TopPanel[] = []
  if (installable) top.push('install-checks')
  // the scan's controls stay at the top until it has a verdict that lets the install go on (the chip shows it after)
  const gate = reviewGate(r.scan, r.hash)
  if (PRE_INSTALL.includes(r.status) && !installed && !gate.ok) top.push('scan')
  if (b?.state === 'building') top.push('progress')
  if (buildLive) top.push('build')
  if (installed || stored || l?.pending || l?.conflict) top.push('lifecycle')
  if (created || installed || verified || run?.state === 'building' || run?.state === 'failed' || run?.state === 'cancelled') top.push('verify')

  const buttons: PageButton[] = []
  const failed = r.status === 'failed'
  if (installable && !(failed && b?.state === 'failed')) buttons.push({ id: 'install', kind: 'primary' })
  // a failed build is retried with a fresh install (BuildPanel's Send back / Open the branch / Discard stay with it)
  if (installable && failed && b?.state === 'failed') buttons.push({ id: 'retry', kind: 'primary' })
  if (created) buttons.push({ id: 'edit', kind: 'normal' })
  if (updateFor(r, list)) buttons.push({ id: 'update', kind: 'normal' })
  if (!installed && r.status !== 'building' && r.status !== 'needs-review') buttons.push({ id: 'delete', kind: 'quiet' })
  // only one primary on the page: a panel's primary (Approve and merge) wins over the row's
  const panelPrimary =
    l?.pending ? 'Approve and merge' : b?.state === 'needs-review' ? 'Approve and merge' : l?.conflict && l.conflict.state !== 'resolving' ? 'Resolve with an agent' : r.status === 'disabled' ? 'Enable' : undefined
  // not scanned yet (or scanning, failed, out of date): Scan… in the scan panel is the primary until it has a verdict
  const scanFirst = top.includes('scan') && !gate.ok && gate.need !== 'blocked' && gate.need !== 'warn-confirm' && gate.need !== 'scanning' ? 'Scan…' : undefined
  if (panelPrimary || scanFirst) for (const x of buttons) if (x.kind === 'primary') x.kind = 'normal'
  const rowPrimary = buttons.find((x) => x.kind === 'primary')

  return {
    status: scanning && r.status === 'not-installed' ? STATUS_WORDS.scanning : STATUS_WORDS[r.status],
    verified,
    tier: TIER_WORDS[r.header.capabilities.tier],
    scan: scanGlance(r),
    buttons,
    top,
    primary: panelPrimary ?? scanFirst ?? (rowPrimary && BUTTON_WORDS[rowPrimary.id])
  }
}

export const BUTTON_WORDS: Record<PageButtonId, string> = {
  install: 'Install…',
  retry: 'Retry…',
  edit: 'Edit',
  update: 'Update',
  delete: 'Delete'
}

/** The first two or three sentences of a text, and whether there is more. */
export function shortText(text: string, sentences = 3, max = 360): { short: string; more: boolean } {
  const t = text.trim()
  const parts = t.match(/[^.!?\n]+(?:[.!?]+|\n+|$)/g) ?? [t]
  let short = ''
  for (const p of parts.slice(0, sentences)) {
    if (short && (short + p).length > max) break
    short += p
  }
  short = short.trim()
  if (short.length > max) short = short.slice(0, max).replace(/\s+\S*$/, '') + '…'
  return { short, more: short.length < t.length }
}
