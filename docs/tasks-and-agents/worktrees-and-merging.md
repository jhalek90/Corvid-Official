---
title: Worktrees and merging
summary: Where a worker makes its changes, and how they reach main.
section: tasks-and-agents
order: 6
---

# Worktrees and merging

A worker that changes files works on its own git branch, in its own folder. When its checks pass, Corvid merges the
branch into main. Several workers can work in one repository at once this way.

This is the **Feature branches** workflow, the default. The other workflow is
[Work on the current branch](#work-on-the-current-branch).

## Where a worker works

Before a worker starts, Corvid gives it:

- a branch named `task-<id>-<title>`, for example `task-12-fix-the-export-button`
- a git worktree for that branch, in a `<project>-worktrees` folder next to the project folder

A git worktree is a second folder that shows the same repository on another branch. The worker makes and commits
its changes there. Your project folder and its branch stay as they are.

The worker's card in the Agents view shows its branch.

## How the merge works

1. The worker commits its changes on its task branch.
2. The worker runs the project's checks, like the typecheck or the tests.
3. If they pass, the worker calls the `merge_task_branch` tool.
4. Corvid merges the task branch into `main` (or `master`) in the project folder, with a merge commit. It runs one
   merge for each repository at a time.
5. The task moves to **Done**.

Corvid does not merge when:

- the merge has a conflict
- the checks failed
- the project folder has uncommitted changes on main

The branch then stays as it is, for you to look at. The worker says on the board what stopped it.

NOTE: Corvid never forces a merge or a push, and never rewrites history.

## After the merge

When the worker has ended and everything on its branch is in main, Corvid removes the worktree and the branch.

Corvid keeps the worktree and the branch when the branch has commits that are not in main, or the worktree has
uncommitted files. The worker's card says so, in amber.

## Push after merge

**Push after merge** pushes the default branch to its remote after each merge. It is off by default.

CAUTION: with **Push after merge** on, each merged worker's changes go to the remote at once, with no review step.

1. Open **Settings** → **Git and branches**.
2. Turn on **Push after merge**.

A failed push leaves the merge on this computer only.

## Work on the current branch

With **Work on the current branch**, a worker commits in the project folder, on whatever branch it has. There is
no worktree and no merge step. Two workers in the same repository then share one folder.

To pick the workflow:

1. Open **Settings** → **Git and branches**.
2. Pick **Feature branches** or **Work on the current branch** in **Agent git workflow**.
3. Optional: set a different workflow for one project in the list under it.

The change applies to workers that start after it. Running workers keep their workflow. See the
[Settings reference](../settings/reference.md#git-and-branches).

## Corvid's own source

When a task is in the **Corvid** project, the worker edits Corvid's own source. It is told to deploy only when you ask,
and to run the typecheck first. It also gets the whole of [What Corvid is](../getting-started/what-corvid-is.md) in its
start instructions. A worker on any other project gets only that page's three sentences and the rule on when it may
suggest a Corvid change (see [Settings](../settings/reference.md)).

CAUTION: a deploy restarts Corvid and ends every running agent.
