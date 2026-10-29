// Custom models (#313, step 1 of the plan in N175): the user's own model entries in config.json's optional "models"
// list, and the "custom:<id>" value that picks one in workerModel, assistantModel and a task's model. This file only
// describes and checks them. Nothing here launches anything: with no entries, Corvid behaves exactly as before.

import { HARD_MAX_WORKERS } from './workerLimits'

/** How a session talks to the server. Only 'anthropic' for now: the server speaks Anthropic's /v1/messages itself. */
export type CustomModelKind = 'anthropic'
/** How Corvid authenticates to the server. Only 'none' for now; keys come later through Corvid's own proxy. */
export interface CustomModelAuth {
  kind: 'none'
}
export type CustomModelProfile = 'lean' | 'full'

/** One entry in config.json's "models" list, as the user made it in Settings (or by hand). */
export interface CustomModel {
  /** what the pickers store, as custom:<id>; lowercase letters, digits and dashes, 1-32 characters, unique */
  id: string
  /** what selectors, cards and notices show; 1-40 characters */
  label: string
  kind: CustomModelKind
  /** http(s) on this computer only (localhost, 127.0.0.1, ::1), with no user name or password in it */
  baseUrl: string
  /** what --model and ANTHROPIC_MODEL get */
  model: string
  /** the small/fast model; unset means `model` */
  smallModel?: string
  /** the server's context window, in tokens */
  contextTokens: number
  /** unset means DEFAULT_MAX_OUTPUT */
  maxOutputTokens?: number
  /** sessions on this model at once; unset means 1 */
  maxRunning?: number
  /** unset means lean below LEAN_BELOW tokens of context, else full */
  profile?: CustomModelProfile
  /** extra environment for the session: allow-listed names only, never anything key-like */
  env?: Record<string, string>
  /** unset means { kind: 'none' } */
  auth?: CustomModelAuth
}

/** The value a model setting or a task stores to pick a custom model. */
export type CustomModelRef = `custom:${string}`

/** Ids an entry can't take: Claude Code's own model choices and "default". */
export const RESERVED_MODEL_IDS = ['haiku', 'sonnet', 'opus', 'fable', 'default'] as const
export const CONTEXT_TOKENS = { min: 8192, max: 2_000_000 }
export const DEFAULT_MAX_OUTPUT = 4096
export const LEAN_BELOW = 100_000
/** More entries than this is a hand-edit gone wrong; the rest are dropped. */
export const MAX_CUSTOM_MODELS = 50
const LABEL_MAX = 40
const MODEL_NAME_MAX = 200
const URL_MAX = 300
const ENV_MAX = 20
const ENV_VALUE_MAX = 500

const ID = /^[a-z0-9-]{1,32}$/
const PREFIX = 'custom:'
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A well-formed id: the right characters and length, and not reserved. Whether an entry has it is another matter. */
export const isCustomModelId = (id: unknown): id is string =>
  typeof id === 'string' && ID.test(id) && !(RESERVED_MODEL_IDS as readonly string[]).includes(id)

/** A well-formed custom:<id>, whether or not its entry exists. Such a value is kept in the file even when the entry is gone. */
export const isCustomModelRef = (v: unknown): v is CustomModelRef =>
  typeof v === 'string' && v.startsWith(PREFIX) && isCustomModelId(v.slice(PREFIX.length))

export const customModelRef = (id: string): CustomModelRef => `${PREFIX}${id}`
/** "custom:qwen-local" -> "qwen-local"; undefined for anything that isn't a well-formed ref. */
export const customModelId = (v: unknown): string | undefined => (isCustomModelRef(v) ? v.slice(PREFIX.length) : undefined)

/** The entry a ref picks, or undefined when it isn't a ref or its entry is gone. */
export const findCustomModel = (models: readonly CustomModel[] | undefined, ref: unknown): CustomModel | undefined => {
  const id = customModelId(ref)
  return id === undefined ? undefined : models?.find((m) => m.id === id)
}

/** What to call a model a local transcript names (#317): the label of the entry it belongs to, else the name itself. */
export const localModelLabel = (models: readonly CustomModel[] | undefined, model: string): string =>
  models?.find((m) => m.model === model)?.label ?? models?.find((m) => m.smallModel === model)?.label ?? model

