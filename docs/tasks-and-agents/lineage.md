---
title: The Context cloud
summary: A 3D node graph of where each agent's context came from and what it left behind.
section: tasks-and-agents
order: 8
---

# The Context cloud

The Context cloud draws a provenance graph in 3D: what each worker was given at its start, what it read, and what
it left behind. It is a picture to look at and poke, not a report. It is read-only: nothing in it changes a
prompt, a note or a task.

## What it shows

The graph is a force-directed cloud of nodes on a dark background. Connected nodes pull together, the rest
drift apart, and the whole thing turns slowly until you touch it.

- **Sources** are amber octahedra: the task's title and notes, the files attached to the task, the project's
  `CLAUDE.md`, Corvid's worker rules, the "What Corvid is" page, and any instructions typed at start.
- **Agents** are cyan spheres, one per worker run, named by agent name and task id. Corvid the assistant is one
  large pale sphere at the centre.
- **Artifacts** are cubes: notes and board posts in green, done posts and the project's main branch in a brighter
  green. A note of your own is rose. A note or post that no longer exists is grey.

A node's size follows how many edges it has, with a floor so a lone node still shows. Time shows as brightness:
the newest nodes are brightest and the oldest fade towards the background.

Edges are faint lines. A "read" or "wrote" edge carries a small particle that moves in the direction of the flow.
"Started with" edges are fainter than the rest. The **Straight / Curved** switch in the bar draws them as straight
lines (the default) or as gentle curves that bend a fixed way per edge, so parallel edges fan apart; the particles
follow, nothing else changes, and the choice is kept across restarts.

## Live updates

The view updates while it is open. Corvid pushes new log events to it about once a second, and new notes and
posts come from the store, so a worker's start, its reads and its done post appear as they happen. New nodes land
next to the node they attach to and the layout settles around them; nothing already placed jumps. A node that
has just arrived pulses once. A worker that is running breathes, a slow change of size, until it ends.

An edge
whose event has just happened draws at full brightness with a denser, faster particle stream for 10 seconds,
with both its ends at full brightness, then eases back over the next 10 seconds; a running worker's "started
with" edges stay at the neighbour level. With a node picked, an active edge outside the pick still shows at
60%.

Events that arrive while the view is hidden are applied in one step when it shows again, without the pulse
or the highlight. With `prefers-reduced-motion` set there is no pulse and no breathing: nodes appear and edges
only brighten and fade.

## Looking around

Drag to orbit, scroll to zoom, right-drag to pan. The view turns on its own after a few seconds without a touch.

Hover a node for its kind, name, task id and time. Click a node to pick it: the picked node shows at full
brightness, its neighbours and the edges to them at 90%, and everything else, nodes, edges and particles, at 20%.
The time fade still applies inside each level, so an old neighbour is dimmer than a new one and never above 90%.
Clearing the pick brings everything back to its normal brightness.

The panel on the right opens with the pick. For an agent it shows the context receipt: each input with its origin and its size
in characters, then everything it read and wrote, in time order. For a note or a post it shows who wrote it, and
which agents read it and when. For a source it shows who was handed it. Click the node again, or empty space, to
clear the pick.

## Filter

The view shows the last 30 days by default. Pick **Last 7 days** or **All time** in the range list. To see one
task, type its id in the task box or pick it from the list. With a task picked, the view shows the task's agents,
what they touched, and whoever touched the task's notes and posts.

The project list holds **All projects** and every project a worker has started in or merged into since logging
began. Corvid spans projects, and workers are meant to stay in theirs: their start is, but notes and the board are
shared, so context can cross. The project view makes those crossings visible.

With a project picked, the view shows that project's workers, their task sources, the project's `CLAUDE.md` and
main, and everything those workers read or wrote, one hop out, wherever it lives. Other projects' workers are left
out, and so is anything reachable only through them. The choice is kept across restarts. A task already implies
its project, so the project list is disabled while a task is picked. Project paths are compared without case and
without trailing slashes.

In a project view two tints mark what crossed in, with a legend line for each:

- **Other project**, coral: a node that belongs to another project, which is nearly always a note or a board post
  written by a worker there and read by a worker here. That is the strongest sign of context crossing between
  projects, so it is loud on purpose.
- **Shared**, a quiet grey-violet: a node whose project cannot be known, so it belongs to everyone: Corvid, the
  worker rules, the "What Corvid is" page, and your own notes and posts.

The hover tip and the panel say which one applies. Live updates respect the filter: a worker of another project
starting or reading never appears, and Corvid or a worker of no known project only appears when it touches a node
the view already shows. The tints are a look only; nothing is logged for them.

The graph stops at 2000 nodes. Past that the oldest are left out and a note in the corner says how many. With
more than 500 edges only some of the read and wrote edges carry a particle.

## Where the data comes from

Notes, board messages and tasks give the artifact nodes and the "wrote" edges. They need no new logging.

The rest comes from a lineage log: `lineage.jsonl` in Corvid's data folder, one JSON event per line. Corvid appends
to it when a worker starts (each input with its size), when a worker ends or is merged, when an agent reads or
writes a note, reads a task file, reads the board or posts, and when a ping is delivered or wakes an agent. The log
only grows. No existing data file changes its format.

Logging starts with the version that added this view. Agents that ran before it show as the authors of their
notes and posts, with no start and no reads. A note or post that was deleted or expired still shows, marked as
gone, when the log says an agent read or wrote it.

## Behind the picture

The view draws with three.js into a canvas it owns, with no network and nothing fetched from the web. The frame loop runs only while
the canvas is on screen, the document is visible and the window has focus: a hidden pane, another app in front
or a minimised window stops it. Closing the view disposes the renderer.

With `prefers-reduced-motion` set, the view does not turn on its own and the particles stay off. Without WebGL
the view shows a plain message instead of a blank pane.

A test copy started with `npm run test-instance -- start --owner <you> --seed` gets about 150 fake nodes across
eight tasks in two projects, with notes read across them, so the graph and the project filter have something to show
on first open. `npm run test-instance -- lineage-live <id> --owner <you>`
appends a few fake events to a running copy through its own log writer, so the live path can be watched.

## What it cannot show yet

- Commits, beyond the merge of a task branch.
- What an agent read in the project's files, or on the web.
- The size of a worker's context after its start.
- The assistant's own inputs: Corvid is one long-lived node, and only its note and board activity is logged.
