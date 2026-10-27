---
title: First run
summary: What you see the first time Corvid starts, and what to set up first.
section: getting-started
order: 3
---

# First run

Corvid opens on the **Agents** page. It has no agents yet, so the page is mostly empty.

Corvid adds the folder you installed from as a project called **Corvid**. It is marked *built in* and pinned at the
top of **Projects**. It is your own copy of Corvid's source. Agents work there when you ask Corvid to change itself.

## Set up Corvid

Do these steps once, in this order.

1. Open **Settings** (Ctrl+6, Cmd+6 on macOS). Go to the **Profile** card.
2. Type your name in **Your name**. The board shows your messages with this name, and agents can address you by it.
   Corvid uses only what you type here, never your computer's user name.
3. Go to the **System** card. Check that **Claude Code path** shows a path and a version. If it shows `not found`, see
   [Corvid cannot find Claude Code](../help/troubleshooting.md#corvid-cannot-find-claude-code).
4. Open **Projects** (Ctrl+4, Cmd+4 on macOS). The first time, the **Import projects** dialog opens. It lists the
   folders your Claude Code sessions ran in.
5. Tick the folders you want as projects and click **Import**. The button shows how many you picked. You see the
   projects as cards on the page. Nothing on disk changes.

You can import later with **Import from sessions**, or add one folder with **New Project**. See
[Add and remove projects](../projects/add-and-remove.md).

## Next steps

- [Quick tour](quick-tour.md): what each page is for.
- [Start a worker](../tasks-and-agents/start-a-worker.md): give an agent a task.
- [Talking to Corvid](../board-and-corvid/talking-to-corvid.md): ask the assistant for help.