/** The worker profile an entry runs with (N175 section 5): its own choice, else lean below LEAN_BELOW tokens of context. */
export const customProfile = (m: Pick<CustomModel, 'profile' | 'contextTokens'>): CustomModelProfile =>
  m.profile ?? (m.contextTokens < LEAN_BELOW ? 'lean' : 'full')

/** Loopback hosts as URL.hostname gives them. LAN and public hosts are refused for now (N175, decision 2). */
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]']

/** Why a base URL can't be used, or null. */
export function baseUrlProblem(u: unknown): string | null {
  if (typeof u !== 'string' || !u.trim() || u.length > URL_MAX || CONTROL.test(u)) return "its base URL isn't a URL"
  let url: URL
  try {
    url = new URL(u.trim())
  } catch {
    return "its base URL isn't a URL"
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return "its base URL isn't http or https"
  if (url.username || url.password) return 'its base URL has a user name or password in it'
  if (!LOOPBACK.includes(url.hostname.toLowerCase())) return 'its base URL is not on this computer (only localhost, 127.0.0.1 and ::1 are allowed)'
  if (url.search || url.hash) return 'its base URL has a query or a # part'
  return null
}

/** Names Corvid sets itself for a custom-model session (N175 section 3); an entry's env can't override them. */
const CORVID_ENV = new Set([
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
  'CLAUDE_CODE_SUBAGENT_MODEL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'DISABLE_AUTOUPDATER'
])
// N175 also lists MAX_THINKING_TOKENS, but it contains TOKEN and the key-like rule has no exceptions (#313)
const ENV_EXACT = new Set(['API_TIMEOUT_MS', 'BASH_DEFAULT_TIMEOUT_MS', 'BASH_MAX_TIMEOUT_MS'])
const KEY_LIKE = /KEY|TOKEN|SECRET|PASS|AUTH|CREDENTIAL/i

/** Why an env name can't go on an entry, or null: it must be on the allow list and never look like it holds a secret. */
export function envNameProblem(name: string): string | null {
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) return `the env name ${JSON.stringify(name).slice(0, 60)} isn't an upper-case variable name`
  if (KEY_LIKE.test(name)) return `the env name ${name} looks like it holds a secret, and keys never go on a model entry`
  if (CORVID_ENV.has(name)) return `the env name ${name} is one Corvid sets itself`
  if (ENV_EXACT.has(name) || name.startsWith('CLAUDE_CODE_') || name.startsWith('DISABLE_')) return null
  return `the env name ${name} isn't on the allow list (API_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, CLAUDE_CODE_*, DISABLE_*)`
}

const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max && !CONTROL.test(v)
const whole = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max

/**
 * Why an entry can't be used, or null. `taken` holds the ids of the good entries before it, so the second of two
 * entries with one id is the one refused.
 */
export function customModelProblem(e: unknown, taken: ReadonlySet<string> = new Set()): string | null {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return "it isn't an entry"
  const m = e as Record<string, unknown>
  if (typeof m.id === 'string' && (RESERVED_MODEL_IDS as readonly string[]).includes(m.id)) return `the id "${m.id}" is reserved`
  if (!isCustomModelId(m.id)) return 'its id must be 1-32 lowercase letters, digits or dashes'
  if (taken.has(m.id)) return `another entry already has the id "${m.id}"`
  if (!text(m.label, LABEL_MAX)) return `its label must be 1-${LABEL_MAX} characters`
  if (m.kind !== 'anthropic') return `its kind ${JSON.stringify(m.kind)?.slice(0, 40)} isn't one Corvid knows (only "anthropic")`
  const url = baseUrlProblem(m.baseUrl)
  if (url) return url
  if (!text(m.model, MODEL_NAME_MAX)) return 'its model name is missing or too long'
  if (m.smallModel !== undefined && !text(m.smallModel, MODEL_NAME_MAX)) return 'its small model name is empty or too long'
  if (!whole(m.contextTokens, CONTEXT_TOKENS.min, CONTEXT_TOKENS.max))
    return `its context ${JSON.stringify(m.contextTokens)?.slice(0, 40)} isn't a whole number from ${CONTEXT_TOKENS.min} to ${CONTEXT_TOKENS.max.toLocaleString('en-US')}`
  if (m.maxOutputTokens !== undefined && !whole(m.maxOutputTokens, 1, m.contextTokens)) return 'its max output tokens must be a whole number no bigger than its context'
  if (m.maxRunning !== undefined && !whole(m.maxRunning, 1, HARD_MAX_WORKERS)) return `its sessions at once must be a whole number from 1 to ${HARD_MAX_WORKERS}`
  if (m.profile !== undefined && m.profile !== 'lean' && m.profile !== 'full') return 'its profile must be "lean" or "full"'
  if (m.auth !== undefined) {
    const kind = m.auth && typeof m.auth === 'object' ? (m.auth as { kind?: unknown }).kind : undefined
    if (kind !== 'none') return `its auth kind ${JSON.stringify(kind)?.slice(0, 40) ?? 'unset'} isn't allowed (only "none")`
  }
  if (m.env !== undefined) {
    if (!m.env || typeof m.env !== 'object' || Array.isArray(m.env)) return 'its env must be a list of names and values'
    const entries = Object.entries(m.env)
    if (entries.length > ENV_MAX) return `its env has more than ${ENV_MAX} names`
    for (const [k, v] of entries) {
      const why = envNameProblem(k)
      if (why) return why
      if (typeof v !== 'string' || v.length > ENV_VALUE_MAX || CONTROL.test(v)) return `the env value of ${k} must be plain text up to ${ENV_VALUE_MAX} characters`
    }
  }
  return null
}

