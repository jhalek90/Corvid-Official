import { useState, type ReactNode } from 'react'
import type { AppConfig } from '@shared/types'
import {
  CONTEXT_TOKENS,
  customModelProblem,
  customModelRef,
  DEFAULT_MAX_OUTPUT,
  LEAN_BELOW,
  type CustomModel,
  type CustomModelProfile
} from '@shared/customModels'
import { HARD_MAX_WORKERS } from '@shared/workerLimits'
import { api } from '../api'
import { setUpModel, toast } from '../store'

// Settings → Models (#316, step 4 of the plan in N175): the user's own model entries, with add, edit, remove, Test (the
// pre-start check, #315) and Set up (one interactive Claude Code on the entry, so the user answers its first-run and
// trust questions themselves). This page is the only place entries are made or changed: no tool or message can.

/** The form's text fields; numbers stay text until saved, so a half-typed value doesn't jump. */
interface Draft {
  label: string
  id: string
  baseUrl: string
  model: string
  smallModel: string
  contextTokens: string
  maxOutputTokens: string
  maxRunning: string
  profile: '' | CustomModelProfile
  /** NAME=value, one per line */
  env: string
}

const BLANK: Draft = {
  label: '',
  id: '',
  baseUrl: 'http://localhost:8080',
  model: '',
  smallModel: '',
  contextTokens: '32768',
  maxOutputTokens: '',
  maxRunning: '1',
  profile: '',
  env: ''
}

const toDraft = (m: CustomModel): Draft => ({
  label: m.label,
  id: m.id,
  baseUrl: m.baseUrl,
  model: m.model,
  smallModel: m.smallModel ?? '',
  contextTokens: String(m.contextTokens),
  maxOutputTokens: m.maxOutputTokens === undefined ? '' : String(m.maxOutputTokens),
  maxRunning: m.maxRunning === undefined ? '1' : String(m.maxRunning),
  profile: m.profile ?? '',
  env: Object.entries(m.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
})

/** "Qwen 27B (local)" -> "qwen-27b-local", as a suggested id. */
const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/, '')

const num = (s: string): number => (s.trim() && /^\d+$/.test(s.trim()) ? Number(s.trim()) : NaN)

/** The entry a draft makes, or why it can't be one. `old` keeps fields the form doesn't show (auth). */
function fromDraft(d: Draft, old: CustomModel | undefined): { entry: CustomModel } | { error: string } {
  const env: Record<string, string> = {}
  for (const line of d.env.split(/\r?\n/)) {
    if (!line.trim()) continue
    const eq = line.indexOf('=')
    if (eq < 1) return { error: `"${line.trim().slice(0, 40)}" in Extra env isn't NAME=value.` }
    env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  const entry: CustomModel = {
    id: d.id.trim(),
    label: d.label.trim(),
    kind: 'anthropic',
    baseUrl: d.baseUrl.trim(),
    model: d.model.trim() || d.id.trim(),
    ...(d.smallModel.trim() ? { smallModel: d.smallModel.trim() } : {}),
    contextTokens: num(d.contextTokens),
    ...(d.maxOutputTokens.trim() ? { maxOutputTokens: num(d.maxOutputTokens) } : {}),
    ...(num(d.maxRunning) !== 1 ? { maxRunning: num(d.maxRunning) } : {}),
    ...(d.profile ? { profile: d.profile } : {}),
    ...(Object.keys(env).length ? { env } : {}),
    ...(old?.auth ? { auth: old.auth } : {})
  }
  return { entry }
}

/** "32k", "128k", "1M": a context size for the list. */
const ctx = (n: number): string => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(1)}M` : `${Math.round(n / 1024)}k`)

/** Where an entry is picked right now, for the list and the Remove confirmation. */
function usedBy(config: AppConfig, id: string, tasks: { id: number; model?: string }[]): string[] {
  const ref = customModelRef(id)
  return [
    ...(config.workerModel === ref ? ['the worker model'] : []),
    ...(config.assistantModel === ref ? ["Corvid's model"] : []),
    ...tasks.filter((t) => t.model === ref).map((t) => `#${t.id}`)
  ]
}

