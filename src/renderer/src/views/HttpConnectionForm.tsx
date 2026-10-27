import { useState, type ReactNode } from 'react'
import type { ConnectorDetail } from '@shared/types'
import {
  AUTH_FIELDS,
  HTTP_AUTH_METHODS,
  authConflict,
  authLabel,
  authSlots,
  effectiveAuth,
  formatAuth,
  guessPaste,
  methodsForSlot,
  pickAuth,
  type HttpAuthKind,
  type PasteGuess
} from '@shared/httpAuth'
import { DB_RUNTIMES } from '@shared/dbAdvice'
import { Field } from '../components/RemoteSystems'
import type { ConnectionInput } from '../api'
import { InfoTip } from '../components/Tooltip'

// The HTTP connector's part of the connection form (#103): "Sign in with" as a list of plain choices, only the
// settings and secret slots the chosen method needs, a paste box that suggests a method, and a note on http://
// base URLs. Choice lists for the other connectors' fixed-value settings live here too. Form and checks only: the
// stored values are the ones httpRules.ts and db.ts always read.

type Config = ConnectionInput['config']
type Slot = ConnectorDetail['secretSlots'][number]

/** An HTTP connector with the auth setting: the built-in one, or one drafted on the http runtime. */
export const isHttpAuth = (d?: ConnectorDetail): d is ConnectorDetail => d?.runtime === 'http' && d.configFields.some((f) => f.key === 'auth')

export const chosenAuth = (d: ConnectorDetail, config: Config): string[] => effectiveAuth(config, d.configFields, d.secretSlots.map((s) => s.key))

/** The secret slots the form shows: for http only those the chosen method uses (the runtime reads no others). */
export function shownSlots(d: ConnectorDetail | undefined, config: Config): Slot[] {
  if (!d) return []
  const all = d.secretSlots
  if (!isHttpAuth(d)) return all
  const used = authSlots(chosenAuth(d, config))
  return all.filter((s) => used.has(s.key))
}

/** A setting of a sign-in method that isn't chosen: hidden, but kept as saved. */
export function hiddenField(d: ConnectorDetail | undefined, config: Config, key: string): boolean {
  if (!isHttpAuth(d) || !AUTH_FIELDS.has(key)) return false
  const kinds = chosenAuth(d, config)
  return !HTTP_AUTH_METHODS.some((m) => kinds.includes(m.kind) && m.fields.includes(key))
}

export const slotLabel = (d: ConnectorDetail, key: string): string => d.secretSlots.find((s) => s.key === key)?.label ?? key
export const fieldLabel = (d: ConnectorDetail, key: string): string => d.configFields.find((f) => f.key === key)?.label.replace(/ \(for [a-z0-9]+\)$/, '') ?? key

/** The config after choosing `kind` for a pasted value: the method, and the user name of a Basic pair. */
export function withPasted(d: ConnectorDetail, config: Config, kind: HttpAuthKind, g: PasteGuess): Config {
  return { ...config, auth: formatAuth(pickAuth(chosenAuth(d, config), kind)), ...(kind === 'basic' && g.username ? { username: g.username } : {}) }
}

export const pasteSlot = (kind: HttpAuthKind): string | undefined => HTTP_AUTH_METHODS.find((m) => m.kind === kind)?.slots[0]

export function AuthPicker({
  d,
  config,
  set,
  onPaste
}: {
  d: ConnectorDetail
  config: Config
  set: (c: Config) => void
  onPaste?: (kind: HttpAuthKind, g: PasteGuess) => void
}): ReactNode {
  const kinds = chosenAuth(d, config)
  const conflict = authConflict(kinds)
  const toggle = (kind: HttpAuthKind): void => {
    const next = kinds.includes(kind) && kind !== 'none' ? kinds.filter((k) => k !== kind) : pickAuth(kinds, kind)
    set({ ...config, auth: formatAuth(next) })
  }
  return (
    <Field label="Sign in with" hint="what Corvid adds to each request">
      <div className="conn-auth" role="group" aria-label="Sign in with">
        {HTTP_AUTH_METHODS.map((m) => (
          <label key={m.kind} className="conn-check conn-small">
            <input type="checkbox" checked={kinds.includes(m.kind)} onChange={() => toggle(m.kind)} /> {m.label}
          </label>
        ))}
      </div>
      {conflict && <div className="conn-small bad">{conflict}</div>}
      {kinds.includes('none') ? (
        <>
          <div className="muted conn-small">Corvid won’t send any credentials. Pick a method if the API needs a key or token.</div>
          {onPaste && <PasteKey onUse={onPaste} />}
        </>
      ) : (
        <div className="muted conn-small">
          One Authorization method at a time{' '}
          <InfoTip tip="Header and query keys can be combined. Bearer, Basic and OAuth2 each use the Authorization header, so only one of them at a time." />
        </div>
      )}
    </Field>
  )
}

/** A write-only box: a pasted value is checked here for its shape, then handed to the slot of the method picked. */
function PasteKey({ onUse }: { onUse: (kind: HttpAuthKind, g: PasteGuess) => void }): ReactNode {
  const [value, setValue] = useState('')
  const g = guessPaste(value)
  return (
    <div className="conn-paste-key">
      <input
        className="rinput"
        type="password"
        autoComplete="new-password"
        aria-label="Paste a key or token"
        placeholder="Have a key or token? Paste it here and Corvid suggests a method"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {value.trim() &&
        (g ? (
          <div className="conn-small conn-suggest">
            <span>{g.why} Use it as:</span>
            {g.kinds.map((k) => (
              <button
                key={k}
                className="btn sm"
                onClick={() => {
                  onUse(k, g)
                  setValue('')
                }}
              >
                {authLabel(k)}
              </button>
            ))}
          </div>
        ) : (
          <div className="muted conn-small">That doesn’t look like a key or token. Pick a method above if the API needs one.</div>
        ))}
    </div>
  )
}

