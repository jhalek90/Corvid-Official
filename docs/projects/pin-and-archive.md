---
title: Pin, archive and missing folders
summary: How to pin or archive a project, and what happens when its folder moves.
section: projects
order: 3
---

# Pin, archive and missing folders

Pin a project to keep it at the top of the list. Archive a project to hide it without removing it. If a project's
folder moves, point the project at the new place and its history follows.

## Pin a project

1. Open **Projects**.
2. Click the pin button on the project's card. The card moves to **Pinned**.

You can also click **Pin** on the project page. Click the pin button or **Unpin** again to unpin.

Pinned projects come first in the project switcher too. Corvid's own project is always first among the pinned ones.

## Archive a project

Archiving hides a project from the list. Nothing is deleted.

1. Open the project page.
2. Click **Archive**. The project leaves the **Projects** list.

To see archived projects, click **show N archived** under the **Projects** title. To bring one back, open it and
click **Unarchive**.

You cannot archive Corvid's own project.

## Missing folders

A project whose folder is not there shows **missing** on its card and its page. This happens when the folder was
moved, renamed or deleted, or is on a drive that is not connected. Corvid keeps the project with its sessions, tasks
and notes. It never hides or deletes it.

Corvid checks again each time its window gets focus. When a drive comes back, the mark goes away.

While the folder is missing:

- The buttons that open the folder are turned off: **New Claude session**, the Visual Studio Code (VS Code) button, **Terminal** and **Folder**.
- No agent starts in the folder. The message says why.

### Point a project at its new folder

Use **Locate folder…** when the folder is missing. Use **Move folder…** when the folder is still there and you
moved or copied it yourself.

1. Open the project page.
2. Click **Locate folder…** or **Move folder…**. A dialog opens. It lists other clones with the same git remote as
   likely places.
3. Pick the new folder.
4. Click **Use this folder**. The project now uses the new folder.

Corvid checks that the new folder looks like the same project: the same git remote, the same first commit or the
same folder name. If nothing matches, it warns that the folder may be another project, and **Use it anyway** lets
you go on. Corvid refuses a folder that is in another project, your home folder and git worktrees.

Nothing on disk moves. The old path is kept as a past path of the project, so old sessions, tasks and notes still
belong to it. Tasks follow the project, so the next agent starts in the new folder.

Old sessions resume in the new folder. A session whose folder is missing and was not located is refused, so it
does not open in the wrong place.

### Task worktrees after a move

The worktrees that agents use for tasks are linked to the repository by git. After the repository moves, the
dialog lists the worktrees still linked to the old place. An agent does not start in one of them. To fix the links,
run `git worktree repair` in the new folder, followed by the new path of any worktree that moved too. Corvid does
not change git's files itself.
