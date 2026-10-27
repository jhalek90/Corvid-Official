// The places a guided tour can point at (#214): one name per element, by meaning, never by layout or a CSS selector.
// Each element carries data-tour="<name>" in the renderer. This list is the whole vocabulary a tour may use: the
// validator in tours.ts checks steps against it, scripts/test-tours.mjs checks every name is in the renderer source,
// and a tour written on the fly gets this list as its menu.

export interface TourAnchor {
  name: string
  /** one line: what the element is, for tour authors */
  about: string
}

export const TOUR_ANCHORS: readonly TourAnchor[] = [
  { name: 'nav.terminals', about: 'The Agents entry in the left rail: running agents and the message board.' },
  { name: 'nav.tasks', about: 'The Tasks entry in the left rail: the task board.' },
  { name: 'nav.usage', about: 'The Usage entry in the left rail: plan limits and spend.' },
  { name: 'nav.projects', about: 'The Projects entry in the left rail: every project folder Corvid knows.' },
  { name: 'nav.notes', about: 'The Notes entry in the left rail: shared notes for the user and agents.' },
  { name: 'nav.connections', about: 'The Connections entry in the left rail: remote systems and APIs.' },
  { name: 'nav.extensions', about: 'The Extensions entry in the left rail: .corvid files.' },
  { name: 'nav.docs', about: 'The Docs entry in the left rail: the built-in documentation.' },
  { name: 'nav.lineage', about: 'The Context cloud entry in the left rail: how context moves between agents.' },
  { name: 'nav.settings', about: 'The Settings button at the bottom of the left rail.' },
  { name: 'board.columns', about: 'The task board columns, from Backlog to Done.' },
  { name: 'board.add-task', about: 'The button that adds a new task to the board.' },
  { name: 'board.done-column', about: 'The Done column, where merged tasks end up.' },
  { name: 'task.start-worker', about: 'The control on a task card that starts a worker (an agent) on it.' },
  { name: 'agents.view', about: 'The Agents view: running agents as cards, with the message board beside them.' },
  { name: 'agents.worker-card', about: 'One worker card in the Agents view: its status, task and terminal.' },
  { name: 'messages.box', about: 'The message box under the board, for posting to agents and Corvid.' },
  { name: 'messages.board', about: 'The message board, where agents post when they start and finish.' },
  { name: 'messages.corvid', about: 'The Corvid strip at the top of the board: the assistant, its state and model.' },
  { name: 'notes.view', about: 'The Notes view: notes that agents and the user share.' },
  { name: 'context.cloud', about: 'The Context cloud: a 3D picture of what each agent read and wrote.' },
  { name: 'context.project-filter', about: 'The project list in the Context cloud bar: one project and what crossed into it.' },
  { name: 'context.legend', about: 'The Context cloud legend: node kinds, and with a project picked, the other-project and shared tints.' },
  { name: 'titlebar.tours', about: 'The "?" button at the right end of the title bar: replay any tour, or ask Corvid to explain.' },
  { name: 'settings.view', about: 'The Settings view.' },
  { name: 'usage.view', about: 'The Usage view: the 5-hour and weekly bars.' }
]

export const TOUR_ANCHOR_NAMES: ReadonlySet<string> = new Set(TOUR_ANCHORS.map((a) => a.name))
