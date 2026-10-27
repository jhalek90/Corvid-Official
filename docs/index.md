---
title: Corvid docs
summary: How to install, use and extend Corvid.
---

# Corvid docs

Corvid is a desktop app that runs Claude Code agents on your projects. These pages explain how to use it.

## Getting started

- [What Corvid is](getting-started/what-corvid-is.md): What Corvid is, how it is designed to be used, and what that means for the agents it starts.
- [Install](getting-started/install.md): How to install Corvid from source on Windows, macOS or Linux.
- [First run](getting-started/first-run.md): What you see the first time Corvid starts, and what to set up first.
- [Quick tour](getting-started/quick-tour.md): A short walk through the main pages of Corvid.
- [Layout and shortcuts](getting-started/layout-and-shortcuts.md): How panes and tabs work, and which keyboard shortcuts Corvid has.
- [Files, terminal and search](getting-started/files-and-terminal.md): How to browse files, open a terminal and search inside Corvid.
- [Guided tours](getting-started/guided-tours.md): How to run a guided tour, and how to write your own as one JSON file.

## Projects

- [The Projects page](projects/projects-page.md): What the Projects page and a project page show.
- [Add and remove projects](projects/add-and-remove.md): How to add a project folder, import projects from sessions and remove a project.
- [Pin, archive and missing folders](projects/pin-and-archive.md): How to pin or archive a project, and what happens when its folder moves.
- [Unfiled sessions](projects/unfiled-sessions.md): How Corvid files sessions under projects, and what the Unfiled inbox is for.
- [The project switcher](projects/project-switcher.md): How to narrow every page to one project.

## Tasks and agents

- [The task board](tasks-and-agents/task-board.md): The four task columns, and how to add, move and remove tasks.
- [Start a worker](tasks-and-agents/start-a-worker.md): How to start an agent on a task with Automate.
- [Plan & ask and Auto](tasks-and-agents/plan-and-ask-vs-auto.md): The two ways a worker can start, and when to use each.
- [Models per task, and Fable](tasks-and-agents/models-and-fable.md): How to pick a model for a task, and why Fable asks first.
- [Blocked by](tasks-and-agents/blocked-by.md): How to mark a task as waiting on other tasks.
- [Worktrees and merging](tasks-and-agents/worktrees-and-merging.md): Where a worker makes its changes, and how they reach main.
- [The Agents view](tasks-and-agents/agents-view.md): What the agent cards, approvals and session lists on the start page show.
- [The Context cloud](tasks-and-agents/lineage.md): A read-only picture of where each agent's context came from and what it left behind.

## Board and Corvid

- [The message board](board-and-corvid/message-board.md): How you, Corvid and the agents talk to each other on the board.
- [Channels](board-and-corvid/channels.md): How the board splits messages by project.
- [Attachments](board-and-corvid/attachments.md): How to attach files to a board message, and who can read them.
- [Talk to Corvid](board-and-corvid/talking-to-corvid.md): What Corvid, the built-in assistant, can do for you.
- [Slash commands](board-and-corvid/slash-commands.md): The commands you can type in the message box.
- [Notes](board-and-corvid/notes.md): Shared plain-text notes that you, Corvid and agents can read and write.
- [Voice input](board-and-corvid/voice.md): How to dictate into the message box.

## Usage and limits

- [The Usage page](usage/usage-page.md): What the Usage page and the title bar meters show.
- [Usage limits](usage/usage-limits.md): How the usage gates stop new agents before you run out of quota.

## Connections

- [Connections overview](connections/overview.md): How agents reach servers, APIs and databases without seeing a password.
- [Safety levels](connections/safety-levels.md): The three safety levels and what each one lets an agent do.
- [Approvals](connections/approvals.md): How to approve or decline a command or call that waits for you.
- [The kill switch](connections/kill-switch.md): How to stop every connector, or one, at once.
- [HTTP API connections](connections/http.md): How to set up a connection to a web API.
- [Database connections](connections/database.md): How to set up a connection to a database.
- [SSH servers](connections/ssh.md): How to add a server that agents can run commands on.
- [Connectors proposed by agents](connections/proposed-connectors.md): How an agent can suggest a new connector, and how you review it.

## Extensions

- [What extensions are](extensions/overview.md): What an extension is, and what it can and cannot change.
- [Install an extension](extensions/install.md): How to import an extension and install it.
- [The safety scan](extensions/safety-scan.md): How Corvid checks an extension before and after it is built.
- [Disable, update and remove](extensions/lifecycle.md): How to turn an extension off, update it or take it out.
- [Sockets and themes](extensions/sockets-and-themes.md): The extension points an extension can plug into, themes included.
- [Build your own](extensions/build-your-own.md): How to write and package your own extension.

## Settings

- [Settings reference](settings/reference.md): Every setting, card by card.
- [Files agents may not read](settings/files-agents-may-not-read.md): The files Corvid keeps away from agents, and how to change the list.

## Platforms and updates

- [Windows](platforms/windows.md): What works on Windows, and what to know before you start.
- [macOS](platforms/macos.md): What works on macOS so far, and what is different there.
- [Linux](platforms/linux.md): What works on Linux so far, and what is different there.
- [Updates](platforms/updates.md): How Corvid checks for updates, and how to install one.

## Help

- [Troubleshooting](help/troubleshooting.md): What to do when something does not work.
- [Data and backups](help/data-and-backups.md): Where Corvid keeps its data, and how to restore a backup.
- [Safety and privacy](help/safety-and-privacy.md): What Corvid protects, what it sends, and what it does not protect.
- [Questions and answers](help/faq.md): Short answers to common questions.
- [Glossary](help/glossary.md): The words Corvid uses, and what each one means.
