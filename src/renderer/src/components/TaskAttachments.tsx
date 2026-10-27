import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { FolderOpen, Paperclip, X } from 'lucide-react'
import type { BoardAttachment } from '@shared/board'
import type { Task } from '@shared/types'
import { extOf, formatBytes, MAX_ATTACH_COUNT, MAX_ATTACH_FILE, MAX_ATTACH_TOTAL } from '@shared/board'
import { api } from '../api'
import { getState, toast, useStore } from '../store'
import { AttachButton, droppedFiles, ImageViewer, KindIcon, MIME, pastedFiles, releaseStaged, StagedChips, stageFiles, type Staged } from './BoardAttachments'

// Files attached to a task (#187), built on the board's (#147): the same limits, chips, viewer, drop and paste. A task's
// files are stored as soon as they're attached (a new task's wait until it's added); Corvid keeps copies, never the originals.

/** The quiet warning on the task's attach button, said once there and nowhere louder. */
export const TASK_ATTACH_TIP =
  `Attach files (or drop them on the task or its card, or paste a screenshot). Up to ${MAX_ATTACH_COUNT} files, ${formatBytes(MAX_ATTACH_FILE)} each, ${formatBytes(MAX_ATTACH_TOTAL)} in all. ` +
  'Attached files are copied into Corvid and can be read by Corvid and any agent that takes the task. They stay on this PC and go when the task is removed.'

const cleanError = (e: unknown): string => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const hasFiles = (e: DragEvent): boolean => [...e.dataTransfer.types].includes('Files')

/** Dropping files on an element: the props to spread on it, and whether files are over it now (for the highlight).
 *  Anything that isn't files (a card being dragged between columns) passes straight through. */
export function useFileDrop(onFiles: (files: File[]) => void): { dropping: boolean; props: Record<string, (e: DragEvent) => void> } {
  const [dropping, setDropping] = useState(false)
  const depth = useRef(0)
  return {
    dropping,
    props: {
      onDragEnter: (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        depth.current++
        setDropping(true)
      },
      onDragOver: (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        e.dataTransfer.dropEffect = 'copy'
      },
      onDragLeave: (e) => {
        if (!hasFiles(e)) return
        if (--depth.current <= 0) {
          depth.current = 0
          setDropping(false)
        }
      },
      onDrop: (e) => {
        if (!hasFiles(e)) return
        e.preventDefault()
        e.stopPropagation()
        depth.current = 0
        setDropping(false)
        const files = droppedFiles(e)
        if (files.length) onFiles(files)
      }
    }
  }
}

/** Files read and stored onto a task one batch after another, so two quick drops don't both slip under a limit. */
let queue = Promise.resolve()
export function attachToTask(t: Task, files: { file: File; name?: string }[]): Promise<void> {
  queue = queue.then(async () => {
    const have = getState().tasks.find((x) => x.id === t.id)?.attachments ?? []
    const staged = await stageFiles([], files, { have, what: 'one task' })
    if (!staged.length) return
    try {
      await api.addTaskFiles(t.id, staged.map((s) => ({ name: s.name, data: s.data })))
    } catch (e) {
      toast(`Not attached: ${cleanError(e)}`, 'error')
    } finally {
      releaseStaged(staged)
    }
  })
  return queue
}

/** An image's bytes, fetched once per task and file while the window is open. */
const urls = new Map<string, Promise<string>>()
function imageUrl(id: number, index: number, att: BoardAttachment): Promise<string> {
  const key = `${id}:${att.name}:${att.size}`
  let p = urls.get(key)
  if (!p) {
    p = api.taskFileImage(id, index).then((data) => URL.createObjectURL(new Blob([data as BlobPart], { type: MIME[extOf(att.name)] ?? 'application/octet-stream' })))
    p.catch(() => urls.delete(key))
    urls.set(key, p)
  }
  return p
}

function Thumb({ id, index, att }: { id: number; index: number; att: BoardAttachment }): ReactNode {
  const [url, setUrl] = useState<string>()
  useEffect(() => {
    let live = true
    imageUrl(id, index, att).then(
      (u) => live && setUrl(u),
      () => {}
    )
    return () => {
      live = false
    }
  }, [id, att.name, att.size])
  return url ? <img className="mb-att-thumb" src={url} alt="" /> : <KindIcon kind="file" />
}

