---
title: The Projects page
summary: What the Projects page and a project page show.
section: projects
order: 1
---

# The Projects page

The **Projects** page is the list of projects you keep. A project stays on the list until you archive or remove
it. Corvid does not add or drop projects by itself.

## The list

The page has these parts, from top to bottom:

- **Pinned**: your pinned projects. Corvid's own project comes first.
- **Projects**: every other project that is not archived, newest activity first.
- **Archived**: shown only after you click **show N archived** under the page title.
- **Unfiled**: folders with Claude sessions that belong to no project. See [Unfiled sessions](unfiled-sessions.md).
- **Other folders**: the other folders in your project folders, each with an add button.

Type in **Find a project…** to filter the list by name or folder. Click the refresh button to check git again for
every project.

## What a card shows

Each project has a card. A card shows:

- The project name, a pin button and chips such as **built in**, **N folders**, **missing** or **archived**.
- The folder path.
- The git state: the branch, the number of changed files, commits to push (↑) and commits to pull (↓).
- The last commit and when it was made.
- The number of Claude sessions, the last activity and a small chart of Claude output for the last 30 days.
- Risk flags, if there are any.
- Buttons: **New session**, a button for Visual Studio Code (VS Code), open folder and, for a repository with a web page, a link to it.

A project with no git repository shows **No git** in place of the git state.

Click a card to open the project page.

## Risk flags

A risk flag marks work you could lose. A flag never changes anything by itself. Corvid checks for flags only on
projects that are pinned or had Claude activity in the last 30 days.

| Flag text | When it shows |
|---|---|
| No git: N sessions of work with no history or backup | The folder has Claude sessions but no git repository. |
| N files with merge conflicts | git reports conflicts in the folder. |
| No remote: commits live only on this machine | The repository has no remote. |
| Branch X has never been pushed | The branch has commits but no upstream branch. |
| Agent branch X has N commits never merged | A task branch has commits that are not on the main branch. |
| N commits not pushed | The branch is ahead of its upstream. |
| N uncommitted files, last commit (a date) | There are uncommitted changes and the last commit is more than 7 days old. |

The no git flag is serious (red) when a session ran in the last 7 days. The uncommitted files flag is serious when
the last commit is more than 21 days old. The other flags are warnings.

On the project page, each flag has two buttons:

- **Make task** adds a task for the flag to the task board. After that, the button shows the task number.
- **Snooze 7d** hides the flag for 7 days.

## The project page

The project page shows one project in full. At the top are **Pin** or **Unpin**, **Rename**, **Archive** and
**Remove**. Corvid's own project shows **built in** in place of **Archive** and **Remove**, because you cannot
remove it.

The action row has these buttons:

- **New Claude session** starts a Claude Code session in the folder.
- **Resume latest** opens the most recent session again.
- **VS Code**, **Terminal** and **Folder** open the folder in VS Code, in the side terminal or in your file
  manager.
- **Add task** opens the task editor with this project already chosen.

Below the buttons the page shows the risk flags, the secret scan, the sessions, the files Claude edits most, the
uncommitted changes and the recent commits. Each session has a resume button and a fork button. Where a terminal
is available, a third button resumes it in a terminal window.

To rename a project, click **Rename**, type the new name and press Enter. The folder keeps its name.

## Secret scan

When a project page opens, Corvid scans the project's files for secrets such as API keys. If it finds any, a line
says "N possible secrets in files agents can read". Click **Scan for secrets** to see each finding by file, line and
kind. The page never shows the value.

Each finding has these buttons:

- **Add to Corvid** saves the secret in Corvid, where agents never see it.
- **Block for agents** stops agents from reading the file.
- **Allow this one** lets agents in this project read that one file.
- **Ignore** stops showing the finding.

The scan does not change any file. It reads nothing outside the project and skips `node_modules`, build folders
and git history. A finding marked **in git** is in a file that git tracks, so the value is in the history too.

CAUTION: a secret in a file that git tracks stays in the history after you delete it from the file. Change the
secret at its source (rotate it), then remove it from the file.

## Several folders in one project

A project can hold more than one folder, for example an app and its website. Use the folders panel on the project
page:

- **Add folder** adds a folder, with an optional label such as "app" or "website".
- The star makes a folder the primary folder. New sessions, and tasks with no folder chosen, work there.
- **Move up** and **Move down** change the order.
- The remove button takes a folder off the project. Nothing on disk changes.

A folder can belong to only one project. If the folder you add is a project of its own, Corvid offers to merge
the two projects and shows what moves across. After a merge, **Undo merge** stays on the project page for 10
minutes and puts both projects back.

Each folder has its own git state and flags. The git panels have one tab per folder.
