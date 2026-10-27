import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ShieldAlert, TriangleAlert } from 'lucide-react'
import type { ConnectorDraftView, DraftsState } from '@shared/types'
import { api } from '../api'
import { setState, toast, useStore } from '../store'
import { relTime, until } from '../format'
import { errText } from '../components/RemoteSystems'
import { Confirm, lineDiff, ProjectChips } from './ConnectionsView'
import { InfoTip } from '../components/Tooltip'

// Proposals (#92): connectors agents drafted and connections they asked for. A draft is data an agent wrote; it
// does nothing until the user approves it here, for its project only or for all projects. Nothing an agent or a
// board message says can approve one: these buttons, in Corvid's own window, are the only way.

function useDrafts(): DraftsState | undefined {
  const remote = useStore((s) => s.remote)
  const [data, setData] = useState<DraftsState>()
  useEffect(() => {
    let live = true
    void api.connectionsDrafts().then((d) => live && setData(d))
    return () => {
      live = false
    }
  }, [remote])
  return data
}

const STATUS_TEXT: Record<ConnectorDraftView['status'], string> = {
  open: 'Waiting for review',
  approved: 'Approved',
  declined: 'Declined',
  replaced: 'Replaced by a newer draft',
  expired: 'Expired'
}

function useProjectName(): (id: string) => string {
  const projects = useStore((s) => s.projects.projects)
  return (id) => projects.find((p) => p.id === id)?.name ?? 'removed project'
}

export function ProposalsArea({ onAdd }: { onAdd: () => void }): ReactNode {
  const data = useDrafts()
  const projectName = useProjectName()
  if (!data) return null
  const open = data.drafts.filter((d) => d.status === 'open')
  const past = data.drafts.filter((d) => d.status !== 'open')
  const requests = data.requests.filter((r) => r.status === 'open')
  return (
    <div className="conn-list">
      <span className="muted conn-small">
        A proposal does nothing until you approve it here{' '}
        <InfoTip tip="Agents that need a service with no connector can propose one: a manifest, data only, never code. Agents can never approve, create connections or enter secrets." />
      </span>
      {!data.enabled && (
        <div className="remote-warn conn-banner">
          <TriangleAlert size={14} style={{ flex: 'none' }} /> Agents can&apos;t propose connectors: it is switched off in Settings. Proposals already here can
          still be reviewed.
        </div>
      )}
      {requests.length > 0 && <div className="section-label">Connections agents asked for</div>}
      {requests.map((r) => (
        <div key={r.id} className="card conn-inbox">
          <div>
            <b>{r.suggestedName}</b> <span className="muted">· {r.connectorName}</span>
          </div>
          <div className="conn-small">
            Asked by {r.agentName ?? r.agent}
            {r.taskId !== undefined ? ` (#${r.taskId}, ${projectName(r.projectId)})` : ` (${projectName(r.projectId)})`} · {relTime(r.createdAt)}
          </div>
          <div className="conn-reason">{r.purpose}</div>
          <div className="srv-actions">
            <span className="muted conn-small">Only you can set it up: enter the secret, choose the safety level and link the project.</span>
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => void api.connectionsSetRequest(r.id, 'dismissed')}>
              Dismiss
            </button>
            <button className="btn sm" onClick={() => void api.connectionsSetRequest(r.id, 'done')}>
              Mark done
            </button>
            <button className="btn sm primary" onClick={onAdd}>
              Set it up…
            </button>
          </div>
        </div>
      ))}
      <div className="section-label">Proposed connectors</div>
      {open.length ? open.map((d) => <DraftCard key={d.id} d={d} projectName={projectName} />) : <div className="muted conn-small">Nothing waiting for review.</div>}
      {past.length > 0 && (
        <details className="conn-history">
          <summary className="muted conn-small">Decided, replaced and expired ({past.length})</summary>
          {past.map((d) => (
            <div key={d.id} className="conn-small conn-past">
              <b>
                {d.name} {d.version}
              </b>{' '}
              <span className="muted">
                · {STATUS_TEXT[d.status]}
                {d.status === 'approved' ? (d.scope === 'global' ? ', all projects' : ', this project only') : ''}
                {d.declineReason ? `: ${d.declineReason}` : ''} · {d.agentName ?? d.agent} · {relTime(d.decidedAt ?? d.createdAt)}
              </span>
              <button className="btn sm ghost" onClick={() => void api.connectionsDeleteDraft(d.id)}>
                Remove
              </button>
            </div>
          ))}
        </details>
      )}
    </div>
  )
}

