import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowUp,
  ChevronRight,
  ChevronsDownUp,
  Code,
  Copy,
  Eye,
  File,
  FileBraces,
  FileCode,
  FileImage,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderSearch,
  HardDrive,
  RefreshCw,
  Terminal,
  X
} from 'lucide-react'
import type { FileEntry, FilePlace, FilePreview } from '@shared/types'
import { baseName, projectKey } from '@shared/projects'
import { normKey, within } from '@shared/projectList'
import { api } from '../api'
import { highlight } from '../highlight'
import { newSideShell, setExplorerRoot, toast, toggleExplorer, useStore } from '../store'
import { useProjects } from '../views/ProjectsView'
import { Resizer } from './Resizer'
import { LocateButton } from './RelocateDialog'
import { keyLabel, mod, platform } from '../keys'

/** What the system's file manager is called here. */
const REVEAL = platform.isMac ? 'Reveal in Finder' : platform.os === 'linux' ? 'Show in file manager' : 'Reveal in File Explorer'

type Listing = { entries: FileEntry[]; truncated: number } | { error: string }

/** Root value meaning "list the drives" rather than a folder. */
const PC = 'pc:'

/** Build output, deps and engine caches: shown, but quieter. */
const HEAVY = new Set(['node_modules', 'out', 'dist', 'build', 'obj', 'bin', 'library', 'temp', 'logs', '__pycache__', '.venv'])

const CODE_EXT = /\.(tsx?|jsx?|mjs|cjs|cs|py|rs|go|c|cc|cpp|h|hpp|java|kt|lua|sh|ps1|bat|cmd|html|css|scss|shader|hlsl|glsl)$/i
const DATA_EXT = /\.(json|jsonc|ya?ml|toml|xml|csv|ini|env|lock)$/i
const TEXT_EXT = /\.(md|mdx|txt|log|rst)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|svg|webp|ico|bmp|psd|tga)$/i

function fileIcon(name: string): typeof File {
  if (CODE_EXT.test(name)) return FileCode
  if (DATA_EXT.test(name)) return FileBraces
  if (TEXT_EXT.test(name)) return FileText
  if (IMAGE_EXT.test(name)) return FileImage
  return File
}

const isDrive = (path: string): boolean => /^[a-z]:[\\/]?$/i.test(path) || path === '/'

/** One level up; a drive's parent is the drive list. */
function parentDir(path: string): string {
  if (path === PC || isDrive(path)) return PC
  const trimmed = path.replace(/[\\/]+$/, '')
  const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'))
  if (cut < 0) return PC
  const up = trimmed.slice(0, cut + 1)
  return isDrive(up) ? up : up.replace(/[\\/]+$/, '') || '/'
}

const under = (path: string, dir: string): boolean => within(normKey(path), normKey(dir))

let placesCache: Promise<FilePlace[]> | undefined
const loadPlaces = (): Promise<FilePlace[]> => (placesCache ??= api.listPlaces().catch(() => []))

