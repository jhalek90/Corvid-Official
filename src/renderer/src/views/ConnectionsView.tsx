import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Cable, ChevronRight, Download, FileUp, Pencil, Plus, Power, Search, ShieldAlert, TriangleAlert } from 'lucide-react'
import type { ConnectionAuditEntry, ConnectionView, ConnectionsState, ConnectorDetail, ManifestCheck, SafetyLevel } from '@shared/types'
import { api, type ConnectionInput } from '../api'
import { setState, toast, useStore } from '../store'
import { useScope } from '../scope'
import { relTime } from '../format'
import { DB_ADVICE, DB_RUNTIMES, LEAST_PRIVILEGE } from '@shared/dbAdvice'
import { ProjectMark, ScopeChip } from '../components/ProjectSwitcher'
import { errText, Field, SAFETY_LABEL, SafetyBadge, SecretStorageNotice, ServerForm, useSecretStorage } from '../components/RemoteSystems'
import { ProposalsArea } from './ConnectorProposals'
import { SendRequestPanel } from './SendRequest'
import { authLabel, missingSecrets, missingSettings, type HttpAuthKind, type PasteGuess } from '@shared/httpAuth'
import {
  AuthPicker,
  BaseUrlNote,
  ChoiceSelect,
  UnusedSecrets,
  chosenAuth,
  choicesFor,
  fieldLabel,
  hiddenField,
  isHttpAuth,
  pasteSlot,
  shownSlots,
  slotLabel,
  withPasted
} from './HttpConnectionForm'
import { InfoTip } from '../components/Tooltip'
import { LearnMore } from './DocsView'

// The Connections tab (#88): one place to see and manage everything agents can reach, and to cut it off. It is the
// interface over #87's store, approvals, audit and kill switch, and changes none of their rules. Only whether a
// secret slot is set ever reaches this window: values are typed in, sent one way, and never come back.

type Area = 'connections' | 'add' | 'connectors' | 'proposals' | 'activity'

const SAFETY_TEXT: Record<SafetyLevel, string> = {
  strict: 'Every operation waits for you, showing exactly what will run. The default, and the one for anything that matters.',
  'approve-writes': 'Reads run straight away; anything that changes data waits for you.',
  free: 'Reads and changes run without asking. Administrative operations still ask. For throwaway test systems.'
}
const LEVELS: SafetyLevel[] = ['strict', 'approve-writes', 'free']
const CLASS_LABEL = { read: 'Read', write: 'Write', admin: 'Admin' } as const
const SOURCE_LABEL = { builtin: 'Built into Corvid', user: 'Added by you', agent: 'Drafted by an agent' } as const
const STATUS_LABEL: Record<ConnectorDetail['status'], string> = {
  draft: 'Draft',
  pending: 'Needs approval',
  approved: 'Approved',
  declined: 'Declined',
  invalid: 'Not valid'
}

/** State, every connector in full, and the merged log; fetched again whenever main says something changed. */
function useConnectionsData(): { state?: ConnectionsState; connectors: ConnectorDetail[]; audit: ConnectionAuditEntry[] } {
  const remote = useStore((s) => s.remote)
  const [data, setData] = useState<{ state?: ConnectionsState; connectors: ConnectorDetail[]; audit: ConnectionAuditEntry[] }>({ connectors: [], audit: [] })
  useEffect(() => {
    let live = true
    void (async () => {
      const state = await api.connectionsState()
      const [connectors, audit] = await Promise.all([
        Promise.all(state.connectors.map((c) => api.connectionsConnector(c.id))),
        api.connectionsAuditAll(1000)
      ])
      if (live) setData({ state, connectors: connectors.filter((c): c is ConnectorDetail => !!c), audit })
    })()
    return () => {
      live = false
    }
  }, [remote])
  return data
}

export function ConnectionsView(): ReactNode {
  const { state, connectors, audit } = useConnectionsData()
  const approvals = useStore((s) => s.remote.approvals)
  const proposals = useStore((s) => s.remote.drafts ?? 0)
  const focus = useStore((s) => s.connectionsFocus)
  const [area, setArea] = useState<Area>(focus?.area ?? 'connections')
  const [confirmKill, setConfirmKill] = useState(false)
  useEffect(() => {
    if (focus?.area) setArea(focus.area)
  }, [focus])
  // a notification about a waiting approval lands here: show the inbox
  useEffect(() => {
    if (approvals.length && area === 'connections' && !state?.connections.length) setArea('activity')
  }, [approvals.length]) // eslint-disable-line react-hooks/exhaustive-deps

  const killed = !!state?.killSwitch
  const kill = async (on: boolean): Promise<void> => {
    await api.connectionsKillAll(on)
    setConfirmKill(false)
    toast(on ? 'All connectors are disabled. Agents get a refusal for every call.' : 'Connectors are back on.')
  }

  return (
    <div className="conn">
      <div className="conn-head">
        <Cable size={16} className="muted" />
        <h2>Connections</h2>
        <LearnMore page="connections/overview" />
        <ScopeChip />
        <span style={{ flex: 1 }} />
        {killed ? (
          <>
            <span className="conn-killed" role="status">
              <Power size={13} /> All connectors are disabled
            </span>
            <button className="btn sm primary" onClick={() => void kill(false)}>
              Turn back on
            </button>
          </>
        ) : (
          <button className="btn sm conn-kill" onClick={() => setConfirmKill(true)} title="The kill switch: every connector stops at once, until you turn them back on">
            <Power size={13} /> Disable all connectors
          </button>
        )}
      </div>
      <div className="conn-bar">
        <div className="conn-tabs seg" role="tablist">
          {(
            [
              ['connections', 'Connections'],
              ['connectors', 'Connectors'],
              ['proposals', 'Proposals'],
              ['activity', 'Activity']
            ] as [Area, string][]
          ).map(([a, label]) => (
            <button key={a} role="tab" aria-selected={area === a} className={area === a ? 'on' : ''} onClick={() => setArea(a)}>
              {label}
              {a === 'activity' && approvals.length > 0 && <span className="count warn">{approvals.length}</span>}
              {a === 'proposals' && proposals > 0 && <span className="count">{proposals}</span>}
            </button>
          ))}
        </div>
        <span style={{ flex: 1 }} />
        {/* an empty list has its own Add button in the middle */}
        {(area !== 'connections' || !!state?.connections.length) && (
          <button className={`btn sm ${area === 'add' ? '' : 'primary'}`} aria-pressed={area === 'add'} onClick={() => setArea('add')}>
            <Plus size={13} /> Add connection
          </button>
        )}
      </div>
      {killed && (
        <div className="remote-warn conn-banner">
          <TriangleAlert size={14} style={{ flex: 'none' }} /> All connectors are disabled. Every agent call, run_on included, is refused until you turn them back
          on. Approvals that were waiting were declined.
        </div>
      )}
      <SecretStorageNotice className="conn-banner" />
      {approvals.length > 0 && area !== 'activity' && (
        <div className="remote-warn conn-banner conn-attn" role="status">
          <ShieldAlert size={14} style={{ flex: 'none' }} />
          <span style={{ flex: 1 }}>
            {approvals.length} request{approvals.length === 1 ? ' is' : 's are'} waiting for your approval
          </span>
          <button className="btn sm" onClick={() => setArea('activity')}>
            Review
          </button>
        </div>
      )}
      <div className="conn-body">
        {!state ? null : area === 'connections' ? (
          <ConnectionsArea state={state} connectors={connectors} audit={audit} onAdd={() => setArea('add')} />
        ) : area === 'add' ? (
          <AddWizard connectors={connectors} done={() => setArea('connections')} />
        ) : area === 'connectors' ? (
          <ConnectorsArea connectors={connectors} state={state} />
        ) : area === 'proposals' ? (
          <ProposalsArea onAdd={() => setArea('add')} />
        ) : (
          <ActivityArea audit={audit} state={state} />
        )}
        <SecurityNote />
      </div>
      {confirmKill && (
        <Confirm
          title="Disable all connectors?"
          body="Every connector stops at once: agents get a refusal for every call, run_on included, approvals waiting now are declined, and results of calls already running are withheld. An SSH command already started keeps running on the server until it ends; an upload in progress is cut off. One click turns them back on."
          yes="Disable all"
          danger
          onYes={() => void kill(true)}
          onNo={() => setConfirmKill(false)}
        />
      )}
    </div>
  )
}

