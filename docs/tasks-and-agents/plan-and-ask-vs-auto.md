---
title: Plan & ask and Auto
summary: The two ways a worker can start, and when to use each.
section: tasks-and-agents
order: 3
---

# Plan & ask and Auto

The mode sets whether a new worker waits for your approval. **Plan & ask** is the default.

| Mode | What happens when a worker is asked for |
|---|---|
| **Plan & ask** | Corvid makes a proposal. The worker starts only after you approve it. |
| **Auto** | The worker starts right away, within the limits. |

The mode applies to **Automate** on a task card and to workers that Corvid, the assistant, starts for you.

## Change the mode

Click **Plan & ask** or **Auto** in the Corvid strip at the top of the message board. You can also type `/mode ask`
or `/mode auto` in the message box. The new mode applies to the next worker. Running workers carry on.

## When to use each

- Use **Plan & ask** when Corvid starts workers for you, and you want to see each one first. You read the task and the
  instructions before any usage is spent.
- Use **Auto** when you start workers yourself with **Automate**, and do not want a second click.

Both modes keep the limits: concurrent workers, the time limit and the usage gates. See
[Start a worker](start-a-worker.md#limits-corvid-enforces).

## Approve a worker

In **Plan & ask** mode, proposals wait in **Awaiting your approval** at the top of the Agents view.

1. Open **Agents**. Each proposal says **Start a worker for #** and the task number, with the task title, project and
   instructions.
2. Click **Approve** to start the worker. Its card shows in the Agents view.
3. Or click **Decline**. The proposal goes away and nothing starts.

A proposal for a task that still waits on other tasks says so. See [Blocked by](blocked-by.md).

NOTE: only your click approves a proposal. No agent, board message or mention can approve one.
