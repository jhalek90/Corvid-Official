// Is a custom model's server there, and does it run with the context its entry says (#315, step 3 of the plan in N175,
// section 6)? Asked from Corvid's main process before every start on a custom model, never from a session, and the
// same check is Settings → Models' Test button. It only reads: GET <baseUrl>/v1/models, and /props when the model list
// doesn't say the context. Corvid never starts, stops or restarts the server.

import type { CustomModel } from '@shared/customModels'

/** How long the server gets to answer /v1/models before it counts as not answering. */
export const HEALTH_TIMEOUT_MS = 3000
/** /props is only a second place to find the context; a server without it isn't a problem. */
const PROPS_TIMEOUT_MS = 1500
/** A model list longer than this isn't read for the context. */
const BODY_MAX = 1_000_000

export type HealthResult =
  | { ok: true; message: string; /** the context the server reported, when it said */ serverContext?: number }
  | { ok: false; reason: 'down' | 'context'; message: string; serverContext?: number }

/** "<baseUrl>/<path>", whatever the entry's base URL ends with. */
const at = (m: CustomModel, path: string): string => `${m.baseUrl.trim().replace(/\/+$/, '')}${path}`

/** The body of a GET as JSON, or null when it isn't a 2xx JSON answer. Throws when nothing answers in time. Redirects
 *  aren't followed, so the check never leaves the entry's own (loopback) host. */
async function getJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', headers: { accept: 'application/json' } })
  const text = await res.text()
  if (!res.ok || text.length > BODY_MAX) return { status: res.status, body: null }
  try {
    return { status: res.status, body: JSON.parse(text) }
  } catch {
    return { status: res.status, body: null }
  }
}

const tokens = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined)
const obj = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined)

/**
 * The context a /v1/models answer reports, if any: n_ctx on the entry's own model (or the only one), or in its meta.
 * n_ctx_train is the model's training length, not what the server runs with, so it's never used.
 */
export function contextFromModels(body: unknown, model: string): number | undefined {
  const list = [obj(body)?.data, obj(body)?.models].find(Array.isArray) as unknown[] | undefined
  if (!list?.length) return undefined
  const mine = list.find((x) => obj(x)?.id === model || obj(x)?.model === model || obj(x)?.name === model) ?? (list.length === 1 ? list[0] : undefined)
  const m = obj(mine)
  return m && (tokens(m.n_ctx) ?? tokens(obj(m.meta)?.n_ctx))
}

/** The context llama-server's /props reports: the per-slot n_ctx of its default generation settings, or a top-level one. */
export function contextFromProps(body: unknown): number | undefined {
  const b = obj(body)
  return b && (tokens(obj(b.default_generation_settings)?.n_ctx) ?? tokens(b.n_ctx))
}

/**
 * Ask the entry's server whether it's up and what context it runs with. Down (no answer within the timeout, refused,
 * reset) and a reported context smaller than the entry's contextTokens are failures; an answer that doesn't say its
 * context passes, since Claude Code's own errors still show at run time.
 */
export async function checkCustomModel(m: CustomModel, timeoutMs = HEALTH_TIMEOUT_MS): Promise<HealthResult> {
  let first: { status: number; body: unknown }
  const t0 = Date.now()
  try {
    first = await getJson(at(m, '/v1/models'), timeoutMs)
  } catch (e) {
    // a kept-alive connection to a server that has restarted since fails at once: one fresh try in the time left
    const left = timeoutMs - (Date.now() - t0)
    try {
      if ((e as Error)?.name === 'TimeoutError' || left <= 0) throw e
      first = await getJson(at(m, '/v1/models'), left)
    } catch {
      return { ok: false, reason: 'down', message: `${m.label} isn't answering at ${m.baseUrl}.` }
    }
  }
  let ctx = contextFromModels(first.body, m.model)
  if (ctx === undefined) {
    try {
      ctx = contextFromProps((await getJson(at(m, '/props'), Math.min(timeoutMs, PROPS_TIMEOUT_MS))).body)
    } catch {
      // no /props, or too slow: the context stays unknown
    }
  }
  if (ctx !== undefined && ctx < m.contextTokens)
    return {
      ok: false,
      reason: 'context',
      serverContext: ctx,
      message: `${m.label}'s server at ${m.baseUrl} runs with a context of ${ctx.toLocaleString('en-US')} tokens, but its entry says ${m.contextTokens.toLocaleString('en-US')}.`
    }
  const said = ctx !== undefined ? ` with a context of ${ctx.toLocaleString('en-US')} tokens` : first.body ? '' : ` (HTTP ${first.status}, no model list, so its context is unknown)`
  return { ok: true, message: `${m.label} is answering at ${m.baseUrl}${said}.`, ...(ctx !== undefined ? { serverContext: ctx } : {}) }
}

/** Why task #taskId can't start on `m` right now, in the words the refusal uses, or null when its server is fine. */
export async function healthRefusal(m: CustomModel, taskId: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<string | null> {
  const h = await checkCustomModel(m, timeoutMs)
  if (h.ok) return null
  return h.reason === 'down'
    ? `${h.message} Start its server, then start #${taskId} again.`
    : `${h.message} Start the server with a context of at least ${m.contextTokens.toLocaleString('en-US')} (-c), or lower the entry's context in Settings → Models, then start #${taskId} again.`
}