/** Secret slots a method that isn't chosen would use, holding a value: a suggestion to switch, and a way to drop it. */
export function UnusedSecrets({
  d,
  config,
  set,
  keys,
  typed,
  onClear
}: {
  d: ConnectorDetail
  config: Config
  set: (c: Config) => void
  keys: string[]
  /** typed in this form (not saved yet) rather than saved earlier */
  typed?: boolean
  onClear: (key: string) => void
}): ReactNode {
  if (!keys.length) return null
  const now = chosenAuth(d, config).map(authLabel).join(' and ')
  return (
    <>
      {keys.map((k) => (
        <div key={k} className="conn-small conn-suggest">
          <span>
            {typed ? `You typed a ${slotLabel(d, k)}` : `A ${slotLabel(d, k)} is saved`}, but {now} doesn’t use it{typed ? ', so it won’t be saved' : ''}. Use:
          </span>
          {methodsForSlot(k).map((m) => (
            <button key={m} className="btn sm" onClick={() => set({ ...config, auth: formatAuth(pickAuth(chosenAuth(d, config), m)) })}>
              {authLabel(m)}
            </button>
          ))}
          <button className="btn sm ghost" onClick={() => onClear(k)}>
            {typed ? 'Discard it' : 'Clear it'}
          </button>
        </div>
      ))}
    </>
  )
}

/** Names, single labels and addresses that are on the user's own computer or network rather than the internet. */
function looksInternal(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  if (h === 'localhost' || !h.includes('.') || /\.(local|localhost|internal|lan|home\.arpa|corp|intranet)$/.test(h)) return true
  if (h === '::1' || /^f[cd]|^fe80:/.test(h)) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (!v4) return false
  const [a, b] = [Number(v4[1]), Number(v4[2])]
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
}

/** Under the base URL: what plain http means here, and a one-click https or local switch. The rules stay in httpRules.ts. */
export function BaseUrlNote({ config, set }: { config: Config; set: (c: Config) => void }): ReactNode {
  const raw = String(config.base_url ?? '').trim()
  if (!/^http:\/\//i.test(raw)) return null
  let host = ''
  try {
    host = new URL(raw).hostname
  } catch {
    return null
  }
  const local = config.local === true || config.local === 'true'
  if (local) return <div className="muted conn-small">Plain http: requests and any credential travel unencrypted. That is only all right on your own computer or network.</div>
  const internal = looksInternal(host)
  return (
    <div className="conn-small conn-url-note">
      <div className="remote-warn">Corvid only talks to https addresses unless this is marked as a local or internal service.</div>
      <div className="muted">“Local or internal service” (below) is for something on your own computer or network: it allows private addresses and plain http.</div>
      <div className="conn-suggest">
        {internal ? (
          <button className="btn sm" onClick={() => set({ ...config, local: true })}>
            Mark as a local or internal service
          </button>
        ) : (
          <>
            <button className="btn sm" onClick={() => set({ ...config, base_url: raw.replace(/^http:/i, 'https:') })}>
              Use https://{host}
            </button>
            <span className="muted">Public APIs almost always answer on https; Test connection tells you if this one doesn’t.</span>
          </>
        )}
      </div>
    </div>
  )
}

// ---------- fixed-value settings of the other connectors ----------

const DB_CHOICES: Record<string, [string, string][]> = {
  tls: [
    ['', 'Automatic: verify for remote hosts, off for localhost'],
    ['verify', 'Verify: encrypted, certificate checked'],
    ['no-verify', 'No verify: encrypted, certificate not checked'],
    ['off', 'Off: unencrypted']
  ],
  access: [
    ['read', 'Read only (queries)'],
    ['read-write', 'Read and write (also insert, update, delete)'],
    ['admin', 'Admin (also schema, users and grants; always asks)']
  ]
}
const HTTP_CHOICES: Record<string, [string, string][]> = {
  oauth_send: [
    ['basic', 'In an Authorization header (basic)'],
    ['body', 'As form fields in the request body']
  ]
}

/** The choices for a setting that takes one of a few fixed values, or undefined for a free-text one. */
export function choicesFor(d: ConnectorDetail | undefined, key: string): [string, string][] | undefined {
  if (d?.runtime === 'http') return HTTP_CHOICES[key]
  if (d && (DB_RUNTIMES as readonly string[]).includes(d.runtime)) return DB_CHOICES[key]
  return undefined
}

/** A dropdown over a fixed-value setting; a saved value it doesn't know is kept and shown as saved. */
export function ChoiceSelect({ value, options, onChange, label }: { value: string; options: [string, string][]; onChange: (v: string) => void; label: string }): ReactNode {
  const all = options.some(([v]) => v === value) ? options : [...options, [value, `${value} (as saved)`] as [string, string]]
  return (
    <select className="rinput" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)}>
      {all.map(([v, text]) => (
        <option key={v} value={v}>
          {text}
        </option>
      ))}
    </select>
  )
}