/** Left-side, read-only file browser for the whole machine. Nothing here writes to disk. */
export function Explorer(): ReactNode {
  const open = useStore((s) => s.explorerOpen)
  const selectedProject = useStore((s) => s.selectedProject)

  // Opening a project page points the explorer at that project.
  useEffect(() => {
    if (selectedProject) setExplorerRoot(selectedProject)
  }, [selectedProject])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // Terminals keep Ctrl+B (readline back-char, tmux prefix).
      if ((document.activeElement as HTMLElement | null)?.closest('.xterm')) return
      if (mod(e) && !e.shiftKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        toggleExplorer()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return open ? <ExplorerPanel /> : null
}

function ExplorerPanel(): ReactNode {
  const projects = useProjects()
  const home = useStore((s) => s.home)
  const saved = useStore((s) => s.explorerRoot)
  const root = saved ?? projects[0]?.path ?? (home || PC)
  const [places, setPlaces] = useState<FilePlace[]>([])
  const [preview, setPreview] = useState<string>()

  useEffect(() => void loadPlaces().then(setPlaces), [])

  // A file opens in the window of the project it belongs to; anything else opens on its own.
  const openInCode = useCallback(
    (e: FileEntry): void => {
      if (e.dir) {
        void api.openVSCode(e.path)
        return
      }
      const owner = projects.filter((p) => under(e.path, p.path)).sort((a, b) => b.path.length - a.path.length)[0]
      void api.openFile(e.path, owner?.path)
    },
    [projects]
  )

  const missingHere = projects.flatMap((p) => p.folders.map((f) => ({ p, f }))).find(({ p, f }) => f.missing && p.id && f.key === projectKey(root))
  const known = root === PC || places.some((p) => projectKey(p.path) === projectKey(root)) || projects.some((p) => p.key === projectKey(root))
  const up = parentDir(root)

  return (
    <aside className={`explorer${preview ? ' previewing' : ''}`}>
      <div className="fx-main">
        <div className="fx-head">
          <span className="fx-title">Files</span>
          <span style={{ flex: 1 }} />
          <button className="btn ghost icon sm" title={up === PC ? 'Up to This PC' : `Up to ${up}`} disabled={root === PC} onClick={() => setExplorerRoot(up)}>
            <ArrowUp size={14} />
          </button>
          <button className="btn ghost icon sm" title="Open folder in VS Code" disabled={root === PC} onClick={() => openInCode({ name: baseName(root), path: root, dir: true })}>
            <Code size={14} />
          </button>
          <button className="btn ghost icon sm" title="Open a terminal here" disabled={root === PC} onClick={() => void newSideShell(undefined, root)}>
            <Terminal size={14} />
          </button>
          <button className="btn ghost icon sm" title={`Close (${keyLabel('B')})`} onClick={() => toggleExplorer(false)}>
            <X size={14} />
          </button>
        </div>
        <div className="fx-pick">
          <select className="select" value={known ? root : ''} onChange={(e) => setExplorerRoot(e.target.value)} title="Jump to">
            {!known && <option value="">{baseName(root)}</option>}
            <optgroup label="Places">
              <option value={PC}>This PC</option>
              {places.map((p) => (
                <option key={p.path} value={p.path}>
                  {p.name}
                </option>
              ))}
            </optgroup>
            {projects.length > 0 && (
              <optgroup label="Projects">
                {projects.map((p) => (
                  <option key={p.key} value={p.path}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>
        {missingHere ? (
          // a project folder that isn't there (4/5): say so and offer to find it, instead of "Folder not found"
          <div className="fx-note err">
            {missingHere.p.name}’s folder isn’t there: moved, renamed, deleted, or on a drive that isn’t connected.{' '}
            <LocateButton projectId={missingHere.p.id} path={missingHere.f.path} missing />
          </div>
        ) : (
          <Tree key={root === PC ? PC : projectKey(root)} root={root} home={home} preview={preview} onPreview={setPreview} onOpen={openInCode} />
        )}
        <Resizer pane="explorer" edge="right" />
      </div>
      {preview && <Preview key={preview} file={preview} onOpen={openInCode} onClose={() => setPreview(undefined)} />}
    </aside>
  )
}

/** Editable path for the current root: type or paste a folder and press Enter. */
function PathBar({ root, home }: { root: string; home: string }): ReactNode {
  const shown = root === PC ? '' : root
  const [draft, setDraft] = useState(shown)
  useEffect(() => setDraft(shown), [shown])

  const go = (): void => {
    let p = draft.trim().replace(/^"(.*)"$/, '$1')
    if (!p) return setDraft(shown)
    if (home && (p === '~' || /^~[\\/]/.test(p))) p = home + p.slice(1)
    if (/^[a-z]:/i.test(p)) p = p.replace(/\//g, '\\')
    if (/^[a-z]:$/i.test(p)) p += '\\'
    setExplorerRoot(p)
  }

  return (
    <input
      className="fx-path mono"
      value={draft}
      placeholder="This PC"
      spellCheck={false}
      title={shown || 'This PC'}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={(e) => e.target.select()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          go()
          e.currentTarget.blur()
        } else if (e.key === 'Escape') {
          setDraft(shown)
          e.currentTarget.blur()
        }
      }}
      onBlur={() => setDraft(shown)}
    />
  )
}

type MenuAt = { x: number; y: number; entry: FileEntry }

function Tree({
  root,
  home,
  preview,
  onPreview,
  onOpen
}: {
  root: string
  home: string
  preview?: string
  onPreview: (file: string) => void
  onOpen: (e: FileEntry) => void
}): ReactNode {
  const [listings, setListings] = useState<Record<string, Listing>>({})
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [selected, setSelected] = useState<string>()
  const [menu, setMenu] = useState<MenuAt>()
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const load = useCallback((dir: string) => {
    const req = dir === PC ? api.listDrives().then((entries) => ({ entries, truncated: 0 })) : api.listDir(dir)
    req.then(
      (l) => setListings((s) => ({ ...s, [dir]: l })),
      (e) => setListings((s) => ({ ...s, [dir]: { error: cleanError(e, 'folder') } }))
    )
  }, [])

  // Re-read whatever is visible; old rows stay up until the new ones land, so nothing flickers.
  const refresh = useCallback(() => {
    load(root)
    for (const d of expandedRef.current) load(d)
  }, [root, load])

  useEffect(() => {
    refresh()
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [refresh])

  const toggle = (dir: string): void => {
    const next = new Set(expanded)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      load(dir)
    }
    setExpanded(next)
  }

  const activate = (e: FileEntry): void => {
    setSelected(e.path)
    if (e.dir) toggle(e.path)
    else onPreview(e.path)
  }

  const rows = (dir: string, depth: number): ReactNode[] => {
    const pad = { paddingLeft: 8 + depth * 12 }
    const l = listings[dir]
    if (!l) return [<div key={`${dir}:loading`} className="fx-note" style={pad}>Loading…</div>]
    if ('error' in l) return [<div key={`${dir}:error`} className="fx-note err" style={pad}>{l.error}</div>]
    if (!l.entries.length) return [<div key={`${dir}:empty`} className="fx-note" style={pad}>Empty</div>]
    const out: ReactNode[] = []
    for (const e of l.entries) {
      const isOpen = e.dir && expanded.has(e.path)
      const Icon = dir === PC ? HardDrive : e.dir ? (isOpen ? FolderOpen : Folder) : fileIcon(e.name)
      const dim = /^[.$]/.test(e.name) || (e.dir && HEAVY.has(e.name.toLowerCase()))
      const sel = selected === e.path || (!e.dir && preview === e.path)
      out.push(
        <div
          key={e.path}
          role="treeitem"
          aria-expanded={e.dir ? isOpen : undefined}
          tabIndex={0}
          className={`fx-row${e.dir ? ' dir' : ''}${dim ? ' dim' : ''}${sel ? ' sel' : ''}`}
          style={pad}
          title={e.dir ? `${e.path}\nDouble-click to browse from here` : `${e.path}\nDouble-click to open in VS Code`}
          onClick={() => activate(e)}
          onDoubleClick={() => (e.dir ? setExplorerRoot(e.path) : onOpen(e))}
          onContextMenu={(ev) => {
            ev.preventDefault()
            setSelected(e.path)
            setMenu({ x: ev.clientX, y: ev.clientY, entry: e })
          }}
          onKeyDown={(k) => {
            if (k.key === 'Enter' || k.key === ' ') {
              k.preventDefault()
              activate(e)
            } else if (e.dir && ((k.key === 'ArrowRight' && !isOpen) || (k.key === 'ArrowLeft' && isOpen))) {
              k.preventDefault()
              toggle(e.path)
            }
          }}
        >
          <ChevronRight size={12} className={`fx-chev${isOpen ? ' open' : ''}`} style={e.dir ? undefined : { visibility: 'hidden' }} />
          <Icon size={14} strokeWidth={1.75} className="fx-icon" />
          <span className="fx-name">{e.name}</span>
          <button
            className="fx-act"
            title={REVEAL}
            tabIndex={-1}
            onClick={(ev) => {
              ev.stopPropagation()
              void api.reveal(e.path)
            }}
          >
            <FolderSearch size={13} />
          </button>
        </div>
      )
      if (isOpen) out.push(...rows(e.path, depth + 1))
    }
    if (l.truncated) out.push(<div key={`${dir}:more`} className="fx-note" style={pad}>{l.truncated} more not shown</div>)
    return out
  }

  return (
    <>
      <div className="fx-tools">
        <PathBar root={root} home={home} />
        <button className="btn ghost icon sm" title="Collapse all" onClick={() => setExpanded(new Set())} disabled={!expanded.size}>
          <ChevronsDownUp size={13} />
        </button>
        <button className="btn ghost icon sm" title="Refresh" onClick={refresh}>
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="fx-tree" role="tree" onScroll={() => setMenu(undefined)}>
        {rows(root, 0)}
      </div>
      {menu && <RowMenu at={menu} onClose={() => setMenu(undefined)} onPreview={onPreview} onOpen={onOpen} />}
    </>
  )
}

function RowMenu({
  at,
  onClose,
  onPreview,
  onOpen
}: {
  at: MenuAt
  onClose: () => void
  onPreview: (file: string) => void
  onOpen: (e: FileEntry) => void
}): ReactNode {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: at.x, top: at.y })
  const e = at.entry

  // Keep the menu on screen when opened near the bottom or right edge.
  useLayoutEffect(() => {
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    setPos({ left: Math.max(4, Math.min(at.x, window.innerWidth - r.width - 4)), top: Math.max(4, Math.min(at.y, window.innerHeight - r.height - 4)) })
    ref.current?.querySelector('button')?.focus()
  }, [at])

  useEffect(() => {
    const away = (ev: MouseEvent): void => {
      if (!ref.current?.contains(ev.target as Node)) onClose()
    }
    const key = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', away, true)
    document.addEventListener('keydown', key, true)
    window.addEventListener('blur', onClose)
    window.addEventListener('resize', onClose)
    return () => {
      document.removeEventListener('mousedown', away, true)
      document.removeEventListener('keydown', key, true)
      window.removeEventListener('blur', onClose)
      window.removeEventListener('resize', onClose)
    }
  }, [onClose])

  const item = (Icon: typeof File, label: string, run: () => void): ReactNode => (
    <button
      className="mi"
      onClick={() => {
        onClose()
        run()
      }}
    >
      <Icon size={14} />
      {label}
    </button>
  )

  return (
    <div ref={ref} className="menu fx-menu" role="menu" style={pos} onContextMenu={(ev) => ev.preventDefault()}>
      {item(Code, 'Open in VS Code', () => onOpen(e))}
      {e.dir ? item(FolderInput, 'Browse from here', () => setExplorerRoot(e.path)) : item(Eye, 'Preview', () => onPreview(e.path))}
      {e.dir && item(Terminal, 'Open terminal here', () => void newSideShell(undefined, e.path))}
      <div className="sep" />
      {item(FolderSearch, REVEAL, () => void api.reveal(e.path))}
      {item(Copy, 'Copy path', () =>
        navigator.clipboard.writeText(e.path).then(
          () => toast('Path copied'),
          () => toast('Could not copy path', 'error')
        )
      )}
    </div>
  )
}

/** Text view of a file beside the tree, syntax-coloured for known code types, or the image scaled to fit. Other binary files just get a note. */
function Preview({ file, onOpen, onClose }: { file: string; onOpen: (e: FileEntry) => void; onClose: () => void }): ReactNode {
  const [data, setData] = useState<FilePreview | { error: string }>()
  const [dims, setDims] = useState<string>()
  const [broken, setBroken] = useState(false)
  const name = baseName(file)
  const Icon = fileIcon(name)

  useEffect(() => {
    let live = true
    api.previewFile(file).then(
      (p) => live && setData(p),
      (e) => live && setData({ error: cleanError(e, 'file') })
    )
    return () => {
      live = false
    }
  }, [file])

  const text = data && 'text' in data ? data.text.replace(/\r\n?/g, '\n') : ''
  const html = useMemo(() => (text ? highlight(name, text) : undefined), [name, text])

  let body: ReactNode
  if (!data) body = <div className="fx-pv-note">Loading…</div>
  else if ('error' in data) body = <div className="fx-pv-note err">{data.error}</div>
  else if ('binary' in data) body = <div className="fx-pv-note">Binary file, no text preview.</div>
  else if ('image' in data) {
    if (!data.image) body = <div className="fx-pv-note">Image is too large to preview.</div>
    else if (broken) body = <div className="fx-pv-note err">Could not read this image.</div>
    else
      body = (
        <div className="fx-img">
          <img
            src={data.image}
            alt={name}
            draggable={false}
            onLoad={(e) => setDims(`${e.currentTarget.naturalWidth} × ${e.currentTarget.naturalHeight}`)}
            onError={() => setBroken(true)}
          />
        </div>
      )
  } else if (!text) body = <div className="fx-pv-note">Empty file</div>
  else {
    const lines = text.split('\n').length
    body = (
      <div className="fx-code">
        <pre className="fx-gutter" aria-hidden>
          {Array.from({ length: lines }, (_, i) => i + 1).join('\n')}
        </pre>
        {html === undefined ? (
          <pre className="fx-text">{text}</pre>
        ) : (
          // highlight.js escapes the source; only its own <span class="hljs-…"> tags are markup.
          <pre className="fx-text" dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </div>
    )
  }

  return (
    <section className="fx-preview" aria-label={`Preview of ${name}`}>
      <Resizer pane="preview" edge="right" />
      <div className="fx-pv-head">
        <Icon size={14} strokeWidth={1.75} className="fx-icon" />
        <span className="fx-pv-name" title={file}>
          {name}
        </span>
        {data && !('error' in data) && (
          <span className="fx-pv-size num">
            {dims && `${dims} · `}
            {formatSize(data.size)}
          </span>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn ghost icon sm" title="Open in VS Code" onClick={() => onOpen({ name, path: file, dir: false })}>
          <Code size={14} />
        </button>
        <button className="btn ghost icon sm" title={REVEAL} onClick={() => void api.reveal(file)}>
          <FolderSearch size={14} />
        </button>
        <button className="btn ghost icon sm" title="Close preview" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <div className="fx-pv-path mono" title={file}>
        {file}
      </div>
      {body}
      {data && 'truncated' in data && data.truncated && (
        <div className="fx-pv-foot">
          Showing the start of this {formatSize(data.size)} file. Open in VS Code for the rest.
        </div>
      )}
    </section>
  )
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

function cleanError(e: unknown, what: 'folder' | 'file'): string {
  const msg = String((e as Error)?.message ?? e)
  // "Error invoking remote method 'fs:list': Error: ENOENT: no such file or directory, scandir 'D:\x'"
  if (/ENOENT/.test(msg)) return what === 'folder' ? 'Folder not found' : 'File not found'
  if (/ENOTDIR/.test(msg)) return 'Not a folder'
  if (/EBUSY/.test(msg)) return 'File is locked by another program'
  if (/EPERM|EACCES/.test(msg)) return `No permission to read this ${what}`
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}