export function ModelsSettings({ config, tasks }: { config: AppConfig; tasks: { id: number; model?: string }[] }): ReactNode {
  const models = config.models ?? []
  // which entry the form edits: an id, 'new', or none
  const [editing, setEditing] = useState<string | null>(null)
  const [removing, setRemoving] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, { ok: boolean; message: string } | 'busy'>>({})

  const save = async (list: CustomModel[]): Promise<string | null> => {
    try {
      await api.setConfig({ models: list })
      return null
    } catch (e) {
      return String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
    }
  }
  const test = async (key: string, entry: CustomModel): Promise<void> => {
    setTests((t) => ({ ...t, [key]: 'busy' }))
    const r = await api.testModel(entry).catch((e: Error) => ({ ok: false, message: String(e.message ?? e) }))
    setTests((t) => ({ ...t, [key]: r }))
  }
  const setUp = async (m: CustomModel): Promise<void> => {
    const r = await setUpModel(m.id)
    if (!r) return
    toast(
      `Claude Code on ${m.label} is open in ${r.folder}. Answer its first-run questions and trust the folder, then close it.` +
        (r.left.length ? ` It doesn't cover ${r.left.join(', ')} (another drive).` : '')
    )
  }

  return (
    <div className="models-settings">
      {!models.length && editing !== 'new' && (
        <div className="setting">
          <div className="setting-label">
            <div className="d">
              No models of your own yet. Add one that runs on this computer (a llama-server, for example) to put workers on it. With none, Corvid works exactly
              as it always has.
            </div>
          </div>
        </div>
      )}
      {models.map((m) =>
        editing === m.id ? (
          <ModelForm
            key={m.id}
            old={m}
            taken={models.filter((x) => x.id !== m.id).map((x) => x.id)}
            onCancel={() => setEditing(null)}
            onSave={async (e) => {
              const err = await save(models.map((x) => (x.id === m.id ? e : x)))
              if (!err) setEditing(null)
              return err
            }}
            onTest={(e) => test(`form:${m.id}`, e)}
            testResult={tests[`form:${m.id}`]}
          />
        ) : (
          <div key={m.id} className="setting setting-wrap model-row">
            <div className="setting-label">
              <div className="setting-name">
                <span>{m.label}</span>
                <span className="chip mono">custom:{m.id}</span>
              </div>
              <div className="d mono">
                {m.baseUrl} · {m.model} · {ctx(m.contextTokens)} context · {m.maxRunning ?? 1} at once · {m.profile ?? (m.contextTokens < LEAN_BELOW ? 'lean' : 'full')}
              </div>
              {usedBy(config, m.id, tasks).length > 0 && <div className="d">Used by {usedBy(config, m.id, tasks).join(', ')}</div>}
            </div>
            <div className="model-actions">
              <button className="btn sm" disabled={tests[m.id] === 'busy'} title="Ask its server whether it answers, and with what context (GET /v1/models)" onClick={() => void test(m.id, m)}>
                {tests[m.id] === 'busy' ? 'Testing…' : 'Test'}
              </button>
              <button
                className="btn sm"
                title="Open one Claude Code terminal on this model in the folder above your projects, so you can answer its first-run questions and trust the folder once. Corvid types nothing into it."
                onClick={() => void setUp(m)}
              >
                Set up
              </button>
              <button className="btn sm" onClick={() => setEditing(m.id)}>
                Edit
              </button>
              <button className="btn sm ghost" onClick={() => setRemoving(m.id)}>
                Remove
              </button>
            </div>
            <TestLine r={tests[m.id]} />
            {removing === m.id && (
              <div className="setting-confirm" role="alertdialog" aria-label={`Remove ${m.label}?`}>
                <span>
                  Remove {m.label}?
                  {usedBy(config, m.id, tasks).length
                    ? ` ${usedBy(config, m.id, tasks).join(', ')} keep${usedBy(config, m.id, tasks).length === 1 ? 's' : ''} it, and won't start until you add it back or pick another model.`
                    : ''}
                </span>
                <button className="btn sm" autoFocus onClick={() => setRemoving(null)}>
                  Cancel
                </button>
                <button
                  className="btn sm danger"
                  onClick={async () => {
                    const err = await save(models.filter((x) => x.id !== m.id))
                    setRemoving(null)
                    if (err) toast(err, 'error')
                  }}
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        )
      )}
      {editing === 'new' ? (
        <ModelForm
          taken={models.map((x) => x.id)}
          onCancel={() => setEditing(null)}
          onSave={async (e) => {
            const err = await save([...models, e])
            if (!err) setEditing(null)
            return err
          }}
          onTest={(e) => test('form:new', e)}
          testResult={tests['form:new']}
        />
      ) : (
        <div className="setting">
          <div className="setting-label">
            <div className="d">Only this page adds or changes your models; no agent, tool or message can.</div>
          </div>
          <button className="btn sm" disabled={editing !== null} onClick={() => setEditing('new')}>
            Add model
          </button>
        </div>
      )}
    </div>
  )
}

function TestLine({ r }: { r: { ok: boolean; message: string } | 'busy' | undefined }): ReactNode {
  if (!r || r === 'busy') return null
  return (
    <div className={`claude-path-result ${r.ok ? 'ok' : 'bad'}`} role="status">
      {r.message}
    </div>
  )
}

function ModelForm({
  old,
  taken,
  onCancel,
  onSave,
  onTest,
  testResult
}: {
  old?: CustomModel
  taken: string[]
  onCancel: () => void
  onSave: (e: CustomModel) => Promise<string | null>
  onTest: (e: CustomModel) => Promise<void>
  testResult?: { ok: boolean; message: string } | 'busy'
}): ReactNode {
  const [d, setD] = useState<Draft>(old ? toDraft(old) : BLANK)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // a new entry's id follows its label until the user types one
  const [idTouched, setIdTouched] = useState(!!old)
  const set = (patch: Partial<Draft>): void => {
    setError(null)
    setD((x) => ({ ...x, ...patch }))
  }
  const built = fromDraft(d, old)
  const problem = 'error' in built ? built.error : customModelProblem(built.entry, new Set(taken))
  const entry = 'entry' in built ? built.entry : undefined

  const field = (label: string, key: keyof Draft, opts: { tip?: string; placeholder?: string; mono?: boolean; disabled?: boolean } = {}): ReactNode => (
    <label className="model-field" title={opts.tip}>
      <span>{label}</span>
      <input
        className={`text${opts.mono ? ' mono' : ''}`}
        spellCheck={false}
        value={d[key]}
        placeholder={opts.placeholder}
        disabled={opts.disabled}
        onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)}
      />
    </label>
  )

  return (
    <div className="setting setting-wrap model-form">
      <div className="model-fields">
        <label className="model-field">
          <span>Label</span>
          <input
            className="text"
            autoFocus
            value={d.label}
            placeholder="Qwen 27B (local)"
            onChange={(e) => set({ label: e.target.value, ...(idTouched ? {} : { id: slug(e.target.value) }) })}
          />
        </label>
        <label className="model-field" title={old ? "An entry's id can't change: tasks and settings refer to it. Remove it and add a new one instead." : 'What tasks and settings store, as custom:<id>: lowercase letters, digits and dashes.'}>
          <span>Id</span>
          <input
            className="text mono"
            spellCheck={false}
            value={d.id}
            disabled={!!old}
            onChange={(e) => {
              setIdTouched(true)
              set({ id: e.target.value })
            }}
          />
        </label>
        {field('Base URL', 'baseUrl', { mono: true, tip: 'Its server on this computer: http(s) on localhost, 127.0.0.1 or ::1. Other machines are refused for now.' })}
        {field('Model name', 'model', { mono: true, placeholder: d.id || 'the id', tip: 'What Claude Code sends as --model. Empty means the id. llama-server answers any name.' })}
        {field('Small model', 'smallModel', { mono: true, placeholder: 'same as the model', tip: "Claude Code's small, fast model for quick jobs. Empty means the same model." })}
        {field('Context (tokens)', 'contextTokens', {
          mono: true,
          tip: `The server's context window, as you started it (-c). ${CONTEXT_TOKENS.min.toLocaleString('en-US')} to ${CONTEXT_TOKENS.max.toLocaleString('en-US')}. Test checks it against the server.`
        })}
        {field('Max output tokens', 'maxOutputTokens', { mono: true, placeholder: String(DEFAULT_MAX_OUTPUT), tip: `Empty means ${DEFAULT_MAX_OUTPUT}.` })}
        {field('Sessions at once', 'maxRunning', {
          mono: true,
          tip: `How many sessions can run on it at the same time (1 to ${HARD_MAX_WORKERS}). One GPU usually means 1. They still count toward Workers at once.`
        })}
        <label className="model-field" title="Lean drops Corvid's extras (never a safety rule) so a small context has room to work. Automatic is lean below 100k context.">
          <span>Profile</span>
          <select className="select" value={d.profile} onChange={(e) => set({ profile: e.target.value as Draft['profile'] })}>
            <option value="">Automatic ({num(d.contextTokens) < LEAN_BELOW ? 'lean' : 'full'})</option>
            <option value="lean">Lean</option>
            <option value="full">Full</option>
          </select>
        </label>
        <label
          className="model-field wide"
          title="Extra environment for its sessions, NAME=value per line. Only API_TIMEOUT_MS, BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS, CLAUDE_CODE_* and DISABLE_*, and never a key or token."
        >
          <span>Extra env</span>
          <textarea className="text mono" rows={2} spellCheck={false} value={d.env} placeholder="API_TIMEOUT_MS=600000" onChange={(e) => set({ env: e.target.value })} />
        </label>
      </div>
      <div className="model-form-foot">
        <span className={error || problem ? 'warn-text' : 'muted'}>{error ?? (problem ? `Can't save yet: ${problem}.` : 'Workers on it ignore Worker effort and always ask before edits.')}</span>
        <button className="btn sm" disabled={!!problem || testResult === 'busy'} onClick={() => entry && void onTest(entry)}>
          {testResult === 'busy' ? 'Testing…' : 'Test'}
        </button>
        <button className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          className="btn sm primary"
          disabled={!!problem || busy}
          onClick={async () => {
            if (!entry) return
            setBusy(true)
            setError(await onSave(entry))
            setBusy(false)
          }}
        >
          Save
        </button>
      </div>
      <TestLine r={testResult} />
    </div>
  )
}
