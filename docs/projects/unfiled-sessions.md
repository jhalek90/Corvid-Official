---
title: Unfiled sessions
summary: How Corvid files sessions under projects, and what the Unfiled inbox is for.
section: projects
order: 4
---

# Unfiled sessions

Corvid files every Claude session under a project by its folder. A session that matches no project goes to the
**Unfiled** inbox on the **Projects** page. Nothing in the inbox is added to your list unless you add it.

## How sessions are filed

Corvid checks a session's folder in this order:

1. The folder is a project's folder, a folder the project used before, or a folder inside one of them.
2. The folder is a git worktree of a project's repository. Task worktrees count under their parent project and
   never become projects of their own.
3. The folder has the same git remote as a project, so it is a second clone. Corvid only suggests this match. The
   folder stays unfiled.

A folder that matches none of these is unfiled. Live sessions and tasks are filed the same way.

## The Unfiled inbox

**Unfiled** is a collapsed list near the bottom of the **Projects** page. Click it to open it. Each row shows the
folder, its sessions, the last activity and its git state. Some rows have a one-line hint, for example a second
clone of a project. You can dismiss a hint.

The **Projects** button in the rail shows how many unfiled folders had activity since you last opened the list.

A folder shows in the inbox once it has real work:

- two or more sessions, or
- one session with 5 or more prompts or 25 or more tool calls, or
- any session in a git repository with a remote.

Smaller folders wait quietly, and the list says how many. Their sessions are still in search and you can still
resume them. The inbox leaves out the same folders as the import: worktrees, temporary folders, Corvid's own
folders and folders where only Corvid started sessions.

## What you can do with an unfiled folder

Each row has these buttons:

- **Sessions** opens the folder's page with its sessions. You can resume one from there.
- **Add as project** asks for a name and a pin choice, then adds the folder as a project. It does not run
  `git init`.
- **Add to…** files the folder under a project you already have. The folder becomes a past path of that project,
  so its sessions count there. Nothing on disk moves.
- The ignore button hides the folder from the inbox.

To act on several folders at once:

1. Check the box on each row you want. The bar shows how many are picked.
2. Click **Add as projects** or **Ignore**.

**Ignore all that look like scratch (N)** picks folders with a throwaway name such as test or tmp. It also picks
folders on the Desktop or in Downloads that have no git and at most two sessions. Corvid lists the folders and asks
before it ignores them.

## Restore an ignored folder

1. Open **Unfiled**.
2. Click **Ignored** at the bottom. The list of ignored folders opens.
3. Click **Restore** on the folder. It shows in **Unfiled** again.
