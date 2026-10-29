---
title: The Agents view
summary: What the agent cards, approvals and session lists on the start page show.
section: tasks-and-agents
order: 7
---

# The Agents view

The **Agents** view shows every Claude session that runs inside Corvid, and what each one does now. It is the start
page.

From top to bottom, it has:

1. the summary line
2. **Awaiting your approval**, when proposals wait
3. a card for each running agent
4. **Ended**, folded
5. **Other sessions**
6. **Recent**, folded

## The summary line

The line under the heading counts each thing once, for example:

`3/4 running · 1 working · 1 needs you · 5h 41% / 70% · wk 20% / 80%`

| Part | What it means |
|---|---|
| `3/4 running` | Agents running, against the most workers at once. |
| `1 working` | Agents busy now. |
| `1 needs you` | Agents that wait for you, like on a permission prompt. |
| `5h 41% / 70%` | Your 5-hour usage, against the 5-hour usage gate. |
| `wk 20% / 80%` | Your weekly usage, against the weekly usage gate. |

A usage number turns red when it is past its gate. If your plan has a Fable weekly limit, the line also shows it. See
[Usage limits](../usage/usage-limits.md).

**Stop all** shows next to the line while workers run. See [Start a worker](start-a-worker.md#stop-workers).

## Awaiting your approval

In **Plan & ask** mode, each worker waits here until you click **Approve** or **Decline**. See
[Plan & ask and Auto](plan-and-ask-vs-auto.md#approve-a-worker).

## Agent cards

Each running agent has one card. An agent can be a task worker, a session you resumed, or a new session.

A card has three rows and a footer:

1. The agent's name, with the task number next to it, for example "#325". A dot on the agent's crow shows the status:
   **Working**, **Starting** or **Idle**. Point at the crow to see the word. **Needs you** and how an agent ended
   show as words next to the name.
2. The task title, on one line. Point at it to see the full title.
3. The latest action, short: the tool and the first command, for example "Bash · npm run typecheck". Point at it to
   see the full command. A warning, such as a problem with one of your own models, shows here in amber instead.

The footer has:

- One chip for the context and the model. A small ring fills as the agent uses its context, next to the size, for
  example "86k". The ring turns amber past 150k tokens or 60% of the window, and red past 85%. Point at the chip to see
  the exact numbers, for example "86k of 1M, 9%".
- The model: **Opus**, **Sonnet**, **Haiku** or **Fable**. Fable has a faint accent color, because it costs the most.
  One of [your own models](your-own-models.md) shows its label with a neutral "local" mark.
  A worker started with an effort shows it after the model, for example "Opus · high".
- For a worker, a branch icon. Point at it to see the branch name and the git message, and click it to copy the name.
  The icon turns amber when the branch needs a look.
- The card's buttons, which show when you point at the card or move to it with the keyboard.

A worker set to the default model shows your Claude Code default model. If Corvid can't read that model, the card
shows **Default**. A task's own model beats the worker model from Settings. For a session that Corvid didn't start,
the card shows the model only when the session's replies name it.

In a narrow pane, the model gets shorter or hides, so the buttons stay on the row.

The card's tooltip gives the minutes the worker has worked.

Click a card to open the agent's terminal inside it. You can type to the agent there, and answer its permission
prompts.

## Ended

**Ended** lists agents that stopped, finished or exited. Click **Ended** to unfold it. Each card says how it ended in
plain words, for example "Stopped by you · kept 2 commits not merged into main".

- Click **Resume** to bring a worker back. It puts the worker's `@` name in the message box. Say what it should
  do, and send the message.
- Click **Remove from the list** to take the card away.

The list drops old cards after a while.

## Other sessions

**Other sessions** lists Claude sessions that run outside Corvid, for example in Visual Studio Code or another terminal. You can
watch them here, but not type to them.

## Recent

**Recent** lists sessions that ran in the last 6 hours and do not run now. Click **Recent** to unfold it. Click a
session to open its project page.
