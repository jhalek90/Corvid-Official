import { useState, type ReactNode } from 'react'
import { KeyRound, Server, Shield, ShieldAlert, ShieldOff } from 'lucide-react'
import type { RemoteAuth, RemoteSystemInput, RemoteSystemView, SafetyLevel, SecretStorageStatus } from '@shared/types'
import { baseName, projectKey } from '@shared/projects'
import { api } from '../api'
import { toast, useStore } from '../store'
import { useProjects } from '../views/ProjectsView'
import { useNow } from '../views/UsageView'

export const SAFETY_LABEL: Record<SafetyLevel, string> = { free: 'Free', 'approve-writes': 'Approve writes', strict: 'Strict' }
export const SAFETY_HINT: Record<SafetyLevel, string> = {
  free: 'Agents run any command without asking. For throwaway dev boxes.',
  'approve-writes': 'Read-only commands (ls, cat, df, systemctl status, …) run freely; anything else waits for you.',
  strict: 'Every command waits for you to approve it. For production.'
}
const SAFETY_ICON: Record<SafetyLevel, typeof Shield> = { free: ShieldOff, 'approve-writes': Shield, strict: ShieldAlert }

export function SafetyBadge({ level }: { level: SafetyLevel }): ReactNode {
  const Icon = SAFETY_ICON[level]
  return (
    <span className={`safety-badge ${level}`} title={SAFETY_HINT[level]}>
      <Icon size={11} strokeWidth={2.25} /> {SAFETY_LABEL[level]}
    </span>
  )
}

/** Whether secrets can be saved now (#159): no real keyring on Linux, or no system secure storage at all, means no. */
export function useSecretStorage(): SecretStorageStatus {
  const remote = useStore((s) => s.remote)
  return (
    remote.secretStorage ??
    (remote.canEncrypt
      ? { available: true, backend: 'unknown' }
      : { available: false, backend: 'unknown', reason: "System secure storage is not available, so secrets can't be saved." })
  )
}

/** A calm note where secrets are entered, shown only when they can't be saved. */
export function SecretStorageNotice({ className = '' }: { className?: string }): ReactNode {
  const st = useSecretStorage()
  if (st.available) return null
  return (
    <div className={`remote-warn ${className}`} role="status">
      <KeyRound size={14} style={{ flex: 'none' }} /> <span>{st.reason} Nothing else changes: secrets already stored stay where they are.</span>
    </div>
  )
}

