# Installing Corvid

Corvid is installed from source: you clone the public repository, run one command, and Corvid builds, installs and
starts. Updates arrive the same way, through git, when you choose to take them. The clone is your own copy, meant to
be changed: with settings, extensions, and agents that edit its code (see
[What Corvid is](docs/getting-started/what-corvid-is.md)).

**Let Claude Code do it.** Open Claude Code in the folder where you want Corvid and say:

> Read INSTALL.md and set up Corvid

(If you haven't cloned yet, give Claude the clone URL from step 2 as well.)

The steps below are written so a person or Claude can follow them in order. Each one says what success looks like.
Stop at the first step that doesn't succeed and see [Troubleshooting](#troubleshooting).

## What you need

- **Windows 10 or 11** (64-bit), **macOS** (Apple Silicon or Intel), or **Linux** (64-bit, with a desktop).
  Windows is the platform Corvid is used on every day. macOS and Linux are in beta, covered by automated tests. On
  macOS, human testers have used Corvid past the first launch. Linux has been built, installed, updated and rolled
  back for real on one headless Ubuntu 26.04 machine, and the test suite passes in a Linux container. Nobody has
  tried a Linux desktop yet. Reports are welcome; see
  [docs/TESTING-PLATFORMS.md](docs/TESTING-PLATFORMS.md#tester-checklist).
- **Node.js 22.18 or newer.** npm comes with it: setup is tested with npm 10 (Node 22) and npm 11 (Node 24). With
  another npm, setup prints a note and carries on.
- **git** on your `PATH`. On macOS, install the Xcode Command Line Tools (`xcode-select --install`), which include
  git; on Linux use your package manager (`sudo apt install git`, `sudo dnf install git`).
- **[Claude Code](https://code.claude.com/docs/en/overview), installed and signed in.** Setup checks this first and
  **stops before changing anything** if it can't find Claude Code. It looks where Corvid does: the native installer's
  `~/.local/bin` and the VS Code extension, and on macOS and Linux also `~/.claude/local`, your `PATH` and (macOS)
  Homebrew's folders. On Windows a `claude` that is only on your `PATH` (for example an npm global install) isn't
  picked up: install the native one. After the first launch you can also choose the program in **Settings** →
  **System** → **Claude Code path**; on Windows it takes a `claude.exe` only, not a `.cmd` or `.bat` wrapper.
- **About 3 GB of free disk space** for dependencies, Electron and the build.
- **Linux only:**
  - **A system keyring** (GNOME Keyring or KWallet, usually already there on a desktop) to save connection secrets.
    Without one Corvid still works, but refuses to save passwords and tokens rather than keep them in plain text.
  - **A colour emoji font.** Minimal installs may lack one, and emoji then show in black and white:
    `sudo apt install fonts-noto-color-emoji` (Debian, Ubuntu) or `sudo dnf install google-noto-color-emoji-fonts`
    (Fedora).
  - On **Ubuntu 23.10 and later**, a one-time `sudo` step for Chromium's sandbox, which setup prints when it's
    needed; see [Linux: Chromium's sandbox](#linux-chromiums-sandbox).

## Steps

### 1. Check the tools

```sh
node --version
git --version
npm --version
```

Success looks like: three version numbers, with Node at `v22.18.0` or higher. If one is missing, install it yourself
first; setup never installs system software.

### 2. Clone the public repository

```sh
git clone https://github.com/jhalek90/Corvid-Official.git corvid
cd corvid
```

Success looks like: a `corvid` folder containing `package.json`, `README.md` and this file, and your shell inside it.

### 3. Run setup

```sh
npm run setup
```

Setup takes a few minutes the first time. In order, it:

1. **Checks** Node, git, npm, Claude Code (installed and signed in) and free disk space. If something is missing it
   stops and tells you what to do. Nothing has been changed at that point.
2. **Makes the folder your own repository** (see [Your copy of Corvid](#your-copy-of-corvid)).
3. **Installs dependencies** with `npm ci`, then Electron's binary (about 160 MB) if it isn't there yet.
4. **Builds Corvid and installs it**, using the same flow as `npm run deploy`: build, check the package loads,
   install, start, and wait up to 30 seconds for it to report healthy. If a new build doesn't come up, the previous
   install is put back. It installs to `%LOCALAPPDATA%\Programs\Corvid` on Windows, `~/Applications/Corvid.app`
   on macOS, and `~/.local/share/corvid/app` on Linux (with an app-menu entry). On Linux, if Chromium's sandbox needs
   the one-time `sudo` step, setup prints it just before this.
5. **Starts Corvid.**

Success looks like: setup ends with `Done. Corvid is installed and running.` and the Corvid window opens. If it stops
earlier, it prints what to fix under `To fix:` (or why it left git alone); fix that and run `npm run setup` again.

Options (`npm run setup -- --help` lists them):

| Option | What it does |
|---|---|
| `--help` | Show the options and exit |
| `--check` | Run only the checks; change nothing |
| `--no-launch` | Only build: don't install or start Corvid (run `npm run deploy` later to do that) |
| `--keep-git` | Leave git alone (for a checkout that isn't a fresh clone) |

### 4. First launch

Corvid opens and adds this folder as its built-in, pinned **Corvid** project. That's your own copy of Corvid's
source: the tutorial uses it, and it's where your agents work when you ask Corvid to change itself.

Success looks like: the Corvid window is open and the Projects view lists **Corvid**, pinned.

### 5. Starting Corvid later

- **Windows:** setup doesn't create a desktop shortcut; Corvid adds itself to the Start menu on its first launch.
  It runs from `%LOCALAPPDATA%\Programs\Corvid\Corvid.exe`; pin it to the taskbar while it's running.
- **macOS:** open **Corvid** from `~/Applications` (Spotlight finds it), and keep it in the Dock.
- **Linux:** open **Corvid** from your desktop's app menu (setup writes `~/.local/share/applications/corvid.desktop`),
  or run `~/.local/share/corvid/app/corvid`.

To rebuild from your folder and restart, run `npm run deploy` (this ends running agents).

Running `npm run setup` again is safe: it rebuilds and reinstalls. It never touches your Corvid data (see
[Where Corvid keeps things](#where-corvid-keeps-things)), Claude Code's `~/.claude`, or your git history.

## Where Corvid keeps things

| | Windows | macOS | Linux |
|---|---|---|---|
| The installed app | `%LOCALAPPDATA%\Programs\Corvid` | `~/Applications/Corvid.app` | `~/.local/share/corvid/app` |
| Previous builds (for rollback) | `%LOCALAPPDATA%\Programs\Corvid.previous` | `~/Library/Application Support/Corvid/previous-builds` | `~/.local/share/corvid/app.previous` |
| Your data: projects, tasks, notes, the board, encrypted secrets, `deploy.log`, `crash.log` | `%APPDATA%\Corvid` | `~/Library/Application Support/Corvid` | `~/.config/Corvid` (or `$XDG_CONFIG_HOME/Corvid`) |
| App menu entry | Start menu shortcut | `~/Applications` | `~/.local/share/applications/corvid.desktop` |
| Open at login (when turned on) | Windows' startup apps | Login Items | `~/.config/autostart/corvid.desktop` |

On Windows, an install from before the rename keeps using `%APPDATA%\Claude Dashboard`. Agents are always denied
access to the data folder.

## Your copy of Corvid

After setup, your folder is **your own git repository**, separate from the public one:

- The clone's `origin` remote is renamed to **`upstream`**, and its push URL is disabled
  (`git remote set-url --push upstream DISABLED`), so nothing can be pushed to the public repository by accident.
  There's no remote called `origin`.
- Your `main` branch no longer tracks the public one, so Corvid never reports "unpushed commits" for it, and
  *push after merge* has nowhere to push.
- The public history is kept. Your changes and the public changes share a common ancestor, so merging an update
  is an ordinary `git merge`.

Setup only does this to a **fresh clone**. If the folder has local commits, uncommitted changes, other branches,
remotes besides `origin`, or has been worked in since it was cloned (a branch switch, a commit), setup explains why and stops without touching git; run it
with `--keep-git` to build anyway. A folder that setup already converted (an `upstream` remote with pushing disabled,
no `origin`) is recognised and simply rebuilt.

**Contributing back** is a deliberate, manual step. Add your own fork as a remote, push a branch to it, and open a
pull request:

```sh
git remote add myfork https://github.com/<you>/corvid.git
git push myfork my-branch
```

## Updating

When Corvid starts, it runs `git fetch upstream` in the background: fetch only, never a pull, merge or push. If it's
offline or the fetch fails, nothing is shown. If the public `main` has commits yours doesn't, a banner says:

> A Corvid update is available (N new changes)

- **Create update task** adds *Update Corvid from the public repo* to the Corvid project's **Up next** column. Start
  its worker like any task. The worker fetches, shows you what's new, merges `upstream/main` into your local `main`
  (never rebasing, never pushing), resolves conflicts keeping your changes or asks you on the board, runs the
  typecheck and tests, and deploys last. **Corvid restarts during the deploy, which ends running agents.**
- **Dismiss** hides the banner until the public repository moves on again.

Corvid never installs an update by itself. In Settings, **Check for updates on launch** turns the check off, and
**Check now** runs it on demand.

To update by hand instead:

```sh
git fetch upstream
git merge upstream/main
npm run setup
```

**Privacy:** setup reaches the npm registry (for dependencies) and the public repository (git). After that, Corvid's
only network access for updates is the `git fetch` against the public repository.

## Uninstalling

1. Turn off **Start with Windows** / **Open at login** in Settings if you turned it on, then quit Corvid: tray or
   menu bar icon → **Quit** (on Linux without a tray, close its window).
2. Delete the installed app and the previous builds:
   - Windows: `%LOCALAPPDATA%\Programs\Corvid`, `%LOCALAPPDATA%\Programs\Corvid.previous`, and the Corvid
     shortcut in the Start menu.
   - macOS: `~/Applications/Corvid.app` (the previous builds are in the data folder, step 4).
   - Linux: `~/.local/share/corvid` (the app, the previous builds and the icon), the app-menu entry
     `~/.local/share/applications/corvid.desktop` and, if it's there, `~/.config/autostart/corvid.desktop`. If you
     added the AppArmor profile, remove it with
     `sudo apparmor_parser -R /etc/apparmor.d/corvid && sudo rm /etc/apparmor.d/corvid`.
3. Delete your clone folder (`corvid`). Push anything you want to keep to your own remote first.
4. Optional: delete your Corvid data: `%APPDATA%\Corvid` (Windows), `~/Library/Application Support/Corvid`
   (macOS) or `~/.config/Corvid` (Linux). That's your projects, tasks, notes and the board; it can't be undone.

Leave `~/.claude` alone: it belongs to Claude Code.

## Troubleshooting

**"Claude Code isn't installed" / Corvid can't find Claude.** Install it with the
[official instructions](https://code.claude.com/docs/en/overview), then run `npm run setup` again. If you installed
it somewhere Corvid doesn't look, choose it in **Settings** → **System** → **Claude Code path** (Browse, then Check,
then Save). On Windows that must be a `claude.exe`: the `claude.cmd` an npm global install makes is refused.

**"Claude Code isn't signed in."** Run `claude`, type `/login`, finish signing in, then run `npm run setup` again.

**Node is too old.** Install Node.js 22.18 or newer, open a new terminal, and run `npm run setup` again.

**"npm … refused this checkout's package-lock.json" (npm ci: "package.json and package-lock.json … are in sync",
"Missing: … from lock file").** npm's strict lockfile check refused the lockfile; your computer and connection are
fine. npm 11.6.2 and later did this with lockfiles from before the fix for it (they lacked entries for
`@electron/windows-sign`, a Windows-only optional package). Update your clone, or run setup through npm 10, which
leaves the lockfile as it is: `npx -y npm@10 run setup`. Don't run `npm install` to "fix" it: that rewrites
`package-lock.json`, and later updates then conflict with it. If npm 10 refuses it too, please report it with
setup's output.

**The build fails.**

1. Run `npm run setup` again; a network hiccup during `npm ci` is the usual cause.
2. Check `node --version` is 22.18 or newer.
3. Delete the `node_modules` folder and run `npm run setup` again.

**"electron/dist/… is missing" or "Error: Electron uninstall".** Electron 44 doesn't download its binary by itself
any more; Corvid's `postinstall` and setup do. If that download failed (offline, or npm runs with
`ignore-scripts`), run `node node_modules/electron/install.js` in the Corvid folder, then `npm run setup` again.
It uses `ELECTRON_MIRROR` and your proxy settings if they're set, and checks the download against Electron's
own checksums. `ELECTRON_SKIP_BINARY_DOWNLOAD=1` skips the `postinstall` download (setup still gets it).

**Corvid doesn't start after an install, or rolled back.** The install and launch log is `deploy.log` in your
data folder (`%APPDATA%\Corvid`, `~/Library/Application Support/Corvid` or `~/.config/Corvid`), and `crash.log`
beside it has window crashes and errors. If a new build didn't report healthy, Corvid puts the previous one back and shows a notice on
its next start saying so.

**macOS: the installed app doesn't start.** The macOS install has only been reported working by one tester so far. Run
`npm run setup -- --no-launch`, then `npm start` to run Corvid from the folder, and please report what
`npm run deploy` printed (see [docs/TESTING-PLATFORMS.md](docs/TESTING-PLATFORMS.md#tester-checklist)).

**Linux: Corvid won't save a secret.** It found no keyring, only Electron's plain-text fallback. Install and unlock
GNOME Keyring (`gnome-keyring`) or KWallet, log out and back in, and restart Corvid.

**Setup refuses to touch git.** The folder isn't a fresh clone (see [Your copy of Corvid](#your-copy-of-corvid)).
Run `npm run setup -- --keep-git` to build without changing git, or clone again into a new folder.

### Linux: Chromium's sandbox

Corvid keeps Chromium's sandbox on. Ubuntu 23.10 and later block the user namespaces it needs for apps AppArmor
doesn't know (`kernel.apparmor_restrict_unprivileged_userns = 1`), and Corvid then won't start, with an error
about `chrome-sandbox` or "No usable sandbox!". Setup checks for this and prints the exact commands; it never runs
`sudo` itself. The fix, once:

- **An AppArmor profile** (recommended; it survives updates): setup prints a `sudo tee /etc/apparmor.d/corvid`
  block with one `flags=(unconfined) { userns, }` profile for the installed app
  (`~/.local/share/corvid/app/corvid`) and one for the Electron that `npm start` runs, then
  `sudo apparmor_parser -r /etc/apparmor.d/corvid`.
- **Or** make `chrome-sandbox` setuid root: `sudo chown root:root <app>/chrome-sandbox` and
  `sudo chmod 4755 <app>/chrome-sandbox`. Each `npm run deploy` copies a fresh one, so this has to be redone after
  every update.

Don't start Corvid with `--no-sandbox`.
