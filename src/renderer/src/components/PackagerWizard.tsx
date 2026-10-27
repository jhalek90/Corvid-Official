import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, Bird, Check, CircleStop, GitMerge, Lightbulb, RotateCcw, Save, Search, Send, ShieldCheck, TriangleAlert, X } from 'lucide-react'
import { emptyPackager, lineDiff, PACKAGER_AGENT_NAME, ROUGH_ESTIMATE, type PackagerMessage, type PackagerOutline, type PackagerState } from '@shared/packager'
import { TIER_WORDS } from '@shared/extensionTiers'
import { api } from '../api'
import { setState, toast } from '../store'
import { relTime } from '../format'
import '../packager.css'

// The packaging wizard (#100, Extensions 6/8): a guided chat in the Extensions tab that turns a feature the user
// built, or a new idea, into a .corvid draft. The chat is run by the packaging agent in the main process
// (src/main/packager.ts); this is only its front end. Nothing here installs, builds or shares anything.

let cache: PackagerState = emptyPackager()
const listeners = new Set<(s: PackagerState) => void>()
let subscribed = false

export function usePackager(): PackagerState {
  const [s, set] = useState(cache)
  useEffect(() => {
    listeners.add(set)
    if (!subscribed) {
      subscribed = true
      const put = (n: PackagerState): void => {
        cache = n
        listeners.forEach((f) => f(n))
      }
      api.onPackager(put)
      void api.packagerState().then(put)
    } else set(cache)
    return () => void listeners.delete(set)
  }, [])
  return s
}

/** Edit on a created extension: opens the wizard ready to revise it (the start still asks first). */
let pendingEdit: { key: string; name: string; findings?: string } | null = null
/** Opens the wizard on a created extension; a failed verify (#101) passes its findings along. */
export function editExtension(key: string, name: string, findings?: string): void {
  pendingEdit = { key, name, findings }
  setState({ extensionsFocus: undefined })
  void api.packagerOpen()
}
export const openPackager = (): void => void api.packagerOpen()

const result = (r: PackagerState | { error: string }): void => {
  if (!('messages' in r)) toast(r.error, 'error')
}

export function PackagerWizard({ s }: { s: PackagerState }): ReactNode {
  const [edit, setEdit] = useState(pendingEdit)
  useEffect(() => void (pendingEdit = null), [])
  const started = !!s.mode && s.messages.length > 0
  const title = s.mode === 'edit' || edit ? 'Edit extension' : 'New extension'
  const close = (): void => void api.packagerClose()

  return (
    <div className="ext-view pkg-view">
      <button className="btn ghost sm ext-back" onClick={close}>
        <ArrowLeft size={13} /> Extensions
      </button>
      <div className="pkg-head">
        <div>
          <h2>{title}</h2>
          <p className="muted">A chat with the {PACKAGER_AGENT_NAME.toLowerCase()} that writes a .corvid file: text that describes the feature, never its code.</p>
        </div>
        <div className="pkg-head-actions">
          <AgentChip s={s} />
          {s.busy && (
            <button className="btn sm danger" onClick={() => void api.packagerStop()} title="Stop the packaging agent; the conversation stays as a draft">
              <CircleStop size={13} /> Stop
            </button>
          )}
          {started && !s.busy && (
            <button className="btn sm ghost" onClick={() => void api.packagerReset()} title="Forget this conversation and start again (saved extensions stay)">
              <RotateCcw size={13} /> Start over
            </button>
          )}
          <button className="btn ghost icon sm" title="Close the wizard (the conversation is kept)" onClick={close}>
            <X size={14} />
          </button>
        </div>
      </div>
      <Author s={s} />
      {started ? <Chat s={s} /> : edit ? <EditStart s={s} edit={edit} onCancel={() => setEdit(null)} /> : <Start s={s} />}
      <p className="muted pkg-foot">
        <ShieldCheck size={12} /> Everything here stays on this machine. The wizard never installs, builds, deploys or shares anything. Your own Corvid keeps the
        feature; the extension is only the packaged text.
      </p>
    </div>
  )
}