function DraftCard({ d, projectName }: { d: ConnectorDraftView; projectName: (id: string) => string }): ReactNode {
  const [dialog, setDialog] = useState<'approve' | 'decline' | 'delete'>()
  const [manifest, setManifest] = useState<'off' | 'whole' | 'diff'>('off')
  const lines = useMemo(() => (d.previousText ? lineDiff(d.previousText, d.manifestText) : []), [d])
  const tests = d.tests ? (d.tests.passed ? { text: 'Tests passed', cls: 'ok' } : { text: 'Tests not passed', cls: 'bad' }) : { text: 'Tests not passed (not run)', cls: 'wait' }
  const groups: [string, string[]][] = [
    ['Read', d.reads],
    ['Write', d.writes],
    ['Admin', d.admin],
    ['Secrets it needs (labels only)', d.secretLabels]
  ]
  return (
    <div className="card conn-card open conn-draft">
      <div className="conn-card-head">
        <b className="conn-name">
          {d.name} <span className="muted">{d.version}</span>
        </b>
        <span style={{ flex: 1 }} />
        <span className={`conn-status ${tests.cls}`}>{tests.text}</span>
      </div>
      <div className="conn-facts">
        <span className="k">Proposed by</span>
        <span className="v">
          {d.agentName ?? d.agent}
          {d.taskId !== undefined ? ` (#${d.taskId}, ${projectName(d.projectId)})` : ` (${projectName(d.projectId)})`} · {relTime(d.createdAt)}
        </span>
        <span className="k">Usable in</span>
        <span className="v">
          <ProjectChips ids={[d.projectId]} /> <span className="muted">until you choose all projects</span>
        </span>
        {d.previousVersion && (
          <>
            <span className="k">Replaces</span>
            <span className="v">the approved version {d.previousVersion}</span>
          </>
        )}
        <span className="k">Expires</span>
        <span className="v">in {until(d.expiresAt)} if untouched</span>
      </div>
      <div className="conn-reason">
        <span className="muted">Why: </span>
        {d.reason}
      </div>
      {d.source && (
        <div className="conn-small">
          <span className="muted">Where the hosts and endpoints came from, by the agent&apos;s account: </span>
          {d.source}
        </div>
      )}
      <div className="conn-targets" aria-label="Hosts it can reach">
        <span className="muted conn-small">Reaches</span>
        {d.targets.map((t) => (
          <span key={t.text} className={`conn-target${t.isNew ? ' new' : ''}`} title={t.isNew ? 'No approved connector reaches this host yet' : undefined}>
            {t.text}
            {t.isNew && <em>new</em>}
          </span>
        ))}
      </div>
      <p className="conn-summary">{d.summary}</p>
      {groups
        .filter(([, items]) => items.length)
        .map(([label, items]) => (
          <div key={label} className="remote-detail">
            <span className={`muted ${label === 'Admin' ? 'bad' : ''}`}>{label}: </span>
            <span className="mono">{items.join(', ')}</span>
          </div>
        ))}
      <div className="conn-small ok">Valid: it passed Corvid&apos;s manifest validator and the rules for drafted connectors.</div>
      {d.tests ? (
        <ul className="conn-tests">
          {d.tests.results.map((r, i) => (
            <li key={i} className={r.ok ? 'ok' : 'bad'}>
              {r.ok ? '✓' : '✗'} {r.name}: <span className="muted">{r.detail}</span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="conn-small muted">
          {d.testsDeclared ? `${d.testsDeclared} test${d.testsDeclared === 1 ? '' : 's'} declared, not run yet.` : 'No tests declared.'} Tests run only against Corvid&apos;s local
          mock server.
        </div>
      )}
      {manifest !== 'off' && (
        <pre className="conn-pre" tabIndex={0}>
          {manifest === 'diff'
            ? lines.map((l, i) => (
                <div key={i} className={l.kind === '+' ? 'add' : l.kind === '-' ? 'del' : ''}>
                  {l.kind} {l.text}
                </div>
              ))
            : d.manifestText}
        </pre>
      )}
      <div className="srv-actions">
        <button className="btn sm ghost" onClick={() => setManifest(manifest === 'whole' ? 'off' : 'whole')}>
          {manifest === 'whole' ? 'Hide manifest' : 'View manifest'}
        </button>
        {d.previousText && (
          <button className="btn sm ghost" onClick={() => setManifest(manifest === 'diff' ? 'off' : 'diff')}>
            {manifest === 'diff' ? 'Hide changes' : `Changes since ${d.previousVersion}`}
          </button>
        )}
        <button className="btn sm ghost" onClick={() => void api.connectionsExtendDraft(d.id).then(() => toast('Kept for 14 more days'))}>
          Keep longer
        </button>
        <button className="btn sm ghost" onClick={() => setDialog('delete')}>
          Delete
        </button>
        <div style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setDialog('decline')}>
          Decline…
        </button>
        <button className="btn sm primary" onClick={() => setDialog('approve')}>
          Review and approve…
        </button>
      </div>
      {dialog === 'approve' && <ApproveDraft d={d} projectName={projectName} close={() => setDialog(undefined)} />}
      {dialog === 'decline' && <DeclineDraft d={d} close={() => setDialog(undefined)} />}
      {dialog === 'delete' && (
        <Confirm
          title={`Delete the ${d.name} proposal?`}
          body="It is removed without a decision; the agent's connector_status then finds nothing. Nothing was ever active."
          yes="Delete"
          danger
          onYes={() => void api.connectionsDeleteDraft(d.id).finally(() => setDialog(undefined))}
          onNo={() => setDialog(undefined)}
        />
      )}
    </div>
  )
}

function ApproveDraft({ d, projectName, close }: { d: ConnectorDraftView; projectName: (id: string) => string; close: () => void }): ReactNode {
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const approve = (): void =>
    void api
      .connectionsApproveDraft(d.id, d.hash, scope)
      .then(() => {
        toast(`Approved ${d.name} ${d.version}. Add a connection to use it.`)
        setState({ connectionsFocus: { area: 'connectors' } })
      })
      .catch((e) => toast(errText(e), 'error'))
      .finally(close)
  return (
    <div className="overlay" style={{ zIndex: 150 }} onMouseDown={close}>
      <div className="dialog remote-approval" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h3>
          <ShieldAlert size={17} color="var(--warn)" /> Approve the {d.name} {d.version} connector?
        </h3>
        <p>
          {d.agentName ?? d.agent} wrote this manifest. Approving makes it a connector; nothing runs until you also add a connection with its secret and link a
          project. A later change is a new proposal that asks again.
        </p>
        {!d.tests?.passed && <p className="remote-warn">Its tests have not passed against Corvid&apos;s mock server.</p>}
        {d.targets.some((t) => t.isNew) && (
          <p className="remote-warn">
            New hosts: {d.targets.filter((t) => t.isNew).map((t) => t.text).join(', ')}. Check they are the ones you meant.
          </p>
        )}
        <p>{d.summary}</p>
        <div className="conn-scope" role="radiogroup" aria-label="Where it can be used">
          <label>
            <input type="radio" checked={scope === 'project'} onChange={() => setScope('project')} /> For {projectName(d.projectId)} only (recommended)
          </label>
          <label>
            <input type="radio" checked={scope === 'global'} onChange={() => setScope('global')} /> For all projects
          </label>
        </div>
        <div className="actions">
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" autoFocus onClick={approve}>
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}

function DeclineDraft({ d, close }: { d: ConnectorDraftView; close: () => void }): ReactNode {
  const [reason, setReason] = useState('')
  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && close()}>
        <h3>
          Decline {d.name} {d.version}?
        </h3>
        <p className="muted">The agent can read your reason through connector_status. Don&apos;t put a secret in it.</p>
        <textarea className="rinput" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Optional reason" />
        <div className="actions">
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button
            className="btn danger"
            onClick={() =>
              void api
                .connectionsDeclineDraft(d.id, reason)
                .then(() => toast(`Declined ${d.name}`))
                .finally(close)
            }
          >
            Decline
          </button>
        </div>
      </div>
    </div>
  )
}
