# Testing on other platforms

How to try Corvid's macOS and Linux behaviour on a real machine. The platform layer and what each cross-platform
task changed are described in [PLATFORM.md](PLATFORM.md); its checklist lists what only a real desktop can confirm.

## Tester checklist

For a person trying Corvid on a real Mac (Apple Silicon, and Intel if you have one) or a real Linux desktop (Ubuntu
24.04 with GNOME first; KDE or Fedora if you can). So far, on a real Mac, one tester has run setup (October 2026:
dependencies, Electron download, build, package check, install and launch all worked, after npm 11 first refused the
lockfile; fixed in #183), and human testers have since used Corvid past the first launch and report that it works
well. Which macOS versions and chips they used, and which items below they covered, hasn't been collected yet. Linux
has been built, installed, updated and rolled back on one headless Ubuntu 26.04 server and the test suite passes in
a Linux container, but nobody has tried a Linux desktop. Every box you tick here is new information. Mark each item
pass, fail (with what you saw) or skipped. Use a machine or account where losing Corvid's data doesn't matter; your
Claude Code sign-in and `~/.claude` are only read.

Before you start, note: the OS and version, `uname -m`, the desktop and session type (Linux:
`echo $XDG_CURRENT_DESKTOP $XDG_SESSION_TYPE`), and the output of `node --version`, `npm --version`,
`git --version` and `claude --version`.

1. [ ] **Install.** Follow [INSTALL.md](../INSTALL.md): clone, then `npm run setup`. It checks your tools, builds,
       installs to `~/Applications/Corvid.app` (macOS) or `~/.local/share/corvid/app` (Linux) and starts Corvid.
       Save the whole setup output. On Ubuntu 23.10 and later, note whether setup printed the one-time AppArmor
       step, and whether Corvid started after you ran it. If setup stops at "Installing dependencies" because npm
       refused `package-lock.json`, note your npm version, then carry on with `npx -y npm@10 run setup`.
2. [ ] **First launch.** The window opens, the Projects view lists **Corvid** pinned, and the title bar looks right:
       on macOS the traffic lights sit in the top row and don't cover the brand; on Linux the minimise, maximise
       and close buttons work. Corvid finds `claude` (Settings shows where).
3. [ ] **Add a project.** Add any small git repository; its branches and status show.
4. [ ] **Start a tiny worker.** Create a task such as "Add a line to the README" and start its worker. It starts
       in its own worktree, posts on the board, and finishes.
5. [ ] **Deny rule.** Start a worker whose task is "Read `<your Corvid data folder>/config.json` and print it"
       (`~/Library/Application Support/Corvid` or `~/.config/Corvid`). It must be refused. On macOS also try
       `~/Library/Keychains`. (The by-hand version is in [PLATFORM.md](PLATFORM.md#the-deny-rule-check-150-by-hand).)
6. [ ] **Close a pane.** Open a terminal pane, run something long (`sleep 600`, or `top`), close the pane. Corvid
       doesn't freeze, and `ps -ef | grep sleep` shows no leftover process.
7. [ ] **Update and rollback.** Run `npm run deploy` from the clone with Corvid open: it closes, comes back, and the
       previous build is kept. Then `npm run deploy -- --rollback`: the previous build comes back. Save
       `deploy.log` (see below).
8. [ ] **Window chrome and tray.** macOS: a monochrome menu bar icon that suits light and dark menu bars; closing
       the window keeps Corvid running and the Dock icon brings it back; Cmd+Q quits. Linux: on GNOME without the
       AppIndicator extension, Settings shows "No system tray", closing the window quits (or asks Minimise or Quit
       while a terminal runs); with the extension, or on KDE, the tray menu's Show Corvid and Quit work.
9. [ ] **Shortcuts.** macOS uses Cmd: Cmd+J board, Cmd+K search, Cmd+P projects, Cmd+B files, and tooltips show ⌘.
       Inside a terminal, Ctrl+C interrupts and Cmd+C/Cmd+V copy and paste. Linux uses Ctrl like Windows.
10. [ ] **Global hotkey.** Cmd+Shift+Space (macOS) or Ctrl+Alt+Space (Linux) shows and hides Corvid from another
        app. On Wayland, note whether the desktop asked to allow it, or whether Corvid said it couldn't register.
11. [ ] **Secrets.** In Connections, add an SSH or HTTP connection with a password. macOS: it saves (the Keychain
        may ask once). Linux with GNOME Keyring or KWallet: it saves. Linux without a keyring (or with it removed
        or locked): saving is refused with a hint to install or unlock one, and nothing is stored in plain text.
12. [ ] **Open in VS Code and terminal.** On a project, the VS Code button opens the folder. On a session, "Resume in
        a terminal window" opens Terminal (macOS) or your desktop's terminal (Linux) running `claude --resume`.
13. [ ] **Notifications.** With the window in the background, a worker finishing shows a desktop notification
        (macOS may ask for permission first). On Linux without a notification daemon, the Notifications toggle is
        hidden in Settings.
14. [ ] **Open at login.** Turn on Settings → Open at login, log out and back in: Corvid starts hidden in the tray
        (or minimised without one). Turn it off again. Linux: `~/.config/autostart/corvid.desktop` appears and goes.
15. [ ] **Emoji** (Linux): board emoji show in colour; on a minimal install, note whether
        `fonts-noto-color-emoji` was needed.
16. [ ] **Uninstall.** Follow [Uninstalling](../INSTALL.md#uninstalling): afterwards nothing named Corvid is left in
        the app menu, Launchpad, the autostart folder or Login Items.

Voice dictation is Windows only; on macOS and Linux the mic button should be greyed out and say so.

**Where to send results.** Open an issue on Corvid's public repository titled "Platform test: macOS 15 (Apple
Silicon)" or "Platform test: Ubuntu 24.04 GNOME Wayland", with the numbered list above (pass, fail or skipped, and
what you saw for each fail). Screenshots of anything that looks wrong help.

**What to attach** (read each file before you attach it):

- The setup output, and the output of any `npm run deploy` that failed.
- `deploy.log` and `crash.log` from your data folder (`~/Library/Application Support/Corvid` on macOS,
  `~/.config/Corvid` on Linux). They hold paths and error messages, not secrets.
- The details you noted before you started.

**Never attach** anything else from the data folder (`config.json`, `connections/`, `remote/`, `secrets.json`, the
board or notes), anything from `~/.claude` (in particular `.credentials.json`), keys, tokens or passwords.

## The Linux check on a headless box (#164)

`scripts/linux-check.mjs` checks the Linux parts of the platform layer on a server with no desktop: the data
folders, deny-rule paths, path keys, a real git worktree with a `node_modules` symlink, where the Claude CLI is
found, the shells, ending a process tree, and the login shell's PATH. It needs only Node and git: no `npm install`,
no Electron, no build. It takes under a minute (usually a few seconds) and leaves nothing behind.

What it does on the box: it works in one temp folder (`/tmp/corvid-linux-check-*`) and deletes it at the end, also
when a check fails or you press Ctrl+C. It refuses to run as root and needs no sudo, never writes to `~/.claude`,
`~/.config`, `~/.ssh` or any data folder, opens no ports and sends nothing anywhere. The only processes it kills are
the ones it started, by pid. The exact commands it runs are listed at the top of the script.

### Steps

1. **Use an ordinary user, ideally a throwaway one.** As your admin user, once:

   ```sh
   sudo adduser --disabled-password --gecos "" corvidcheck
   sudo -iu corvidcheck
   ```

2. **Check Node and git.** `node --version` must say v22.18 or newer (v23.6+ and v24 are fine). If Node is missing
   or older, unpack the Linux binary from nodejs.org into the user's home instead of installing it system-wide:

   ```sh
   curl -fsSLO https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz
   tar -xf node-v24.11.0-linux-x64.tar.xz && export PATH="$PWD/node-v24.11.0-linux-x64/bin:$PATH"
   ```

   `claude` is optional. If it is installed and signed in for this user, the report also shows its version.

3. **Get the code.** Either clone it:

   ```sh
   git clone https://github.com/jhalek90/Corvid-Official.git corvid && cd corvid
   ```

   or, if the box can't reach the repo, copy it from your PC: run `git archive -o corvid.tar HEAD` in your checkout,
   copy `corvid.tar` to the box, then `mkdir corvid && tar -xf corvid.tar -C corvid && cd corvid`. That's enough for
   the Linux check; the deploy test below also needs a local commit in the copy.

4. **Run it:**

   ```sh
   node scripts/linux-check.mjs
   ```

   (`--json` gives the same as JSON, `--help` explains the options.)

5. **Paste the report back** (about 20 lines, starting with `Corvid Linux check`). It contains no secrets, no
   environment variables and no home path (your home shows as `~`). Every check says PASS, FAIL with a reason, or
   SKIP with why; the exit code is 0 only when nothing failed.

6. **Clean up the user** if it was a throwaway one: `exit`, then `sudo deluser --remove-home corvidcheck`.

### What it doesn't cover

- The desktop parts (window, tray, keyring and Electron's safeStorage, the sandbox step): they need Electron and a
  desktop session, so they stay on the PLATFORM.md checklist.
- The deny rules against a real `claude -p`: that writes session history under `~/.claude` and uses the network,
  so it is left to the by-hand check in PLATFORM.md.

### Adding a check

Each check is one entry in `CHECKS` in `scripts/linux-check.mjs`: a name and an `async run(ctx)` that returns
`pass(detail)` or `skip(why)`, or throws for a FAIL. A failure never stops the other checks. `ctx` has the temp
folder and the platform layer's modules; anything a check starts must be its own process group, added to
`ctx.groups` so a failed run still ends it. `npm run test-linux-check` runs the script's pure logic and the whole
script on any OS (on Windows the Linux-only checks skip).

## Deploy on Linux and macOS (#154)

`npm run deploy` builds Corvid, installs it, starts it, waits for its `health.json` and rolls back a build that
doesn't start, on every platform (the install profiles are described in [PLATFORM.md](PLATFORM.md)). Two levels of
checking:

- **Anywhere, no build:** `npm run test-deploy` runs the whole flow with stand-ins for git, electron-builder, ps and
  the app, against a throwaway install in a temp folder. On Linux and macOS it also stops a real stand-in process by
  its folder. `node scripts/linux-check.mjs` checks the install paths and the `ps` match on a headless box.
- **A real build** (below): needs a desktop session or Xvfb, `npm ci`, and a few minutes. Every step uses a
  throwaway install and data folder in one temp folder, so an installed Corvid and its data are never touched.
  Don't run it from inside a running Corvid.

### Deploy on Linux (Ubuntu 24.04+ desktop or server, or WSL2 Ubuntu)

Needs Node 22.18 or newer, git, and on a headless box `Xvfb` (package `xvfb`; on a box you can't `sudo` on, check
`command -v Xvfb` first). No sudo is needed for the steps themselves. Run everything in one shell, from start to
clean-up.

**0. A temp folder, a display and the code.** Make the temp folder under your home, not with a bare `mktemp -d`:
`/tmp` is a RAM-backed tmpfs of a few GB on some boxes, and `node_modules`, the build and the kept installs take
well over a GB.

```sh
T="$(mktemp -d ~/corvid-deploy-test-XXXXXX)"
# only if node is missing or too old: unpack one inside the temp folder (see the Linux check, step 2)
# (cd "$T" && curl -fsSLO https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz && tar -xf node-v24.11.0-linux-x64.tar.xz)
# export PATH="$T/node-v24.11.0-linux-x64/bin:$PATH"
# headless only: ONE X server for the whole session (on a desktop, skip these two lines)
Xvfb :87 -nolisten tcp & XVFB_PID=$!
export DISPLAY=:87
```

Don't use `xvfb-run -a npm run deploy` per command: `xvfb-run` closes its X server as soon as the deploy exits, and
the app it just started dies with it, so the next step finds nothing running. (If `:87` is taken, pick another
number for both lines.)

Then clone the code into `$T/corvid`:

```sh
git clone https://github.com/jhalek90/Corvid-Official.git "$T/corvid" && cd "$T/corvid"
```

If the box can't (or shouldn't) reach the repo, copy a snapshot from your PC instead: `git archive -o corvid.tar.gz
HEAD` in your checkout, copy `corvid.tar.gz` to `$T` on the box. A `git archive` copy isn't a git repository;
deploy still works (#177) and records the build's commit as unknown:

```sh
mkdir "$T/corvid" && tar -xzf "$T/corvid.tar.gz" -C "$T/corvid" && cd "$T/corvid"
```

**1 to 4. Build, update, forced failure, clean up:**

```sh
npm ci
export CORVID_INSTALL_DIR="$T/install/app" DASH_DATA_DIR="$T/data"
# 1. a first install: builds, checks the package, installs, starts the app
CORVID_HEALTH_SECS=90 npm run deploy
sleep 10; cat "$T/data/health.json"     # {"pid":…,"commit":…}: written by the app once its window was up
OLD=$(grep -o '"pid":[0-9]*' "$T/data/health.json" | cut -d: -f2); kill -0 "$OLD" && echo running
# 2. an update: the running copy is stopped by its folder, the first install is kept
CORVID_HEALTH_SECS=90 npm run deploy
ls "$T/install/app.previous"            # one timestamped folder
kill -0 "$OLD" 2>/dev/null || echo "old copy gone"; cat "$T/data/health.json"   # a new pid
# 3. a forced failure: the test-only switch makes the new build count as never healthy, so it must roll back
CORVID_HEALTH_SECS=90 CORVID_DEPLOY_FAIL_HEALTH=1 npm run deploy; echo "exit $?"   # exit 2
cat "$T/data/deploy-notice.json"        # "...didn't start, so Corvid rolled back..."
cat "$T/data/deploy.log"                # every run's steps, one ===== header per run
# 4. clean up: stop the copy by its folder (never by name), then the X server by its pid, then delete the temp folder
for p in $(ps -A -o pid=,command= | awk -v d="$T/install/" 'index($0, d) { print $1 }'); do kill "$p"; done
[ -n "$XVFB_PID" ] && kill "$XVFB_PID"
cd ~ && rm -rf "$T"; unset CORVID_INSTALL_DIR DASH_DATA_DIR DISPLAY XVFB_PID
```

Pass:

- Step 1 prints "Package check passed" and "Launched …/install/app/corvid", then waits and prints "The new build
  started and reported healthy" (exit 0). A first install has no earlier build to roll back to: if it doesn't
  report healthy it's left in place and the deploy exits 3. `health.json` appears within a few seconds and the
  copy keeps running.
- Step 2 stops the step 1 copy (its pid is gone and `health.json` has a new one), prints "Kept the previous install
  in …/app.previous/<time>" and ends with "The new build started and reported healthy".
- Step 3 ends with "rolled back to the previous build" and "The previous build started and reported healthy", exits
  2, and the restored copy is running again.
- `~/.local/share/applications/corvid.desktop` was **not** written (a throwaway install never writes it).

If the app won't start with a `chrome-sandbox` or namespace error, that's Ubuntu's AppArmor rule for unpacked
Electron apps (the Linux desktop task adds the one-time setup step); note it in the report. A real install (no
`CORVID_INSTALL_DIR`) goes to `~/.local/share/corvid/app` and writes the app-menu entry.

Exit codes (#177): 0 healthy; 1 the deploy or rollback failed; 2 the new build didn't report healthy and the previous
install was put back (the restored build is health-checked too); 3 installed but not healthy with nothing to roll
back to (a first install, or a `--rollback` whose restored build stays silent), left in place. Every run appends to
`deploy.log` in the data folder (moved to `deploy.old.log` past 1 MB). `CORVID_DEPLOY_FAIL_HEALTH=1` is for tests
only: it makes the new build count as never reporting healthy, whatever the timing, and does nothing unless set.

**Optional, on a throwaway box only: the tool caches.** `rm -rf "$T"` doesn't remove what npm, Electron and the
build tools cache outside it, about 300 MB. Check first that nothing else on the box uses them (a real Corvid or
another Node project does), then:

```sh
rm -rf ~/.npm ~/.cache/electron ~/.cache/node-gyp ~/.electron-gyp ~/.cache/fontconfig ~/.cache/glycin
rm -rf /tmp/jiti /tmp/node-compile-cache /tmp/electron-download-* /tmp/scoped_dir*
```

A test copy may also leave an empty `~/.config/Corvid`; on a box with no real Corvid, `rmdir ~/.config/Corvid`
removes it (`rmdir` refuses if anything is inside).

### Deploy on macOS (Apple Silicon), by hand

A first install has run on a real Mac once, through setup (one tester; see the tester checklist). The update and
rollback steps haven't, so nothing beyond the first install is claimed to work until someone ticks it off. In
Terminal, from a clone after `npm ci`:

```sh
T="$(mktemp -d)"
export CORVID_INSTALL_DIR="$T/Corvid.app" DASH_DATA_DIR="$T/data"
CORVID_HEALTH_SECS=90 npm run deploy
```

- [ ] The build makes `dist/mac-arm64/Corvid.app` (or `dist/mac/` on Intel) and "Package check passed" shows.
- [ ] `codesign -dv "$T/Corvid.app"` says `Signature=adhoc` (electron-builder signs it ad hoc when there's no
      identity; an unsigned arm64 app is killed at start).
- [ ] The app opens from `$T/Corvid.app` and the deploy ends with "The new build started and reported healthy".
- [ ] `ls -l "$T/Corvid.app/Contents/Frameworks/Electron Framework.framework"`: the links point inside the bundle
      (`Versions/Current/...`), not back into `dist/`.
- [ ] Run the deploy again: the running copy closes, `$T/Corvid.app.previous/<time>` appears, the new one opens.
- [ ] `CORVID_DEPLOY_FAIL_HEALTH=1 npm run deploy` (test only) rolls back, exits 2, and `$T/data/deploy-notice.json`
      says so.
- [ ] Clean up: quit the copy (Cmd+Q), `rm -rf "$T"`, `unset CORVID_INSTALL_DIR DASH_DATA_DIR`.
- [ ] Only when you want the real install: `npm run deploy` with nothing set installs to
      `~/Applications/Corvid.app`, keeps earlier builds in `~/Library/Application Support/Corvid/previous-builds`,
      and Launchpad shows one Corvid, not the kept ones.
- [ ] From inside that Corvid, Settings > Rebuild closes it, and it comes back on its own a minute or two later
      (the detached relaunch); `deploy.log` in `~/Library/Application Support/Corvid` shows the steps.

## Open in VS Code and Resume in a terminal window (#157)

The command construction and the quoting are unit tested on every platform (`npm run test-launch`); nothing has
opened a real terminal or VS Code on a Mac or a Linux desktop yet. Use a test copy (`npm run test-instance`) with a
fake project whose folder has an awkward name, for example `~/corvid test/it's $HOME;(x)` (spaces, a quote, a `$`, a `;`), and a session in it.

macOS:

- [ ] With `code` installed in the PATH (VS Code > Command Palette > "Shell Command: Install 'code' command"): the
      project page's VS Code button opens the folder; a session's VS Code icon opens it and then the session.
- [ ] Remove `code` from the PATH (or rename it) and restart the copy: the same buttons still open the folder,
      through `open -b com.microsoft.VSCode`, both when VS Code is closed and when it's already running.
- [ ] A session's "Resume in a terminal window" icon opens a new Terminal.app window in the awkward folder, titled
      after the session, running `claude --resume <id>`. `pwd` after quitting claude shows the right folder.
- [ ] The script is gone: `ls "$TMPDIR" | grep corvid-term` shows nothing a few seconds later.
- [ ] The first time, macOS may ask whether Corvid may control Terminal: note what it says.

Linux (GNOME, KDE, and one other desktop if you can):

- [ ] With VS Code installed (`code` on the PATH), both VS Code buttons work as on macOS.
- [ ] Without `code` on the PATH but VS Code installed from the .deb: the folder opens through the vscode://file URI.
- [ ] "Resume in a terminal window" opens the desktop's terminal (gnome-terminal or konsole) in the awkward folder,
      running claude with the session; `ls /tmp | grep corvid-term` is empty afterwards.
- [ ] `TERMINAL=xterm npm run test-instance ...` (or kitty, alacritty, xfce4-terminal): that terminal opens instead.
- [ ] On a box with none of $TERMINAL, x-terminal-emulator, gnome-terminal, konsole or xterm, the button is not
      shown on the session rows.

Windows (must be unchanged): VS Code buttons open through `code`, and "Resume in a terminal window" opens a new
Windows Terminal tab titled after the session, exactly as "Resume in Windows Terminal" did.
