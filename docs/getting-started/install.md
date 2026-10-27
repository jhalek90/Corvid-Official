---
title: Install
summary: How to install Corvid from source on Windows, macOS or Linux.
section: getting-started
order: 2
---

# Install

You install Corvid from its source code. One command, `npm run setup`, checks your computer, builds Corvid, installs
it and starts it.

You can also ask Claude Code to do it. Open Claude Code in the folder where you want Corvid and say "Read INSTALL.md
and set up Corvid".

## What you need

- Windows 10 or 11 (64-bit), macOS (Apple Silicon or Intel), or Linux (64-bit, with a desktop). See
  [Platforms](../platforms/windows.md) for what works on each one.
- Node.js 22.18 or newer. npm comes with it.
- git on your `PATH`. On macOS, run `xcode-select --install` to get it. On Linux, use your package manager, for
  example `sudo apt install git`.
- [Claude Code](https://code.claude.com/docs/en/overview), installed and signed in.
- 3 gigabytes (GB) of free disk space.

Linux also needs a system keyring (GNOME Keyring or KWallet) to save passwords. See [Linux](../platforms/linux.md).

Setup never installs system software. If a tool is missing, install it first.

## Install Corvid

1. Check the tools. Run `node --version`, `git --version` and `npm --version`. You see three version numbers. Node
   must be `v22.18.0` or higher.
2. Clone the public repository and go into the folder:

   ```sh
   git clone https://github.com/jhalek90/Corvid-Official.git corvid
   cd corvid
   ```

   You see a `corvid` folder with `package.json` and `INSTALL.md` in it.
3. Run `npm run setup`. The first run takes a few minutes. Setup does these things in order:
   1. It checks Node, git, npm, Claude Code and free disk space. If something is missing, it stops and changes
      nothing.
   2. It makes the folder your own git repository. See [Your copy of Corvid](#your-copy-of-corvid).
   3. It installs the dependencies and Electron (about 160 megabytes).
   4. It builds Corvid, installs it and starts it.
4. Wait for the last line. You see `Done. Corvid is installed and running.` and the Corvid window opens.

If setup stops early, it prints `To fix:` and a list. Fix each item and run `npm run setup` again. Running it again
is safe. It does not touch your Corvid data, `~/.claude` or your git history.

Next: [First run](first-run.md).

## Setup options

Run `npm run setup -- --help` to list the options.

| Option | What it does |
|---|---|
| `--check` | Runs only the checks. Changes nothing. |
| `--no-launch` | Builds only. Does not install or start Corvid. Run `npm run deploy` later to do that. |
| `--keep-git` | Leaves git as it is. Use it in a folder that is not a fresh clone. |

## Where Corvid is installed

| | Windows | macOS | Linux |
|---|---|---|---|
| The app | `%LOCALAPPDATA%\Programs\Corvid` | `~/Applications/Corvid.app` | `~/.local/share/corvid/app` |
| Start it from | The Start menu | `~/Applications` or Spotlight | Your app menu |

Your data is in a separate folder. See [Data and backups](../help/data-and-backups.md).

## Your copy of Corvid

Setup turns a fresh clone into your own repository:

- It renames the `origin` remote to `upstream`.
- It turns off pushing to `upstream`, so nothing goes to the public repository by mistake.
- It keeps the public history, so an update is an ordinary `git merge`.

Setup does this only to a fresh clone. If the folder has your own commits, changes or branches, setup says why and
stops. Run `npm run setup -- --keep-git` to build it as it is.

To send a change back, add your own fork as a remote, push a branch to it and open a pull request.

## Uninstall

1. Turn off **Start with Windows** or **Open at login** in **Settings**, if you turned it on.
2. Quit Corvid from its tray or menu bar icon. On Linux without a tray, close the window.
3. Delete the app folder from the table above. On Windows, also delete `%LOCALAPPDATA%\Programs\Corvid.previous`
   and the Start menu shortcut. On Linux, delete all of `~/.local/share/corvid` and
   `~/.local/share/applications/corvid.desktop`.
4. Delete your clone folder. Push anything you want to keep first.
5. If you want, delete your data folder. This removes your projects, tasks, notes and board, and you cannot undo it.

Leave `~/.claude` alone. It belongs to Claude Code.
