---
title: Linux
summary: What works on Linux so far, and what is different there.
section: platforms
order: 3
---

# Linux

Corvid on Linux is in beta. It needs a 64-bit Linux with a desktop.

## Tested status

- The automated tests pass in a Linux container. They haven't run green on GitHub's Linux runner yet.
- Build, install, update and rollback ran on one Ubuntu 26.04 server with no desktop.
- Nobody has tried Corvid on a Linux desktop yet. The window, the tray, the keyring and the sandbox step are not
  tested on a real desktop.

To help test, follow the tester checklist in
[TESTING-PLATFORMS.md](../TESTING-PLATFORMS.md#tester-checklist) and report what you see.

## What Linux needs

- A system keyring, GNOME Keyring or KWallet, to save passwords and tokens. A desktop has one already.
- A colour emoji font. Without one, emoji on the board show in black and white. Install it with
  `sudo apt install fonts-noto-color-emoji` (Debian, Ubuntu) or `sudo dnf install google-noto-color-emoji-fonts`
  (Fedora).
- On Ubuntu 23.10 and later, a one-time `sudo` step for Chromium's sandbox. See
  [Chromium's sandbox](#chromiums-sandbox).

## What is different on Linux

| Feature | On Linux |
|---|---|
| Shortcuts | Ctrl, as on Windows |
| Show or hide Corvid from any app | Ctrl+Alt+Space. Under Wayland, only if the desktop supports global shortcuts. |
| Tray | Only where the desktop has one, such as KDE. GNOME needs the AppIndicator extension. |
| Start at login | **Open at login** in **Settings** → **Window and layout**. It writes `~/.config/autostart/corvid.desktop`. |
| Resume a session in a terminal window | `$TERMINAL`, then `x-terminal-emulator`, `gnome-terminal`, `konsole` or `xterm`. With none of them, the button is hidden. |
| Open in Visual Studio Code (VS Code) | `code` on your `PATH` |
| Side terminal shells | Your login shell first, then the other installed shells |
| Saved passwords and tokens | GNOME Keyring or KWallet |
| Spell check | Usually none |

Voice dictation does not work on Linux yet. The microphone button is greyed out.

### With no tray

With no tray, Corvid cannot run hidden. **Settings** shows **No system tray**. Closing the window quits Corvid. If
terminals or agents are running, Corvid asks first: **Minimise** or **Quit Corvid**.

### With no keyring

Corvid refuses to save a password or token without a keyring. It never stores them as plain text. The rest of Corvid
works. To fix it, install GNOME Keyring or KWallet and make sure it is unlocked. <!-- asd-ignore: "unlocked" is the literal keyring state -->
Then log out, log back in and restart Corvid.

## Where things are

| What | Where |
|---|---|
| The app | `~/.local/share/corvid/app` |
| Previous builds, for rollback | `~/.local/share/corvid/app.previous` |
| Your data | `~/.config/Corvid`, or `$XDG_CONFIG_HOME/Corvid` if that is set |
| The app menu entry | `~/.local/share/applications/corvid.desktop` |

## Chromium's sandbox

Corvid keeps Chromium's sandbox on. Ubuntu 23.10 and later block what the sandbox needs for unknown apps. Corvid then
does not start, with an error about `chrome-sandbox` or "No usable sandbox!".

Setup checks for this. When the step is needed, setup prints the exact commands before it installs Corvid. It never
runs `sudo` itself. Run the commands once. You have two choices:

- An AppArmor profile. This is the better choice, because it stays in place after updates. Setup prints a
  `sudo tee /etc/apparmor.d/corvid` block, then `sudo apparmor_parser -r /etc/apparmor.d/corvid`.
- Make `chrome-sandbox` setuid root. Each `npm run deploy` copies a new `chrome-sandbox`, so you must do this again
  after every update.

Do not start Corvid with `--no-sandbox`.
