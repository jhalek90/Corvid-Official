---
title: Layout and shortcuts
summary: How panes and tabs work, and which keyboard shortcuts Corvid has.
section: getting-started
order: 5
---

# Layout and shortcuts

The main area is split into panes. Each pane has tabs. Corvid keeps your layout between launches.

## How a page opens

When you open a page from the rail, a shortcut or a link, Corvid does one of these:

- If the page shows in a pane already, that pane gets the focus. Nothing moves.
- If the page is a hidden tab in a pane, that tab comes to the front.
- If the page is not open, it gets a new pane. Corvid splits the focused pane, or the largest pane, in half.

A new page opens as a tab instead when any of these is true:

- There are 4 panes already.
- A new pane would be smaller than 360 by 240 pixels.
- The pane area is narrower than 760 pixels.

To open the page the other way once, Ctrl+click its rail icon (Cmd+click on macOS), or middle-click it. To change
the default, go to **Settings** → **Window and layout** → **Open new views in** and pick **A new pane** or **A new
tab**.

## Change the layout

- Drag a tab to another pane, or onto the edge of a pane to split it.
- Click the split buttons on a tab strip to split a pane by hand.
- Shift-click a rail icon to open that page beside the current one.
- Drag the edge of a panel to resize it. Double-click the edge to reset it.
- Click the X at the right end of a tab strip to close the pane. Its neighbour takes the space.

## Keyboard shortcuts

On macOS, use Cmd in place of Ctrl. The terminal keys are the exception: they stay Ctrl on every platform.

| Keys | What they do |
|---|---|
| Ctrl+1 to Ctrl+8 | Open Agents, Tasks, Usage, Projects, Notes, Settings, Connections, Extensions |
| Ctrl+K | Search sessions. Enter shows the session on its project page. Ctrl+Enter resumes it. |
| Ctrl+J | Open the board with the message box set to Corvid |
| Ctrl+P | Switch project. Not inside a terminal. |
| Ctrl+B | Show or hide the file tree. Not inside a terminal. |
| Ctrl+\` | Go to a shell on screen, or hide the side terminal from inside it |
| Ctrl+Shift+\` | Open another shell |
| Ctrl+D | Dictate. Tap to start and stop, or hold to talk. Windows only. Not inside a terminal. |
| Ctrl+Alt+Space (Cmd+Shift+Space on macOS) | Show or hide Corvid from any app. You can change it in **Settings**. |
| Shift+Enter in a Claude terminal | New line in Claude's prompt |
| Ctrl+C and Ctrl+V in a terminal | Copy the selection and paste. With nothing selected, Ctrl+C stops the running command. |

On macOS, Cmd+C and Cmd+V copy and paste in a terminal, and Ctrl+C always stops the running command.

On Linux under Wayland, the show-or-hide shortcut works only if the desktop supports global shortcuts.
