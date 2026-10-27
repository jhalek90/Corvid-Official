---
title: Windows
summary: What works on Windows, and what to know before you start.
section: platforms
order: 1
---

# Windows

Windows is Corvid's main platform. It is built and used there every day, and every feature works there. Corvid
needs Windows 10 or 11, 64-bit.

## Tested status

| Platform | Status |
|---|---|
| Windows | Used every day. Install, update and rollback all run there. |
| macOS | Beta. Automated tests pass. One tester ran setup on a real Mac: build, install and first launch worked. Nothing after the first launch has been tried. |
| Linux | Beta. Automated tests pass. Build, install, update and rollback ran on one Ubuntu 26.04 server with no desktop. Nobody has tried a Linux desktop yet. |

Continuous integration (CI) runs the tests on all three platforms. Its first runs on GitHub do not pass yet.

## Only on Windows

- Voice dictation, with Ctrl+D or the microphone button. On macOS and Linux the button is greyed out.

## How Windows works

| Feature | On Windows |
|---|---|
| Shortcuts | Ctrl |
| Show or hide Corvid from any app | Ctrl+Alt+Space |
| Tray | The notification area |
| Start at login | **Start with Windows** in **Settings** → **Window and layout** |
| Resume a session in a terminal window | Windows Terminal |
| Side terminal shells | PowerShell, PowerShell 7, Command Prompt, Git Bash and Windows Subsystem for Linux (WSL), if they are installed |
| Saved passwords and tokens | Encrypted with Windows data protection |

## Where things are

| What | Where |
|---|---|
| The app | `%LOCALAPPDATA%\Programs\Corvid` |
| Previous builds, for rollback | `%LOCALAPPDATA%\Programs\Corvid.previous` |
| Your data | `%APPDATA%\Corvid` |

If you used Corvid before it was renamed, your data stays in `%APPDATA%\Claude Dashboard`.

## Claude Code on Windows

Corvid looks for `claude.exe` in two places: the native installer's `~/.local/bin`, and the Visual Studio Code (VS Code) extension. It
uses the newer one. A `claude` that is only on your `PATH`, for example from `npm install -g`, is not found. Install
the native one.

To use a `claude.exe` in another folder, choose it in **Settings** → **System** → **Claude Code path**. Corvid
refuses `.bat`, `.cmd` and `.ps1` files there. On some computers `claude.bat` runs Claude inside the Windows Subsystem
for Linux (WSL). See [Claude Code path](../settings/reference.md#claude-code-path).
