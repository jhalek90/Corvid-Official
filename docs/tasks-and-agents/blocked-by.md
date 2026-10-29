---
title: Blocked by
summary: How to mark a task as waiting on other tasks.
section: tasks-and-agents
order: 5
---

# Blocked by

**Blocked by** marks a task as waiting on other tasks. It is a hint, not a lock: you can still start a blocked task.

## Mark a task as blocked

1. Click the task's card. The task editor opens.
2. In **Blocked by**, type a task number or part of its title. Matching tasks show in a list.
3. Pick a task. It shows as a chip.
4. Repeat for each task it waits on. A task can wait on up to 10 others.
5. Click **Save**. The card shows a lock, "Blocked by" with the task numbers, and whether they are started.

To take a blocker off, click the remove button on its chip, then click **Save**.

## What counts as finished

A blocker stops blocking when it is in **Done**, or when it is removed from the board. The link stays on the task. If
you move the blocker out of Done, it blocks again.

The card of a task that others wait on shows "Blocks" and their numbers.

## Start a blocked task

1. Click **Automate** on the blocked task. A dialog says the task is waiting on other tasks, and lists them with their
   state.
2. Click **Start anyway** (or **Propose anyway** in **Plan & ask** mode) to go on. Click **Cancel** to stop. Click
   **Open #** and a task number to open that blocker instead.

A proposal in **Awaiting your approval** also says when its task still waits on others.

## Start automatically when the blockers are done

A task can start by itself when the last task it waits on moves to **Done**. Use this for a chain of tasks that
must run one after the other. The switch is off by default.

1. Click the task's card. The task editor opens.
2. Set its **Blocked by** tasks.
3. Turn on **Start automatically when its blockers are done**.
4. Click **Save**. The card shows a small lightning icon.

When a blocker moves to Done (its worker's branch is merged, or you move it), Corvid checks each task that waits on
it. A task starts only when all of these are true:

- The switch is on.
- The task is in **Backlog** or **Up next**.
- No worker runs on it.
- Every task it is blocked by is in Done or removed.

The start uses the same path as **Automate**. The worker limit, the usage limit, the time limit, the task's model and
the mode all apply. Each start posts one notice on the board: "Started #N automatically: its blockers are done."

What happens when it cannot start at once:

| Situation | What happens |
|---|---|
| **Plan & ask** mode | Corvid makes the usual proposal. You approve it in **Awaiting your approval**. |
| Every worker slot is taken | A board notice says the task is ready. It starts when a slot frees. A restart of Corvid forgets the wait. |
| Usage is over the limit | A board notice says "#N is ready to start but usage is over the limit; start it yourself." No dialog opens. |

NOTE: turning the switch on does not start the task, even when its blockers are already done. Only a blocker that
moves to Done starts it.

Corvid can set the switch for you, but only when you ask for an automatic chain. See
[Talking to Corvid](../board-and-corvid/talking-to-corvid.md).

## Hide blocked tasks

Click **Hide blocked** at the top of the board. The board shows only the tasks that are ready to start. The count at
the top says how many are hidden. Click **Show blocked** to show them again.
