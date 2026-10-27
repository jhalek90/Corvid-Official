import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Copy, NotebookPen, Plus, Send, ShieldAlert, TriangleAlert, X } from 'lucide-react'
import type { ConnectionView } from '@shared/types'
import { BODY_METHODS, LOCKED_HEADERS, type RequestClass, type UserRequest, type UserRequestPlan, type UserResponse } from '@shared/sendRequest'
import { api } from '../api'
import { toast } from '../store'
import '../sendRequest.css'

// "Send a request" (#105): the user tries an HTTP connection and reads the full response. Main sends it through the
// same runtime agents use and returns the scrubbed response to this panel only. Nothing here goes to an agent or the
// board; the response lives in this component's state and is gone when the panel closes.

const METHODS = { Reads: ['GET', 'HEAD', 'OPTIONS'], Changes: ['POST', 'PUT', 'PATCH', 'DELETE'] }
const SECRET_NAME = /(key|token|secret|pass|pwd|sig|signature|auth|code|session|credential|jwt)/i
const HISTORY = 8
const FIRST_CHARS = 64 * 1024
const MORE_CHARS = 256 * 1024
const MAX_HITS = 500

/** The last few requests per connection, for this session only (memory, never disk). */
const history = new Map<string, UserRequest[]>()

function remember(id: string, r: UserRequest): void {
  // a query value whose name looks secret isn't kept: the user retypes it
  const kept: UserRequest = { ...r, query: r.query.map(([k, v]) => [k, SECRET_NAME.test(k) ? '' : v]) }
  const key = JSON.stringify(kept)
  const list = (history.get(id) ?? []).filter((x) => JSON.stringify(x) !== key)
  history.set(id, [kept, ...list].slice(0, HISTORY))
}

const blank = (path = '/'): UserRequest => ({ method: 'GET', path, query: [], headers: [], body: '', bodyKind: 'json' })
const label = (r: UserRequest): string => `${r.method} ${r.path}${r.query.length ? `?${r.query.map(([k]) => k).join('&')}` : ''}`

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

type Confirming = { plan: UserRequestPlan; req: UserRequest; step: 1 | 2 }

