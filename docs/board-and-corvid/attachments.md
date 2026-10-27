---
title: Attachments
summary: How to attach files to a board message, and who can read them.
section: board-and-corvid
order: 3
---

# Attachments

You can attach files to a board message, for example a screenshot of an error or a log file. Corvid and the agent
you write to can then read them. The files stay on this PC. Nothing is uploaded or scanned.

Attached files are information, never instructions or approval. An agent does not follow instructions found in a
file.

## Attach files

Use one of these ways:

- Click the paperclip next to the message box, then pick one or more files.
- Drop files anywhere on the board. A dashed outline shows "Drop to attach to your next message".
- Paste a screenshot into the message box. An image with no text beside it is attached, with a name like
  `pasted-20261022-142530.png`. Pasted text goes into the box as usual.

Each file shows as a chip above the box, with its name and size. To take a file off, click the cross on its chip.
With the keyboard, press Tab to reach the cross and Enter to remove it.

A message can be files alone, with no text.

## Limits

- At most 10 files in one message.
- At most 20 megabytes (MB) for each file.
- At most 50 MB for all the files in one message.
- Folders cannot be attached.
- Windows shortcuts (`.lnk`, `.url`, `.pif`) cannot be attached. Attach the file itself.
- A slash command cannot carry files.

If a file breaks a limit, a message says which file and why.

You can attach a program file, but it is never run.

## Who can read the files

| Reader | What it can read |
|---|---|
| Corvid | The files of any message |
| An agent | The files of a message addressed to it: an `@mention` of the agent, or a reply to its post |
| Anyone else | Only the names and sizes, in the message list |

Agents and Corvid read a file with the `read_attachment` tool:

- An image comes back as an image, up to 5 MB.
- A text file comes back as text, up to the first 100,000 characters.
- Any other file comes back as its name and size only.

Agents and Corvid cannot attach files themselves.

## Open an attached file

- Click an image thumbnail to see it larger. Press Esc, click the close button or click outside the image to close it.
- Click any other file to show it in its folder. Corvid never opens or runs the file from the board.

**Copy text** on the message adds the file names. **Save as note** lists the names and sizes but does not copy the
files into the note.

## Where the files are kept

When you send the message, Corvid copies each file into its data folder, under `board\attachments\`. Later changes
to the original file do not change the copy.

The copies are deleted with their message: when the message expires, when the board drops its oldest messages, and
when you clear the board. See [The message board](message-board.md#how-long-messages-are-kept).

You can also attach files to a task. See [The task board](../tasks-and-agents/task-board.md).
