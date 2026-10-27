---
title: The project switcher
summary: How to narrow every page to one project.
section: projects
order: 5
---

# The project switcher

The project switcher narrows the app to one project. It is the button at the left of the top bar. It shows
**All projects** until you pick a project.

The switcher is only a view filter. It hides nothing from agents or from Corvid, and it moves or deletes nothing.

## Pick a project

1. Click the switcher, or press Ctrl+P (Cmd+P on macOS). A list opens with **All projects**, then **Pinned**, then
   **Recent**.
2. Type to filter the list. Use the arrow keys to move.
3. Press Enter, or click a project. The pages narrow to that project.

Press Esc to close the list without a change. Archived projects are hidden. Click **Show N archived** at the bottom
of the list to see them.

Inside a terminal, Ctrl+P stays with the shell, where it brings back the previous command.

Corvid remembers your choice between launches. If you remove the chosen project, or archive it, Corvid goes back
to **All projects** and says so.

## What changes when a project is chosen

| Page | With a project chosen |
|---|---|
| **Agents** | Shows only that project's agents, approvals and sessions. A line says how many in other projects need you, with a **Show all projects** link. |
| **Tasks** | Shows only that project's tasks. New tasks go in that project. |
| **Notes** | Shows that project's notes and the notes that belong to no project. New notes go in that project. |
| **Projects** | The rail button opens the project's page. **New Project** opens the folder picker next to the project's folder. |
| **Files** | Starts in the project's folder. |
| **Usage** | No change, because usage counts for the whole account. The chosen project is marked in **Top projects**. |
| Board | No change. To narrow the board, pick the project's channel on the board. |

The worker limit, the usage gates, **Stop all**, the rail badges and notifications still count every project.

A filtered page shows a chip with the project's name next to its title. Click the × on the chip to go back to
**All projects**.