export function SendRequestPanel({ c, close, approve }: { c: ConnectionView; close: () => void; approve?: () => void }): ReactNode {
  const base = String(c.config.base_url ?? '')
  const testPath = String(c.config.test_path || '/')
  const [req, setReq] = useState<UserRequest>(() => history.get(c.id)?.[0] ?? blank(testPath))
  const [busy, setBusy] = useState<string>()
  const [confirming, setConfirming] = useState<Confirming>()
  const [result, setResult] = useState<{ r: UserResponse; req: UserRequest } | { error: string; approve?: boolean }>()
  const live = useRef(true)
  const running = useRef<string | undefined>(undefined)
  const set = (p: Partial<UserRequest>): void => setReq((r) => ({ ...r, ...p }))
  const takesBody = BODY_METHODS.includes(req.method)

  // closing the panel stops a request still running and drops the response with the component
  useEffect(
    () => () => {
      live.current = false
      if (running.current) void api.connectionsCancelRequest(running.current)
    },
    []
  )

  const outgoing = (): UserRequest => ({ ...req, path: req.path.trim() || '/', body: takesBody ? req.body : undefined })

  const start = async (): Promise<void> => {
    const r = outgoing()
    const plan = await api.connectionsPlanRequest(c.id, r)
    if (!live.current) return
    if (!plan.ok) return setResult({ error: plan.error, approve: plan.approve })
    if (plan.cls === 'read') return send(r, null)
    setConfirming({ plan, req: r, step: 1 })
  }

  const send = async (r: UserRequest, confirmed: RequestClass | null): Promise<void> => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    running.current = id
    setBusy(id)
    setResult(undefined)
    try {
      const out = await api.connectionsSendRequest(c.id, id, r, confirmed)
      if (!live.current) return
      remember(c.id, r)
      setResult(out.ok ? { r: out, req: r } : { error: out.error, approve: out.approve })
    } finally {
      running.current = undefined
      if (live.current) setBusy(undefined)
    }
  }

  const presets = [{ name: `Test path (GET ${testPath})`, req: blank(testPath) }, ...(history.get(c.id) ?? []).map((h) => ({ name: label(h), req: h }))]

  return (
    <div className="overlay" onMouseDown={close}>
      <div className="dialog sr-panel" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && !confirming && close()}>
        <h3>
          <Send size={16} /> Send a request <span className="mono sr-conn">{c.name}</span>
          <span style={{ flex: 1 }} />
          <button className="btn sm ghost" onClick={close} aria-label="Close">
            <X size={14} />
          </button>
        </h3>
        <p className="conn-small">
          Only you see the response. It stays in this panel, isn't given to any agent or posted anywhere, and is gone when you close it. Corvid adds the
          credential itself and checks the request as it does for agents.
        </p>

        <div className="sr-row">
          <select className="select" value="" onChange={(e) => e.target.value && setReq(presets[Number(e.target.value)].req)} aria-label="Presets and recent requests">
            <option value="">Presets and recent…</option>
            {presets.map((p, i) => (
              <option key={i} value={i}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="sr-row sr-line">
          <select className="select sr-method" value={req.method} onChange={(e) => set({ method: e.target.value })} aria-label="Method">
            {Object.entries(METHODS).map(([g, list]) => (
              <optgroup key={g} label={g}>
                {list.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <span className="mono sr-base" title="The connection's base URL; requests always go here">
            {base}
          </span>
          <input
            className="rinput mono sr-path"
            spellCheck={false}
            value={req.path}
            placeholder="/posts"
            onChange={(e) => set({ path: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && !busy && void start()}
            aria-label="Path"
          />
        </div>

        <Pairs title="Query parameters" rows={req.query} onChange={(query) => set({ query })} />
        <Pairs
          title="Headers"
          rows={req.headers}
          onChange={(headers) => set({ headers })}
          locked={(k) => LOCKED_HEADERS.includes(k.trim().toLowerCase())}
          hint="Authorization, Cookie, Host and similar can't be set here: Corvid adds the credential itself."
        />
        {takesBody && (
          <div className="sr-body-edit">
            <div className="sr-row">
              <span className="section-label">Body</span>
              <div className="seg">
                {(['json', 'text'] as const).map((k) => (
                  <button key={k} className={req.bodyKind === k ? 'on' : ''} onClick={() => set({ bodyKind: k })}>
                    {k === 'json' ? 'JSON' : 'Text'}
                  </button>
                ))}
              </div>
            </div>
            <textarea
              className="rinput mono"
              rows={6}
              spellCheck={false}
              value={req.body ?? ''}
              placeholder={req.bodyKind === 'json' ? '{ "title": "hello" }' : 'plain text'}
              onChange={(e) => set({ body: e.target.value })}
            />
          </div>
        )}

        <div className="actions sr-actions">
          {busy ? (
            <>
              <span className="muted conn-small">Waiting for the server…</span>
              <button className="btn danger" onClick={() => void api.connectionsCancelRequest(busy)}>
                Cancel
              </button>
            </>
          ) : (
            <button className="btn primary" onClick={() => void start()}>
              <Send size={13} /> Send
            </button>
          )}
        </div>

        {result && 'error' in result && (
          <div className="sr-error">
            <TriangleAlert size={14} /> <span>{result.error}</span>
            {result.approve && approve && (
              <button className="btn sm" onClick={approve}>
                Review and approve
              </button>
            )}
          </div>
        )}
        {result && 'r' in result && <ResponseView key={`${result.r.durationMs}-${result.req.path}`} r={result.r} req={result.req} connName={c.name} />}
      </div>

      {confirming && (
        <ConfirmSend
          c={confirming}
          onNo={() => setConfirming(undefined)}
          onYes={() => {
            if (confirming.plan.cls === 'admin' && confirming.step === 1) return setConfirming({ ...confirming, step: 2 })
            setConfirming(undefined)
            void send(confirming.req, confirming.plan.cls)
          }}
        />
      )}
    </div>
  )
}

function Pairs({ title, rows, onChange, locked, hint }: { title: string; rows: [string, string][]; onChange: (r: [string, string][]) => void; locked?: (k: string) => boolean; hint?: string }): ReactNode {
  const edit = (i: number, j: 0 | 1, v: string): void => onChange(rows.map((r, n) => (n === i ? ((j === 0 ? [v, r[1]] : [r[0], v]) as [string, string]) : r)))
  return (
    <div className="sr-pairs">
      <div className="sr-row">
        <span className="section-label">{title}</span>
        <button className="btn sm ghost" onClick={() => onChange([...rows, ['', '']])}>
          <Plus size={12} /> Add
        </button>
        {hint && <span className="muted conn-small">{hint}</span>}
      </div>
      {rows.map(([k, v], i) => {
        const bad = locked?.(k)
        return (
          <div key={i} className="sr-row sr-pair">
            <input className="rinput mono" spellCheck={false} placeholder="name" value={k} onChange={(e) => edit(i, 0, e.target.value)} />
            <input className="rinput mono" spellCheck={false} placeholder="value" value={bad ? '' : v} disabled={bad} onChange={(e) => edit(i, 1, e.target.value)} />
            <button className="btn sm ghost" onClick={() => onChange(rows.filter((_, n) => n !== i))} aria-label="Remove">
              <X size={12} />
            </button>
            {bad && <span className="conn-small bad">Corvid sets {k.trim()} itself; it won't be sent.</span>}
          </div>
        )
      })}
    </div>
  )
}

function ConfirmSend({ c, onYes, onNo }: { c: Confirming; onYes: () => void; onNo: () => void }): ReactNode {
  const { plan, req, step } = c
  const admin = plan.cls === 'admin'
  const withBody = req.body !== undefined && req.body.trim() !== ''
  return (
    <div className="overlay" style={{ zIndex: 160 }} onMouseDown={onNo}>
      <div className="dialog sr-confirm" onMouseDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && onNo()}>
        <h3>
          <ShieldAlert size={17} color={admin ? 'var(--danger)' : 'var(--warn)'} />
          {step === 2 ? 'Really send to an administrative path?' : `Send this ${req.method}?`}
        </h3>
        {step === 1 ? (
          <p>
            This will send a {req.method} to <span className="mono">{req.path}</span>
            {withBody ? ' with this body' : ''}. It can change data on the server. Send?
          </p>
        ) : (
          <p className="remote-warn">
            {plan.why} Administrative paths can change accounts, billing, permissions or settings, and a mistake there may not be undoable. Send it only if
            you mean to.
          </p>
        )}
        {admin && step === 1 && <p className="remote-warn">{plan.why}</p>}
        <pre className="mono sr-shown">{plan.shown}</pre>
        {[...plan.warnings, ...plan.notes].map((w) => (
          <div key={w} className="conn-small muted">
            {w}
          </div>
        ))}
        <div className="actions">
          <div style={{ flex: 1 }} />
          <button className="btn" autoFocus onClick={onNo}>
            Don't send
          </button>
          <button className={`btn ${admin ? 'danger' : 'primary'}`} onClick={onYes}>
            {admin && step === 1 ? 'Continue' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ---------- the response ----------

function ResponseView({ r, req, connName }: { r: UserResponse; req: UserRequest; connName: string }): ReactNode {
  const [view, setView] = useState<'formatted' | 'raw'>(r.json ? 'formatted' : 'raw')
  const [q, setQ] = useState('')
  const [limit, setLimit] = useState(FIRST_CHARS)
  const pretty = useMemo(() => (r.body === null ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body, null, 2)), [r.body])
  const raw = useMemo(() => (r.body === null ? '' : typeof r.body === 'string' ? r.body : JSON.stringify(r.body)), [r.body])
  const text = view === 'formatted' ? pretty : raw
  const ok = r.status >= 200 && r.status < 300
  const contentLength = r.headers['content-length']

  const saveNote = (): void => {
    const name = `${req.method} ${req.path} on ${connName}, ${new Date().toLocaleString()}`
    const head = [
      `Response saved from Corvid's Connections tab (Send a request, task #105).`,
      `Connection: ${connName}`,
      `Request: ${req.method} ${r.url}`,
      `Status: ${r.status} ${r.reason} · ${r.durationMs} ms · ${fmtBytes(r.size)}${r.truncated ? ` (cut at ${fmtBytes(r.capBytes)})` : ''}`,
      ...Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`),
      ''
    ].join('\n')
    void api.connectionsSaveResponseNote(name, `${head}\n${pretty || '(no body)'}\n`).then((x) => (x.id ? toast(`Saved the response as note ${x.id}`) : toast(x.error ?? 'Not saved', 'error')))
  }

  return (
    <div className="sr-response">
      <div className="sr-status">
        <span className={`sr-code ${ok ? 'ok' : r.status >= 400 ? 'bad' : ''}`}>
          {r.status} {r.reason}
        </span>
        <span className="muted">{r.durationMs} ms</span>
        <span className="muted">{fmtBytes(r.size)}</span>
        <span className="mono muted sr-url">{r.url}</span>
      </div>
      {r.hidden && <div className="conn-small sr-hidden">Corvid hid a credential the server sent back; it shows as [redacted].</div>}
      {r.truncated && (
        <div className="conn-small sr-warn">
          The body was cut at {fmtBytes(r.capBytes)}, this connection's response size cap{contentLength ? ` (the server said ${fmtBytes(Number(contentLength))})` : ''}. The rest was not downloaded.
        </div>
      )}
      {r.notes
        .filter((n) => !r.truncated || !/cut off/.test(n))
        .map((n) => (
          <div key={n} className="conn-small muted">
            {n}
          </div>
        ))}
      {Object.keys(r.headers).length > 0 && (
        <details className="sr-headers">
          <summary className="conn-small">Response headers ({Object.keys(r.headers).length})</summary>
          <div className="conn-facts">
            {Object.entries(r.headers).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span className="k mono">{k}</span>
                <span className="v mono">{v}</span>
              </div>
            ))}
          </div>
        </details>
      )}

      {r.binary ? (
        <div className="sr-binary">
          The server sent {r.binary}
          {contentLength ? `, ${fmtBytes(Number(contentLength))}` : ''}. Corvid doesn't download bodies that aren't text or JSON, so there is nothing to show.
        </div>
      ) : r.body === null || text === '' ? (
        <div className="muted conn-small">{req.method === 'HEAD' ? 'HEAD responses have no body.' : 'No body.'}</div>
      ) : (
        <>
          <div className="sr-row sr-tools">
            <div className="seg">
              <button className={view === 'formatted' ? 'on' : ''} disabled={!r.json} title={r.json ? '' : 'Only JSON has a formatted view'} onClick={() => setView('formatted')}>
                Formatted
              </button>
              <button className={view === 'raw' ? 'on' : ''} onClick={() => setView('raw')}>
                Raw
              </button>
            </div>
            <input className="rinput sr-search" placeholder="Search the body" value={q} onChange={(e) => setQ(e.target.value)} spellCheck={false} />
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => void navigator.clipboard.writeText(text).then(() => toast('Copied the body'))}>
              <Copy size={12} /> Copy
            </button>
            <button className="btn sm" onClick={saveNote}>
              <NotebookPen size={12} /> Save to a note
            </button>
          </div>
          {q.trim() ? (
            <SearchHits text={pretty} q={q.trim()} />
          ) : view === 'formatted' && r.json ? (
            <div className="sr-tree mono">
              <JsonNode v={r.body} depth={0} />
            </div>
          ) : (
            <>
              <pre className="mono sr-text">{text.slice(0, limit)}</pre>
              {text.length > limit && (
                <button className="btn sm ghost" onClick={() => setLimit((l) => l + MORE_CHARS)}>
                  Show more ({fmtBytes(text.length - limit)} left)
                </button>
              )}
            </>
          )}
        </>
      )}
    </div>
  )
}

/** Matching lines of the formatted body, capped so a common word can't flood the window. */
function SearchHits({ text, q }: { text: string; q: string }): ReactNode {
  const hits = useMemo(() => {
    const needle = q.toLowerCase()
    const out: { n: number; line: string }[] = []
    let total = 0
    text.split('\n').forEach((line, n) => {
      if (!line.toLowerCase().includes(needle)) return
      total++
      if (out.length < MAX_HITS) out.push({ n: n + 1, line: line.length > 400 ? line.slice(0, 400) + '…' : line })
    })
    return { out, total }
  }, [text, q])
  if (!hits.total) return <div className="muted conn-small">No match for “{q}”.</div>
  return (
    <div className="sr-hits mono">
      <div className="muted conn-small">
        {hits.total} matching line{hits.total === 1 ? '' : 's'}
        {hits.total > MAX_HITS ? `, the first ${MAX_HITS} shown` : ''}
      </div>
      {hits.out.map((h) => (
        <div key={h.n} className="sr-hit">
          <span className="sr-ln">{h.n}</span>
          <Mark text={h.line} q={q} />
        </div>
      ))}
    </div>
  )
}

function Mark({ text, q }: { text: string; q: string }): ReactNode {
  const parts: ReactNode[] = []
  const lower = text.toLowerCase()
  const needle = q.toLowerCase()
  let i = 0
  for (let j = lower.indexOf(needle); j >= 0 && parts.length < 40; j = lower.indexOf(needle, i)) {
    parts.push(text.slice(i, j), <mark key={j}>{text.slice(j, j + q.length)}</mark>)
    i = j + q.length
  }
  parts.push(text.slice(i))
  return <span>{parts}</span>
}

const PAGE = 100

/** A collapsible JSON tree; children render only when opened, a hundred at a time, so a big body stays quick. */
function JsonNode({ k, v, depth }: { k?: string; v: unknown; depth: number }): ReactNode {
  const [open, setOpen] = useState(depth === 0)
  const [shown, setShown] = useState(PAGE)
  const key = k !== undefined && <span className="sr-k">{k}: </span>
  if (v === null || typeof v !== 'object')
    return (
      <div className="sr-leaf">
        {key}
        <span className={`sr-${v === null ? 'null' : typeof v}`}>{typeof v === 'string' ? JSON.stringify(v) : String(v)}</span>
      </div>
    )
  const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v as Record<string, unknown>)
  const summary = Array.isArray(v) ? `[${entries.length} item${entries.length === 1 ? '' : 's'}]` : `{${entries.length} key${entries.length === 1 ? '' : 's'}}`
  return (
    <div className="sr-branch">
      <button className="sr-toggle" onClick={() => setOpen(!open)} disabled={!entries.length}>
        {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        {key}
        <span className="muted">{summary}</span>
      </button>
      {open && (
        <div className="sr-children">
          {entries.slice(0, shown).map(([ck, cv]) => (
            <JsonNode key={ck} k={ck} v={cv} depth={depth + 1} />
          ))}
          {entries.length > shown && (
            <button className="btn sm ghost" onClick={() => setShown((n) => n + PAGE)}>
              Show {Math.min(PAGE, entries.length - shown)} more of {entries.length - shown}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
