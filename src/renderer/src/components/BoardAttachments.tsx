import { useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { File as FileIcon, FileText, FolderOpen, Paperclip, X } from 'lucide-react'
import type { BoardAttachment, BoardMessage } from '@shared/board'
import { attachmentKind, attachProblem, extOf, formatBytes, isShortcut, MAX_ATTACH_COUNT, MAX_ATTACH_FILE, MAX_ATTACH_TOTAL } from '@shared/board'
import { api } from '../api'
import { toast } from '../store'

// Attached files on the board (#147): the files waiting to go with the next message, the chips on a sent one, and
// the viewer an image opens in. The window reads each file when it is attached and main stores a copy on send, so
// later edits or deletes of the original don't matter. Nothing here uploads anything: it all stays on this PC.

export interface Staged {
  key: string
  name: string
  size: number
  data: Uint8Array
  /** a blob URL for an image's thumbnail */
  url?: string
}

export const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }

/** The quiet warning on the attach button, said once there and nowhere louder. */
export const ATTACH_TIP =
  `Attach files (or drop them on the board, or paste a screenshot). Up to ${MAX_ATTACH_COUNT} files, ${formatBytes(MAX_ATTACH_FILE)} each, ${formatBytes(MAX_ATTACH_TOTAL)} in all. ` +
  'Attached files are copied into Corvid and can be read by Corvid and any agent the message is addressed to. They stay on this PC and go when the message does.'

let seq = 0
const pad = (n: number): string => String(n).padStart(2, '0')

/** A pasted screenshot's name: when it was pasted, as the clipboard gives none worth keeping. */
export function pastedName(type: string): string {
  const d = new Date()
  const ext = Object.entries(MIME).find(([, m]) => m === type)?.[0] ?? 'png'
  return `pasted-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.${ext}`
}

/**
 * Read `files` into the list, one at a time, refusing any that is a folder, a shortcut or past a limit, with one
 * message for all that were refused. Resolves to the new list.
 */
export async function stageFiles(
  current: Staged[],
  files: { file: File; name?: string }[],
  /** what the limits are counted with besides `current` (a task's stored files, #187), and what they're for */
  opts: { have?: { name: string; size: number }[]; what?: string } = {}
): Promise<Staged[]> {
  const out = [...current]
  const refused: string[] = []
  for (const { file, name = file.name } of files) {
    if (isShortcut(name)) {
      refused.push(`${name} is a shortcut; attach the file it points to instead`)
      continue
    }
    const problem = attachProblem([...(opts.have ?? []), ...out, { name, size: file.size }], opts.what)
    if (problem) {
      refused.push(problem.replace(/\.$/, ''))
      continue
    }
    let data: Uint8Array
    try {
      // a folder (dropped from Explorer) can't be read like this, which is how it's told apart
      data = new Uint8Array(await file.arrayBuffer())
    } catch {
      refused.push(`${name} is a folder or can't be read; attach the files inside it instead`)
      continue
    }
    const mime = MIME[extOf(name)]
    out.push({ key: `a${++seq}`, name, size: data.byteLength, data, url: mime ? URL.createObjectURL(new Blob([data as BlobPart], { type: mime })) : undefined })
  }
  if (refused.length) toast(`Not attached: ${refused.join('; ')}.`, 'error')
  return out
}

/** Dropped files, with any folder refused by name before anything is read (it can't be attached). */
export function droppedFiles(e: { dataTransfer: DataTransfer }): File[] {
  const items = [...e.dataTransfer.items]
  const folders = items.map((it) => it.webkitGetAsEntry?.()).filter((x) => x?.isDirectory).map((x) => x!.name)
  if (folders.length) toast(`Not attached: ${folders.join(', ')} ${folders.length === 1 ? 'is a folder' : 'are folders'}; attach the files inside instead.`, 'error')
  return [...e.dataTransfer.files].filter((f) => !folders.includes(f.name))
}

/** A paste that is only files (a screenshot, #147): them, with a pasted image named for when it was pasted; else none. */
export function pastedFiles(e: { clipboardData: DataTransfer }): { file: File; name: string }[] {
  const pasted = [...e.clipboardData.files]
  if (!pasted.length || e.clipboardData.getData('text/plain')) return []
  return pasted.map((file) => ({ file, name: file.type.startsWith('image/') ? pastedName(file.type) : file.name }))
}

export const releaseStaged = (list: Staged[]): void => list.forEach((s) => s.url && URL.revokeObjectURL(s.url))

