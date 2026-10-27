---
title: macOS
summary: What works on macOS so far, and what is different there.
section: platforms
order: 2
---

# macOS

Corvid on macOS is in beta. It runs on Apple Silicon and Intel Macs.

## Tested status

- The automated tests cover macOS behaviour. They haven't run green on GitHub's macOS runner yet.
- One tester ran `npm run setup` on a real Mac. Build, install and first launch worked.
- Human testers have since used Corvid on their Macs past the first launch, and report that it works well. Which
  parts they tried, such as updates and rollback, hasn't been collected yet.

To help test, follow the tester checklist in
[TESTING-PLATFORMS.md](../TESTING-PLATFORMS.md#tester-checklist) and report what you see.

## What is different on macOS

| Feature | On macOS |
|---|---|
| Shortcuts | Cmd in place of Ctrl. Tooltips show ⌘. The terminal keys stay Ctrl. |
| Show or hide Corvid from any app | Cmd+Shift+Space |
| Tray | The menu bar. Closing the window keeps Corvid running. Click the Dock icon to show it again. |
| Start at login | **Open at login** in **Settings** → **Window and layout**. It adds Corvid to Login Items. |
| Resume a session in a terminal window | Terminal |
| Open in Visual Studio Code (VS Code) | `code` on your `PATH`, or else VS Code by its app id |
| Side terminal shells | Your login shell first, then the other installed shells |
| Saved passwords and tokens | The Keychain. It can ask you once. |

Voice dictation does not work on macOS yet. The microphone button is greyed out.

## Where things are

| What | Where |
|---|---|
| The app | `~/Applications/Corvid.app` |
| Previous builds, for rollback | `~/Library/Application Support/Corvid/previous-builds` |
| Your data | `~/Library/Application Support/Corvid` |

## Claude Code on macOS

Corvid looks for `claude` in these places and uses the newest version it finds:

- `~/.local/bin` (the native installer)
- `~/.claude/local`
- The VS Code extension
- Homebrew's folders: `/opt/homebrew/bin` and `/usr/local/bin`
- Your `PATH`

To use a different `claude`, choose it in **Settings** → **System** → **Claude Code path**. A symbolic link is fine.
See [Claude Code path](../settings/reference.md#claude-code-path).

## If the installed app does not start

1. Run `npm run setup -- --no-launch` in your Corvid folder. It builds Corvid but does not install it.
2. Run `npm start`. Corvid runs from the folder.
3. Report what `npm run deploy` printed. See the tester checklist above.
