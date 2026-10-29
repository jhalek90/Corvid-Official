import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { AuditDecision, RemoteApproval, RemoteSystem, SafetyLevel } from '@shared/types'
import type { ToolDef } from '../mcp'
import { classify } from './classify'
import { audit } from './audit'
import { scrubber } from './scrub'
import { runCommand } from './ssh'
import { getSystem, initStore, systemsForProject } from './store'
import { sshGate } from '../connectors'
import { confirmMigration, killedAll, touchConnection } from '../connectors/store'

// Agents use remote systems only through these tools: they name a system, Corvid connects with
// the stored credentials and returns the (scrubbed) output. Each agent sees only the systems
// linked to the project it works in, and the system's safety level decides what needs the user.

export const APPROVAL_TIMEOUT_MS = 3 * 60_000
const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 600

export interface AgentScope {
  /** the project folder the agent works in */
  project: string
  /** who is asking, for the approval card and audit log, e.g. "worker #12" */
  agent: string
  /** where it runs (a worker's worktree), for the deny rules' project patterns */
  cwd?: string
  /** the folders it may upload files from (#168): its worktree and session scratchpad; no upload without them */
  uploadRoots?: () => string[]
}

interface Pending extends RemoteApproval {
  resolve: (d: 'approved' | 'denied' | 'timeout') => void
  timer: NodeJS.Timeout
}

let onChange: () => void = () => {}
let onRequest: (a: RemoteApproval) => void = () => {}
const pending: Pending[] = []

export function initRemote(deps: { changed: () => void; approvalRequested: (a: RemoteApproval) => void }): void {
  onChange = deps.changed
  onRequest = deps.approvalRequested
  initStore()
}

/** Refuse everything waiting for the user, e.g. when the kill switch goes on. */
export function denyAll(filter: (a: RemoteApproval) => boolean = () => true): void {
  for (const p of pending.filter(filter)) settle(p, 'denied')
}

export const listApprovals = (): RemoteApproval[] => pending.map(({ resolve: _r, timer: _t, ...a }) => a)

export function decide(id: string, approve: boolean): void {
  const p = pending.find((x) => x.id === id)
  if (p) settle(p, approve ? 'approved' : 'denied')
}

/** A worker ended: nothing it was waiting on should run. */
export function cancelForAgent(agent: string): void {
  for (const p of pending.filter((x) => x.agent === agent)) settle(p, 'denied')
}

function settle(p: Pending, d: 'approved' | 'denied' | 'timeout'): void {
  clearTimeout(p.timer)
  pending.splice(pending.indexOf(p), 1)
  p.resolve(d)
  onChange()
}

/** Shown in Corvid's own approval dialog (and as a notification); only that dialog can answer it. */
export function askUser(a: Omit<RemoteApproval, 'id' | 'createdAt' | 'expiresAt'>): Promise<'approved' | 'denied' | 'timeout'> {
  return new Promise((resolve) => {
    const now = Date.now()
    const p: Pending = { ...a, id: randomUUID().slice(0, 8), createdAt: now, expiresAt: now + APPROVAL_TIMEOUT_MS, resolve, timer: undefined! }
    p.timer = setTimeout(() => settle(p, 'timeout'), APPROVAL_TIMEOUT_MS)
    pending.push(p)
    onChange()
    onRequest(listApprovals().find((x) => x.id === p.id)!)
  })
}

const target = (s: RemoteSystem): string => `${s.user}@${s.host}${s.port === 22 ? '' : `:${s.port}`}`

const SAFETY_TEXT: Record<SafetyLevel, string> = {
  free: 'free: commands run without asking',
  'approve-writes': 'approve writes: read-only commands run straight away; anything else waits for the user to approve',
  strict: 'strict: every command waits for the user to approve'
}

function findSystem(scope: AgentScope, name: string): RemoteSystem {
  const mine = systemsForProject(scope.project)
  const s = mine.find((x) => x.name.toLowerCase() === String(name).trim().toLowerCase())
  if (!s) {
    throw new Error(
      mine.length
        ? `No system called "${name}" is linked to this project. Available: ${mine.map((x) => x.name).join(', ')}.`
        : 'No remote systems are linked to this project. The user can link one in Corvid, in the Servers panel.'
    )
  }
  return s
}

