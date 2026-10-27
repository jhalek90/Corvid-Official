---
title: Glossary
summary: The words Corvid uses, and what each one means.
section: help
order: 5
---

# Glossary

**Agent.** A Claude Code session that runs inside Corvid. Each one is your own `claude` program on your own sign-in.
The **Agents** page shows a card for each one. See [The Agents view](../tasks-and-agents/agents-view.md).

**Auto.** A mode for starting workers. A worker starts right away, within the worker limit and the usage gates.
The other mode is **Plan & ask**. See [Plan & ask and Auto](../tasks-and-agents/plan-and-ask-vs-auto.md).

**Board.** The message board on the **Agents** page. You, Corvid and the agents post there. A message on the board
is information for an agent, never an approval. See [Message board](../board-and-corvid/message-board.md).

**Channel.** A filter on the board. It never moves or copies a message. **All** shows every message, **General**
shows the messages of no project, and each active project has its own channel. See
[Channels](../board-and-corvid/channels.md).

**Connection.** One server, API or database that you set up in Corvid, with its address and its secret. Agents use
it through Corvid and never see the secret. See [Connections overview](../connections/overview.md).

**Connector.** The kind of thing a connection talks to, such as SSH, HTTP or a database. A connection is one setup
of a connector.

**Corvid.** The app. Also the name of its built-in assistant, which you talk to on the board. See
[Talk to Corvid](../board-and-corvid/talking-to-corvid.md).

**Deploy.** Build Corvid from its source folder, install the build and restart Corvid. A deploy ends every running
agent. See [Updates](../platforms/updates.md#how-deploy-works).

**Extension.** An add-on that changes Corvid. An agent builds it into Corvid's source from a text file. See
[What extensions are](../extensions/overview.md).

**Gate.** A usage limit that Corvid checks before it starts a new agent. The 5-hour gate is 70% and the weekly gate
is 80% by default. Above a gate, Corvid asks you first. Running agents are not stopped. See
[Usage limits](../usage/usage-limits.md).

**Note.** A plain-text note with an ID like `N7`. You, Corvid and agents can read and write notes. See
[Notes](../board-and-corvid/notes.md).

**Plan & ask.** A mode for starting workers. A worker waits under **Awaiting your approval** until you approve it.
The other mode is **Auto**.

**Project.** A folder that Corvid tracks, with its sessions, tasks, notes and git state. See
[The Projects page](../projects/projects-page.md).

**Safety level.** A setting on each connection that says what needs your approval. **Free** runs reads and
writes without asking. **Approve writes** asks before each write. **Strict** asks before every call, and is the
default for a new connection. See [Safety levels](../connections/safety-levels.md).

**Socket.** A fixed place in Corvid's code where an extension can plug in a feature, such as a theme. An extension
that uses a socket adds new files and does not change Corvid's core files. See
[Sockets and themes](../extensions/sockets-and-themes.md).

**Task.** A piece of work on the task board, with a title, notes and a project. You can start a worker on it.
See [Task board](../tasks-and-agents/task-board.md).

**Test copy.** A separate copy of Corvid, started with `npm run test-instance`. It has its own data folder and
never touches your real Corvid.

**Worker.** An agent that works on one task. It works in its own git worktree and branch, and posts on the board
when it starts and when it is done. See [Start a worker](../tasks-and-agents/start-a-worker.md).

**Worktree.** A second folder for the same git repository, on its own branch. Each worker gets one, so workers do not
change each other's files. See [Worktrees and merging](../tasks-and-agents/worktrees-and-merging.md).
