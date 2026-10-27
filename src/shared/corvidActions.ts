import { baseName } from './projects'

// What Corvid did in a turn, in the user's words: the "what I did" line under its board reply.
// Reads that only looked something up are left out there (see `quiet`), so the line lists real actions.

/** Look-ups that change nothing: left off the reply's "what I did" line. */
const QUIET = new Set([
  'overview',
  'list_tasks',
  'list_projects',
  'project_details',
  'search_sessions',
  'recent_sessions',
  'session_details',
  'usage',
  'list_workers',
  'list_notes',
  'read_note',
  'read_messages',
  'Read',
  'Grep',
  'Glob'
])

export const quietTool = (name: string): boolean => QUIET.has(name)

/** `result` tells a proposal from a start for start_worker. */
export function toolLabel(name: string, input: any, result = ''): string {
  const i = input ?? {}
  switch (name) {
    case 'overview':
      return 'Checked the overview'
    case 'list_tasks':
      return 'Read the task board'
    case 'create_task':
      return `Created task “${i.title ?? ''}”`
    case 'update_task':
      return `Updated #${i.id}`
    case 'finish_task':
      return `${i.outcome === 'done' ? 'Completed' : 'Discarded'} #${i.id}`
    case 'list_projects':
      return 'Read projects'
    case 'project_details':
      return `Looked at ${i.project}`
    case 'search_sessions':
      return `Searched transcripts for “${i.query}”`
    case 'recent_sessions':
      return 'Read recent sessions'
    case 'session_details':
      return 'Read a session'
    case 'usage':
      return 'Checked usage'
    case 'list_workers':
      return 'Checked workers'
    case 'start_worker':
      return `${/^Proposed/.test(result) ? 'Proposed' : 'Started'} a worker for #${i.task_id}`
    case 'stop_worker':
      return 'Stopped a worker'
    case 'show':
      return `Opened ${i.project ?? i.view}`
    case 'create_note':
      return `Left a note “${i.name ?? ''}”`
    case 'append_to_note':
      return `Added to ${i.note ?? 'a note'}`
    case 'update_note':
      return `Updated ${i.note ?? 'a note'}`
    case 'delete_note':
      return `Deleted ${i.note ?? 'a note'}`
    case 'post_message':
      return 'Posted on the board'
    case 'Read':
      return `Read ${baseName(String(i.file_path ?? 'a file'))}`
    case 'Grep':
      return `Searched files for “${i.pattern}”`
    case 'Glob':
      return `Listed ${i.pattern}`
    default:
      return name
  }
}
