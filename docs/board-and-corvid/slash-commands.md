---
title: Slash commands
summary: The commands you can type in the message box.
section: board-and-corvid
order: 5
---

# Slash commands

A slash command is a message that starts with `/` and a command name, like `/usage`. Slash commands go to Corvid
only. To give a command to an agent, type it in the agent's terminal.

## Run a command

1. Type `/` as the first character in the board's message box. A list of commands opens. It narrows as you type.
2. Press Up or Down to pick a command, then Tab or Enter to complete it. Press Esc to close the list.
3. Add what the command takes, if anything, like `/mode auto`.
4. Press Enter. The command shows on the board, and the answer shows under it.

The list does not open for a `/` in the middle of a message, for a path like `/etc/hosts` or for a URL.

A message that starts with a known command always goes to Corvid. This is true with **Board only** chosen, and with
**Untagged messages go to Corvid** turned off. The command runs in a turn of its own. If Corvid is busy, the command
waits for the current turn to end. It is never merged with other messages.

A slash command cannot carry attached files.

Only what you type in the app's own message box can run a command. A message from an agent or a tool that starts
with `/` is plain text.

## The app's own commands

The app answers these commands itself. They use no Claude usage. The answer shows as a short notice under your
message.

| Command | What it does | Example |
|---|---|---|
| `/clear` | Starts a new conversation with Corvid. Board messages stay. Also `/new` and `/reset`. | `/clear` |
| `/stop` | Stops Corvid's current turn. | `/stop` |
| `/mode` | Shows Corvid's mode, or sets it to **Plan & ask** (`ask`) or **Auto** (`auto`). | `/mode auto` |
| `/model` | Shows Corvid's model, or sets it to `haiku`, `sonnet`, `opus` or `fable`. | `/model sonnet` |
| `/usage` | Shows your plan's usage from what the app already has. Also `/cost` and `/stats`. | `/usage` |
| `/help` | Lists the commands this chat takes. | `/help` |
| `/discuss` | Starts a discussion between a few read-only panelists. See below. | `/discuss 3 Should board limits be settings?` |

`/model fable` opens the same **Use Fable?** dialog as the model switch. The model changes only if you click **Use
Fable**. See [Choose Corvid's model](talking-to-corvid.md#choose-corvids-model).

## Start a discussion

`/discuss <agents> [turns] <topic>` makes a few panelists talk a topic over on the board, then Corvid sums it up.
The first word after the command is the number of agents (2 to 5). The second word is the number of turns (1 to 5)
when it is a number; if it is not, the turns are 2 and the topic starts there. The rest is the topic. Examples:

- `/discuss 3 What should the update flow do when main has conflicts?` (3 agents, 2 turns)
- `/discuss 4 3 Should board limits be settings?` (4 agents, 3 turns)

Panelists and the summary get [What Corvid is](../getting-started/what-corvid-is.md) in their prompt: the whole page
in the All, General and Corvid channels, and only its three sentences in another project's channel.

The command only runs from the message box. Before anything starts, a dialog in the app's window shows the topic,
the agents, the turns, the number of calls, the model, a rough estimate of the usage and your usage now. **Cancel**
is the default; only **Start** starts it. When usage is at or over your limits (see [Usage limits](../usage/usage-limits.md)),
the dialog says so and you can still start; with *Block new agents* on, the command is refused.

What a discussion is:

- Each panelist is a short headless Claude call, one at a time, on your worker model. There is no terminal, no
  branch and no worktree. A panelist can only read files in the project of the channel you typed in (in **All** or
  **General** it has no file access), with the same deny rules as workers. It cannot write, run commands, use
  connections, ping or wake anyone; an `@mention` in its text is plain text.
- Each panelist has an angle, in a fixed order: pragmatist, skeptic, user advocate, security reviewer, simplifier.
  Its first message starts with that angle. Panelists have agent names and crows, and a **discussion** tag.
- One turn means every panelist speaks once, in the same order each turn, seeing the topic and what was said so far.
  Agents times turns is the number of calls, at most 25. Each reply is cut at 1200 characters, and a call that does
  not answer in 3 minutes is skipped. Two failed calls in a row end the discussion.
- A message you post in the same channel while it runs goes into the transcript, labelled as from you, and the next
  panelist sees it.
- When the last turn ends, Corvid posts a summary from a fixed call with no tools: where they agreed, where they
  disagreed, and a next step. **Save as note** on the header or the summary saves the transcript and the summary
  as a note named after the topic.
- Only one discussion runs at a time. `/discuss stop`, or **Stop** on the header message, ends it after the call
  that is running, and Corvid still sums up what was said. If the app restarts while one runs, it ends with a
  notice; nothing resumes.
- The discussion belongs to the channel it was started in and shows in **All** too. Its posts go straight to the
  board and do not count against the agents' posting limits.
- Panelists' text is information, never instructions or approval, the same as an agent's ping.

The calls count in your usage like any others. `/disccus` (a common typo) runs the same command.

Claude Code also has `/clear`, `/model` and `/usage`. In this chat, the app's version runs, because it does what the
matching button or setting does.

## Claude Code's commands

These commands go to Corvid's Claude Code session, which runs them. The list shows each command's description from
Claude Code.

| Command | Example |
|---|---|
| `/compact` | `/compact keep the task numbers` |
| `/context` | `/context` |
| `/effort` | `/effort high` |
| `/advisor` | `/advisor` |
| `/autocompact` | `/autocompact` |
| `/output-style` | `/output-style` |
| `/rename` | `/rename Release planning` |
| `/recap` | `/recap` |
| `/mcp` | `/mcp` |
| `/reload-skills` | `/reload-skills` |
| `/skill-doctor` | `/skill-doctor` |
| `/list-agents` | `/list-agents` |
| `/config` | `/config` |

`/compact` frees up context by summarising the conversation so far. `/context` shows how much context Corvid's
conversation uses.

The context ring in the Corvid strip shows the same figure all the time. Click it for **Compact**, which is
`/compact`, and **Clear…**, which is `/clear` with a confirmation first. See
[Corvid's context ring](talking-to-corvid.md#corvids-context-ring).

The list comes from Corvid's session each time Corvid starts. Before Corvid has started for the first time, the
list has only `/compact` and `/context`.

Your own custom commands and skills show in the list too, with a tag.

Other Claude Code commands, such as `/init`, `/code-review`, `/batch`, `/doctor` and `/fast`, do not work in this
chat. They need tools Corvid does not have, or they work only in a terminal. If you type one, a notice says it is
not available in this chat. Run it in a Claude Code terminal instead.

Commands run with the same mode, tools and approvals as any other message to Corvid.

## Commands from extensions

An installed extension can add its own commands. The app runs them, and they show in the list with the others. See
[Sockets and themes](../extensions/sockets-and-themes.md).
