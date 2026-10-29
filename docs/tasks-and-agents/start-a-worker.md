---
title: Start a worker
summary: How to start an agent on a task with Automate.
section: tasks-and-agents
order: 2
---

# Start a worker

**Automate** on a task card starts a worker on that task. A worker is an interactive Claude Code session in a Corvid
terminal, in the task's project folder. It has Claude Code's normal permission prompts, unless you choose another
[permission mode](#permission-mode).

## Before you start

- The task has a project. Without one, the button says **Set the project**. Click it and pick a project.
- The task is not in **Done**. Move it to **Up next** first.

CAUTION: every worker uses your Claude plan usage. Several workers at once use it up faster.

## Start a worker on a task

1. Click **Automate** on the task's card.
2. What you see next depends on the mode:
   - In **Plan & ask** mode, the button says **Awaiting approval**. Approve the worker in the Agents view. See
     [Plan & ask and Auto](plan-and-ask-vs-auto.md).
   - In **Auto** mode, the button says **Running**. The worker's card shows in the Agents view.
3. If the task is blocked by unfinished tasks, a dialog asks first. See [Blocked by](blocked-by.md).
4. If your usage is high, a dialog asks first. See [Usage limits](../usage/usage-limits.md).

The worker reads the task's title, notes and files. It posts on the message board when it starts and when it is done.

## Permission mode

**Settings** → **Corvid and models** → **Worker permission mode** sets what new workers may do without asking you.
Corvid gives it to Claude Code with its `--permission-mode` option.

| Choice | What a worker does |
|---|---|
| **Claude Code default** | Corvid passes nothing. The worker asks as Claude Code and the project decide. This is the default. |
| **Accept edits** | The worker edits files without asking. Commands still ask. |

- The choice applies to workers that start after the change. Running workers keep theirs.
- Corvid itself does not get the permission mode. Only workers do.
- A project's own `.claude/settings.json` can still ask for more prompts, for example with its `ask` and `deny` rules.
- Corvid never offers the mode that skips every check. A config file that names another mode goes back to
  **Claude Code default**.

## Project memory

Claude Code reads a project's `CLAUDE.md` at the start of every session, also in a worker's worktree. With
**Settings** → **Agents and workers** → **Workers keep project memory in CLAUDE.md** on, workers also write to it, so
the next worker on the project starts with what earlier tasks found out.

- A worker adds one short line under a "Project notes" section when its task sets or reveals a convention, a
  decision or a gotcha that a later task must know and that the code does not show.
- It creates `CLAUDE.md` with a one-line header if the project has none.
- It does not log what it did, because git keeps that. It does not repeat a line that is already there. It updates a
  line that its task made wrong instead of adding one that contradicts it.
- The line is committed and merged with the rest of the worker's branch.
- The setting is on for new installs. An existing install keeps its current setting after an update; if you never
  changed it, it stays off.
- Turn it off where workers should not write a `CLAUDE.md`, for example in benchmark or scratch repos.
- A change applies to workers that start after it.

NOTE: two workers that run at the same time can both add a line in the same place. The second merge then conflicts
in `CLAUDE.md`, and Corvid's merge stops as it does for any conflict: nothing changes on the main branch, and the
worker leaves its branch for you. Keep both lines when you merge it.

## Limits Corvid enforces

Corvid enforces these limits itself. An agent cannot change them.

| Limit | Default | Range | Where to change it |
|---|---|---|---|
| **Concurrent workers** | 4 | 1 to 12 | **Settings** → **Agents and workers** |
| **Worker time limit** | 45 minutes of work | 5 to 240 minutes | **Settings** → **Agents and workers** |
| Usage gates | 70% of 5-hour usage, 80% of weekly usage | 5 to 100% | **Settings** → **Usage limits** |

Setting **Concurrent workers** above 8 asks you to confirm once. See the
[Settings reference](../settings/reference.md#agents-and-workers).

## The time limit

The time limit counts minutes of work, not minutes on the clock. The clock pauses:

- while the computer sleeps
- while the worker waits for you: a permission prompt, a pending approval, or a question to you that it ended its
  turn on

Every start, restart and resume gets a fresh clock. Five minutes before the limit, you and the worker get a warning.
The worker has a `time_left` tool, so it does not have to guess the time.

When the limit runs out, Corvid stops the worker. A notice on the board says how many minutes it worked. Its commits
stay on its task branch. To go on, start a worker on the task again.

The minutes a worker has worked show in the tooltip of its card.

## Finished agents close by themselves

A worker ends its work with a "done" post on the board. When it then sits idle, its card shows **Closing in** and a
countdown. When the countdown runs out, Corvid stops the worker and frees its slot. The card says **Finished**.

- Click **Keep open** to keep the worker running until it works and posts "done" again.
- The countdown starts over when the worker prints anything, works, is mentioned, or has its terminal on screen.
- The countdown does not start while the worker waits for you.
- A worker with uncommitted files, or commits not merged into main, is never closed. Its card says it has unmerged
  work.

The delay is 2 minutes by default. Change it with **Close finished agents after** in **Settings** → **Agents and
workers**: 1 to 60 minutes, or **Off**.

## Bring an agent back

Mention an agent that has ended on the board, with `@` and its name. Corvid resumes it in its own Claude session, on
its task branch, so it can read and answer. Only messages you type do this.

- A resumed agent counts as a worker for the limits, and its time limit starts again.
- Corvid resumes at most 6 agents an hour by itself. After that, it asks first.
- **Resume mentioned agents** in Settings sets this to **Automatically**, **Ask first** or **Off**.

Mention an agent that is still running, and Corvid types a short message into its terminal, so it answers now. It
types only when the agent is idle. **Tagging an agent wakes it** in Settings turns this off.

NOTE: resuming or waking an agent uses usage, like any worker.

## Stop workers

CAUTION: **Stop all** does not ask first. It stops every running worker, in every project, mid-task.

Click **Stop all** in the summary line of the Agents view. The button shows only while workers run. Commits the
workers made stay on their task branches. See [The Agents view](agents-view.md).
