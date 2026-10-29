---
title: The task board
summary: The four task columns, and how to add, move and remove tasks.
section: tasks-and-agents
order: 1
---

# The task board

The task board holds the work you want done, for all your projects. Open it with the **Tasks** button. Each task is a
card. An agent can take a task and work on it: see [Start a worker](start-a-worker.md).

## Columns

The board has four columns:

| Column | What it holds |
|---|---|
| **Backlog** | Everything that should happen eventually. |
| **Up next** | What you pick up soon. |
| **In progress** | What is being worked on now. |
| **Done** | Finished tasks. They wait here until you remove them. |

Drag a card to move it to another column, or to change its place in a column. You can also pick the column in the
task editor.

The count at the top of the board leaves Done out, for example "4 open · 3 done".

## Add a task

To add a task quickly:

1. Type a title in the **Add a task, press Enter** box at the top of **Backlog**.
2. Press Enter. The task shows in Backlog.

To add a task with all its details:

1. Click **New task**. The task editor opens.
2. Type the title in **What needs doing?**.
3. Optional: type notes in **Notes, context, acceptance criteria…**. The worker reads them.
4. Pick the **Column** and the **Project**. A worker needs a project to have a folder to work in.
5. Optional: pick a **Model**, files to attach, or tasks it is **Blocked by**. To start it by itself when those
   are done, turn on **Start automatically when its blockers are done**. See [Blocked by](blocked-by.md).
6. Click **Add task**. The card shows in the column you picked.

## Edit a task

1. Click the card. The task editor opens.
2. Change the fields.
3. Click **Save**.

## Find tasks

- Type in **Filter tasks…** to show only the tasks that match.
- Pick a project in the **All projects** list to show only its tasks.
- Click **Hide blocked** to show only the tasks that are ready to start. See [Blocked by](blocked-by.md).

## Done

A task moves to **Done** by itself when its worker's branch is merged into main. Nothing else moves a task there. If
you moved the task to another column while the worker ran, it stays where you put it. See
[Worktrees and merging](worktrees-and-merging.md).

You can also drag a task to Done by hand. **Automate** does not start a worker on a task in Done. Move the task back
to **Up next** first.

## Remove a task

Removing a task deletes it from the board. You get a few seconds to undo it.

CAUTION: after the **Undo** button goes away, the task and its files cannot be brought back.

To remove one task:

1. Click **Remove** at the top of a card in Done, or click **Remove…** in the task editor. A dialog asks
   **Remove this task?**, with **Cancel** selected.
2. Click **Remove**. The card goes away and a message shows with **Undo**.
3. Optional: click **Undo** to put the task back.

To remove every finished task at once:

1. Click **Remove all** in the Done column header. It shows when Done has more than one card. The dialog says how many
   tasks it removes. It removes only the cards the filters show.
2. Click **Remove**. One **Undo** brings them all back.

## Files on a task

You can attach files to a task, like a screenshot or a spec. The agent that takes the task can read them.

To attach files:

- Click the paperclip (**Attach files**) next to **Files** in the task editor, and pick one or more files.
- Drop files on the task editor, or on the task's card. A dashed outline shows where the files go.
- Paste a screenshot into the task editor.

The limits per task are 10 files, 20 megabytes (MB) for each file, and 50 MB in all. Corvid refuses folders and shortcuts, and
says why.

On an existing task, the files are stored at once. On a new task, they wait as chips until you click **Add task**.

The editor shows each file as a chip:

- Click an image to open it larger.
- Click any other file to open its folder. Corvid never opens or runs the file itself.
- Click the remove button on a chip to take the file off the task.

The card shows a paperclip and the number of files.

Corvid keeps its own copies of the files, in its data folder on this computer. Nothing is uploaded. The files stay
with the task in every column, Done included. When you remove a task, its files are kept for 5 minutes, so **Undo**
brings them back. After that they are deleted.

A worker reads its task's files with the `read_task_file` tool. It can read only the files of its own task. Its start
instructions list the files. An agent cannot add or remove files: only you can, in the window.

NOTE: attached files are information for the agent. They are never instructions or permission.