// ---------- 1. connections ----------

function connStatus(c: ConnectionView, d: ConnectorDetail | undefined, killed: boolean): { text: string; cls: string; tip?: string } {
  if (killed) return { text: 'off', cls: 'off', tip: 'All connectors are disabled with the kill switch' }
  if (!d || d.status === 'invalid') return { text: 'connector missing', cls: 'bad', tip: "Its connector is missing or not valid, so agents can't use it" }
  if (d.disabled) return { text: 'disabled', cls: 'off', tip: `The ${d.name} connector is switched off under Connectors` }
  if (d.status === 'declined') return { text: 'declined', cls: 'bad', tip: `You declined the ${d.name} connector, so agents can't use it` }
  if (d.status !== 'approved') return { text: 'needs approval', cls: 'wait', tip: `The ${d.name} connector asks for your approval on first use` }
  const missing = isHttpAuth(d)
    ? missingSecrets(chosenAuth(d, c.config), (s) => slotLabel(d, s), (s) => !!c.secretsSet[s])
    : shownSlots(d, c.config)
        .filter((s) => !s.optional && !c.secretsSet[s.key])
        .map((s) => `${s.label} is not set.`)
  if (missing.length) return { text: 'secret missing', cls: 'wait', tip: missing.join(' ') }
  return { text: 'ready', cls: 'ok' }
}

/** The target in plain words: user@host:port for SSH, else the host and the other settings. */
function targetText(c: ConnectionView, d?: ConnectorDetail): string {
  const cfg = c.config
  if (c.connectorId === 'ssh') return `${cfg.user}@${cfg.host}${cfg.port && Number(cfg.port) !== 22 ? `:${cfg.port}` : ''}`
  const host = d?.configFields.find((f) => f.type === 'host')
  const rest = (d?.configFields ?? [])
    .filter((f) => f !== host && cfg[f.key] !== undefined && cfg[f.key] !== '' && !hiddenField(d, cfg, f.key))
    .map((f) => (f.key === 'auth' && isHttpAuth(d) ? `Sign in with ${chosenAuth(d, cfg).map(authLabel).join(' + ')}` : `${isHttpAuth(d) ? fieldLabel(d, f.key) : f.label} ${String(cfg[f.key])}`))
  // the HTTP connector's own target is "the host set in each connection": its base URL already says which
  const fixed = isHttpAuth(d) ? '' : (d as ConnectorDetail | undefined)?.targets.join(', ')
  return [host ? String(cfg[host.key] ?? '') : fixed, ...rest].filter(Boolean).join(' · ') || 'no target set'
}

/** The one thing a row shows of the target: user@host, the host, the API's host or the file's name. */
function shortTarget(c: ConnectionView, d?: ConnectorDetail): string {
  const cfg = c.config
  if (c.connectorId === 'ssh') return `${cfg.user}@${cfg.host}`
  const host = d?.configFields.find((f) => f.type === 'host')
  if (host && cfg[host.key]) return String(cfg[host.key])
  if (cfg.base_url) {
    try {
      return new URL(String(cfg.base_url)).host
    } catch {
      return String(cfg.base_url)
    }
  }
  if (cfg.path) return String(cfg.path).split(/[\\/]/).pop() ?? ''
  return (d?.targets[0] ?? '').replace(/ \(.*\)$/, '')
}

