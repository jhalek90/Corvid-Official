// How an HTTP connection signs in (#103): the plain labels behind the stored `auth` setting, which settings and
// secret slots each method uses, and the form's checks. The stored value stays the comma list httpRules.ts reads
// ("none", "bearer", "header,query"), so nothing is migrated. No electron imports: the window, main and the tests
// all use it. It never touches a secret value except to suggest where a pasted one belongs.

export type HttpAuthKind = 'none' | 'bearer' | 'basic' | 'header' | 'query' | 'oauth2'

export interface HttpAuthMethod {
  kind: HttpAuthKind
  label: string
  /** the name in "…, but you chose Bearer" */
  short: string
  /** the secret slots this method needs */
  slots: string[]
  /** the settings that only matter for this method */
  fields: string[]
}

export const HTTP_AUTH_METHODS: HttpAuthMethod[] = [
  { kind: 'none', label: 'No credentials', short: 'No credentials', slots: [], fields: [] },
  { kind: 'bearer', label: 'Bearer token', short: 'Bearer', slots: ['token'], fields: [] },
  { kind: 'basic', label: 'Basic (user name and password)', short: 'Basic', slots: ['password'], fields: ['username'] },
  { kind: 'header', label: 'API key in a header', short: 'API key in a header', slots: ['api_key'], fields: ['auth_header'] },
  { kind: 'query', label: 'API key in the URL query', short: 'API key in the URL query', slots: ['api_key'], fields: ['auth_query'] },
  { kind: 'oauth2', label: 'OAuth2 (client credentials)', short: 'OAuth2', slots: ['client_secret'], fields: ['token_url', 'client_id', 'scope', 'oauth_send'] }
]

const byKind = new Map(HTTP_AUTH_METHODS.map((m) => [m.kind, m]))
export const authLabel = (k: string): string => byKind.get(k as HttpAuthKind)?.label ?? k
export const authShort = (k: string): string => byKind.get(k as HttpAuthKind)?.short ?? k

/** Settings that belong to one sign-in method; the form shows each only when its method is chosen. */
export const AUTH_FIELDS = new Set(HTTP_AUTH_METHODS.flatMap((m) => m.fields))

/** The stored comma list as kinds, in the order written; empty and repeated entries dropped. */
export function parseAuth(v: unknown): string[] {
  return [
    ...new Set(
      String(v ?? '')
        .split(',')
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean)
    )
  ]
}

/** The chosen kinds as the stored value, in the dropdown's order. "none" goes alone. */
export function formatAuth(kinds: string[]): string {
  const picked = HTTP_AUTH_METHODS.filter((m) => m.kind !== 'none' && kinds.includes(m.kind)).map((m) => m.kind)
  return picked.length ? picked.join(',') : 'none'
}

/**
 * What a connection signs in with when it has no auth of its own: the connector's default, or, for a drafted
 * connector without the setting, what its secret slots imply. The same order as httpSettings in httpRules.ts.
 */
export function effectiveAuth(config: Record<string, unknown>, fields: { key: string; default?: unknown }[], slots: string[]): string[] {
  const own = config.auth
  if (own !== undefined && own !== '') return parseAuth(own)
  const d = fields.find((f) => f.key === 'auth')?.default
  if (d !== undefined && d !== '') return parseAuth(d)
  if (slots.includes('client_secret')) return ['oauth2']
  if (slots.includes('token')) return ['bearer']
  if (slots.includes('password')) return ['basic']
  if (slots.includes('api_key')) return ['header']
  return ['none']
}

/** The secret slots the chosen kinds use. */
export function authSlots(kinds: string[]): Set<string> {
  return new Set(kinds.flatMap((k) => byKind.get(k as HttpAuthKind)?.slots ?? []))
}

/** The kinds after ticking one: "none" alone, else without "none" and without another Authorization-header method. */
export function pickAuth(kinds: string[], kind: HttpAuthKind): string[] {
  if (kind === 'none') return ['none']
  const authz = ['bearer', 'basic', 'oauth2']
  return [...kinds.filter((k) => k !== 'none' && k !== kind && !(authz.includes(kind) && authz.includes(k))), kind]
}

