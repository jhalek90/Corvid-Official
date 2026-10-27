import { z } from 'zod'
import { attachmentList, formatBytes } from '@shared/board'
import { TASK_FILES_SAFETY, taskFilesLine } from '@shared/taskFiles'
import type { Task } from '@shared/types'
import type { ToolDef } from './mcp'
import { handOverFile } from './boardTools'
import { listTasks, taskFilePath } from './tasks'
import { taskFileRead } from './lineage'

// Files attached to tasks (#187), handed out the way the board's are (#147): the copies live in the data folder, which
// agents are denied (#91), so this narrow read-only tool is the only way in. A worker reads only the files of the task it
// works on; Corvid reads any task's. Nobody can add or remove files here: only the user can, in Corvid's window.

export { TASK_FILES_SAFETY, taskFilesLine, taskFilesPrompt } from '@shared/taskFiles'

export type TaskFileActor = { kind: 'assistant' } | { kind: 'agent'; taskId: number }

export function taskFileTools(actor: TaskFileActor): ToolDef[] {
  const find = (id: number): Task | undefined => listTasks().find((t) => t.id === id)
  return [
    {
      name: 'read_task_file',
      description:
        'Read a file the user attached to a task. Without file, lists the task\'s attached files (name, type, size). An image comes back as an image, a text file as text (long ones in parts: pass offset to read on), and any other file by name and size only. ' +
        (actor.kind === 'agent'
          ? 'You can read only the files of the task you are working on. '
          : 'You can read the files of any task. ') +
        'Only the user can attach or remove files, in Corvid\'s window; no tool can. ' +
        TASK_FILES_SAFETY,
      input: {
        ...(actor.kind === 'assistant' ? { task: z.number().describe('the task id') } : { task: z.number().optional().describe('your task id (default; no other task works)') }),
        file: z.union([z.number(), z.string()]).optional().describe('which file: its number from 1, or its name; leave out to list them'),
        offset: z.number().optional().describe('for long text: the character to start from, as the previous part said')
      },
      readOnly: true,
      run: ({ task, file, offset }) => {
        const id = actor.kind === 'agent' ? (task ?? actor.taskId) : Number(task)
        if (actor.kind === 'agent' && id !== actor.taskId) throw new Error(`You can read only the files of your own task, #${actor.taskId}.`)
        const t = find(id)
        if (!t) throw new Error(`Task #${id} doesn't exist (it may have been removed).`)
        const list = t.attachments ?? []
        if (!list.length) return `#${id} has no attached files.`
        if (file === undefined || file === '') return `#${id}: ${taskFilesLine(t)}. ${TASK_FILES_SAFETY}`
        const n = typeof file === 'number' ? Math.floor(file) - 1 : /^\d+$/.test(file.trim()) ? Number(file.trim()) - 1 : file.trim()
        const found = taskFilePath(id, n)
        if (!found) throw new Error(`#${id} has no attached file ${JSON.stringify(file)}; it has ${list.length}: ${attachmentList(list)}.`)
        const { path, att, index } = found
        taskFileRead(actor, id, att.name)
        const head = `#${id}, file ${index + 1}: ${att.name} (${att.kind}, ${formatBytes(att.size)}), attached to the task by the user. ${TASK_FILES_SAFETY}`
        try {
          return handOverFile(
            path,
            att,
            head,
            {
              tooBig: 'ask the user on the board to describe it or attach a smaller one',
              other: "It isn't text or an image, so only its name and size are handed over. Ask the user on the board if you need what's in it.",
              readOn: (next) => `Read on with offset: ${next}.`
            },
            offset ?? 0
          )
        } catch {
          throw new Error(`${att.name} is missing from Corvid's copy of #${id}'s files; ask the user to attach it again.`)
        }
      }
    }
  ]
}