export const errText = (e: unknown): string => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** An SSH server's form, shown in the Connections tab (#88); with no system it's the draft for a new server. */
export function ServerForm({ system, close }: { system?: RemoteSystemView; close: () => void }): ReactNode {
  const projects = useProjects()
  const [form, setForm] = useState<RemoteSystemInput>(() => ({
    id: system?.id,
    name: system?.name ?? '',
    host: system?.host ?? '',
    port: system?.port ?? 22,
    user: system?.user ?? '',
    auth: system?.auth ?? 'key',
    keyPath: system?.keyPath ?? '',
    projects: system?.projects ?? [],
    // new systems start strict
    safety: system?.safety ?? 'strict'
  }))
  // Secrets are typed here and sent once; what's stored is never sent back. Empty keeps the stored one.
  const [password, setPassword] = useState('')
  const [passphrase, setPassphrase] = useState('')
  const [clearPassphrase, setClearPassphrase] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const set = (patch: Partial<RemoteSystemInput>): void => setForm((f) => ({ ...f, ...patch }))

  const linked = new Set(form.projects.map(projectKey))
  const choices = [
    ...projects.filter((p) => p.active || p.pinned || linked.has(p.key)).map((p) => ({ key: p.key, path: p.path, name: p.name })),
    // links to folders the projects board doesn't show any more
    ...form.projects.filter((p) => !projects.some((x) => x.key === projectKey(p))).map((p) => ({ key: projectKey(p), path: p, name: baseName(p) }))
  ]
  const toggleProject = (path: string): void =>
    set({ projects: linked.has(projectKey(path)) ? form.projects.filter((p) => projectKey(p) !== projectKey(path)) : [...form.projects, path] })

  const storage = useSecretStorage()
  // a typed secret (or a new password server) can't be saved without system secure storage
  const typedSecret = form.auth === 'password' ? !!password || !system : !!passphrase
  const blocked = !storage.available && typedSecret
  const save = async (): Promise<void> => {
    if (busy || blocked) return
    setBusy(true)
    try {
      await api.remoteSave({
        ...form,
        password: form.auth === 'password' ? password : undefined,
        passphrase: form.auth === 'key' ? (clearPassphrase ? null : passphrase) : undefined
      })
      toast(`Saved ${form.name}`)
      close()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!system) return
    try {
      await api.remoteDelete(system.id)
      toast(`Deleted ${system.name}`)
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  // Only whether a secret is stored is known; it can be replaced, never read back.
  const storedPassword = !!system?.hasPassword && system.auth === 'password'
  const storedPassphrase = !!system?.hasPassphrase && system.auth === 'key'

  return (
    <div
      className={`card srv-card editing safety-${form.safety}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close()
        else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') void save()
      }}
    >
      <div className="srv-head">
        <Server size={14} className="muted" />
        <span className="srv-name">{system ? `Edit ${system.name}` : 'New server'}</span>
        <span style={{ flex: 1 }} />
        <SafetyBadge level={form.safety} />
      </div>

      <Field label="Name" hint="what agents call it">
        <input className="rinput mono" spellCheck={false} value={form.name} placeholder="staging-web" onChange={(e) => set({ name: e.target.value })} autoFocus />
      </Field>
      <div className="srv-hostport">
        <Field label="Host">
          <input className="rinput mono" spellCheck={false} value={form.host} placeholder="server.example.com" onChange={(e) => set({ host: e.target.value })} />
        </Field>
        <Field label="Port">
          <input className="rinput mono" spellCheck={false} value={String(form.port)} onChange={(e) => set({ port: Number(e.target.value.replace(/\D/g, '')) || 0 })} />
        </Field>
      </div>
      <Field label="User">
        <input className="rinput mono" spellCheck={false} value={form.user} placeholder="deploy" onChange={(e) => set({ user: e.target.value })} />
      </Field>

      <Field label="Sign in with">
        <div className="seg">
          {(['key', 'password'] as RemoteAuth[]).map((a) => (
            <button key={a} className={form.auth === a ? 'on' : ''} onClick={() => set({ auth: a })}>
              {a === 'key' ? 'Key file' : 'Password'}
            </button>
          ))}
        </div>
      </Field>
      {form.auth === 'key' ? (
        <>
          <Field label="Private key file" hint="the path only, never a copy">
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                className="rinput mono"
                spellCheck={false}
                style={{ flex: 1 }}
                value={form.keyPath ?? ''}
                placeholder="C:\Users\you\.ssh\id_ed25519"
                onChange={(e) => set({ keyPath: e.target.value })}
              />
              <button className="btn sm" onClick={() => void api.remotePickKey().then((p) => p && set({ keyPath: p }))}>
                Browse…
              </button>
            </div>
          </Field>
          <SecretField
            label="Key passphrase"
            stored={storedPassphrase}
            cleared={clearPassphrase}
            value={passphrase}
            onChange={setPassphrase}
            onClear={storedPassphrase ? setClearPassphrase : undefined}
            empty="leave empty if the key has none"
          />
        </>
      ) : (
        <SecretField label="Password" stored={storedPassword} value={password} onChange={setPassword} empty="required" />
      )}

      <Field label="Safety level">
        <div className="seg srv-safety">
          {(['strict', 'approve-writes', 'free'] as SafetyLevel[]).map((l) => (
            <button key={l} className={form.safety === l ? `on ${l}` : ''} onClick={() => set({ safety: l })}>
              {SAFETY_LABEL[l]}
            </button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {SAFETY_HINT[form.safety]}
        </div>
      </Field>

      <Field label="Linked projects" hint="their workers can use it">
        <div className="remote-projects">
          {choices.length === 0 && <span className="muted">No projects yet.</span>}
          {choices.map((p) => (
            <button key={p.key} className={`chip${linked.has(p.key) ? ' on' : ''}`} title={p.path} onClick={() => toggleProject(p.path)}>
              {p.name}
            </button>
          ))}
        </div>
      </Field>

      {system?.hostKey && (
        <div className="muted" style={{ fontSize: 11.5 }}>
          Host key <span className="mono">{system.hostKey}</span>{' '}
          <button
            className="btn sm ghost"
            onClick={() => {
              if (confirm(`Forget the host key for ${system.name}? The next connection trusts whatever key the server presents. Only do this if you know the server's key changed.`))
                void api.remoteForgetHost(system.id).then(() => toast('Host key forgotten'))
            }}
          >
            Forget
          </button>
        </div>
      )}
      <div className="muted" style={{ fontSize: 11, display: 'flex', gap: 6 }}>
        <KeyRound size={12} style={{ flex: 'none', marginTop: 1 }} /> Passwords and passphrases are encrypted with system secure storage. They
        are never shown again, exported, or given to agents.
      </div>
      <SecretStorageNotice />

      {confirmDelete && system ? (
        <div className="srv-confirm">
          <div>
            Delete <span className="mono">{system.name}</span>? Its stored password or passphrase is deleted too. The key file is not touched.
          </div>
          <div className="srv-actions">
            <div style={{ flex: 1 }} />
            <button className="btn sm ghost" onClick={() => setConfirmDelete(false)} autoFocus>
              Keep it
            </button>
            <button className="btn sm danger" onClick={() => void remove()}>
              Delete server
            </button>
          </div>
        </div>
      ) : (
        <div className="srv-actions">
          {system && (
            <button className="btn sm ghost" onClick={() => setConfirmDelete(true)}>
              Delete
            </button>
          )}
          <div style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={close}>
            Cancel
          </button>
          <button
            className="btn sm primary"
            disabled={busy || blocked}
            title={blocked ? storage.reason : undefined}
            onClick={() => void save()}
          >
            {system ? 'Save' : 'Add server'}
          </button>
        </div>
      )}
    </div>
  )
}