/** Kinds that work together: "none" with anything else doesn't, and neither do two methods that set Authorization. */
export function authConflict(kinds: string[]): string | undefined {
  if (kinds.includes('none') && kinds.length > 1) return 'No credentials can’t be combined with another method.'
  const unknown = kinds.filter((k) => !byKind.has(k as HttpAuthKind))
  if (unknown.length) return `Unknown sign-in method: ${unknown.join(', ')}.`
  const authz = kinds.filter((k) => k === 'bearer' || k === 'basic' || k === 'oauth2')
  if (authz.length > 1) return `${authz.map(authLabel).join(' and ')} both use the Authorization header, so only one can be chosen.`
  return undefined
}

/** One line per needed secret that isn't there, naming the slot and the method that needs it. */
export function missingSecrets(kinds: string[], slotLabel: (slot: string) => string, isSet: (slot: string) => boolean): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const k of kinds)
    for (const s of byKind.get(k as HttpAuthKind)?.slots ?? []) {
      if (seen.has(s) || isSet(s)) continue
      seen.add(s)
      const users = kinds.filter((x) => byKind.get(x as HttpAuthKind)?.slots.includes(s)).map(authShort)
      out.push(`${slotLabel(s)} is empty, but you chose ${users.join(' and ')}.`)
    }
  return out
}

/** Settings a chosen method can't work without, with what to put there. */
export function missingSettings(kinds: string[], config: Record<string, unknown>, fieldLabel: (key: string) => string): string[] {
  const empty = (k: string): boolean => config[k] === undefined || String(config[k]).trim() === ''
  const out: string[] = []
  if (kinds.includes('basic') && empty('username')) out.push(`${fieldLabel('username')} is empty, but you chose Basic.`)
  if (kinds.includes('oauth2') && empty('token_url')) out.push(`${fieldLabel('token_url')} is empty, but you chose OAuth2.`)
  if (kinds.includes('oauth2') && empty('client_id')) out.push(`${fieldLabel('client_id')} is empty, but you chose OAuth2.`)
  return out
}

/** A slot the chosen kinds don't use, and the methods that would use it. */
export const methodsForSlot = (slot: string): HttpAuthKind[] => HTTP_AUTH_METHODS.filter((m) => m.slots.includes(slot)).map((m) => m.kind)

export interface PasteGuess {
  /** the methods it could be for, the likeliest first */
  kinds: HttpAuthKind[]
  why: string
  /** the value to save, with a "Bearer " prefix taken off */
  value: string
  /** for an "Authorization: Basic" value: the user name in it (the password goes in the Password slot) */
  username?: string
}

/** What a pasted value looks like, so the form can suggest a method. Undefined when it doesn't look like a credential. */
export function guessPaste(raw: string): PasteGuess | undefined {
  const v = raw.trim().replace(/^authorization:\s*/i, '')
  if (!v) return undefined
  const bearer = v.match(/^bearer\s+(\S+)$/i)
  if (bearer) return { kinds: ['bearer'], why: 'It starts with “Bearer”, so it is a bearer token.', value: bearer[1] }
  const basic = v.match(/^basic\s+([A-Za-z0-9+/=]+)$/i)
  if (basic) {
    let pair = ''
    try {
      pair = atob(basic[1])
    } catch {
      /* not base64 */
    }
    const i = pair.indexOf(':')
    if (i > 0) return { kinds: ['basic'], why: 'It is an Authorization: Basic value, a user name and password.', value: pair.slice(i + 1), username: pair.slice(0, i) }
  }
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]*$/.test(v)) return { kinds: ['bearer', 'header'], why: 'It looks like a JWT, which is usually sent as a bearer token.', value: v }
  if (/^[A-Za-z0-9._~+/=:-]{16,}$/.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v))
    return { kinds: ['header', 'bearer', 'query'], why: 'It looks like an API key or token. The API’s documentation says how to send it.', value: v }
  return undefined
}
