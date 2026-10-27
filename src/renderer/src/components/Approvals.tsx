import type { ReactNode } from 'react'
import { Check, Lock } from 'lucide-react'
import { blockerLabel, openBlockers } from '@shared/blockers'
import { api } from '../api'
import { useStore } from '../store'
import { useInScope } from '../scope'

/** Worker proposals from Plan & ask mode (Corvid's start_worker, or Automate on a task card), awaiting the user. */
export function Approvals(): ReactNode {
  // with a project chosen (#77), only its approvals; the Agents view counts the others above
  const inScope = useInScope()
  const proposals = useStore((s) => s.assistant.proposals).filter((p) => inScope(p.project))
  if (!proposals.length) return null
  return (
    <section className="approvals" aria-label="Awaiting your approval">
      <div className="section-label">Awaiting your approval</div>
      {proposals.map((p) => (
        <div className="proposal" key={p.id}>
          <div className="pr-title">Start a worker for #{p.taskId}?</div>
          <div className="pr-task">{p.taskTitle}</div>
          <div className="pr-meta mono">{p.project}</div>
          {p.instructions && <div className="pr-instr">{p.instructions}</div>}
          <ProposalBlockers taskId={p.taskId} />
          <div className="actions">
            <button className="btn sm primary" onClick={() => void api.approveProposal(p.id)}>
              <Check size={13} /> Approve
            </button>
            <button className="btn sm ghost" onClick={() => void api.rejectProposal(p.id)}>
              Decline
            </button>
          </div>
        </div>
      ))}
    </section>
  )
}

/** A proposal for a task that still waits on others says so, live, so the user sees it when approving. */
function ProposalBlockers({ taskId }: { taskId: number }): ReactNode {
  const tasks = useStore((s) => s.tasks)
  const t = tasks.find((x) => x.id === taskId)
  const open = t ? openBlockers(t, (id) => tasks.find((x) => x.id === id)) : []
  if (!open.length) return null
  return (
    <div className="pr-blocked">
      <Lock size={12} />
      <span>Blocked by {open.map(blockerLabel).join(', ')}. Approving starts it anyway.</span>
    </div>
  )
}