function AgentChip({ s }: { s: PackagerState }): ReactNode {
  const state = s.busy ? 'Working' : s.stage === 'saved' ? 'Saved' : s.mode && s.stage !== 'stopped' ? 'Your turn' : 'Not started'
  return (
    <span className={`pkg-chip ${s.busy ? 'busy' : ''}`} title="The packaging agent shows on the Agents page while it runs">
      <Bird size={12} /> {PACKAGER_AGENT_NAME} · {state}
    </span>
  )
}

function Author({ s }: { s: PackagerState }): ReactNode {
  const [v, setV] = useState(s.author)
  useEffect(() => setV(s.author), [s.author])
  return (
    <label className="pkg-author">
      <span>Author name in the file</span>
      <input value={v} maxLength={60} onChange={(e) => setV(e.target.value)} onBlur={() => v !== s.author && void api.packagerAuthor(v)} placeholder="A display name" />
      <span className="muted">Set once; defaults to your board name. Nothing from this machine is added.</span>
    </label>
  )
}

const Estimate = ({ s }: { s: PackagerState }): ReactNode => (
  <p className="muted pkg-estimate">
    Estimate: {s.estimate ?? ROUGH_ESTIMATE}. It starts like any agent: within the agent limit, under the deny rules, and asking first when usage is over your limit.
  </p>
)

