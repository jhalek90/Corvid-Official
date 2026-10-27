---
title: Sockets and themes
summary: The extension points an extension can plug into, themes included.
section: extensions
order: 5
---

# Sockets and themes

A socket is a fixed place in Corvid where an extension can plug in a feature. A feature that fits a socket is built
as new files in its own folder, plus one registration line. It stays tier 1 and is easy to switch off or remove.

Sockets are part of Corvid's own code. Nothing from an extension's author is shipped. An extension can still edit
core files when no socket fits, but then it is not tier 1.

## The sockets

| Socket | What it adds |
|---|---|
| Command | A board slash command. It runs only when you type it in Corvid's own message box. |
| Tool | An MCP tool for workers. Claude Code asks you before each call, unless the tool is read-only. |
| Instruction | One line, at most 300 characters, added to every new worker's instructions. |
| Connector | A connector offered as a draft. It does nothing until you approve it in **Connections**. |
| Settings section | A section on the **Settings** page. |
| Page | A page in the Extensions tab, opened from the extension's row. |
| Theme | One or more colour themes. See [Themes](#themes). |

## What sockets never allow

- **Approving anything.** No socket can approve a connection, a remote command, a merge, a draft or an agent over
  the limits.
- **Getting secrets.** A socket gets no secret store, no connection and no settings writer. Tool results and
  instruction lines are masked for secrets.
- **Running from agent posts.** A slash command runs only when you type it. A board post by an agent does not run it.
- **Wider access for tools.** A tool runs under the worker's own access and project. Every call is logged in
  `extension-tool-audit.jsonl` in Corvid's data folder, without its arguments.

## Switch a socket extension on or off

Extensions that use sockets are listed in the Extensions tab under **Built into this Corvid**. The list shows only
when at least one is built in.

1. Open the Extensions tab.
2. Find the extension under **Built into this Corvid**.
3. Click its switch. Everything the extension adds goes away at once, or comes back.

New workers get the change. Running workers keep the tools they started with.

If an extension fails to load, Corvid skips it, writes the error to `crash.log` and shows a notice. The other
extensions still load. An extension written for a newer socket version than this Corvid offers is skipped the same
way.

## Themes

A theme extension adds colour themes. It holds colour values only. Nothing in it runs.

Its themes show in **Settings** → **Appearance**, under **From extensions**, grouped by extension. Pick one like a
built-in theme. An extension theme cannot replace a built-in theme or another extension's theme.

Corvid checks every colour value before it uses it:

- Only plain colours pass, such as `#1e1e2e` or `rgb(30, 30, 46)`.
- A theme with a bad value, or no background, text or accent colour, is rejected. The extension's other themes still
  load.
- A missing required colour is filled from the default theme of the same kind, with a warning.
- An extension can add at most 8 themes.

Corvid also checks contrast. Text that is hard to read on its background gets a **low contrast** mark on the theme's
card. This is a warning only. The theme still works.

When a theme's extension is switched off or removed, Corvid shows the default theme of the same kind and tells you.
Your choice is kept. When the extension comes back, the theme comes back.

## Ask for a socket in your extension

If you write an extension, name the socket in the seed prompt in plain words. For example: "Add a board command
`/weather` through the command socket." [Build your own](build-your-own.md) has more on writing the text.