/** A task's stored files as chips: open (an image in the viewer, anything else shown in its folder) and remove, each a button. */
export function TaskFileChips({ t }: { t: Task }): ReactNode {
  const [view, setView] = useState<{ url: string; name: string }>()
  const list = t.attachments ?? []
  if (!list.length) return null
  const open = (i: number, a: BoardAttachment): void => {
    if (a.kind === 'image')
      imageUrl(t.id, i, a).then(
        (url) => setView({ url, name: a.name }),
        (e) => toast(cleanError(e), 'error')
      )
    else api.revealTaskFile(t.id, i).catch((e) => toast(cleanError(e), 'error'))
  }
  const remove = (i: number): void => void api.removeTaskFile(t.id, i).catch((e) => toast(cleanError(e), 'error'))
  const total = list.reduce((s, a) => s + a.size, 0)
  return (
    <div className="mb-attach-row task-files" role="list" aria-label={`${list.length} attached file${list.length === 1 ? '' : 's'}, ${formatBytes(total)}`}>
      {list.map((a, i) => (
        <span key={a.name} className="mb-att staged" role="listitem">
          <button
            className="task-file-open"
            title={a.kind === 'image' ? `${a.name} (${formatBytes(a.size)}) · open larger` : `Show ${a.name} in its folder (it is never opened or run from here)`}
            aria-label={a.kind === 'image' ? `Open ${a.name}, ${formatBytes(a.size)}` : `Show ${a.name}, ${formatBytes(a.size)}, in its folder`}
            onClick={() => open(i, a)}
          >
            {a.kind === 'image' ? <Thumb id={t.id} index={i} att={a} /> : <KindIcon kind={a.kind} />}
            <span className="mb-att-name">{a.name}</span>
            <span className="mb-att-size">{formatBytes(a.size)}</span>
            {a.kind !== 'image' && <FolderOpen size={12} aria-hidden />}
          </button>
          <button className="btn ghost icon xs" title={`Remove ${a.name} from the task`} aria-label={`Remove ${a.name}`} onClick={() => remove(i)}>
            <X size={11} />
          </button>
        </span>
      ))}
      {view && <ImageViewer url={view.url} name={view.name} onClose={() => setView(undefined)} />}
    </div>
  )
}

/**
 * The editor's Files row: the paperclip, and the task's files as chips. An existing task's files are stored straight
 * away; a new task's wait in `staged` until it's added (TaskEditor passes them on then).
 */
export function TaskFilesField({ id, staged, setStaged }: { id?: number; staged: Staged[]; setStaged: (next: Staged[]) => void }): ReactNode {
  const t = useStore((s) => (id === undefined ? undefined : s.tasks.find((x) => x.id === id)))
  const count = (t?.attachments?.length ?? 0) + staged.length
  return (
    <div className="task-files-field">
      <div className="task-files-head">
        <span className="section-label">Files{count ? ` (${count})` : ''}</span>
        <AttachButton tip={TASK_ATTACH_TIP} onFiles={(files) => addToEditor(t, files.map((file) => ({ file })), staged, setStaged)} />
      </div>
      {t && <TaskFileChips t={t} />}
      <StagedChips
        files={staged}
        onRemove={(key) => {
          releaseStaged(staged.filter((f) => f.key === key))
          setStaged(staged.filter((f) => f.key !== key))
        }}
      />
    </div>
  )
}

/** Files attached in the editor (picker, drop or paste): onto the task when it exists, else into the new task's list. */
export function addToEditor(t: Task | undefined, files: { file: File; name?: string }[], staged: Staged[], setStaged: (next: Staged[]) => void): void {
  if (t) void attachToTask(t, files)
  else void stageFiles(staged, files, { what: 'one task' }).then(setStaged)
}

export { pastedFiles }

/** The card's quiet sign that a task has files: a paperclip and how many, never the chips themselves. */
export function TaskFilesBadge({ t }: { t: Task }): ReactNode {
  const n = t.attachments?.length ?? 0
  if (!n) return null
  const total = t.attachments!.reduce((s, a) => s + a.size, 0)
  return (
    <span className="tc-files" title={`${n} attached file${n === 1 ? '' : 's'}, ${formatBytes(total)}: ${t.attachments!.map((a) => a.name).join(', ')}`}>
      <Paperclip size={11} aria-label={`${n} attached file${n === 1 ? '' : 's'}`} /> {n}
    </span>
  )
}
