---
title: Data and backups
summary: Where Corvid keeps its data, and how to restore a backup.
section: help
order: 2
---

# Data and backups

Corvid keeps all its data in one folder on your computer. It backs up the important files in that folder by itself.

## The data folder

| Windows | macOS | Linux |
|---|---|---|
| `%APPDATA%\Corvid` | `~/Library/Application Support/Corvid` | `~/.config/Corvid`, or `$XDG_CONFIG_HOME/Corvid` if that is set |

On Windows, if `%APPDATA%\Claude Dashboard` exists from before the rename, Corvid uses that folder.

Agents can never read the data folder. A deny rule blocks it, and you cannot turn that rule off.

## What is in it

| File or folder | What it holds |
|---|---|
| `config.json` | Your settings |
| `projects.json` | Your project list |
| `tasks.json` | The task board |
| `agents.json` | What Corvid needs to resume recent agents |
| `notes` | One Markdown file per note |
| `board` | The message board |
| `connections` and `remote` | Your connections. Passwords and tokens are encrypted. |
| `extensions.json` and `extensions` | Your extensions |
| `backups` | The backups |
| `deploy.log` | The steps of every deploy |
| `crash.log` | Crashes and errors |

Corvid also reads Claude Code's files in `~/.claude`: your session transcripts and the list of live sessions. It
never writes there.

## Backups

Corvid backs up these files and folders: `config.json`, `tasks.json`, `projects.json`, `agents.json`, `notes`,
`board`, `extensions.json` and `extensions`.

- It makes a backup when Corvid starts, if the file changed since the last backup.
- It makes a backup when a file changes, at most once every 10 minutes for each file.
- It keeps the last 10 backups of each, and the newest one of each day for a week.

Corvid never backs up your passwords and tokens, or the `connections`, `remote` and `connectors` folders.

## Restore a backup

CAUTION: a restore restarts Corvid. Every running agent stops.

1. Go to **Settings** → **Rare and destructive** → **Restore from backup**.
2. Pick what to restore, then pick the backup.
3. Click **Restore…**. A dialog asks you to confirm. Click **Restore and restart**. Corvid restarts.
4. Corvid backs up the current version first, then puts the backup in its place. A notice says it is done.

To undo a restore, restore the backup that Corvid made in step 4.

## Uninstall

See [Uninstall](../getting-started/install.md#uninstall). Deleting the data folder removes your projects, tasks,
notes and board. You cannot undo it.
