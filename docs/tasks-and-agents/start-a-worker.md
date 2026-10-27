---
title: Start a worker
summary: How to start an agent on a task with Automate.
section: tasks-and-agents
order: 2
---

# Start a worker

**Automate** on a task card starts a worker on that task. A worker is an interactive Claude Code session in a Corvid
terminal, in the task's project folder. It has Claude Code's normal permission prompts.

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