function ConnectionsArea({
  state,
  connectors,
  audit,
  onAdd
}: {
  state: ConnectionsState
  connectors: ConnectorDetail[]
  audit: ConnectionAuditEntry[]
  onAdd: () => void
}): ReactNode {
  const scope = useScope()
  const focus = useStore((s) => s.connectionsFocus)
  const projects = useStore((s) => s.projects.projects)
  const [open, setOpen] = useState<string | undefined>(focus?.connectionId)
  const [q, setQ] = useState('')
  // from a project page's "Manage in Connections": that project's connections, with a way back to all
  const [only, setOnly] = useState<string | undefined>(focus?.projectId)
  useEffect(() => {
    setOpen(focus?.connectionId)
    setOnly(focus?.projectId)
  }, [focus])
  const narrowTo = scope ?? projects.find((p) => p.id === only)
  const byId = new Map(connectors.map((d) => [d.id, d]))
  const scoped = narrowTo ? state.connections.filter((c) => c.projectIds.includes(narrowTo.id)) : state.connections
  const needle = q.trim().toLowerCase()
  const list = needle
    ? scoped.filter((c) => [c.name, byId.get(c.connectorId)?.name ?? c.connectorId, shortTarget(c, byId.get(c.connectorId))].some((x) => x.toLowerCase().includes(needle)))
    : scoped

  if (!state.connections.length)
    return (
      <div className="conn-empty">
        <Cable size={26} className="muted" />
        <div className="conn-empty-title">
          No connections yet{' '}
          <InfoTip tip="A connection is a server, API or database agents may use by name: Corvid holds its secret and runs the operation for them, and an agent only sees the connections linked to its own project." />
        </div>
        <button className="btn primary" onClick={onAdd}>
          <Plus size={14} /> Add a connection
        </button>
      </div>
    )
  return (
    <div className="conn-list">
      {(narrowTo || state.connections.length > 6) && (
        <div className="conn-toolbar">
          {narrowTo && (
            <span className="muted conn-small">
              Linked to <b>{narrowTo.name}</b> · {scoped.length} of {state.connections.length}
            </span>
          )}
          {narrowTo &&
            (scope ? (
              <InfoTip tip="Use the × on the project chip above to see every connection." />
            ) : (
              <button className="btn sm ghost" onClick={() => setOnly(undefined)}>
                Show all
              </button>
            ))}
          <span style={{ flex: 1 }} />
          {state.connections.length > 6 && (
            <span className="conn-search">
              <Search size={13} className="muted" />
              <input className="rinput" placeholder="Filter" aria-label="Filter connections" value={q} onChange={(e) => setQ(e.target.value)} />
            </span>
          )}
        </div>
      )}
      {scoped.length === 0 ? (
        <div className="muted conn-small">No connections are linked to {narrowTo?.name}, so its agents can't reach any.</div>
      ) : list.length === 0 ? (
        <div className="muted conn-small">Nothing matches.</div>
      ) : (
        <div className="conn-rows">
          {list.map((c) => (
            <ConnectionRow
              key={c.id}
              c={c}
              d={byId.get(c.connectorId)}
              killed={state.killSwitch}
              audit={audit.filter((e) => e.connection === c.name).slice(0, 8)}
              open={open === c.id}
              toggle={() => setOpen(open === c.id ? undefined : c.id)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

export function ProjectChips({ ids }: { ids: string[] }): ReactNode {
  const projects = useStore((s) => s.projects.projects)
  if (!ids.length) return <span className="muted">no project, so no agent can use it</span>
  return (
    <span className="conn-projects">
      {ids.map((id) => {
        const p = projects.find((x) => x.id === id)
        return (
          <span key={id} className="conn-project" title={p?.name ?? id}>
            <ProjectMark p={p ?? { id, name: '?' }} size={14} /> {p?.name ?? 'removed project'}
          </span>
        )
      })}
    </span>
  )
}

/** A row's linked projects as small marks; their names are in the tooltip. */
function ProjectMarks({ ids }: { ids: string[] }): ReactNode {
  const projects = useStore((s) => s.projects.projects)
  if (!ids.length)
    return (
      <span className="conn-marks none" title="Linked to no project, so no agent can use it">
        no project
      </span>
    )
  const names = ids.map((id) => projects.find((x) => x.id === id)?.name ?? 'removed project')
  return (
    <span className="conn-marks" title={`Linked to ${names.join(', ')}`}>
      {ids.slice(0, 3).map((id) => (
        <ProjectMark key={id} p={projects.find((x) => x.id === id) ?? { id, name: '?' }} size={14} />
      ))}
      {ids.length > 3 && <span className="muted">+{ids.length - 3}</span>}
    </span>
  )
}

function ConnectionRow({
  c,
  d,
  killed,
  audit,
  open,
  toggle
}: {
  c: ConnectionView
  d?: ConnectorDetail
  killed: boolean
  audit: ConnectionAuditEntry[]
  open: boolean
  toggle: () => void
}): ReactNode {
  const status = connStatus(c, d, killed)
  const [approving, setApproving] = useState(false)
  const [testing, setTesting] = useState(false)
  const runtime = c.connectorId === 'ssh' ? 'ssh' : d?.runtime
  const test = (): void => {
    setTesting(true)
    void api
      .connectionsTest(c.id)
      .then((r) => toast(`${c.name}: ${r.message}`, r.ok ? 'info' : 'error'))
      .finally(() => setTesting(false))
  }
  return (
    <div className={`conn-row ${status.cls}${open ? ' open' : ''}`}>
      <div className="conn-row-head">
        <button className="conn-row-main" onClick={toggle} aria-expanded={open}>
          <ChevronRight size={14} className="conn-chev" />
          <span className="conn-row-id">
            <span className="mono conn-name" title={c.name}>
              {c.name}
            </span>
            <span className="conn-row-sub">
              {d?.name ?? c.connectorId}
              <span className="mono"> · {shortTarget(c, d)}</span>
            </span>
          </span>
          <ProjectMarks ids={c.projectIds} />
          <span className="conn-row-safety">
            <SafetyBadge level={c.safety} />
          </span>
          <span className={`conn-status ${status.cls}`} title={status.tip ?? ''}>
            {status.text}
          </span>
        </button>
        <span className="conn-row-act">
          {status.cls === 'wait' && d && d.status !== 'approved' ? (
            <button className="btn sm primary" onClick={() => setApproving(true)}>
              Review
            </button>
          ) : (status.cls === 'ok' || status.cls === 'wait') && runtime && TEST_HINT[runtime] ? (
            <button className="btn sm" disabled={testing} onClick={test} title={httpTestHint(d, c.config) ?? TEST_HINT[runtime]}>
              {testing ? 'Testing…' : 'Test'}
            </button>
          ) : null}
        </span>
      </div>
      {open && <ConnectionDetail c={c} d={d} audit={audit} />}
      {approving && d && <ApproveConnector d={d} close={() => setApproving(false)} />}
    </div>
  )
}

function ConnectionDetail({ c, d, audit }: { c: ConnectionView; d?: ConnectorDetail; audit: ConnectionAuditEntry[] }): ReactNode {
  const system = useStore((s) => s.remote.systems.find((x) => x.id === c.id))
  const [editing, setEditing] = useState(false)
  const slots = shownSlots(d, c.config)
  if (editing)
    return (
      <div className="conn-detail">
        {c.origin === 'remote' ? (
          system ? (
            <ServerForm system={system} close={() => setEditing(false)} />
          ) : (
            <div className="muted">This SSH server is no longer stored.</div>
          )
        ) : (
          <ConnectionEditor c={c} d={d} close={() => setEditing(false)} />
        )}
      </div>
    )
  return (
    <div className="conn-detail">
      <div className="conn-facts">
        <span className="k">Target</span>
        <span className="v mono">{targetText(c, d)}</span>
        {slots.length > 0 && (
          <>
            <span className="k">Secrets</span>
            <span className="v">{slots.map((s) => `${s.label}: ${c.secretsSet[s.key] ? 'set' : 'not set'}`).join(' · ')}</span>
          </>
        )}
        {isHttpAuth(d) && !slots.length && (
          <>
            <span className="k">Secrets</span>
            <span className="v muted">none: it sends no credentials</span>
          </>
        )}
        <span className="k">Projects</span>
        <span className="v">
          <ProjectChips ids={c.projectIds} />
        </span>
        <span className="k">Last used</span>
        <span className="v">{c.lastUsedAt ? relTime(c.lastUsedAt) : <span className="muted">never</span>}</span>
      </div>
      <div className="conn-actions">
        <TestButton id={c.id} runtime={c.connectorId === 'ssh' ? 'ssh' : d?.runtime} hint={httpTestHint(d, c.config)} />
        {d?.runtime === 'http' && <SendRequestButton c={c} d={d} />}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setEditing(true)}>
          <Pencil size={12} /> Edit
        </button>
      </div>
      <div className="section-label">Recent activity</div>
      {audit.length ? <AuditRows rows={audit} compact /> : <div className="muted conn-small">Not used yet.</div>}
    </div>
  )
}

/** Send a request (#105): the user's own request on an HTTP connection; the response stays in the panel. */
function SendRequestButton({ c, d }: { c: ConnectionView; d: ConnectorDetail }): ReactNode {
  const [open, setOpen] = useState(false)
  const [approving, setApproving] = useState(false)
  return (
    <>
      <button className="btn sm" onClick={() => setOpen(true)} title="Try the connection yourself and read the full response. Only you see it; writes ask first.">
        Send a request
      </button>
      {open && <SendRequestPanel c={c} close={() => setOpen(false)} approve={() => setApproving(true)} />}
      {approving && <ApproveConnector d={d} close={() => setApproving(false)} />}
    </>
  )
}

const TEST_HINT: Record<string, string> = {
  ssh: 'Connects and checks the host key; runs nothing.',
  http: "Sends the connection's safe GET (its test path); logged as test_connection.",
  ...Object.fromEntries(DB_RUNTIMES.map((r) => [r, 'Signs in and runs SELECT 1 in a read-only transaction; logged as test_connection.']))
}

/** The databases' least-privilege advice with a copyable example (#90). */
function DbAdvice({ runtime }: { runtime?: string }): ReactNode {
  const example = LEAST_PRIVILEGE[runtime as keyof typeof LEAST_PRIVILEGE]
  if (!example) return null
  return (
    <div className="conn-small conn-db-advice">
      <div className="muted">{DB_ADVICE}</div>
      <pre className="mono">{example}</pre>
      <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(example).then(() => toast('Copied the example. Change the names and the password before you run it.'))}>
        Copy example
      </button>
    </div>
  )
}

/** "calls api.example.com without sending any credentials", or with which method. */
function httpSignInText(d: ConnectorDetail, config: ConnectionInput['config']): string {
  let host = String(config.base_url ?? '')
  try {
    host = new URL(host).host
  } catch {
    /* shown as typed */
  }
  const kinds = chosenAuth(d, config)
  return `calls ${host || 'its base URL'} ${kinds.includes('none') ? 'without sending any credentials' : `signing in with ${kinds.map(authLabel).join(' and ')}`}`
}

const httpTestHint = (d: ConnectorDetail | undefined, config: ConnectionInput['config']): string | undefined =>
  isHttpAuth(d) ? `Sends a GET to its test path (${String(config.test_path || '/')}), so it ${httpSignInText(d, config)}; logged as test_connection.` : undefined

function TestButton({ id, runtime, hint }: { id: string; runtime?: string; hint?: string }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ ok: boolean; message: string }>()
  if (!runtime || !TEST_HINT[runtime]) return <span className="muted conn-small">No safe test for this connector yet</span>
  return (
    <>
      <button
        className="btn sm"
        disabled={busy}
        title={hint ?? TEST_HINT[runtime]}
        onClick={() => {
          setBusy(true)
          void api
            .connectionsTest(id)
            .then(setResult)
            .finally(() => setBusy(false))
        }}
      >
        {busy ? 'Testing…' : 'Test connection'}
      </button>
      {result && <span className={`conn-small conn-test-result ${result.ok ? 'ok' : 'bad'}`}>{result.message}</span>}
    </>
  )
}

/** Edits a connection of any connector but SSH (whose form is the server form). Secrets save on their own buttons. */
function ConnectionEditor({ c, d, close }: { c?: ConnectionView; d?: ConnectorDetail; close: () => void }): ReactNode {
  const [form, setForm] = useState<ConnectionInput>(() => ({
    id: c?.id,
    connectorId: c?.connectorId ?? d?.id ?? '',
    name: c?.name ?? '',
    config: { ...(c?.config ?? {}) },
    safety: c?.safety ?? 'strict',
    adminWithoutAsking: c?.adminWithoutAsking ?? false,
    projectIds: c?.projectIds ?? []
  }))
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = (patch: Partial<ConnectionInput>): void => setForm((f) => ({ ...f, ...patch }))
  // a key pasted under "No credentials": saved into the slot of the method picked, which the form then switches to
  const pasteInto = async (c: ConnectionView, d: ConnectorDetail, kind: HttpAuthKind, g: PasteGuess): Promise<void> => {
    const slot = pasteSlot(kind)
    if (!slot || (c.secretsSet[slot] && !confirm(`Replace the saved ${slotLabel(d, slot)}?`))) return
    try {
      await api.connectionsSetSecret(c.id, slot, g.value)
      set({ config: withPasted(d, form.config, kind, g) })
      toast(`Saved as the ${slotLabel(d, slot)}. Save the connection to sign in with ${authLabel(kind)}.`)
    } catch (e) {
      toast(errText(e), 'error')
    }
  }
  const save = async (): Promise<void> => {
    try {
      await api.connectionsSave(form)
      toast(`Saved ${form.name}. A changed safety level applies from the next call.`)
    } catch (e) {
      toast(errText(e), 'error')
    }
  }
  return (
    <div className="conn-editor">
      <Field label="Name" hint="what agents call it">
        <input className="rinput mono" spellCheck={false} value={form.name} onChange={(e) => set({ name: e.target.value })} />
      </Field>
      <ConfigFields d={d} config={form.config} set={(config) => set({ config })} onPaste={c && isHttpAuth(d) ? (kind, g) => void pasteInto(c, d, kind, g) : undefined} />
      <DbAdvice runtime={d?.runtime} />
      {c &&
        shownSlots(d, form.config).map((s) => (
          <SecretSlot key={s.key} connectionId={c.id} slot={s} isSet={!!c.secretsSet[s.key]} />
        ))}
      {c && isHttpAuth(d) && (
        <>
          <AuthProblems d={d} config={form.config} isSet={(s) => !!c.secretsSet[s]} />
          <UnusedSecrets
            d={d}
            config={form.config}
            set={(config) => set({ config })}
            keys={d.secretSlots.filter((s) => c.secretsSet[s.key] && !shownSlots(d, form.config).includes(s)).map((s) => s.key)}
            onClear={(k) =>
              confirm(`Clear the saved ${slotLabel(d, k)}?`) &&
              void api
                .connectionsSetSecret(c.id, k, null)
                .then(() => toast(`${slotLabel(d, k)} cleared`))
                .catch((e) => toast(errText(e), 'error'))
            }
          />
        </>
      )}
      <SafetyPicker value={form.safety as SafetyLevel} onChange={(safety) => set({ safety })} />
      {form.safety === 'free' && (d?.admin.length ?? 0) > 0 && (
        <label className="conn-small conn-check">
          <input type="checkbox" checked={!!form.adminWithoutAsking} onChange={(e) => set({ adminWithoutAsking: e.target.checked })} /> Run administrative operations without
          asking too
        </label>
      )}
      <ProjectPicker ids={form.projectIds} onChange={(projectIds) => set({ projectIds })} />
      {confirmDelete && c ? (
        <div className="srv-confirm">
          <div>
            Delete <span className="mono">{c.name}</span>? Its saved secrets are deleted too, and agents can no longer use it.
          </div>
          <div className="srv-actions">
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => setConfirmDelete(false)} autoFocus>
              Keep it
            </button>
            <button
              className="btn sm danger"
              onClick={() =>
                void api
                  .connectionsDelete(c.id)
                  .then(() => toast(`Deleted ${c.name} and its saved secrets`))
                  .catch((e) => toast(errText(e), 'error'))
              }
            >
              Delete connection
            </button>
          </div>
        </div>
      ) : (
        <div className="srv-actions">
          {c && (
            <button className="btn sm ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={close}>
            Close
          </button>
          <button className="btn sm primary" onClick={() => void save()}>
            Save
          </button>
        </div>
      )}
    </div>
  )
}

function ConfigFields({
  d,
  config,
  set,
  onPaste
}: {
  d?: ConnectorDetail
  config: ConnectionInput['config']
  set: (c: ConnectionInput['config']) => void
  onPaste?: (kind: HttpAuthKind, g: PasteGuess) => void
}): ReactNode {
  const http = isHttpAuth(d)
  return (
    <>
      {d?.configFields.filter((f) => !hiddenField(d, config, f.key)).map((f) =>
        http && f.key === 'auth' ? (
          <AuthPicker key={f.key} d={d} config={config} set={set} onPaste={onPaste} />
        ) : (
        <Field key={f.key} label={http ? f.label.replace(/ \(for [a-z0-9]+\)$/, '') : f.label} hint={[f.required ? 'required' : '', f.description ?? ''].filter(Boolean).join(' · ') || undefined}>
          {f.type === 'boolean' ? (
            <input type="checkbox" checked={!!config[f.key]} onChange={(e) => set({ ...config, [f.key]: e.target.checked })} />
          ) : choicesFor(d, f.key) ? (
            <ChoiceSelect label={f.label} value={String(config[f.key] ?? f.default ?? '')} options={choicesFor(d, f.key)!} onChange={(v) => set({ ...config, [f.key]: v })} />
          ) : (
            <input
              className="rinput mono"
              spellCheck={false}
              value={String(config[f.key] ?? '')}
              placeholder={f.default !== undefined ? String(f.default) : ''}
              onChange={(e) => set({ ...config, [f.key]: f.type === 'number' ? Number(e.target.value.replace(/[^\d.-]/g, '')) || 0 : e.target.value })}
            />
          )}
          {http && f.key === 'base_url' && <BaseUrlNote config={config} set={set} />}
        </Field>
        )
      )}
    </>
  )
}

/** For an HTTP connection: each secret or setting the chosen sign-in method needs but doesn't have. */
function AuthProblems({ d, config, isSet }: { d?: ConnectorDetail; config: ConnectionInput['config']; isSet: (slot: string) => boolean }): ReactNode {
  if (!isHttpAuth(d)) return null
  const kinds = chosenAuth(d, config)
  const lines = [...missingSecrets(kinds, (s) => slotLabel(d, s), isSet), ...missingSettings(kinds, config, (k) => fieldLabel(d, k))]
  if (!lines.length) return null
  return (
    <ul className="conn-errors">
      {lines.map((l) => (
        <li key={l}>{l}</li>
      ))}
    </ul>
  )
}

/** Write-only: shows set or not set; Replace sends a new value one way; Clear removes it. Nothing is ever read back. */
function SecretSlot({ connectionId, slot, isSet }: { connectionId: string; slot: ConnectorDetail['secretSlots'][number]; isSet: boolean }): ReactNode {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState('')
  const storage = useSecretStorage()
  const send = async (v: string | null): Promise<void> => {
    try {
      await api.connectionsSetSecret(connectionId, slot.key, v)
      toast(v ? `${slot.label} saved` : `${slot.label} cleared`)
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setValue('')
      setEditing(false)
    }
  }
  return (
    <Field label={slot.label} hint={isSet ? 'set' : slot.optional ? 'not set (optional)' : 'not set'}>
      {editing ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="rinput"
            style={{ flex: 1 }}
            type="password"
            autoComplete="new-password"
            value={value}
            autoFocus
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && value && storage.available && void send(value)}
          />
          <button className="btn sm primary" disabled={!value || !storage.available} title={storage.reason} onClick={() => void send(value)}>
            Save
          </button>
          <button
            className="btn sm ghost"
            onClick={() => {
              setValue('')
              setEditing(false)
            }}
          >
            Cancel
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className={`chip${isSet ? ' srv-set' : ''}`}>{isSet ? 'Set' : 'Not set'}</span>
          <InfoTip tip="Corvid never shows a saved secret again: Replace sends a new value one way, Clear removes it." />
          <span style={{ flex: 1 }} />
          <button className="btn sm" onClick={() => setEditing(true)}>
            {isSet ? 'Replace' : 'Set'}
          </button>
          {isSet && (
            <button className="btn sm ghost" onClick={() => confirm(`Clear the saved ${slot.label}?`) && void send(null)}>
              Clear
            </button>
          )}
        </div>
      )}
    </Field>
  )
}

function SafetyPicker({ value, onChange }: { value: SafetyLevel; onChange: (s: SafetyLevel) => void }): ReactNode {
  return (
    <Field label="Safety level">
      <div className="seg srv-safety">
        {LEVELS.map((l) => (
          <button key={l} className={value === l ? `on ${l}` : ''} onClick={() => onChange(l)}>
            {SAFETY_LABEL[l]}
          </button>
        ))}
      </div>
      <div className="muted conn-small">{SAFETY_TEXT[value]}</div>
    </Field>
  )
}

function ProjectPicker({ ids, onChange }: { ids: string[]; onChange: (ids: string[]) => void }): ReactNode {
  const projects = useStore((s) => s.projects.projects).filter((p) => !p.archived || ids.includes(p.id))
  return (
    <Field label="Linked projects" hint="only their agents can use it">
      <div className="remote-projects">
        {projects.length === 0 && <span className="muted">No projects yet.</span>}
        {projects.map((p) => (
          <button
            key={p.id}
            className={`chip${ids.includes(p.id) ? ' on' : ''}`}
            onClick={() => onChange(ids.includes(p.id) ? ids.filter((x) => x !== p.id) : [...ids, p.id])}
          >
            <ProjectMark p={p} size={13} /> {p.name}
          </button>
        ))}
      </div>
      {!ids.length && <div className="muted conn-small">Linked to no project, it is visible to no agent. Link at least one for agents to use it.</div>}
    </Field>
  )
}

// ---------- 2. add a connection ----------

function AddWizard({ connectors, done }: { connectors: ConnectorDetail[]; done: () => void }): ReactNode {
  // built-in connectors (they ask on first use) and approved ones
  const usable = connectors.filter((d) => d.status !== 'invalid' && !d.disabled && (d.source === 'builtin' || d.status === 'approved'))
  const [pick, setPick] = useState<string>()
  const [step, setStep] = useState(0)
  const [form, setForm] = useState<ConnectionInput>({ connectorId: '', name: '', config: {}, safety: 'strict', projectIds: [] })
  const [secretValues, setSecretValues] = useState<Record<string, string>>({})
  const [created, setCreated] = useState<string>()
  const storage = useSecretStorage()
  const d = connectors.find((x) => x.id === pick)
  const set = (patch: Partial<ConnectionInput>): void => setForm((f) => ({ ...f, ...patch }))

  if (!d)
    return (
      <div className="conn-list">
        <div className="section-label">1 · Choose a connector</div>
        {usable.map((c) => (
          <button
            key={c.id}
            className="card conn-pick"
            onClick={() => {
              setPick(c.id)
              const config = Object.fromEntries(c.configFields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default!]))
              // a new HTTP connection starts with no credentials (#103); the user picks a method if the API needs one
              if (isHttpAuth(c)) config.auth = 'none'
              setForm({ connectorId: c.id, name: '', config, safety: 'strict', projectIds: [] })
              setSecretValues({})
              setStep(0)
            }}
          >
            <span>
              <b>{c.name}</b> <span className="muted conn-version">{c.version}</span>
            </span>
            <span className="muted conn-small conn-pick-desc" title={c.description}>
              {c.description}
            </span>
          </button>
        ))}
        {connectors.length > usable.length && (
          <div className="muted conn-small">Connectors waiting for approval or switched off are not offered here; approve or enable them under Connectors.</div>
        )}
      </div>
    )

  const back = (
    <button className="btn sm ghost" onClick={() => (step ? setStep(step - 1) : setPick(undefined))}>
      Back
    </button>
  )
  // SSH keeps the server form it always had: its secrets are stored where run_on reads them
  if (d.id === 'ssh')
    return (
      <div className="conn-list">
        <div className="section-label">New SSH server</div>
        <ServerForm close={done} />
        <div>{back}</div>
      </div>
    )

  // for http only the slots the chosen method uses; a value typed into another one isn't saved
  const slots = shownSlots(d, form.config)
  const typed = Object.keys(secretValues).filter((k) => secretValues[k])
  const kept = typed.filter((k) => slots.some((s) => s.key === k))
  const unusedTyped = typed.filter((k) => !kept.includes(k))
  const setConfig = (config: ConnectionInput['config']): void => set({ config })
  const paste = (kind: HttpAuthKind, g: PasteGuess): void => {
    const slot = pasteSlot(kind)
    if (!slot) return
    setSecretValues((v) => ({ ...v, [slot]: g.value }))
    setConfig(withPasted(d, form.config, kind, g))
    toast(`Kept as the ${slotLabel(d, slot)}. It is saved when you add the connection.`)
  }
  const unused = (
    <UnusedSecrets d={d} config={form.config} set={setConfig} keys={unusedTyped} typed onClear={(k) => setSecretValues((v) => ({ ...v, [k]: '' }))} />
  )

  const create = async (): Promise<void> => {
    try {
      const v = await api.connectionsSave(form)
      for (const k of kept) await api.connectionsSetSecret(v.id, k, secretValues[k])
      setSecretValues({})
      setCreated(v.id)
      toast(`Added ${v.name}`)
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  const steps = ['Settings', 'Secrets', 'Safety and projects', 'Review']
  return (
    <div className="conn-list">
      <div className="conn-steps muted">
        {d.name} ·{' '}
        {steps.map((s, i) => (
          <span key={s} className={i === step ? 'on' : ''}>
            {i + 2}. {s}
            {i < steps.length - 1 ? ' › ' : ''}
          </span>
        ))}
      </div>
      <div className="card conn-editor">
        {created ? (
          <>
            <div>
              <b>{form.name}</b> is added. Its first use asks you to approve the {d.name} connector unless it already is.
            </div>
            <TestButton id={created} runtime={d.runtime} hint={httpTestHint(d, form.config)} />
            <div className="srv-actions">
              <div style={{ flex: 1 }} />
              <button
                className="btn sm primary"
                onClick={() => {
                  setState({ connectionsFocus: { area: 'connections', connectionId: created } })
                  done()
                }}
              >
                Show it
              </button>
            </div>
          </>
        ) : (
          <>
            {step === 0 && (
              <>
                <Field label="Name" hint="what agents call it: letters, digits, dot, dash, underscore">
                  <input className="rinput mono" spellCheck={false} value={form.name} autoFocus onChange={(e) => set({ name: e.target.value })} />
                </Field>
                <ConfigFields d={d} config={form.config} set={setConfig} onPaste={paste} />
                <DbAdvice runtime={d.runtime} />
              </>
            )}
            {step === 1 &&
              (slots.length ? (
                slots.map((s) => (
                  <Field key={s.key} label={s.label} hint={s.optional ? 'optional' : undefined}>
                    <input
                      className="rinput"
                      type="password"
                      autoComplete="new-password"
                      value={secretValues[s.key] ?? ''}
                      onChange={(e) => setSecretValues({ ...secretValues, [s.key]: e.target.value })}
                    />
                  </Field>
                ))
              ) : isHttpAuth(d) ? (
                <div className="muted">No credentials chosen, so there are no secrets to set. Go back to Settings to pick a method if the API needs a key or token.</div>
              ) : (
                <div className="muted">This connector needs no secrets.</div>
              ))}
            {step === 1 && (
              <>
                <AuthProblems d={d} config={form.config} isSet={(s) => !!secretValues[s]} />
                {unused}
              </>
            )}
            {step === 1 && slots.length > 0 && (
              <div className="muted conn-small">Encrypted with system secure storage. Corvid never shows a saved secret again, and agents never get it.</div>
            )}
            {step === 1 && slots.length > 0 && <SecretStorageNotice />}
            {step === 2 && (
              <>
                <SafetyPicker value={form.safety as SafetyLevel} onChange={(safety) => set({ safety })} />
                <ProjectPicker ids={form.projectIds} onChange={(projectIds) => set({ projectIds })} />
              </>
            )}
            {step === 3 && (
              <>
                <div className="section-label">What {d.name} can do</div>
                <p className="conn-summary">{d.summary}</p>
                {isHttpAuth(d) && <p className="conn-summary">This connection {httpSignInText(d, form.config)}.</p>}
                <div className="conn-small">
                  <b className="mono">{form.name || '(no name)'}</b> · {SAFETY_LABEL[form.safety as SafetyLevel]} · {form.projectIds.length} project
                  {form.projectIds.length === 1 ? '' : 's'} ·{' '}
                  {isHttpAuth(d) && chosenAuth(d, form.config).includes('none') ? (
                    'sends no credentials'
                  ) : (
                    <>
                      {kept.length} secret{kept.length === 1 ? '' : 's'} set
                    </>
                  )}
                </div>
                <AuthProblems d={d} config={form.config} isSet={(s) => !!secretValues[s]} />
                {unused}
              </>
            )}
            <div className="srv-actions">
              {back}
              <div style={{ flex: 1 }} />
              {step < 3 ? (
                <button className="btn sm primary" onClick={() => setStep(step + 1)}>
                  Next
                </button>
              ) : (
                <button
                  className="btn sm primary"
                  disabled={kept.length > 0 && !storage.available}
                  title={kept.length > 0 && !storage.available ? storage.reason : undefined}
                  onClick={() => void create()}
                >
                  Add connection
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- 3. connectors ----------

function ConnectorsArea({ connectors, state }: { connectors: ConnectorDetail[]; state: ConnectionsState }): ReactNode {
  const [adding, setAdding] = useState(false)
  return (
    <div className="conn-list">
      <div style={{ display: 'flex' }}>
        <span className="muted conn-small" style={{ flex: 1 }}>
          Never active without your approval{' '}
          <InfoTip tip="Connectors are the definitions: what a kind of connection can reach and do. A connector never becomes active without your approval, here or at first use." />
        </span>
        <button className="btn sm" onClick={() => setAdding(!adding)}>
          <FileUp size={13} /> Add connector
        </button>
      </div>
      {adding && <ImportConnector close={() => setAdding(false)} />}
      <div className="conn-rows">
        {connectors.map((d) => (
          <ConnectorCard key={d.id} d={d} killed={state.killSwitch} />
        ))}
      </div>
    </div>
  )
}

function ConnectorCard({ d, killed }: { d: ConnectorDetail; killed: boolean }): ReactNode {
  const [open, setOpen] = useState(false)
  const [dialog, setDialog] = useState<'approve' | 'manifest' | 'delete'>()
  const groups: [string, string[]][] = [
    ['Targets', d.targets],
    ['Read', d.reads],
    ['Write', d.writes],
    ['Admin', d.admin],
    ['Secrets it uses (labels only)', d.secretLabels]
  ]
  const source = d.source === 'agent' && d.draftedBy ? `Drafted by ${d.draftedBy}` : SOURCE_LABEL[d.source]
  const cls = d.disabled || killed ? 'off' : d.status === 'approved' ? 'ok' : d.status === 'invalid' || d.status === 'declined' ? 'bad' : 'wait'
  const approvable = d.status !== 'invalid' && d.status !== 'approved'
  return (
    <div className={`conn-row ${cls}${open ? ' open' : ''}`}>
      <div className="conn-row-head">
        <button className="conn-row-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          <ChevronRight size={14} className="conn-chev" />
          <span className="conn-row-id">
            <span className="conn-name">
              {d.name} <span className="muted conn-version">{d.version}</span>
            </span>
            <span className="conn-row-sub">
              {source} · {d.usedBy.length ? `${d.usedBy.length} connection${d.usedBy.length === 1 ? '' : 's'}` : 'not used'}
            </span>
          </span>
          <span className={`conn-status ${cls}`}>{d.disabled ? 'disabled' : STATUS_LABEL[d.status]}</span>
        </button>
        <span className="conn-row-act">
          {approvable && (
            <button className="btn sm primary" onClick={() => setDialog('approve')}>
              Review
            </button>
          )}
        </span>
      </div>
      {d.errors?.length ? (
        <ul className="conn-errors conn-row-errors">
          {d.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {open && (
        <div className="conn-detail">
          {!d.errors?.length && <p className="conn-summary">{d.summary}</p>}
          <div className="conn-facts">
            <span className="k">Used by</span>
            <span className="v">{d.usedBy.length ? d.usedBy.join(', ') : <span className="muted">no connections</span>}</span>
            {d.source === 'agent' && (
              <>
                <span className="k">Usable in</span>
                <span className="v">{d.projectId ? <ProjectChips ids={[d.projectId]} /> : 'all projects'}</span>
              </>
            )}
          </div>
          {groups
            .filter(([, items]) => items.length)
            .map(([label, items]) => (
              <div key={label} className="remote-detail">
                <span className={`muted ${label === 'Admin' ? 'bad' : ''}`}>{label}: </span>
                <span className="mono">{items.join(', ')}</span>
              </div>
            ))}
          <div className="remote-detail">
            <span className="muted">Hash: </span>
            <span className="mono conn-hash" title={d.hash}>
              {d.hash}
            </span>
          </div>
          <div className="srv-actions">
            {d.status !== 'invalid' && d.status !== 'approved' && (
              <button className="btn sm primary" onClick={() => setDialog('approve')}>
                Review and approve
              </button>
            )}
            {d.source === 'agent' && d.projectId && (
              <button
                className="btn sm"
                title="Agents drafted it for one project; this lets every project link connections to it"
                onClick={() => void api.connectionsPromoteConnector(d.id).then(() => toast(`${d.name} is now available to all projects`))}
              >
                Make available to all projects
              </button>
            )}
            {d.status !== 'invalid' && (
              <button className="btn sm" onClick={() => void api.connectionsDisableConnector(d.id, !d.disabled)}>
                {d.disabled ? 'Enable' : 'Disable'}
              </button>
            )}
            <button className="btn sm ghost" onClick={() => setDialog('manifest')}>
              View manifest{d.previousText ? ' (changed)' : ''}
            </button>
            <div style={{ flex: 1 }} />
            {d.source !== 'builtin' && (
              <button className="btn sm ghost" onClick={() => setDialog('delete')}>
                Delete
              </button>
            )}
          </div>
        </div>
      )}
      {dialog === 'approve' && <ApproveConnector d={d} close={() => setDialog(undefined)} />}
      {dialog === 'manifest' && <ManifestDialog d={d} close={() => setDialog(undefined)} />}
      {dialog === 'delete' && (
        <Confirm
          title={`Delete the ${d.name} connector?`}
          body={
            d.usedBy.length
              ? `${d.usedBy.length} connection${d.usedBy.length === 1 ? ' uses' : 's use'} it (${d.usedBy.join(', ')}). ${d.usedBy.length === 1 ? 'It is' : 'They are'} deleted too, with ${d.usedBy.length === 1 ? 'its' : 'their'} saved secrets, and agents can no longer use ${d.usedBy.length === 1 ? 'it' : 'them'}.`
              : 'No connection uses it. Its manifest is deleted; you can import it again later.'
          }
          yes="Delete connector"
          danger
          onYes={() =>
            void api
              .connectionsDeleteConnector(d.id)
              .then(() => toast(`Deleted ${d.name}`))
              .catch((e) => toast(errText(e), 'error'))
              .finally(() => setDialog(undefined))
          }
          onNo={() => setDialog(undefined)}
        />
      )}
    </div>
  )
}

/** The same content as the first-use approval dialog (#87), opened from here, for exactly this hash. */
function ApproveConnector({ d, close }: { d: ConnectorDetail; close: () => void }): ReactNode {
  const decide = (approve: boolean): void =>
    void api
      .connectionsDecideConnector(d.id, d.hash, approve)
      .then(() => toast(approve ? `Approved ${d.name} ${d.version}` : `Declined ${d.name} ${d.version}`))
      .finally(close)
  return (
    <div className="overlay" style={{ zIndex: 150 }} onMouseDown={close}>
      <div className="dialog remote-approval" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h3>
          <ShieldAlert size={17} color="var(--warn)" /> Approve the {d.name} {d.version} connector?
        </h3>
        <p>Approve it once and its connections can be used, each under its own safety level. A changed connector asks again.</p>
        {d.broad && <p className="remote-warn">This connector is marked broad: it is not limited to named hosts or targets.</p>}
        <p>{d.summary}</p>
        {(
          [
            ['Targets', d.targets],
            ['Reads', d.reads],
            ['Changes', d.writes],
            ['Administrative', d.admin],
            ['Saved secrets it uses (labels only)', d.secretLabels]
          ] as [string, string[]][]
        )
          .filter(([, i]) => i.length)
          .map(([label, items]) => (
            <div key={label} className="remote-detail">
              <span className="muted">{label}: </span>
              <span className="mono">{items.join(', ')}</span>
            </div>
          ))}
        <div className="actions">
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => decide(false)}>
            Decline
          </button>
          <button className="btn primary" autoFocus onClick={() => decide(true)}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

/** A plain line diff (longest common subsequence); manifests are small. */
export function lineDiff(a: string, b: string): { kind: ' ' | '-' | '+'; text: string }[] {
  const x = a.split('\n')
  const y = b.split('\n')
  const L = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0))
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
  const out: { kind: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) out.push({ kind: ' ', text: x[i++] }), j++
    else if (L[i + 1][j] >= L[i][j + 1]) out.push({ kind: '-', text: x[i++] })
    else out.push({ kind: '+', text: y[j++] })
  }
  while (i < x.length) out.push({ kind: '-', text: x[i++] })
  while (j < y.length) out.push({ kind: '+', text: y[j++] })
  return out
}

function ManifestDialog({ d, close }: { d: ConnectorDetail; close: () => void }): ReactNode {
  const [diff, setDiff] = useState(!!d.previousText)
  const lines = useMemo(() => (d.previousText ? lineDiff(d.previousText, d.manifestText) : []), [d])
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog conn-manifest" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h3>
          {d.name} {d.version}
        </h3>
        {d.previousText && (
          <div className="seg xs">
            <button className={diff ? 'on' : ''} onClick={() => setDiff(true)}>
              Changes since the approved version
            </button>
            <button className={diff ? '' : 'on'} onClick={() => setDiff(false)}>
              Whole manifest
            </button>
          </div>
        )}
        <pre className="conn-pre" tabIndex={0}>
          {diff
            ? lines.map((l, i) => (
                <div key={i} className={l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}>
                  {l.kind} {l.text}
                </div>
              ))
            : d.manifestText || 'The manifest could not be read.'}
        </pre>
        <div className="actions">
          <div style={{ flex: 1 }} />
          <button className="btn" autoFocus onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

function ImportConnector({ close }: { close: () => void }): ReactNode {
  const [text, setText] = useState('')
  const [check, setCheck] = useState<ManifestCheck>()
  const run = (t: string): void => {
    setText(t)
    void api.connectionsCheckManifest(t).then(setCheck)
  }
  return (
    <div className="card conn-editor">
      <div className="section-label">Add a connector</div>
      <div className="muted conn-small">Paste a manifest or open a .json file. Corvid checks it; it is added waiting for your approval and does nothing until you approve it.</div>
      <textarea className="rinput mono conn-paste" spellCheck={false} rows={8} value={text} onChange={(e) => run(e.target.value)} placeholder='{ "manifestVersion": 1, "id": "…" }' />
      {text.trim() &&
        check &&
        (check.ok ? (
          <div>
            <div className="conn-small ok">
              Valid: {check.name} {check.version}
              {check.exists ? ' (replaces the connector with this id; it asks for approval again)' : ''}
            </div>
            <p className="conn-summary">{check.summary}</p>
          </div>
        ) : (
          <ul className="conn-errors">
            {check.errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        ))}
      <div className="srv-actions">
        <button className="btn sm" onClick={() => void api.connectionsOpenManifest().then((t) => t !== undefined && run(t))}>
          Open file…
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn sm ghost" onClick={close}>
          Cancel
        </button>
        <button
          className="btn sm primary"
          disabled={!check?.ok}
          onClick={() =>
            void api
              .connectionsImportManifest(text)
              .then(() => {
                toast('Connector added. Review and approve it before it can be used.')
                close()
              })
              .catch((e) => toast(errText(e), 'error'))
          }
        >
          Add, waiting for approval
        </button>
      </div>
    </div>
  )
}

// ---------- 4. activity ----------

const DECISIONS: ConnectionAuditEntry['decision'][] = ['automatic', 'approved', 'denied', 'timed out', 'refused']

function ActivityArea({ audit, state }: { audit: ConnectionAuditEntry[]; state: ConnectionsState }): ReactNode {
  const approvals = useStore((s) => s.remote.approvals)
  const projects = useStore((s) => s.projects.projects)
  const [f, setF] = useState({ agent: '', connection: '', project: '', cls: '', decision: '', from: '', q: '' })
  const uniq = (xs: (string | undefined)[]): string[] => [...new Set(xs.filter((x): x is string => !!x))].sort()
  const projectName = (p?: string): string => projects.find((x) => x.id === p)?.name ?? (p ? p.split(/[\\/]/).pop()! : '')
  const fromTs = f.from ? new Date(f.from).getTime() : 0
  const q = f.q.trim().toLowerCase()
  const rows = audit.filter(
    (e) =>
      (!f.agent || e.agent === f.agent) &&
      (!f.connection || e.connection === f.connection) &&
      (!f.project || projectName(e.project) === f.project) &&
      (!f.cls || e.class === f.cls) &&
      (!f.decision || e.decision === f.decision) &&
      e.ts >= fromTs &&
      (!q || [e.agent, e.connection, e.operation, e.request, e.detail, e.error, projectName(e.project)].some((x) => x?.toLowerCase().includes(q)))
  )
  const sel = (key: keyof typeof f, label: string, options: string[]): ReactNode => (
    <select className="rinput conn-filter" aria-label={label} value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })}>
      <option value="">{label}</option>
      {options.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  )
  return (
    <div className="conn-list">
      <div className="section-label">Waiting for you</div>
      {approvals.length ? (
        approvals.map((a) => (
          <div key={a.id} className="card conn-inbox">
            <div>
              <b>{a.kind === 'connector' ? `First use of the ${a.command} connector` : a.systemName}</b>{' '}
              <span className="muted">
                · {a.agent} · {relTime(a.createdAt)}
              </span>
            </div>
            {a.kind === 'connector' ? <div className="conn-small">{a.summary}</div> : <pre className="remote-cmd">{a.command}</pre>}
            <div className="srv-actions">
              <span className="muted conn-small">{a.why}</span>
              <div style={{ flex: 1 }} />
              <button className="btn sm" onClick={() => void api.remoteDecide(a.id, false)}>
                Decline
              </button>
              <button className="btn sm primary" onClick={() => void api.remoteDecide(a.id, true)}>
                {a.kind === 'connector' ? 'Approve' : 'Run it'}
              </button>
            </div>
          </div>
        ))
      ) : (
        <div className="muted conn-small">Nothing waiting{state.killSwitch ? ': all connectors are disabled' : ''}.</div>
      )}
      <div className="conn-log-head">
        <span className="section-label">Log</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm ghost" disabled={!audit.length} onClick={() => void api.connectionsExportAudit().then((ok) => ok && toast('Exported the log, without secrets or results'))}>
          <Download size={13} /> Export
        </button>
      </div>
      <div className="conn-filters">
        <input className="rinput conn-filter" placeholder="Search" aria-label="Search the log" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
        {sel('agent', 'Any agent', uniq(audit.map((e) => e.agent)))}
        {sel('connection', 'Any connection', uniq(audit.map((e) => e.connection)))}
        {sel('project', 'Any project', uniq(audit.map((e) => projectName(e.project))))}
        {sel('cls', 'Read, write or admin', ['read', 'write', 'admin'])}
        {sel('decision', 'Any decision', DECISIONS)}
        <input className="rinput conn-filter" type="date" aria-label="From date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
      </div>
      {rows.length ? <AuditRows rows={rows.slice(0, 300)} projectName={projectName} /> : <div className="muted conn-small">{audit.length ? 'Nothing matches.' : 'No calls yet.'}</div>}
      {rows.length > 300 && <div className="muted conn-small">Showing the newest 300 of {rows.length}; narrow the filters or export.</div>}
    </div>
  )
}

function AuditRows({ rows, compact, projectName }: { rows: ConnectionAuditEntry[]; compact?: boolean; projectName?: (p?: string) => string }): ReactNode {
  return (
    <div className="conn-log">
      {rows.map((e, i) => (
        <div key={i} className="conn-log-row" title={new Date(e.ts).toLocaleString()}>
          <span className={`conn-class ${e.class}`}>{CLASS_LABEL[e.class]}</span>
          <span className="mono">{e.connection}</span>
          <span className="mono muted">{e.operation}</span>
          <span className={e.decision === 'denied' || e.decision === 'timed out' || e.decision === 'refused' || e.error ? 'bad' : 'muted'}>
            {e.decision}
            {e.error ? ' · failed' : ''}
          </span>
          <span style={{ flex: 1 }} />
          <span className="muted">
            {e.page !== undefined ? `page ${e.page}/${e.pages} · ${e.returnedBytes} B of ${e.resultBytes} B · ` : e.resultBytes !== undefined ? `${e.resultBytes} B · ` : ''}
            {e.durationMs !== undefined ? `${e.durationMs} ms · ` : ''}
            {compact ? '' : `${e.agent}${projectName && e.project ? ` · ${projectName(e.project)}` : ''} · `}
            {relTime(e.ts)}
          </span>
          {!compact && e.request && <div className="mono conn-log-req">{e.request}</div>}
        </div>
      ))}
    </div>
  )
}

// ---------- shared bits ----------

function SecurityNote(): ReactNode {
  return (
    <details className="conn-note">
      <summary>What this protects against, and what it doesn't</summary>
      <ul>
        <li>Secrets stay in Corvid, encrypted for your user account by the system's secure storage. They aren't in prompts, transcripts, notes, the board, exports, backups or logs, and this window only learns whether one is set.</li>
        <li>Agents only reach connections linked to their project, only through a connector's declared operations, under the safety level you chose. Nothing an agent or a message says can approve anything.</li>
        <li>It does not stop a hostile program running as your user: it could ask the system to decrypt the store or read your key files. Keep agents' permissions limited and don't run untrusted code.</li>
        <li>Results reach the model. Query results, API responses and command output go back to the agent, with known secrets masked; masking is a safety net, not a guarantee.</li>
        <li>Agents' file tools can't read secret files or Corvid's data folder (Settings → Files agents may not read), but a script an agent runs still could. The threat model and a short checklist are in docs/SECURITY.md.</li>
      </ul>
      <button
        className="btn sm ghost"
        onClick={() =>
          void api.connectionsOpenDoc().then((ok) => ok || toast("This install has no copy of the page; it is docs/CONNECTORS.md in Corvid's source.", 'info'))
        }
      >
        Read the full page (docs/CONNECTORS.md)
      </button>
    </details>
  )
}

export function Confirm({ title, body, yes, danger, onYes, onNo }: { title: string; body: string; yes: string; danger?: boolean; onYes: () => void; onNo: () => void }): ReactNode {
  return (
    <div className="overlay" onMouseDown={onNo}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onNo()}>
        <h3>{title}</h3>
        <p>{body}</p>
        <div className="actions">
          <div style={{ flex: 1 }} />
          <button className="btn" autoFocus onClick={onNo}>
            Cancel
          </button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} onClick={onYes}>
            {yes}
          </button>
        </div>
      </div>
    </div>
  )
}