/** The files waiting above the message box: name, size and a remove button each; they wrap on a narrow board. */
export function StagedChips({ files, onRemove }: { files: Staged[]; onRemove: (key: string) => void }): ReactNode {
  if (!files.length) return null
  const total = files.reduce((s, f) => s + f.size, 0)
  return (
    <div className="mb-attach-row" role="list" aria-label={`${files.length} attached file${files.length === 1 ? '' : 's'}, ${formatBytes(total)}`}>
      {files.map((f) => (
        <span key={f.key} className="mb-att staged" role="listitem">
          {f.url ? <img className="mb-att-thumb" src={f.url} alt="" /> : <KindIcon kind={attachmentKind(f.name)} />}
          <span className="mb-att-name" title={f.name}>
            {f.name}
          </span>
          <span className="mb-att-size">{formatBytes(f.size)}</span>
          <button className="btn ghost icon xs" title={`Remove ${f.name}`} aria-label={`Remove ${f.name}`} onClick={() => onRemove(f.key)}>
            <X size={11} />
          </button>
        </span>
      ))}
    </div>
  )
}

export const KindIcon = ({ kind }: { kind: BoardAttachment['kind'] }): ReactNode =>
  kind === 'text' ? <FileText size={13} aria-hidden /> : <FileIcon size={13} aria-hidden />

/** The paperclip: opens the file picker, several files at once. It is also the keyboard way in, instead of dropping. */
export function AttachButton({ onFiles, disabled, tip = ATTACH_TIP }: { onFiles: (files: File[]) => void; disabled?: boolean; tip?: string }): ReactNode {
  const input = useRef<HTMLInputElement>(null)
  return (
    <>
      <button className="btn ghost icon mb-attach-btn" data-tip={tip} aria-label="Attach files" disabled={disabled} onClick={() => input.current?.click()}>
        <Paperclip size={15} />
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const list = [...(e.target.files ?? [])]
          e.target.value = ''
          if (list.length) onFiles(list)
        }}
      />
    </>
  )
}

/** An image's bytes, fetched once per message and file while the window is open. */
const urls = new Map<string, Promise<string>>()
function imageUrl(id: number, index: number, name: string): Promise<string> {
  const key = `${id}:${index}`
  let p = urls.get(key)
  if (!p) {
    p = api.boardAttachment(id, index).then((data) => URL.createObjectURL(new Blob([data as BlobPart], { type: MIME[extOf(name)] ?? 'application/octet-stream' })))
    p.catch(() => urls.delete(key))
    urls.set(key, p)
  }
  return p
}

function Thumb({ m, index, att, onOpen }: { m: BoardMessage; index: number; att: BoardAttachment; onOpen: (url: string) => void }): ReactNode {
  const [url, setUrl] = useState<string>()
  const [gone, setGone] = useState(false)
  useEffect(() => {
    let live = true
    imageUrl(m.id, index, att.name).then(
      (u) => live && setUrl(u),
      () => live && setGone(true)
    )
    return () => {
      live = false
    }
  }, [m.id, index])
  return (
    <button
      className="mb-att image"
      title={gone ? `${att.name} is gone` : `${att.name} (${formatBytes(att.size)}) · open larger`}
      aria-label={`Open ${att.name}, ${formatBytes(att.size)}`}
      disabled={gone || !url}
      onClick={() => url && onOpen(url)}
    >
      {url ? <img className="mb-att-img" src={url} alt="" /> : <span className="mb-att-img empty" />}
    </button>
  )
}

/** The files on a sent message: images as small thumbnails that open larger, the rest as chips that show the file in its folder. */
export function MessageAttachments({ m }: { m: BoardMessage }): ReactNode {
  const [view, setView] = useState<{ url: string; name: string }>()
  if (!m.attachments?.length) return null
  const reveal = (i: number): void => {
    api.boardRevealAttachment(m.id, i).catch((e) => toast(String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error'))
  }
  return (
    <div className="mb-attach-row sent" role="list" aria-label="Attached files">
      {m.attachments.map((a, i) =>
        a.kind === 'image' ? (
          <span role="listitem" key={i}>
            <Thumb m={m} index={i} att={a} onOpen={(url) => setView({ url, name: a.name })} />
          </span>
        ) : (
          <span role="listitem" key={i}>
            <button className="mb-att" title={`Show ${a.name} in its folder (it is never opened or run from here)`} onClick={() => reveal(i)}>
              <KindIcon kind={a.kind} />
              <span className="mb-att-name">{a.name}</span>
              <span className="mb-att-size">{formatBytes(a.size)}</span>
              <FolderOpen size={12} aria-hidden />
            </button>
          </span>
        )
      )}
      {view && <ImageViewer url={view.url} name={view.name} onClose={() => setView(undefined)} />}
    </div>
  )
}

/** An attached image, larger, over the window; Esc, the close button or a click outside closes it. */
export function ImageViewer({ url, name, onClose }: { url: string; name: string; onClose: () => void }): ReactNode {
  const close = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    close.current?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      back?.focus()
    }
  }, [])
  return createPortal(
    <div className="mb-viewer" role="dialog" aria-modal="true" aria-label={name} onClick={onClose}>
      <figure onClick={(e) => e.stopPropagation()}>
        <img src={url} alt={name} />
        <figcaption>
          <span>{name}</span>
          <button ref={close} className="btn ghost icon xs" title="Close (Esc)" aria-label="Close" onClick={onClose}>
            <X size={13} />
          </button>
        </figcaption>
      </figure>
    </div>,
    document.body
  )
}