/** A short name for an entry in a notice: its label and id when they're usable, else its place in the list. */
const entryName = (e: unknown, i: number): string => {
  const m = (e && typeof e === 'object' ? e : {}) as Record<string, unknown>
  const id = typeof m.id === 'string' && m.id ? ` ("${m.id.slice(0, 32)}")` : ''
  return typeof m.label === 'string' && m.label.trim() ? `${JSON.stringify(m.label.slice(0, LABEL_MAX))}${id}` : `number ${i + 1}${id}`
}

/**
 * config.json's "models" as loaded: the good entries, unchanged and in order, and one sentence for each one dropped.
 * Absent stays absent (undefined), so an older config.json loads and saves exactly as before.
 */
export function cleanCustomModels(raw: unknown): { models: CustomModel[] | undefined; dropped: string[] } {
  if (raw === undefined) return { models: undefined, dropped: [] }
  if (!Array.isArray(raw)) return { models: [], dropped: ["the custom models list wasn't a list, so it's now empty"] }
  const models: CustomModel[] = []
  const dropped: string[] = []
  const taken = new Set<string>()
  raw.forEach((e, i) => {
    if (models.length >= MAX_CUSTOM_MODELS) return void dropped.push(`custom model ${entryName(e, i)} was dropped: there can be at most ${MAX_CUSTOM_MODELS}`)
    const why = customModelProblem(e, taken)
    if (why) return void dropped.push(`custom model ${entryName(e, i)} was dropped: ${why}`)
    models.push(e as CustomModel)
    taken.add((e as CustomModel).id)
  })
  return { models, dropped }
}

// ---------- Corvid itself on a custom model (#320, step 8 of the plan in N175, decision 6) ----------

/** The least context an entry needs before Corvid itself may run on it: its prompt and tool list alone are 15k-20k. */
export const ASSISTANT_MIN_CONTEXT = 64_000

/** Why Corvid itself can't run on `ref` (a custom:<id>), or null when it can, experimentally. */
export function assistantModelProblem(models: readonly CustomModel[] | undefined, ref: string): string | null {
  const m = findCustomModel(models, ref)
  if (!m) return `There's no model "${customModelId(ref) ?? ref}" in Settings → Models.`
  if (m.contextTokens < ASSISTANT_MIN_CONTEXT)
    return `${m.label} has a context of ${m.contextTokens.toLocaleString('en-US')} tokens; Corvid itself needs one of ${ASSISTANT_MIN_CONTEXT.toLocaleString('en-US')} or more. Workers can still use it.`
  return null
}

/**
 * The mode that applies: always "ask" while Corvid's model is a custom one, whatever the saved mode says, so
 * start_worker only proposes and the user approves in Corvid's own UI. The saved mode isn't changed and comes back
 * when Corvid is on a Claude model again.
 */
export const effectiveAssistantMode = <M extends string>(c: { assistantMode: M; assistantModel: string }): M | 'ask' =>
  isCustomModelRef(c.assistantModel) ? 'ask' : c.assistantMode
