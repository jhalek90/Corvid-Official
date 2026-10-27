---
title: Files, terminal and search
summary: How to browse files, open a terminal and search inside Corvid.
section: getting-started
order: 6
---

# Files, terminal and search

Corvid has a file tree, shells and a session search. You reach all three from the rail or with a shortcut.

## Files

Press Ctrl+B (Cmd+B on macOS) or click **Files** on the rail. A read-only tree opens. It starts in the folder of the
project you chose in the project switcher.

- Click a file to preview its first 256 kilobytes as text.
- Double-click a file to open it in Visual Studio Code (VS Code). Corvid never opens files in the system's default app, because that app
  could run a script.
- Right-click a file for more actions.

## Terminal

Press Ctrl+\` or click **Terminal** on the rail. A shell opens in a panel at the side. The keys are Ctrl on macOS
too.

- Press Ctrl+Shift+\` to open another shell.
- Press Ctrl+\` inside a shell to hide the side panel.
- With no shell on screen, Ctrl+\` brings back the shell you used last.

The shells on offer depend on your platform. See [Platforms](../platforms/windows.md).

### Move a shell into a pane

1. Drag the shell's tab out of the side panel onto a pane's tab strip, or onto a pane's edge. You can also click
   **Move to a pane** in the panel.
2. The shell shows as a tab in that pane. It is the same shell, with the same scrollback and folder.

To move it back, drag the tab onto the side panel, or click **Move to the side panel** on the tab.

Closing a shell's tab ends the shell. All shells end when Corvid quits.

## Search

Press Ctrl+K (Cmd+K on macOS), or click the search box in the top bar. Type a word. Corvid searches session titles
and the full text of each session.

- Press Enter to show the session on its project page.
- Press Ctrl+Enter to resume it.

The search also finds sessions that Claude Code has deleted. You can read their summary, but you cannot resume them.