function Start({ s }: { s: PackagerState }): ReactNode {
  const [mode, setMode] = useState<'built' | 'scratch' | null>(null)
  const [picked, setPicked] = useState<string[]>([])
  const [q, setQ] = useState('')
  const [starting, setStarting] = useState(false)
  const features = useMemo(() => {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean)
    return (s.features ?? []).filter((f) => words.every((w) => `${f.title} #${f.taskId} ${f.files.join(' ')}`.toLowerCase().includes(w)))
  }, [s.features, q])
  const begin = async (): Promise<void> => {
    if (!mode) return
    setStarting(true)
    result(await api.packagerBegin(mode, mode === 'built' ? picked : []))
    setStarting(false)
  }
  const toggle = (c: string): void => setPicked((p) => (p.includes(c) ? p.filter((x) => x !== c) : [...p, c]))

  return (
    <div className="pkg-start">
      <div className="pkg-choices">
        <button className={`card pkg-choice ${mode === 'built' ? 'on' : ''}`} onClick={() => setMode('built')}>
          <GitMerge size={18} />
          <b>From something I built</b>
          <span className="muted">Pick a feature you merged on this Corvid. The agent reads its notes and diff privately and describes what it does.</span>
        </button>
        <button className={`card pkg-choice ${mode === 'scratch' ? 'on' : ''}`} onClick={() => setMode('scratch')}>
          <Lightbulb size={18} />
          <b>From scratch</b>
          <span className="muted">A short interview about a new idea, then an outline to approve.</span>
        </button>
      </div>
      {mode === 'built' && (
        <div className="pkg-picker">
          <div className="pkg-search">
            <Search size={13} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search merged features by title, #task or file" />
          </div>
          {s.error && <p className="pkg-warn"><TriangleAlert size={13} /> {s.error}</p>}
          {!s.features ? (
            <p className="muted">Reading the git history…</p>
          ) : !features.length ? (
            <p className="muted">{s.features.length ? 'Nothing matches.' : 'No merged task branches found yet.'}</p>
          ) : (
            <ul className="pkg-features">
              {features.map((f) => (
                <li key={f.commit}>
                  <label className={picked.includes(f.commit) ? 'on' : ''}>
                    <input type="checkbox" checked={picked.includes(f.commit)} onChange={() => toggle(f.commit)} />
                    <span className="pkg-feature-title">
                      {f.taskId !== undefined && <span className="muted">#{f.taskId} </span>}
                      {f.title}
                    </span>
                    <span className="muted pkg-feature-meta">
                      {relTime(f.date)} · {f.files.length} file{f.files.length === 1 ? '' : 's'}
                      {f.minutes ? ` · ${f.minutes} min` : ''}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="muted">Pick one feature, or a few related ones. To repackage an extension you created, use Edit on its page.</p>
        </div>
      )}
      {mode && (
        <>
          <Estimate s={s} />
          <div className="ext-buttons">
            <button className="btn primary sm" disabled={starting || (mode === 'built' && !picked.length)} onClick={() => void begin()}>
              <Bird size={13} /> {starting ? 'Starting…' : 'Start the packaging agent'}
            </button>
          </div>
        </>
      )}
    </div>
  )
}

function EditStart({ s, edit, onCancel }: { s: PackagerState; edit: { key: string; name: string; findings?: string }; onCancel: () => void }): ReactNode {
  const [starting, setStarting] = useState(false)
  return (
    <div className="pkg-start">
      <p>
        Revise <b>{edit.name}</b> in a chat. The result is a new version (bumped), with a diff of the text. A new version has a new hash, so any verification resets.{edit.findings ? " The failed verify's findings go to the packaging agent with the text." : ""}
      </p>
      <Estimate s={s} />
      <div className="ext-buttons">
        <button
          className="btn primary sm"
          disabled={starting}
          onClick={async () => {
            setStarting(true)
            result(await api.packagerBegin('edit', [edit.key], edit.findings))
            setStarting(false)
          }}
        >
          <Bird size={13} /> {starting ? 'Starting…' : 'Start the packaging agent'}
        </button>
        <button className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function Chat({ s }: { s: PackagerState }): ReactNode {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const end = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLTextAreaElement>(null)
  // braced: scrollIntoView returns a promise in this Chromium, and an effect must return nothing or a cleanup
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [s.messages.length, s.busy])
  const send = async (t: string): Promise<void> => {
    if (!t.trim() || s.busy) return
    setSending(true)
    setText('')
    result(await api.packagerReply(t))
    setSending(false)
  }
  const save = async (): Promise<void> => {
    const r = await api.packagerSave()
    if ('error' in r) return toast(r.error, 'error')
    toast('Saved in Extensions as Not installed yet')
  }
  const last = s.messages[s.messages.length - 1]
  const closed = s.stage === 'stopped' || s.stage === 'saved'

  return (
    <div className="pkg-chat">
      {s.derived && s.mode === 'built' && (
        <p className="muted pkg-derived">
          From the diff: at least tier {s.derived.tier} ({TIER_WORDS[s.derived.tier]}) · {s.derived.files} files · areas {s.derived.coreAreas.join(', ') || 'none'}
          {s.derived.packages.length ? ` · packages ${s.derived.packages.join(', ')}` : ''}
          {s.derived.hosts.length ? ` · hosts ${s.derived.hosts.join(', ')}` : ''}. Correct it in the chat if it's wrong.
        </p>
      )}
      <div className="pkg-messages">
        {s.messages.map((m) => (
          <Message key={m.id} m={m} s={s} quick={m === last && !s.busy && !closed} onQuick={(q) => void send(q)} />
        ))}
        {s.busy && <div className="pkg-msg agent typing">The packaging agent is thinking…</div>}
        <div ref={end} />
      </div>
      {s.ready && s.stage !== 'saved' && (
        <div className="pkg-save">
          <span>
            <Check size={13} /> The latest draft passed the validator and the leak checks.
          </span>
          <button className="btn primary sm" onClick={() => void save()} disabled={s.busy}>
            <Save size={13} /> Save as extension
          </button>
        </div>
      )}
      {s.stage === 'saved' ? (
        <p className="muted">Saved. It's in the Extensions list as Not installed yet, with Review, Install, Edit and Delete. Start over for another one.</p>
      ) : (
        <form
          className="pkg-input"
          onSubmit={(e) => {
            e.preventDefault()
            void send(text)
          }}
        >
          <textarea
            ref={input}
            value={text}
            rows={2}
            maxLength={4000}
            placeholder={s.busy ? 'Waiting for the packaging agent…' : s.stage === 'outline' ? 'Approve the outline, or say what to change' : 'Reply to the packaging agent'}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                void send(text)
              }
            }}
          />
          <button className="btn primary sm" disabled={s.busy || sending || !text.trim()} type="submit" title="Send (Enter)">
            <Send size={13} />
          </button>
        </form>
      )}
    </div>
  )
}

function Message({ m, s, quick, onQuick }: { m: PackagerMessage; s: PackagerState; quick: boolean; onQuick: (q: string) => void }): ReactNode {
  const replies = m.quick?.length ? m.quick : m.outline ? ['Approve the outline and write it', 'Change something'] : []
  return (
    <div className={`pkg-msg ${m.from}`}>
      {m.from !== 'user' && <div className="pkg-who">{m.from === 'agent' ? PACKAGER_AGENT_NAME : 'Corvid'}</div>}
      <div className="pkg-text">{m.text}</div>
      {m.outline && <Outline o={m.outline} />}
      {m.draft && <Draft d={m.draft} before={s.editing?.text} />}
      {quick && replies.length > 0 && (
        <div className="pkg-quick">
          {replies.map((q) => (
            <button key={q} className="btn sm" onClick={() => onQuick(q)}>
              {q}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function Outline({ o }: { o: PackagerOutline }): ReactNode {
  const row = (label: string, v: string | string[] | undefined): ReactNode =>
    (Array.isArray(v) ? v.length > 0 : !!v) && (
      <div className="pkg-row">
        <span className="muted">{label}</span>
        <span>{Array.isArray(v) ? v.join(', ') : v}</span>
      </div>
    )
  return (
    <div className="pkg-outline">
      <h4>
        {o.name} <span className="muted">· tier {o.tier}, {TIER_WORDS[o.tier]}</span>
      </h4>
      <p>{o.purpose}</p>
      {o.behaviours.length > 0 && (
        <ul>
          {o.behaviours.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      )}
      {row('Core areas', o.coreAreas)}
      {row('Packages', o.packages)}
      {row('Hosts', o.hosts)}
      {row('Data', o.data)}
      {row('Requires', o.requires)}
      {o.checks.length > 0 && (
        <>
          <span className="muted">Acceptance checks</span>
          <ol>
            {o.checks.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ol>
        </>
      )}
    </div>
  )
}

function Draft({ d, before }: { d: { text: string; problems: string[] }; before?: string }): ReactNode {
  const [showDiff, setShowDiff] = useState(!!before)
  const diff = useMemo(() => (before ? lineDiff(before.trimEnd(), d.text.trimEnd()) : []), [before, d.text])
  return (
    <div className="pkg-draft">
      {d.problems.length ? (
        <ul className="pkg-problems">
          {d.problems.map((p, i) => (
            <li key={i}>
              <TriangleAlert size={12} /> {p}
            </li>
          ))}
        </ul>
      ) : (
        <p className="pkg-ok">
          <Check size={12} /> Passed the validator and the leak checks.
        </p>
      )}
      {before && (
        <div className="pkg-tabs">
          <button className={`btn ghost sm ${showDiff ? 'on' : ''}`} onClick={() => setShowDiff(true)}>
            Changes
          </button>
          <button className={`btn ghost sm ${!showDiff ? 'on' : ''}`} onClick={() => setShowDiff(false)}>
            Full text
          </button>
        </div>
      )}
      {showDiff && before ? (
        <pre className="pkg-text-block pkg-diff">
          {diff.map((l, i) => (
            <div key={i} className={l.kind}>
              {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '- ' : '  '}
              {l.text}
            </div>
          ))}
        </pre>
      ) : (
        <pre className="pkg-text-block">{d.text}</pre>
      )}
    </div>
  )
}

/** The packaging agent on the Agents page, while the wizard has a session going. */
export function PackagerAgentCard(): ReactNode {
  const s = usePackager()
  if (!s.busy && !(s.open && s.mode && s.stage !== 'saved' && s.stage !== 'stopped')) return null
  return (
    <div className="card pkg-agent-card">
      <Bird size={14} />
      <div>
        <b>{PACKAGER_AGENT_NAME}</b>
        <span className="muted"> · Extensions wizard · {s.busy ? 'Working' : 'Waiting for you'}{s.startedAt ? ` · started ${relTime(s.startedAt)}` : ''}</span>
      </div>
      <div className="pkg-agent-actions">
        <button className="btn sm" onClick={() => setState({ view: 'extensions', extensionsFocus: undefined })}>
          Open
        </button>
        {s.busy && (
          <button className="btn sm danger" onClick={() => void api.packagerStop()}>
            Stop
          </button>
        )}
      </div>
    </div>
  )
}
