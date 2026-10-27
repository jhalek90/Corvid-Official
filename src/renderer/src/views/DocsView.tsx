// The Docs view (#188): the docs/ pages, bundled with the app, shown offline. A tree of sections and pages with a
// search box on the left (a slide-over in a narrow pane), the page in the middle, and an "on this page" outline on
// the right for long pages. Pages are parsed to data by src/shared/docs.ts and drawn here as React elements, so no
// HTML from a page reaches the DOM; the one exception is code blocks, which highlight.js escapes, as in the file
// preview.
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, BookOpen, ExternalLink, Info, ListTree, OctagonAlert, Search, TriangleAlert, X } from 'lucide-react'
import { DOCS_SITE_URL, docTarget, headingsOf, parseMarkdown, readingOrder, resolveDocImage, resolveDocLink, searchDocs, type Block, type CalloutKind, type Inline } from '@shared/docs'
import { docImages, docs } from '../docsData'
import { highlight } from '../highlight'
import { focusedView } from '../panes'
import { getState, openDocs, setState, useStore } from '../store'
import { keyLabel } from '../keys'
import '../docs.css'
import { TourList } from '../components/TourPlayer'

/** App.tsx sends this on Ctrl+K (Cmd+K) while the Docs view has focus: it focuses the docs search box. */
export const DOCS_SEARCH_EVENT = 'corvid:docs-search'

const ORDER = readingOrder(docs.manifest)
const META = new Map<string, { title: string; summary: string; section?: string }>([
  ...(docs.manifest.index ? [[docs.manifest.index.path, { title: docs.manifest.index.title, summary: docs.manifest.index.summary }] as const] : []),
  ...docs.manifest.sections.flatMap((s) => s.pages.map((p) => [p.path, { title: p.title, summary: p.summary, section: s.title }] as const))
])
const SECTION_TITLE = new Map(docs.manifest.sections.map((s) => [s.id, s.title]))

const reduceMotion = (): boolean => matchMedia('(prefers-reduced-motion: reduce)').matches
const typing = (t: EventTarget | null): boolean => t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))

/** Fenced code languages to the extensions highlight() knows. */
const LANG_EXT: Record<string, string> = { javascript: 'js', typescript: 'ts', shell: 'sh', console: 'sh', powershell: 'ps1', yaml: 'yml', markdown: 'md', python: 'py', html: 'html' }