export async function runOn(scope: AgentScope, systemName: string, command: string, timeoutSec?: number): Promise<string> {
  const sys = findSystem(scope, systemName)
  const scrub = scrubber()
  const cmd = String(command ?? '')
  const { readOnly, reason } = classify(cmd)
  const base = { system: sys.name, target: target(sys), command: scrub(cmd), agent: scope.agent, project: scope.project, safety: sys.safety, readOnly }
  const log = (decision: AuditDecision, approvedBy: string, extra: Partial<Parameters<typeof audit>[0]> = {}): void =>
    audit({ ts: Date.now(), ...base, decision, approvedBy, ...extra })

  if (!cmd.trim()) throw new Error('The command is empty.')
  // run_on is the ssh connector's old name: the kill switch and first-use approval apply to it too
  const gate = await sshGate(scope, sys.id)
  if (gate) {
    log('refused', gate)
    throw new Error(gate)
  }
  const needsUser = sys.safety === 'strict' || (sys.safety === 'approve-writes' && !readOnly)
  let approvedBy = sys.safety === 'free' ? 'auto (free)' : 'auto (read-only)'
  if (needsUser) {
    const why = sys.safety === 'strict' ? `${sys.name} is strict: every command needs approval.` : `Not recognised as read-only: ${reason}.`
    const answer = await askUser({ systemId: sys.id, systemName: sys.name, target: target(sys), command: base.command, agent: scope.agent, project: scope.project, why })
    // The user approved this command on this host; if the system was edited or removed meanwhile, don't guess.
    if (answer === 'approved' && getSystem(sys.id)?.updatedAt !== sys.updatedAt) {
      log('refused', 'system changed while waiting')
      throw new Error(`${sys.name} was changed or removed while the command waited for approval. Nothing was run; try again.`)
    }
    if (answer === 'denied') {
      log('denied', 'user')
      throw new Error('The user declined to run this command. Nothing was run. Ask them before trying something else on this system.')
    }
    if (answer === 'timeout') {
      log('timeout', `no answer in ${APPROVAL_TIMEOUT_MS / 60_000} min`)
      throw new Error(`No one approved the command within ${APPROVAL_TIMEOUT_MS / 60_000} minutes, so it was refused. Nothing was run.`)
    }
    approvedBy = 'user'
  }

  const timeout = Math.min(MAX_TIMEOUT_S, Math.max(1, Math.round(Number(timeoutSec) || DEFAULT_TIMEOUT_S)))
  try {
    const r = await runCommand(sys, cmd, timeout * 1000)
    if (killedAll()) {
      log('refused', 'kill switch went on while it ran')
      throw new Error('All connectors were switched off in Corvid while this ran, so its output is withheld.')
    }
    confirmMigration()
    touchConnection(sys.id)
    log(needsUser ? 'approved' : 'auto', approvedBy, {
      exitCode: r.code,
      durationMs: r.durationMs,
      outputBytes: r.stdout.length + r.stderr.length,
      error: r.timedOut ? `timed out after ${timeout}s` : undefined
    })
    const head = [
      `exit code: ${r.code ?? (r.signal ? `killed (${r.signal})` : 'none')}${r.timedOut ? ` (timed out after ${timeout}s)` : ''}`,
      r.newHostKey ? `first connection: remembered host key ${r.newHostKey}` : '',
      r.truncated ? 'output was cut off at 256 KB per stream' : ''
    ].filter(Boolean)
    return [...head, r.stdout ? `--- stdout ---\n${scrub(r.stdout)}` : '(no stdout)', r.stderr ? `--- stderr ---\n${scrub(r.stderr)}` : ''].filter(Boolean).join('\n')
  } catch (e) {
    const msg = scrub((e as Error).message)
    log(needsUser ? 'approved' : 'auto', approvedBy, { error: msg })
    throw new Error(msg)
  }
}

// ---------- giving a worker access ----------

/**
 * The remote tools for one worker's project, and what to tell it about them, or null when the
 * project has no linked systems. agentAccess.ts puts them on the worker's MCP token.
 */
export function remoteAccess(scope: AgentScope): { tools: ToolDef[]; allowed: string[]; prompt: string } | null {
  const mine = systemsForProject(scope.project)
  if (!mine.length) return null
  return {
    tools: remoteTools(scope),
    // Corvid applies each system's safety level itself, so Claude Code doesn't ask a second time.
    allowed: ['list_systems', 'run_on'],
    prompt:
      `Remote systems linked to this project: ${mine.map((s) => s.name).join(', ')}. To run a command on one, use mcp__corvid__run_on with the system's name (mcp__corvid__list_systems shows them and their safety levels). ` +
      // that some commands wait for the user's approval is in run_on's description (#308)
      'Corvid connects for you; you never get passwords or keys, and must not ask the user for them or try ssh yourself. ' +
        'To copy a file from your worktree or scratchpad onto a system, use the upload operation of the connection with the same name (mcp__corvid__call), not base64 in commands.'
  }
}

/** The MCP tools one agent gets, bound to its project. */
export function remoteTools(scope: AgentScope): ToolDef[] {
  return [
    {
      name: 'list_systems',
      description:
        'List the remote systems (SSH servers) linked to the project you are working in, with each one\'s safety level. Refer to systems by name in run_on.',
      input: {},
      readOnly: true,
      run: () => {
        const mine = systemsForProject(scope.project)
        if (!mine.length) return 'No remote systems are linked to this project.'
        return mine.map((s) => ({ name: s.name, target: target(s), safety: SAFETY_TEXT[s.safety] }))
      }
    },
    {
      name: 'run_on',
      description:
        'Run one shell command on a remote system linked to this project, over SSH, and get its exit code and output. ' +
        'Depending on the system\'s safety level the user may have to approve the command in Corvid first; the call waits up to 3 minutes for that and fails if they decline or don\'t answer. ' +
        'Read-only means plain inspection commands (ls, cat, grep, df, ps, systemctl status, journalctl, git log, docker ps, …) without redirects to files, $( ), or sudo; anything else counts as a write. ' +
        'There is no terminal or stdin, so interactive commands and sudo password prompts won\'t work. Known secrets are masked as [redacted] in the output. ' +
        'To send a file, don\'t paste it into a command: use mcp__corvid__call with operation upload on the connection of the same name.',
      input: {
        system: z.string().describe('system name, from list_systems'),
        command: z.string().describe('the exact command to run'),
        timeout_seconds: z.number().optional().describe(`default ${DEFAULT_TIMEOUT_S}, max ${MAX_TIMEOUT_S}`)
      },
      run: (a: { system: string; command: string; timeout_seconds?: number }) => runOn(scope, a.system, a.command, a.timeout_seconds)
    }
  ]
}
