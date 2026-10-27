---
title: Add and remove projects
summary: How to add a project folder, import projects from sessions and remove a project.
section: projects
order: 2
---

# Add and remove projects

You add projects one folder at a time, or import them from the folders your Claude sessions ran in. Removing a
project only takes it off the list.

## Add a project

1. Open **Projects**.
2. Click **New Project**. A folder picker opens.
3. Pick the folder. The project shows on the list, named after the folder.

If the folder has no git repository, Corvid starts a short Claude session that runs `git init` there. The files in
the folder stay as they are.

Corvid refuses a folder that is already a project, is inside a project, or is a git worktree of one. The message
says which project it belongs to.

To change the name, open the project and click **Rename**.

## Import projects from sessions

The import lists the folders your Claude sessions ran in, so you can add many at once. Corvid offers it once, on the
first start. You can run it again at any time, and it never adds a project twice.

1. Open **Projects**.
2. Click **Import from sessions**. The **Import projects** window lists each folder with its name, path, last
   activity, session count and git state.
3. Check the folders you want. Real projects are checked already.
4. Click **Import N**, where N is the number of checked folders. The projects show on the list.

Pinned folders stay pinned. The import leaves out some folders and lists them under **Skipped**, with the reason:

- git worktrees, because their sessions count under the parent project
- temporary and scratch folders
- Corvid's own data folder and the assistant's folder
- folders where Corvid started every session, such as task agents
- folders that no longer exist, with no git and fewer than five sessions
- one-off folders with no git, one session and a name such as test or tmp

Each skipped folder has an **Add** button if you want it anyway. **Cancel** closes the window and changes nothing.

## Add a folder from Other folders

**Other folders**, at the bottom of the **Projects** page, lists the rest of the folders in your project folders.

1. Click **Other folders**. The list opens.
2. Click the add button on a row. The folder shows on the list as a project.

## Remove a project

Removing a project takes it off the list. The folder, its sessions and its tasks stay as they are.

1. Open the project page.
2. Click **Remove**. Corvid asks you to confirm. It names the project and says that its folder, sessions and tasks stay as they
   are.
3. Click **OK**. The **Projects** list opens, without the project.

To get the project back, add its folder again with **New Project**. You cannot remove Corvid's own project.

To hide a project without removing it, archive it. See [Pin, archive and missing folders](pin-and-archive.md).
