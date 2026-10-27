---
title: Troubleshooting
summary: What to do when something does not work.
section: help
order: 1
---

# Troubleshooting

Find the symptom, then follow the steps under it. Two log files in your data folder help with most problems:

- `deploy.log` has the steps of every install and deploy.
- `crash.log` has window crashes and errors.

The data folder is `%APPDATA%\Corvid` on Windows, `~/Library/Application Support/Corvid` on macOS and
`~/.config/Corvid` on Linux.

## Setup stops

Setup prints `Setup stopped before changing anything. To fix:` and a list. Fix each item and run `npm run setup`
again. Nothing changed on your computer.

### Corvid cannot find Claude Code

Setup stops, or **Settings** → **System** shows `not found` for **Claude Code path**.

1. Install Claude Code with the [official instructions](https://code.claude.com/docs/en/overview). On Windows, use
   the native installer. Corvid does not use a `claude` that is only on your `PATH` there.
2. Run `npm run setup` again.

If Claude Code is installed in a folder that Corvid does not look in, choose it yourself. Open **Settings** →
**System** → **Claude Code path**, select **Browse**, then **Check**, then **Save**. On Windows, choose
`claude.exe`. Corvid refuses `claude.bat` and `claude.cmd`. See
[Claude Code path](../settings/reference.md#claude-code-path).

### Claude Code is not signed in

1. Run `claude` in a terminal.
2. Type `/login` and finish signing in.
3. Run `npm run setup` again.

### Node is too old

Install Node.js 22.18 or newer. Open a new terminal and run `npm run setup` again.

### npm refused the package-lock.json

Setup says npm refused this checkout's `package-lock.json`. npm's strict lockfile check caused this. Your computer
and your connection are fine.

1. Update your clone with `git fetch upstream` and `git merge upstream/main`.
2. Or run setup through npm 10, which leaves the lockfile alone: `npx -y npm@10 run setup`.

Do not run `npm install` to fix it. That rewrites `package-lock.json`, and later updates then conflict with it.

### Setup refuses to touch git

The folder is not a fresh clone. Run `npm run setup -- --keep-git` to build it as it is, or clone again into a new
folder. See [Your copy of Corvid](../getting-started/install.md#your-copy-of-corvid).

## The build fails

1. Run `npm run setup` again. A network error during the download is the usual cause.
2. Check that `node --version` shows 22.18 or newer.
3. Delete the `node_modules` folder and run `npm run setup` again.

If the error says `electron/dist/… is missing` or `Error: Electron uninstall`, the Electron download failed. Run
`node node_modules/electron/install.js` in your Corvid folder, then `npm run setup` again.

## Corvid does not start, or it rolled back

If a new build does not report healthy within 30 seconds, Corvid puts the previous build back. It shows a notice on
the next start. Read `deploy.log` to see which step failed.

On macOS, see [If the installed app does not start](../platforms/macos.md#if-the-installed-app-does-not-start).
On Linux, an error about `chrome-sandbox` needs a one-time step. See
[Chromium's sandbox](../platforms/linux.md#chromiums-sandbox).

## A part of the window shows "Something went wrong here"

One part of the window broke. The rest of Corvid keeps working, and agents keep running.

1. Click **Try again**. The broken part draws again.
2. If it breaks again, click **Reload window**. Agents and terminals keep running. Each terminal comes back with its
   scrollback.
3. Click **Open crash.log** to see the error.

## The whole window crashed

Corvid reloads the window once by itself and tells you on the next load. If it crashes again within 2 minutes,
Corvid does not reload again. A dialog offers **Reload**, **Open crash.log** and **Leave it**. If the window stops responding, a dialog offers
**Wait** or **Reload**.

## "Corvid was closed unexpectedly last time"

The last run did not end with a clean quit. A crash, a killed process or a power loss causes this. Click **Open
crash.log** in the notice to see the details. Your data is kept.

A restart from a deploy does not count as unexpected.

## Corvid will not save a password (Linux)

Corvid found no system keyring. See [With no keyring](../platforms/linux.md#with-no-keyring).

## A setting went back to its default

When Corvid loads `config.json`, it repairs values that are out of range or of the wrong type. It says what it
repaired in a notice. It keeps every good value. To get an older version back, see
[Data and backups](data-and-backups.md#restore-a-backup).

## The show-or-hide shortcut does not work

Another app has the same shortcut. Corvid keeps your setting and shows a notice that it could not register it.
Pick another shortcut in **Settings** → **Window and layout** → **Global hotkey**.

## Still stuck

Ask Corvid on the board. Press Ctrl+J (Cmd+J on macOS) and describe what you see.