/**
 * Write-only secret: shows whether one is stored, and an empty box to type a replacement.
 * With onClear, a stored secret can also be marked for removal on save.
 */
function SecretField({
  label,
  stored,
  cleared = false,
  value,
  onChange,
  onClear,
  empty
}: {
  label: string
  stored: boolean
  cleared?: boolean
  value: string
  onChange: (v: string) => void
  onClear?: (v: boolean) => void
  empty: string
}): ReactNode {
  const [replacing, setReplacing] = useState(!stored)
  const status = cleared ? 'removed on save' : stored ? (value ? 'replaced on save' : 'set') : empty
  return (
    <Field label={label} hint={status}>
      {replacing && !cleared ? (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            className="rinput"
            style={{ flex: 1 }}
            type="password"
            autoComplete="new-password"
            placeholder={stored ? 'new value' : ''}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            autoFocus={stored}
          />
          {stored && (
            <button
              className="btn sm ghost"
              onClick={() => {
                onChange('')
                setReplacing(false)
              }}
            >
              Keep current
            </button>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <span className={`chip${cleared ? '' : ' srv-set'}`}>{cleared ? 'Not set' : 'Set'}</span>
          <span style={{ flex: 1 }} />
          {!cleared && (
            <button className="btn sm" onClick={() => setReplacing(true)}>
              Replace
            </button>
          )}
          {onClear && (
            <button className="btn sm ghost" onClick={() => onClear(!cleared)}>
              {cleared ? 'Undo' : 'Remove'}
            </button>
          )}
        </div>
      )}
    </Field>
  )
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }): ReactNode {
  // a div, not a label: a label passes clicks on its text to the first button inside it
  return (
    <div className="remote-field">
      <span>
        <span className="section-label">{label}</span>
        {hint && <span className="muted" style={{ fontSize: 11, marginLeft: 8 }}>{hint}</span>}
      </span>
      {children}
    </div>
  )
}

/** Shown over everything while an agent's command waits for you. */
export function RemoteApprovalDialog(): ReactNode {
  const approvals = useStore((s) => s.remote.approvals)
  const now = useNow(1000)
  const a = approvals[0]
  if (!a) return null
  const left = Math.max(0, Math.round((a.expiresAt - now) / 1000))
  const connector = a.kind === 'connector'
  return (
    <div className="overlay" style={{ zIndex: 150 }}>
      <div className="dialog remote-approval">
        {connector ? (
          <>
            <h3>
              <ShieldAlert size={17} color="var(--warn)" /> Approve the {a.command} connector?
            </h3>
            <p>
              <b>{a.agent}</b>
              {a.project ? ` in ${baseName(a.project)}` : ''} wants to use <b>{a.systemName}</b>. {a.why}
            </p>
            {a.warn && <p className="remote-warn">{a.warn}</p>}
            <p>{a.summary}</p>
            {a.details?.map((d) => (
              <div key={d.label} className="remote-detail">
                <span className="muted">{d.label}: </span>
                <span className="mono">{d.items.join(', ')}</span>
              </div>
            ))}
          </>
        ) : (
          <>
            <h3>
              <ShieldAlert size={17} color="var(--warn)" /> Run this on {a.systemName}?
            </h3>
            <p>
              <b>{a.agent}</b>
              {a.project ? ` in ${baseName(a.project)}` : ''} wants to run {a.warn ? <b>an administrative operation</b> : 'a command'} on <span className="mono">{a.target}</span>. {a.why}
            </p>
            <pre className="remote-cmd">{a.command}</pre>
          </>
        )}
        <div className="actions">
          <span className="muted" style={{ fontSize: 12 }}>
            Refused automatically in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
            {approvals.length > 1 ? ` · ${approvals.length - 1} more waiting` : ''}
          </span>
          <div style={{ flex: 1 }} />
          <button className="btn" onClick={() => void api.remoteDecide(a.id, false)}>
            Decline
          </button>
          <button className="btn primary" onClick={() => void api.remoteDecide(a.id, true)}>
            {connector ? 'Approve' : 'Run it'}
          </button>
        </div>
      </div>
    </div>
  )
}
