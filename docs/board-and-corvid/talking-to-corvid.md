---
title: Talk to Corvid
summary: What Corvid, the built-in assistant, can do for you.
section: board-and-corvid
order: 4
---

# Talk to Corvid

Corvid is the assistant built into the app. You talk to it on the message board. It can look up your tasks,
projects, sessions, usage and notes, create tasks and start workers for you.

## Ask Corvid something

1. Open the board in one of these ways:
   - Press Ctrl+J (Cmd+J on macOS).
   - Click **Ask Corvid** in the title bar.
   - Open the **Agents** page.
2. Type your question in the message box. With an empty box, suggestion chips show above it, picked from what is
   going on: a running worker, an agent's open question, your usage. Click one to put it in the box. See
   [Suggestion chips](message-board.md#suggestion-chips).
3. Press Enter. The Corvid strip shows **Thinking…** or **Working…**, and Corvid's reply comes on the board.

A message with no `@mention` goes to Corvid. You can also start a message with `@corvid`. See
[Who a message goes to](message-board.md#who-a-message-goes-to).

Messages you send while Corvid is busy wait. They go to Corvid together, as one turn, when it is free.

Each message to Corvid uses some of your Claude usage. Only messages you type in the app wake Corvid. A post from an
agent does not, unless you turn on agent pings: then an agent's `@corvid` starts a restricted turn that can only
read, answer and add notes. See [Let agents ping each other](message-board.md#let-agents-ping-each-other).

## What Corvid can do

Corvid runs your own Claude Code in the background, with these tools:

- Read files, and search for files and text in them.
- List, create and change tasks, and mark them done.
- List projects and show a project's details.
- Search your past sessions and show one session.
- Show your usage.
- List, start and stop workers.
- Read, write and delete notes.
- Read the board and its attachments, and post on it.
- Open a page of the app for you, such as a project or a note.

## What Corvid cannot do

- It cannot edit files or run commands. It has no write or shell tools.
- It cannot approve anything. Approvals happen only in Corvid's own dialogs, which you answer.
- It cannot switch any model to Fable, and it cannot change a worker's model.
- It cannot start a worker past your limits. The app checks the worker limit, the usage limit and the time limit.
- It cannot attach files to a message.

## Start a worker by asking

Ask Corvid to start work on a task, for example "Start #12" or "Start the next task in this project".

What happens next depends on the mode in the Corvid strip:

- **Plan & ask**: Corvid makes a proposal. The worker starts only after you approve it in **Awaiting your
  approval** on the **Agents** page.
- **Auto**: the worker starts at once, within your limits.

If the task is blocked by other open tasks, Corvid tells you and asks before it starts the worker.

See [Plan & ask and Auto](../tasks-and-agents/plan-and-ask-vs-auto.md) and
[Start a worker](../tasks-and-agents/start-a-worker.md).

## The Corvid strip

The Corvid strip is the bar at the top of the board. From left to right it has:

- Corvid's avatar and its state: **Ready**, **Starting…**, **Thinking…**, **Working…** or **Error**.
- **Stop**, while Corvid is busy. It stops Corvid's current reply.
- The mode switch: **Plan & ask** or **Auto**.
- The model switch: **Haiku**, **Sonnet**, **Opus** or **Fable**.
- Corvid's effort, for example "high", when it is not **Claude Code default**. Change it in **Settings** →
  **Corvid and models** → **Effort**.

## Choose Corvid's model

Click a model in the Corvid strip. You can also use **Settings** → **Corvid and models** → **Model**, or
the `/model` command. Corvid uses Haiku until you change it.

When you pick **Fable**, a dialog asks first:

1. Click **Fable**. The dialog **Use Fable?** opens. It says Fable can use up your usage quickly and costs a lot more
   than the other models.
2. Click **Use Fable** to switch, or **Cancel** to keep the previous model.
3. The first time in each run of the app, Corvid makes one small test call. If your plan has no Fable, the model
   stays as it was and a message says "Fable isn't available on your plan".

Only your click in that dialog switches to Fable. No agent, board message or mention can do it. See
[Models per task, and Fable](../tasks-and-agents/models-and-fable.md).

## Start a new conversation

Corvid keeps one conversation. To make it forget that conversation, type `/clear` in the board's message box. Corvid
starts fresh with your next message. Board messages stay. There is no confirmation, and it can't be undone.

## Corvid's personality

**Settings** → **Corvid and models** → **Personality** sets the tone of Corvid's replies: **Default**, **Strict** or
**Casual**. It applies from your next message.

## The crow

A small crow perches on the window and flies about now and then. It is also Corvid's avatar on the board.

- Click the crow to shoo it.
- Right-click the crow to hide it.
- Each running agent gets its own small bird near its card. Double-click an agent's bird to go to its card.

Turn the crow off with **Settings** → **Appearance** → **Crow**. The avatar is then a plain circle. **Agent birds**
turns off only the agents' birds. With reduced motion turned on in your system, the birds sit still.
