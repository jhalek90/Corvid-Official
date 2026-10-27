// The Connections tab's "Send a request" panel (#105): the user's own request through an HTTP connection, and the
// response that comes back only to that panel. Shared by main (connectors/userRequest.ts) and the renderer.

export interface UserRequest {
  method: string
  /** under the connection's base URL, starting with / */
  path: string
  query: [string, string][]
  headers: [string, string][]
  /** only for methods that take one */
  body?: string
  bodyKind: 'json' | 'text'
}

export type RequestClass = 'read' | 'write' | 'admin'

/** Why a request can't go: the kill switch, a switched-off or unapproved connector, or a request the runtime refuses. */
export interface UserRequestRefusal {
  ok: false
  error: string
  /** the connector needs the user's approval first: the panel offers "Review and approve" */
  approve?: boolean
  durationMs?: number
}

/** The exact request before it is sent, for the confirmation of writes and admin paths. */
export interface UserRequestPlan {
  ok: true
  cls: RequestClass
  why: string
  /** the request as it will be sent, with the credential's place marked */
  shown: string
  warnings: string[]
  notes: string[]
}

export interface UserResponse {
  ok: true
  status: number
  reason: string
  durationMs: number
  /** bytes of the body that was read */
  size: number
  /** the final path and query, secret-looking query values masked */
  url: string
  headers: Record<string, string>
  /** parsed JSON, text, or null (HEAD, 204, binary) */
  body: unknown
  json: boolean
  truncated: boolean
  /** the connection's response size cap, in bytes */
  capBytes: number
  /** a non-text body's type: it was described, not downloaded */
  binary?: string
  notes: string[]
  /** Corvid masked a credential the server sent back */
  hidden: boolean
}

/** Headers the panel doesn't let the user set: Corvid adds the credential itself or they'd change where it goes. */
export const LOCKED_HEADERS = ['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length', 'transfer-encoding', 'connection', 'forwarded', 'x-forwarded-for', 'x-forwarded-host']

export const BODY_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']

/** A saved response note is capped so a big body can't fill the notes folder. */
export const NOTE_CAP = 100 * 1024
