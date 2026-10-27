---
title: Guided tours
summary: How to run a guided tour, and how to write your own as one JSON file.
section: getting-started
order: 7
---

# Guided tours

A guided tour is a short walk through Corvid. The crow flies to a part of the screen and perches next to it. A speech
bubble tells you what that part does.

## Run a tour

There are four ways to start a tour:

- **The first-run card.** The first time Corvid starts, a card asks "Want a quick tour?". It offers the tour "Your
  first day". The card shows only once.
- **The board chip.** On an empty board, the chip **Show me around** under the message box starts "Your first day".
- **The Docs view.** The page list has a **Guided tours** group. It lists every tour, built-in and your own. Click one
  to run it again.
- **The ? button.** The **?** button at the right end of the title bar opens a menu of every tour, built-in and
  your own. A finished tour has a check mark. Click a tour to run it.

In the **?** menu:

- **Esc** or a click outside closes it.
- With the keyboard, **Tab** to the button and press **Enter**. The arrow keys move, **Enter** picks.
- The button is there with **Offer tours** off too.

The last entry in the menu, **Ask Corvid to explain something…**, opens the message box addressed to Corvid with
"Explain " in it. Type the feature you want explained and send it. See [Ask Corvid for a tour](#ask-corvid-for-a-tour).

In a tour:

- **Next** goes to the next step. **Back** goes to the step before.
- **Skip**, the close button or **Esc** ends the tour at once.
- Some steps are hands-on. They wait for you to do the thing, like adding a task. They move on by themselves when you
  do it. **Skip this step** moves on without it.
- Nothing is blocked. You can click anywhere in Corvid during a tour.
- In a narrow Agents view, which shows the cards or the board, the tour switches to the half the step points at.

If the mascot is off, the crow flies in for the tour and leaves after. With reduced motion turned on in your system,
the crow does not fly. The bubble appears next to the part it explains.

To stop the offers, turn off **Offer tours** in Settings. The tours stay in the Docs view and in the **?** menu.

## The built-in tours

| Tour | What it shows |
|---|---|
| **Your first day** | The daily loop: a project, a task, a worker, the board, merge and Done. 8 steps. |
| **Who knows what** | How context moves between agents. 8 steps, for users who already know the daily loop. |

"Who knows what" covers:

- What a worker starts with: the task's title and notes, the files attached to the task, the project's
  `CLAUDE.md`, Corvid's rules and the "What Corvid is" text. Each new worker starts fresh.
- What a worker can pick up while it works: notes, and the board when it reads it. Your @mention of a worker is
  typed into its terminal.
- Corvid the assistant: the one long-lived agent. It sees every project and does not do the work itself.
- How work outlives the worker: the done post, notes and the merge.
- Why the board is information and never permission.
- The Context cloud: the project list, a worker's "started with" edges, and the coral tint for a node from another
  project.

The first time you open the Context cloud, a line at its top right offers "Who knows what", once. It shows only
with **Offer tours** on and after the first-run card was answered. Finishing the tour from the Docs view also
stops the offer.

## Ask Corvid for a tour

Corvid the assistant can make a short tour for you on the spot. Ask it on the message board, for example "where are
the usage limits?" or "how do I start a worker?". When a tour helps more than a long answer, it writes one and plays
it at once.

You can also ask Corvid to explain a feature, for example "explain the Context cloud", "what is a worker?" or "what
does the Done column do?". Corvid answers in one or two sentences on the board. When a part of the screen fits the
question, it also plays a short tour of it. When nothing on the screen fits, it answers in text only.

- A tour made this way has 3 to 6 steps, at most 8. It uses the same format and anchors as a tour file.
- It only points and explains. It never clicks, types, changes data or starts anything.
- If a tour is already playing, the new tour replaces it.
- The tour is not kept. To keep it, say so, for example "save that tour". Corvid then writes it to the `tours`
  folder, and it shows in the Guided tours group in the Docs view. Its id starts with `my-`. Corvid never saves a
  tour unless you ask.
- A turn that an agent's ping started cannot play or save a tour. Workers cannot make tours.

To remove a kept tour, delete its file from the `tours` folder.

## Write a tour

A tour is one JSON file. It is data, not code. To add a tour, add one file. Nothing else changes.

Put your own tours in the `tours` folder in Corvid's data folder. The link **Open the tours folder** at the end of
the Guided tours group in the Docs view opens it. Corvid reads the folder at start-up and each time the Docs view
opens. A file that is not a valid tour is skipped, and a notice names it.

Built-in tours are in `src/renderer/src/tours` in the source. Each file is one tour.

### The format

```json
{
  "format": 1,
  "id": "my-tour",
  "title": "My tour",
  "summary": "One line about what the tour shows.",
  "steps": [
    { "anchor": "nav.tasks", "text": "This opens the task board." },
    { "anchor": "board.add-task", "view": "tasks", "advance": "task-created", "text": "Add a task here." }
  ]
}
```

| Field | What it is |
|---|---|
| `format` | Always `1`. A later format gets a new number, so an old file is never read wrong. |
| `id` | Lowercase letters, digits and dashes. It must not be the id of a built-in tour. |
| `title` | The name in the list. At most 60 characters. |
| `summary` | One line for the list. At most 160 characters. |
| `steps` | 1 to 12 steps. |

Each step has these fields:

| Field | What it is |
|---|---|
| `anchor` | Where the crow goes: a name from the anchor list below. Not a CSS selector. |
| `text` | What the bubble says. Plain text, one or two sentences, at most 240 characters. |
| `view` | Optional. The view to open first: `terminals` (Agents), `tasks`, `usage`, `projects`, `notes`, `settings`, `connections`, `extensions`, `docs` or `lineage` (the Context cloud). |
| `advance` | Optional. `next` (the default) shows a Next button. An event name makes a hands-on step that waits for the event. |

The events are:

- `task-created`: a new task is on the board.
- `worker-started`: a worker started.
- `worker-done`: a worker finished.
- `view-opened:<view>`: the user opened that view, like `view-opened:notes`.

Any other event name is an error. If the anchor is not on the screen when the step runs, the bubble shows in the
middle of the window with a Next button. The tour never stops.

### The anchors

| Anchor | What it points at |
|---|---|
| `nav.terminals` | The Agents entry in the left rail: running agents and the message board. |
| `nav.tasks` | The Tasks entry in the left rail: the task board. |
| `nav.usage` | The Usage entry in the left rail: plan limits and spend. |
| `nav.projects` | The Projects entry in the left rail: every project folder Corvid knows. |
| `nav.notes` | The Notes entry in the left rail: shared notes for the user and agents. |
| `nav.connections` | The Connections entry in the left rail: remote systems and APIs. |
| `nav.extensions` | The Extensions entry in the left rail: .corvid files. |
| `nav.docs` | The Docs entry in the left rail: the built-in documentation. |
| `nav.lineage` | The Context cloud entry in the left rail: how context moves between agents. |
| `nav.settings` | The Settings button at the bottom of the left rail. |
| `board.columns` | The task board columns, from Backlog to Done. |
| `board.add-task` | The button that adds a new task to the board. |
| `board.done-column` | The Done column, where merged tasks end up. |
| `task.start-worker` | The control on a task card that starts a worker (an agent) on it. |
| `agents.view` | The Agents view: running agents as cards, with the message board beside them. |
| `agents.worker-card` | One worker card in the Agents view: its status, task and terminal. |
| `messages.box` | The message box under the board, for posting to agents and Corvid. |
| `messages.board` | The message board, where agents post when they start and finish. |
| `messages.corvid` | The Corvid strip at the top of the board: the assistant, its state and model. |
| `notes.view` | The Notes view: notes that agents and the user share. |
| `context.cloud` | The Context cloud: a 3D picture of what each agent read and wrote. |
| `context.project-filter` | The project list in the Context cloud bar: one project and what crossed into it. |
| `context.legend` | The Context cloud legend: node kinds, and with a project picked, the other-project and shared tints. |
| `titlebar.tours` | The "?" button at the right end of the title bar: replay any tour, or ask Corvid to explain. |
| `settings.view` | The Settings view. |
| `usage.view` | The Usage view: the 5-hour and weekly bars. |