export function DocsView(): ReactNode {
  const target = useStore((s) => s.docsPage) ?? 'index'
  const { path: wanted, anchor } = docTarget(target)
  const path = META.has(wanted) ? wanted : undefined
  const blocks = useMemo(() => (path ? safeParse(docs.bodies.get(path) ?? '') : []), [path])
  const outline = useMemo(() => headingsOf(blocks).filter((h) => h.level === 2 || h.level === 3), [blocks])
  const [treeOpen, setTreeOpen] = useState(false)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const [notice, setNotice] = useState<string>()
  const hits = useMemo(() => searchDocs(docs.manifest.search, q, 12), [q])
  const mainRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const treeRef = useRef<HTMLElement>(null)

  const go = (id: string): void => {
    setNotice(undefined)
    setTreeOpen(false)
    setQ('')
    setState({ docsPage: id })
    // the same page again doesn't change the store, so scroll to its heading here
    if (id === target) scrollTo(docTarget(id).anchor)
  }
  const scrollTo = (a: string): void => {
    const el = a ? mainRef.current?.querySelector(`[data-anchor="${CSS.escape(a)}"]`) : null
    if (el) el.scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' })
    else mainRef.current?.scrollTo({ top: 0 })
  }
  useEffect(() => scrollTo(anchor), [target])
  // the open page stays in sight in the page list
  // a block body: scrollIntoView returns a Promise in this Electron, and an effect must not return one (#215)
  useEffect(() => {
    treeRef.current?.querySelector('.docs-tree-link.on')?.scrollIntoView({ block: 'nearest' })
  }, [path, q === ''])
  useEffect(() => setSel(0), [q])

  useEffect(() => {
    const focusSearch = (): void => {
      setTreeOpen(true)
      searchRef.current?.focus()
      searchRef.current?.select()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing(e.target) && focusedView(getState().layout) === 'docs') {
        e.preventDefault()
        focusSearch()
      }
    }
    window.addEventListener(DOCS_SEARCH_EVENT, focusSearch)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener(DOCS_SEARCH_EVENT, focusSearch)
      window.removeEventListener('keydown', onKey)
    }
  }, [])

  const onSearchKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') setSel((i) => Math.min(hits.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setSel((i) => Math.max(0, i - 1))
    else if (e.key === 'Enter' && hits[sel]) go(hits[sel].path)
    else if (e.key === 'Escape') {
      if (q) setQ('')
      else (searchRef.current?.blur(), setTreeOpen(false))
    } else return
    e.preventDefault()
  }

  const at = path ? ORDER.indexOf(path) : -1
  const prev = at > 0 ? ORDER[at - 1] : undefined
  const next = at >= 0 && at < ORDER.length - 1 ? ORDER[at + 1] : undefined
  const meta = path ? META.get(path) : undefined
  const ctx: Ctx = {
    from: path ?? 'index.md',
    go,
    scrollTo,
    notice: setNotice
  }

  return (
    <div className="docs">
      <aside className={`docs-side${treeOpen ? ' open' : ''}`}>
        <div className="docs-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            type="text"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onSearchKey}
            placeholder="Search the docs"
            aria-label="Search the docs"
            role="combobox"
            aria-expanded={!!q.trim()}
            aria-controls="docs-results"
            aria-activedescendant={q.trim() && hits[sel] ? `docs-hit-${sel}` : undefined}
            spellCheck={false}
          />
          <kbd title="Focus the search box (or press /)">{keyLabel('K')}</kbd>
          <button className="btn ghost icon xs docs-side-close" onClick={() => setTreeOpen(false)} aria-label="Close the page list">
            <X size={13} />
          </button>
        </div>
        {q.trim() ? (
          <ul id="docs-results" className="docs-results" role="listbox" aria-label="Search results">
            {hits.map((h, i) => (
              <li key={h.path} id={`docs-hit-${i}`} role="option" aria-selected={i === sel} className={i === sel ? 'on' : ''} onMouseMove={() => setSel(i)} onClick={() => go(h.path)}>
                <div className="t">{h.title}</div>
                <div className="s">{h.section ? SECTION_TITLE.get(h.section) : 'Docs'}</div>
                <div className="snip">{h.mark ? <Marked text={h.snippet} {...h.mark} /> : META.get(h.path)?.summary}</div>
              </li>
            ))}
            {!hits.length && <li className="docs-none">No page matches “{q.trim()}”.</li>}
          </ul>
        ) : (
          <nav className="docs-tree" aria-label="Docs pages" ref={treeRef}>
            {docs.manifest.index && (
              <a href="#" className={`docs-tree-link top${path === docs.manifest.index.path ? ' on' : ''}`} aria-current={path === docs.manifest.index.path ? 'page' : undefined} onClick={(e) => (e.preventDefault(), go('index'))}>
                <BookOpen size={13} aria-hidden /> {docs.manifest.index.title}
              </a>
            )}
            {docs.manifest.sections.map((s) => (
              <Fragment key={s.id}>
                <div className="docs-tree-sec" id={`docs-sec-${s.id}`}>
                  {s.title}
                </div>
                <ul aria-labelledby={`docs-sec-${s.id}`}>
                  {s.pages.map((p) => (
                    <li key={p.path}>
                      <a href="#" className={`docs-tree-link${p.path === path ? ' on' : ''}`} aria-current={p.path === path ? 'page' : undefined} title={p.summary} onClick={(e) => (e.preventDefault(), go(p.path))}>
                        {p.title}
                      </a>
                    </li>
                  ))}
                </ul>
              </Fragment>
            ))}
            {/* the Help list of guided tours (#214) */}
            <TourList />
          </nav>
        )}
      </aside>
      {treeOpen && <div className="docs-scrim" onClick={() => setTreeOpen(false)} />}
      <div className="docs-main" ref={mainRef}>
        <div className="docs-bar">
          <button className="btn ghost sm" onClick={() => setTreeOpen(true)} aria-expanded={treeOpen} aria-label="Show the page list and search">
            <ListTree size={14} /> Pages
          </button>
          {meta?.section && <span className="muted">{meta.section}</span>}
        </div>
        <article className="docs-page">
          {notice && (
            <div className="docs-notice" role="status">
              <Info size={14} aria-hidden /> {notice}
              <button className="btn ghost icon xs" onClick={() => setNotice(undefined)} aria-label="Dismiss">
                <X size={12} />
              </button>
            </div>
          )}
          {path ? (
            <Blocks blocks={blocks} ctx={ctx} />
          ) : (
            <>
              <h1>Page not found</h1>
              <p>
                There is no page “{wanted}” in these docs.{' '}
                <a href="#" onClick={(e) => (e.preventDefault(), go('index'))}>
                  Go to the docs index
                </a>
                .
              </p>
            </>
          )}
          {path && DOCS_SITE_URL && (
            <p className="docs-web">
              <a href={`${DOCS_SITE_URL}/${path === 'index.md' ? '' : path.replace(/\.md$/, '')}`} target="_blank" rel="noreferrer noopener">
                Open on the website <ExternalLink size={12} aria-hidden />
              </a>
            </p>
          )}
          {path && (
            <nav className="docs-pager" aria-label="Previous and next page">
              {prev ? (
                <a href="#" className="prev" onClick={(e) => (e.preventDefault(), go(prev))}>
                  <span className="muted">
                    <ArrowLeft size={12} aria-hidden /> Previous
                  </span>
                  {META.get(prev)?.title}
                </a>
              ) : (
                <span />
              )}
              {next && (
                <a href="#" className="next" onClick={(e) => (e.preventDefault(), go(next))}>
                  <span className="muted">
                    Next <ArrowRight size={12} aria-hidden />
                  </span>
                  {META.get(next)?.title}
                </a>
              )}
            </nav>
          )}
          {path === 'index.md' && <footer className="docs-foot">These docs match this version of Corvid. A Corvid update brings the docs that go with it.</footer>}
        </article>
      </div>
      {outline.length >= 3 && (
        <nav className="docs-outline" aria-label="On this page">
          <div className="docs-tree-sec">On this page</div>
          <ul>
            {outline.map((h) => (
              <li key={h.id} className={`l${h.level}`}>
                <a href={`#${h.id}`} onClick={(e) => (e.preventDefault(), scrollTo(h.id))}>
                  {h.text}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  )
}

function safeParse(body: string): Block[] {
  try {
    return parseMarkdown(body)
  } catch {
    return [{ t: 'para', inl: [{ t: 'text', text: 'This page could not be shown.' }] }]
  }
}

function Marked({ text, start, len }: { text: string; start: number; len: number }): ReactNode {
  return (
    <>
      {text.slice(0, start)}
      <mark>{text.slice(start, start + len)}</mark>
      {text.slice(start + len)}
    </>
  )
}

interface Ctx {
  from: string
  go: (id: string) => void
  scrollTo: (anchor: string) => void
  notice: (text: string) => void
}

const CALLOUT: Record<CalloutKind, { label: string; icon: typeof Info }> = {
  note: { label: 'Note', icon: Info },
  caution: { label: 'Caution', icon: TriangleAlert },
  warning: { label: 'Warning', icon: OctagonAlert }
}

function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }): ReactNode {
  return blocks.map((b, i) => <BlockView key={i} b={b} ctx={ctx} />)
}

function BlockView({ b, ctx }: { b: Block; ctx: Ctx }): ReactNode {
  switch (b.t) {
    case 'heading': {
      const H = `h${b.level}` as 'h1'
      return (
        <H data-anchor={b.id} className="docs-h">
          <Inlines inl={b.inl} ctx={ctx} />
          {b.level > 1 && (
            <a className="docs-anchor" href={`#${b.id}`} aria-label={`Link to ${b.text}`} onClick={(e) => (e.preventDefault(), ctx.scrollTo(b.id))}>
              #
            </a>
          )}
        </H>
      )
    }
    case 'para':
      return (
        <p>
          <Inlines inl={b.inl} ctx={ctx} />
        </p>
      )
    case 'callout': {
      const { label, icon: Icon } = CALLOUT[b.kind]
      return (
        <div className={`docs-callout ${b.kind}`} role="note" aria-label={label}>
          <div className="docs-callout-label">
            <Icon size={14} aria-hidden /> {label}
          </div>
          <Blocks blocks={b.blocks} ctx={ctx} />
        </div>
      )
    }
    case 'list': {
      const items = b.items.map((it, i) => (
        <li key={i}>
          <Blocks blocks={it} ctx={ctx} />
        </li>
      ))
      return b.ordered ? <ol start={b.start === 1 ? undefined : b.start}>{items}</ol> : <ul>{items}</ul>
    }
    case 'code': {
      const html = highlight(`code.${LANG_EXT[b.lang] ?? b.lang}`, b.text)
      return (
        <pre className="docs-code" tabIndex={0}>
          {html !== undefined ? <code dangerouslySetInnerHTML={{ __html: html }} /> : <code>{b.text}</code>}
        </pre>
      )
    }
    case 'table':
      return (
        <div className="docs-table" tabIndex={0}>
          <table>
            <thead>
              <tr>
                {b.head.map((c, i) => (
                  <th key={i} style={b.align[i] ? { textAlign: b.align[i] } : undefined}>
                    <Inlines inl={c} ctx={ctx} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {b.rows.map((r, i) => (
                <tr key={i}>
                  {r.map((c, j) => (
                    <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                      <Inlines inl={c} ctx={ctx} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
    case 'quote':
      return (
        <blockquote>
          <Blocks blocks={b.blocks} ctx={ctx} />
        </blockquote>
      )
    case 'hr':
      return <hr />
  }
}

function Inlines({ inl, ctx }: { inl: Inline[]; ctx: Ctx }): ReactNode {
  return inl.map((x, i) => <InlineView key={i} x={x} ctx={ctx} />)
}

function InlineView({ x, ctx }: { x: Inline; ctx: Ctx }): ReactNode {
  switch (x.t) {
    case 'text':
      return x.text
    case 'code':
      return <code>{x.text}</code>
    case 'strong':
      return (
        <strong>
          <Inlines inl={x.kids} ctx={ctx} />
        </strong>
      )
    case 'em':
      return (
        <em>
          <Inlines inl={x.kids} ctx={ctx} />
        </em>
      )
    case 'image': {
      const url = resolveDocImage(ctx.from, x.src, docImages)
      return url ? <img src={url} alt={x.alt} loading="lazy" /> : <span className="docs-noimg">{x.alt || 'Image not available'}</span>
    }
    case 'link': {
      const kids = <Inlines inl={x.kids} ctx={ctx} />
      const r = resolveDocLink(ctx.from, x.href, docs.pages, docs.files)
      if (r.kind === 'external')
        // the window's open handler sends http(s) links to the system browser; nothing opens inside Corvid
        return (
          <a href={r.url} target="_blank" rel="noreferrer noopener" className="docs-ext" title={r.url}>
            {kids}
            <ExternalLink size={11} aria-label="(opens in your browser)" />
          </a>
        )
      if (r.kind === 'blocked') return <span>{kids}</span>
      return (
        <a
          href={`#${r.kind === 'page' ? r.path : r.kind === 'anchor' ? r.anchor : ''}`}
          className={r.kind === 'missing' || r.kind === 'source' ? 'docs-missing' : undefined}
          title={r.kind === 'missing' ? 'This page is not in the docs' : r.kind === 'source' ? `${r.path} in Corvid's source folder` : undefined}
          onClick={(e) => {
            e.preventDefault()
            if (r.kind === 'page') ctx.go(r.anchor ? `${r.path}#${r.anchor}` : r.path)
            else if (r.kind === 'anchor') ctx.scrollTo(r.anchor)
            else if (r.kind === 'source') ctx.notice(`That link goes to ${r.path} in Corvid's source folder. It isn't part of the in-app docs: open it from your Corvid checkout.`)
            else ctx.notice(`That page isn't in these docs: ${r.path}`)
          }}
        >
          {kids}
        </a>
      )
    }
  }
}

/** A small, quiet "Learn more" link for other views (#188): opens the Docs view on a page, by id ("connections/overview")
 *  or with a heading ("settings/reference#profile"). */
export function LearnMore({ page, label = 'Learn more', className = '' }: { page: string; label?: string; className?: string }): ReactNode {
  const title = META.get(docTarget(page).path)?.title ?? 'the docs'
  return (
    <button
      type="button"
      className={`learn-more ${className}`}
      onClick={(e) => {
        e.stopPropagation()
        openDocs(page)
      }}
      title={`Open “${title}” in Docs`}
      aria-label={label ? undefined : `Learn more: ${title}`}
    >
      <BookOpen size={12} aria-hidden />
      {label}
    </button>
  )
}
