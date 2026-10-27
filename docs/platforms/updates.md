---
title: Updates
summary: How Corvid checks for updates, and how to install one.
section: platforms
order: 4
---

# Updates

Corvid tells you when the public repository has new changes. It never installs an update by itself. You start the
update as a task, or you run it by hand.

## The update check

Each time Corvid starts, it runs `git fetch upstream` in the background. It only fetches. It never pulls, merges,
pushes or installs. If the fetch fails or you are offline, Corvid shows nothing.

If the public `main` branch has changes that your copy does not, a banner shows: "A Corvid update is available (N
new changes)". It has two buttons:

- **Create update task** adds the task "Update Corvid from the public repo" to **Up next** in the **Corvid**
  project.
- **Dismiss** hides the banner until the public repository changes again.

To turn the check off, go to **Settings** → **System** and turn off **Check for updates on launch**. Click **Check
now** to check at any time. The result shows beside the button, for example "Up to date with the public repo."

## Update with the update task

1. Click **Create update task** in the banner. The task shows in **Up next** in the **Corvid** project.
2. Start its worker, as for any task. See [Start a worker](../tasks-and-agents/start-a-worker.md).
3. Read the worker's post on the board. It lists the new commits and the changed files.
4. Wait. The worker merges the public `main` into your `main` with a merge commit. It never rebases and never pushes.
   If a conflict is unclear, it stops and asks you on the board.
5. The worker runs the typecheck and the tests. If they fail, it stops and reports. It does not install anything.
6. The worker says on the board that Corvid is about to restart, then runs `npm run deploy`.

CAUTION: the deploy restarts Corvid. Every running agent stops, the update worker too.

## Update by hand

Run these commands in your Corvid folder:

```sh
git fetch upstream
git merge upstream/main
npm run setup
```

## How deploy works

`npm run deploy` builds Corvid from your folder and installs the new build. Setup and the update task use it too.
It does these steps in order:

1. It builds Corvid and checks that the build can load.
2. It stops Corvid. This ends every terminal and agent running in Corvid.
3. It moves the current install aside, as a previous build. It keeps the newest 2 previous builds.
4. It installs the new build and starts it.
5. It waits up to 30 seconds for the new build to report that it is healthy.

If the build or the check fails, the installed Corvid is not changed. If the new build does not report healthy in
time, deploy puts the previous build back and starts it. Corvid then shows a notice on its next start.

Every deploy writes its steps to `deploy.log` in your data folder.

## Roll back by hand

1. Open **Projects** and open the **Corvid** project.
2. Click **Roll back to the previous build**. Corvid asks you to confirm, because the restart ends every agent.
3. Confirm. Corvid restarts on the previous build.

From a terminal, `npm run deploy -- --rollback` does the same.

## Deploy and rollback per platform

| | Windows | macOS | Linux |
|---|---|---|---|
| Install folder | `%LOCALAPPDATA%\Programs\Corvid` | `~/Applications/Corvid.app` | `~/.local/share/corvid/app` |
| Previous builds | `%LOCALAPPDATA%\Programs\Corvid.previous` | `~/Library/Application Support/Corvid/previous-builds` | `~/.local/share/corvid/app.previous` |
| How deploy stops Corvid | By its program name | Only the processes that run from the install folder | Only the processes that run from the install folder |
| Tested | Used every day | First install only, by one tester | Install, update and rollback, on one server with no desktop |
