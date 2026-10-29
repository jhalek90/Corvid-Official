# Changelog

The changes in Corvid that you can see or use, newest first. Corvid has no releases yet: you run `main` from your own
clone, and the **Update Corvid** task merges the public `main` into your copy. Each entry is dated by the day its
changes reached the public `main`, so you can see what an update brings in since the build you run (Settings shows
`Corvid v… · build <commit>`).

Internal changes (tests, refactors, CI) are left out unless they change what you see. The history starts at the
first public commit; earlier work lives in the maintainer's private repository.

## 0.2.0 (2026-10-29)

Tasks and workers:

- **Start automatically**: a task can start by itself when all its blockers are done, with one board notice per
  start. It's off by default and set per task.
- **Worker permission mode**: a setting for what new workers may do without asking you, Claude Code's default or
  accept edits.
- **Shorter worker start-up prompt**: workers get a trimmed generic prompt, so more of their context goes to the task.
- **Project memory**: the setting **Workers keep project memory in CLAUDE.md** lets workers add short lines on
  conventions, decisions and gotchas to the project's `CLAUDE.md`, merged with their work. On by default for new
  installs; an existing install keeps its setting.

Your own models (experimental):

- **Local models**: add a model server on your own computer, such as `llama-server` from llama.cpp, in
  **Settings** → **Models**, and pick it per task or for workers. Workers on it use no plan usage.
- **Checks and limits**: a cap per model, a health check before a worker starts and while it runs, and a lean worker
  profile for small context windows.
- **Local sessions**: sessions on your own models show in Sessions, Live and Usage.
- **Corvid on your own model**: the assistant itself can run on a local model with a 64k context or more.
- **Docs**: a new page, [Your own models](docs/tasks-and-agents/your-own-models.md), with what has been tested and a
  llama.cpp quick start.

Corvid and the Agents view:

- **Context ring**: a ring next to Corvid's state shows how full its context is. Click it to compact or clear the
  conversation.
- **Slimmer agent cards**: the same information in three rows and a light footer, with details on hover.

## 0.1.1 (2026-10-27)

- **Continuous integration**: the UI smoke test now runs on Linux too, so a green run on the public repository covers
  all three platforms.
- **Publishing**: the maintainer now ships updates to the public repository with `npm run publish-sync`, one commit per
  update. Each commit message names the version and lists what changed.

## 0.1.0 (2026-10-27): first public release

The first public version of Corvid, a beta. Windows is where it's built and used every day; macOS and Linux are
newly supported. See the [README](README.md#platforms) for the platform status.

It includes:

- **Agents and the message board**: a card for every Claude session running in Corvid, and a board with project
  channels where you, the agents and Corvid's assistant talk. A board message is never an approval.
- **Corvid, the assistant**: answers on the board, looks through your tasks, projects, sessions, usage and notes,
  creates tasks and starts workers, in Plan & ask or Auto mode.
- **Tasks and workers**: a task board whose workers each get their own branch and git worktree, merge into `main`
  with a merge commit when their checks pass, and stay within the limits you set (workers at once, time per
  worker, usage).
- **Projects**: git state, recent Claude activity and a secret scan per project, and a project switcher.
- **Usage and limits**: the 5-hour and weekly meters in the title bar, and a Usage page.
- **Notes**: plain-text notes with short IDs that you, the assistant and agents share.
- **Connections**: SSH, HTTP APIs and databases that agents use without seeing a password, each with a safety level.
- **Extensions**: text-only `.corvid` files that your agents build into your copy after a safety scan and your
  approval.
- **Guided tours**: a **?** button in the title bar that replays each tour, or asks Corvid to explain a feature.
