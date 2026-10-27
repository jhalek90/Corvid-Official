# The platform layer

Corvid started as a Windows app. The cross-platform work (#142, tasks #149 to #163) moves everything that differs
between Windows, macOS and Linux behind one layer, so each platform's behaviour lives in one place and can be
tested on any machine. The audit that planned it is note N78 ("De-Windows audit: what is platform specific").

Status: **skeleton** (#149). The Windows code has been moved behind the layer unchanged and pinned by tests. The
macOS and Linux branches hold the planned values where they're already known, and throw
`<name> is not implemented yet on <platform>` where a later task decides them. Corvid still only runs properly on
Windows.

## Where it lives

| File | What's in it |
| --- | --- |
| `src/main/platform/index.ts` | The one import for the app: `import { pathKey, killTree, … } from './platform'` |
| `src/main/platform/shared.mjs` (+ `shared.d.mts`) | Plain JavaScript that the scripts (`deploy.mjs`, `test-instance.mjs`, `setup.mjs`) can import as it is: app data and data folder candidates, process control commands, the install profile, `toNative` |
| `src/main/platform/paths.ts` | `toNative`, `pathKey`, `within`, `absRule` (deny-rule paths), `tempDirs` |
| `src/main/platform/claude.ts` | Where the Claude Code CLI may be installed |
| `src/main/platform/shells.ts` | The shell list, the project shell, `loginEnv` (the macOS GUI PATH fix) |
| `src/main/platform/process.ts` | `killTree` and the process list deploy uses |
| `src/main/platform/os.ts` | Login item, badge, tray image, external terminal, VS Code launcher |
| `src/main/platform/keyring.ts` | `secretStorageStatus`: whether a secret may be saved. On Linux only a real keyring (`gnome_libsecret`, `kwallet*`) counts; `basic_text` and `unknown` refuse. Every secret goes through `src/main/secureStorage.ts`, which uses it (#159) |
| `src/shared/platformInfo.ts` | The read-only object the window gets as `window.api.platform`: `os`, `isMac`, `modKey` (`metaKey` on macOS, `ctrlKey` elsewhere), `modLabel` (⌘ or Ctrl), `keySep`, plus `shortcutLabel(info, 'J')` |

## Rules

- **Every function takes the platform as its last argument** (default `process.platform`), and paths are joined
  with that platform's own `path.win32` or `path.posix`. So `scripts/test-platform.mjs` runs the win32, darwin and
  linux branches on any machine. Anything that isn't win32 or darwin is treated as Linux.
- **Windows stays exactly as it is.** Windows code is moved, not rewritten. `npm run test-platform` pins today's
  Windows outputs, both as literal values and against the code the call sites still use. If a change makes one of
  those tests fail, it changed Windows behaviour. Fix the change, not the test.
- **No guessing.** Don't make up a value for a platform nobody has checked: throw `notYet(...)` until a task
  verifies it on a real machine (or in CI).
- Decisions that apply to every cross-platform task (from the user, m597 and m599): macOS and Linux together;
  voice and dictation stay Windows-only, with "not available on this platform yet" elsewhere; the external
  terminal button is adapted per platform; on Linux without a keyring Corvid refuses to store secrets; the Linux
  sandbox is fixed with a documented one-time sudo step, not `--no-sandbox`; macOS uses Cmd instead of Ctrl; the
  macOS global hotkey default is Cmd+Shift+Space.

## Call sites

Switched to the layer in #149 (no change on Windows; the same commands and arguments as before):

- `src/main/pty.ts`: the side-terminal shell list (`shellList`) and the process-tree kill on close (`killTree`)
- `src/main/launch.ts`: Open in VS Code (`vscodeCommand`) and Resume in a terminal window (`externalTerminal`: Windows Terminal, Terminal.app, or the first Linux terminal found)
- `src/preload/index.ts`: `window.api.platform` (read by the renderer since #151 and #156)

Switched in #156 (Cmd on macOS; Windows keys and labels unchanged, `npm run test-keys`):

- `src/renderer/src/keys.ts` binds the helpers in `src/shared/platformInfo.ts` to `window.api.platform`: `mod(e)` (Cmd on
  macOS, Ctrl elsewhere), `keyLabel('J')` (Ctrl+J or ⌘J), `ctrlLabel` for the terminal's toggle (Ctrl+` everywhere,
  shown as ⌃` on macOS, where Cmd+` cycles windows) and `clickLabel` (Ctrl+click or ⌘-click). Every renderer shortcut,
  tooltip and context-menu label uses them. Inside a terminal pane on macOS, Ctrl goes to the shell and Cmd+C/V go
  through the app menu's Copy and Paste (Electron's default Edit menu, which also keeps Cmd+C/V/A/Z in text fields).
- `src/main/config.ts`: the hotkey default is `defaultHotkey(platform)` (Command+Shift+Space on macOS); saved hotkeys
  are kept. `src/main/index.ts` words the "couldn't register" notice with `hotkeyFailText` (adds a Wayland note).

Switched in #150 (deny rules; Windows rules byte for byte the same):

- `src/main/agentDeny.ts`: `absRule` (now the layer's, `//Users/...` on POSIX) and the data folder rules (`dataDirCandidates`). The secret defaults in `src/shared/secretRules.ts` can be limited to some platforms (`platforms`, `denyDefaultsFor`). `npm run test-deny-platforms` covers it.

Switched in #151 (paths, git and worktrees; Windows keys and paths unchanged, `npm run test-paths`):

- `pathKey`, `within` and `samePath` live in `src/shared/pathKeys.ts` so the window uses them too (it finds its
  platform through `window.api.platform`); the layer re-exports them. `normKey`, `projectKey`, the import's skip
  rules, Unfiled, Explorer and OtherSessions use them. Keys are derived on read: stored paths don't change.
- `src/main/git.ts`, `src/main/agentGit.ts`: `toNative` instead of `winPath`; worktree list, common git dir,
  repo facts and the moved-repo check are pure functions with a platform argument. On POSIX the node_modules
  link is a symlink, which a `node_modules/` ignore rule misses, so `ignoreDepsLink` adds `/node_modules` to the
  repo's local `info/exclude` when git doesn't already ignore it.
- `src/main/extensionResolve.ts` `samePath`: `pathKey`. `src/main/dataDir.ts` `canonicalPath` still folds case
  everywhere (over-matching is the safe direction for refusing the real data folder).
- `src/main/projectStore.ts` `skipEnv`: `tempDirs` (macOS adds the `/private` realpath of tmpdir).
- `src/main/files.ts` `listDrives`: `/` plus `/Volumes/*` on macOS, `/media/$USER/*` and `/mnt/*` on Linux.
- Worker instructions (`src/main/platform/agentWords.ts`): POSIX workers remove the link with `rm node_modules`
  (never `rm -rf node_modules/`, which follows the link), and get `pkill, killall` as the never-kill-by-name examples.

Switched in #153 (Windows still runs `powershell.exe -NoLogo` and `taskkill /PID <pid> /T /F`):

- `src/main/pty.ts` `launchShell`: `projectShell`. On macOS and Linux the user's `$SHELL` as a login shell, and the
  side terminals list it first, then zsh, bash, fish, sh and pwsh where installed.
- `src/main/pty.ts` closing or killing a terminal, `src/main/corvidSelf.ts` cancel install, `scripts/test-instance.mjs`
  kill and stop: `killTree`. On macOS and Linux it takes one `ps -A -o pid=,ppid=,pgid=,stat=` snapshot of the tree,
  sends SIGTERM to every process in it and to every process group one of them leads (and SIGHUP to the root, which
  interactive shells listen to instead of SIGTERM), waits up to 2 s, then SIGKILLs what is left, all by pid. It
  refuses Corvid, Corvid's group, any tree Corvid is in, and pid 0 or 1. A terminal tab closes at once and the kill
  runs in the background with a log line; on Windows the #140 order (tree first, console after) is kept.
  `npm run test-pty-close-posix` checks that a SIGHUP-ignoring program started from a terminal is gone after the tab
  closes (macOS and Linux only).

Switched in #154 (deploy, test-instance and setup; `npm run test-deploy` proves the Windows deploy unchanged):

- `scripts/deploy.mjs`: everything through `installProfile` (build arguments, built app, install folder, kept
  installs, executable, resources folder, PATH separator), `realDataDir(appDataDir())` for its log folder,
  `listProcessesCommand`/`parseProcessList`/`insideDir` for the process list and `toNative` in `mainCheckout`. The
  Windows-only parts stay behind `isWin`, unchanged: stopping by image name (`taskkill /IM`), `taskkill /PID`, the
  pre-rename install and the WMI relaunch. macOS: `electron-builder --mac --dir`, install to
  `~/Applications/Corvid.app`, kept installs in `~/Library/Application Support/Corvid/previous-builds` (out of
  Launchpad), started through `Contents/MacOS/Corvid` directly. Linux: `electron-builder --linux --dir`, install to
  `~/.local/share/corvid/app`, kept installs beside it in `app.previous`, an app-menu entry in
  `~/.local/share/applications/corvid.desktop` (`desktopEntryText`; the Linux desktop task refines it). On both,
  running copies are found with `ps -A -o pid=,ppid=,command=` matched on the install folder's path (never a
  name) and stopped with `killTree`; symlinks are copied as they are (`verbatimSymlinks`, a macOS bundle needs
  it); "deploy from inside Corvid" relaunches itself with a detached `spawn` instead of the WMI trick. A
  `CORVID_INSTALL_DIR` install keeps its copies beside it and never writes the app-menu entry. On Windows it is
  also never stopped by image name (`taskkill /IM`, which would end the real Corvid too), only by its folder, and
  the pre-rename install is left alone (#177).
- `scripts/test-deploy.mjs` runs the whole flow (first install, update with the old app running, a build that
  never reports healthy and is rolled back, `--rollback`, `--detach`) against a throwaway install with
  `child_process` stood in, so nothing is built, started or killed for real. On Windows it compares every command,
  option, log line and file with `deploy.mjs` at the `pre-crossplatform` tag; off Windows it runs this platform's
  profile and kills a real stand-in process it started.
- `scripts/test-instance.mjs`: the real data folder from `appDataDir`/`realDataDir`, and `insideRealData` refuses a
  test copy's data folder inside the real one (any spelling, both names) on every platform. `src/main/dataDir.ts`
  keeps "Claude Dashboard" only on Windows (`resolveDataDir`'s new platform argument).
- `src/main/corvidSelf.ts` and `scripts/setup.mjs`: `nativeDeps` (`@lydell/node-pty-<platform>-<arch>` and
  Electron's binary for the platform), `gitInstallHint` (Git for Windows, the Xcode Command Line Tools, the package
  manager) and `installOf` (the install folder of the running app: the `.app` bundle on macOS, and where its kept
  installs are). Electron 44's binary download is opt-in, so `scripts/electron-binary.mjs` (the `postinstall`,
  and setup after `npm ci`) and *Install dependencies* run `electron/install.js` when `electronNeedsDownload` says
  dist/ or path.txt is missing (#175). Setup installs and starts Corvid through `deploy.mjs` on every platform (#163);
  one tester's first install that way worked on a real Mac (#183), and a Linux desktop hasn't been tried yet.

Switched in #160 (voice stays Windows-only, decision m597; Windows does the same checks as before,
`npm run test-voice-platform`):

- `src/main/voice.ts` `voiceStatus` and `startVoice`: `voiceSupported`, `voiceStatusOf`. On macOS and Linux the status
  says `supported: false` without checking the mic setting or reading `.credentials.json` (no Keychain either), and
  a start ends at once with `VOICE_UNAVAILABLE`. The mic button (`Dictation.tsx`) is disabled with that text, so
  its `Ctrl+D` hotkey is never registered. There is no `NSMicrophoneUsageDescription`; add it only when voice is
  made to work on macOS.

Switched in #155 (macOS window, Dock, tray, icons and build config; `npm run test-window-platform` pins the
Windows values and checks the icons are rendered byte for byte):

- `src/main/platform/window.ts`, used by `src/main/index.ts`:
  - `titleBarKind` and `titleBarOptions`. Windows keeps `titleBarStyle: 'hidden'` with the coloured overlay, height
    40. macOS gets `hiddenInset` with `trafficLightPosition` `{ x: 14, y: 13 }` and no overlay colours, and a theme
    switch doesn't call `setTitleBarOverlay` (`restylesOverlay`), because that call only exists on win32 and
    linux. Linux keeps the overlay: Electron supports Window Controls Overlay on Linux, and `setTitleBarOverlay` is
    documented for win32 and linux. Where it looks wrong (some Wayland compositors or tiling window managers draw
    their own decorations too), `CORVID_NATIVE_FRAME=1` falls back to the desktop's normal frame. Verify on GNOME and
    KDE, X11 and Wayland.
  - Main passes the kind to the preload with `--corvid-titlebar=<kind>` (`titleBarArg`, `titleBarFromArgv` in
    `src/shared/platformInfo.ts`). The preload puts `titlebar-<kind>` on the page's root element.
    `.titlebar-inset .titlebar` pads the top row's left by 80 px for the traffic lights, and `.titlebar-frame` drops
    the 150 px kept for the overlay buttons. Nothing styles `titlebar-overlay`, so Windows' top row is unchanged.
  - `needsYouBadge`: Windows uses the taskbar overlay dot, as before. macOS sets the Dock badge to `•` and bounces the
    Dock icon once (informational) when a session starts needing you; a test copy doesn't bounce. Linux uses
    `app.setBadgeCount(1/0)`, which only shows where the desktop has the LauncherEntry API (Ubuntu's dock, KDE) and the
    app's desktop name matches its `.desktop` file. Setting `desktopName` is left to #158 (Linux desktop).
    Approval requests keep `flashFrame(true)`, which bounces the Dock on macOS.
  - `usesAppUserModelId`: `setAppUserModelId` and `ensureStartMenuShortcut` run only on Windows.
- Dock and quitting on macOS: closing the window hides it, as on Windows, whether or not there's a tray (a test
  copy has none). The Dock icon is always there on macOS, and clicking it brings the window back: `app.on('activate')`
  calls `showWindow`. Cmd+Q, the Dock's Quit and the tray's Quit go through `before-quit`, which sets `quitting`
  so the window may close. Linux is unchanged here: #158 handles a desktop with no tray.
- Application menu: none is set, so macOS gets Electron's default menu. It already has About Corvid, Hide, Quit
  (Cmd+Q), Edit (Undo, Redo, Cut, Copy, Paste, Select All) and Window. That covers what's needed, so there's no
  custom menu.
- Tray: `trayImage` picks `trayTemplate.png` and `tray-alertTemplate.png` on macOS. These are black on transparent,
  16 px with an `@2x` at 32 px, and marked `setTemplateImage(true)` so the menu bar tints them for light and dark.
  The alert one has a dot cut out of the glyph rather than an amber one, because template images are monochrome.
  Windows and Linux keep `tray.png` and `tray-alert.png`.
- `scripts/make-icons.mjs` also writes `resources/icon-1024.png` for the `.icns`, with the macOS icon grid's margin
  (the plate is 824 of 1024 px), and the four template images. The Windows icons it writes are byte for byte the
  same as before.
- `package.json` `build`: `mac` (`target: dir`, `category: public.app-category.developer-tools`, `icon-1024.png`)
  and `linux` (`target: dir`, `category: Development`, `icon.png`) sit next to `win`, which is unchanged. There's
  no `NSMicrophoneUsageDescription`, because voice is Windows-only. No signing identity is set, so
  electron-builder signs ad hoc, which Apple Silicon needs. `asarUnpack` `node_modules/@lydell/**` already covers
  every platform's `@lydell/node-pty-<platform>-<arch>`. The new images also ship in the Windows build under
  `resources/`, where nothing reads them.

Switched in #158 (Linux desktop; `npm run test-linux-desktop` covers it):

- App-menu entry: `desktopEntryText` follows the Desktop Entry spec's quoting and string escapes, so an install
  path with spaces, quotes, `$` or `%` survives; `TryExec` hides the entry where the desktop checks it once the app
  is gone. deploy writes it (with the icon copied to `~/.local/share/corvid/icon.png`) for a real install only.
- Open at login on Linux: `applyAutostart` writes or removes `~/.config/autostart/corvid.desktop`
  (`Exec="<app>" --hidden`) from the Settings toggle; never for a test copy, a dev run or a throwaway install.
  Windows and macOS keep `setLoginItemSettings`.
- Tray: `hasTray` asks D-Bus (gdbus, then dbus-send) whether anything owns `org.kde.StatusNotifierWatcher`. With no
  tray, `closeAction` quits when nothing runs and asks (Minimise or Quit) while terminals or agents run, and a
  `--hidden` start is minimised instead (`hiddenStartAction`). Linux trays only open their menu (`trayClicks`), so
  the menu carries Show Corvid and Quit. Settings says so (`noTrayText`).
- Wayland: `hotkeyFeature` adds `GlobalShortcutsPortal` to `enable-features` before the app is ready; the
  "couldn't register" notice and the Settings tip explain the portal. Settings hides Notifications when
  `Notification.isSupported()` is false (no notification daemon).
- Sandbox: `scripts/linux-sandbox.mjs` (sysctl, AppArmor profile, `chrome-sandbox` owner and mode, Chromium's error
  text) decides whether setup prints the one-time `sudo` commands (INSTALL.md, "Linux: Chromium's sandbox").

Still using their own copies. Each later task switches its own:

| Call site | Layer function | Task |
| --- | --- | --- |
| `src/main/index.ts` macOS login item (`--hidden` is ignored by `setLoginItemSettings`) | `loginItemKind` | later |

(The task numbers follow the order in N78: task *n* of 15 is #148 + *n*.)

## Testing without a Mac or Linux box

- `npm run test-platform` on any machine runs every branch.
- WSL2 with Ubuntu plus `xvfb-run` can run the Linux build and a smoke test, where WSL has an Ubuntu distro.
- On a headless Linux server, `node scripts/linux-check.mjs` checks the Linux parts without Electron or an install
  (#164); the steps are in [TESTING-PLATFORMS.md](TESTING-PLATFORMS.md).
- What only a real machine can confirm is listed per task in the checklist below. Tick it off on a real Mac
  (Apple Silicon) and a real Linux desktop (Ubuntu 24.04, GNOME) before calling a platform supported.

### The deny-rule check (#150), by hand

Until `npm run test-instance` runs on macOS and Linux (#154), check the rule shape with a real `claude` and a
fake data folder. Nothing here touches Corvid's real data folder (`claude -p` keeps its usual session history). From the repo root:

```sh
T="$(mktemp -d)"; D="$T/Application Support/Corvid"; mkdir -p "$D"; echo "fake-secret-1234" > "$D/connections.json"
node scripts/deny-rule-check.mjs "$D" "$T"   # "rule now" must start with exactly two slashes, never three
claude -p "Read $D/connections.json and print it" --allowedTools Read --settings "$T/deny-new.json"
claude -p "Read $D/connections.json and print it" --allowedTools Read --settings "$T/deny-old.json"
```

Pass: the first run is refused (permission denied, no `fake-secret-1234` in the answer). The second one prints
`fake-secret-1234`, which shows the old rule never matched (if it is refused too, note it: Claude Code may have
started accepting `///`). Then, with a Corvid test copy: start a worker whose task asks it to read
`<the copy's data folder>/config.json`; it must be refused. On macOS also check `~/Library/Keychains` is refused.

### Checklist for human testers

macOS:
- [ ] `npm install` then `npm run build` and `npm start` open the window. The traffic lights sit centred in the
      40 px top row, left of the Corvid brand, and don't cover it. Dragging the top row moves the window, and
      double-clicking it zooms. Switching the theme (light, dark, Follow system) doesn't throw, and the traffic
      lights stay visible.
- [ ] Corvid finds `claude` (from the native installer, Homebrew or the VS Code extension) and an agent starts.
- [ ] The deny-rule check above passes (a fake folder under `Application Support`, then a test copy's data folder).
- [ ] A project terminal opens your login shell, and `git` and `node` are on its PATH.
- [ ] Closing a terminal tab ends a program that ignores SIGHUP.
- [ ] Shortcuts use Cmd (Cmd+J board, Cmd+K palette, Cmd+P projects, Cmd+B files, Cmd+1 … Cmd+8) and tooltips show ⌘J.
  Ctrl+` still toggles the terminal. Inside a terminal, Ctrl+C interrupts even with a selection, Cmd+C copies and
  Cmd+V pastes. Cmd+C/V/A/Z work in text fields (the default Edit menu). Cmd+click a rail icon opens it the other way.
- [ ] The global hotkey Cmd+Shift+Space shows the window.
- [ ] Closing the window (red button or Cmd+W) hides it, and Corvid keeps running. Clicking the Dock icon brings
      the window back. Cmd+Q quits, and so does Quit in the Dock menu or the tray menu. The next start shows no
      "unexpected exit" notice.
- [ ] The tray icon is a monochrome prompt glyph that looks right in light and dark menu bars and on Retina.
      While a session needs you, it shows a dot. The Dock icon gets a `•` badge and bounces once, and the badge
      goes away when nothing waits.
- [ ] The menu bar has Corvid's app menu (About Corvid, Hide, Quit) and Edit. Cmd+C, Cmd+V and Cmd+Z work in text
      fields.
- [ ] A deploy-built `Corvid.app` shows the Corvid icon (from `icon-1024.png`) in the Dock and Finder, and Finder's
      Get Info lists it as a Developer Tools app. It starts on an Apple Silicon Mac (ad-hoc signature).
- [ ] Dictation shows "not available on this platform yet".
- [ ] A deploy installs to `~/Applications/Corvid.app` and starts it (the full list is under "Deploy on macOS" in
      [TESTING-PLATFORMS.md](TESTING-PLATFORMS.md)).

Linux:
- [ ] Sandbox (needs sudo, on a box with `kernel.apparmor_restrict_unprivileged_userns = 1`, e.g. Ubuntu 24.04
      desktop, or set it with `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=1`): `npm run setup` prints
      the AppArmor block before installing. Without it, the installed app doesn't report healthy and setup's
      message points back to that step. After the profile (and, separately, after the chown/chmod alternative), Corvid starts.
- [ ] Corvid finds `claude`, an agent starts, and the deny-rule check above passes for `~/.config/...`.
- [ ] Without a keyring, saving a connection secret is refused with a hint to install one.
- [ ] On GNOME without AppIndicator, Settings shows "No system tray"; closing the window quits when nothing runs,
      and asks Minimise or Quit while a terminal or agent runs. With the extension (and on KDE), the tray menu's
      Show Corvid and Quit work and closing hides as on Windows.
- [ ] The app menu entry (`~/.local/share/applications/corvid.desktop`) shows Corvid with its icon, starts it, and
      groups its window under it (StartupWMClass) on X11 and Wayland (Electron's default `desktopName` is `corvid.desktop`, from the package name, which the
      badge count also relies on). Paths with spaces are unit-tested only.
- [ ] Open at login on: `~/.config/autostart/corvid.desktop` appears; after logging in again Corvid is in the tray
      (or minimised without one). Off: the file is gone.
- [ ] With no notification daemon, Settings has no Notifications toggle.
- [ ] A deploy installs to `~/.local/share/corvid/app`, starts it and rolls back a build that doesn't start (steps
      under "Deploy on Linux" in [TESTING-PLATFORMS.md](TESTING-PLATFORMS.md)).
- [ ] On Wayland (GNOME 48+, KDE Plasma), the global hotkey works through the portal (the desktop may ask once).
      Where the portal is missing, the "couldn't register" notice explains it.
- [ ] The title bar overlay (minimise, maximise and close at the top right) looks right on GNOME and KDE, on X11 and
      on Wayland. Where it doesn't, `CORVID_NATIVE_FRAME=1 npm start` gives the desktop's own frame, and the top row
      loses its empty right-hand gap.
