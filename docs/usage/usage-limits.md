---
title: Usage limits
summary: How the usage gates stop new agents before you run out of quota.
section: usage
order: 2
---

# Usage limits

Corvid checks your usage before it starts a new agent. Above a limit you set, it asks you first, or it does not
start the agent at all. Agents that already run keep going in both cases.

The check exists because several agents at once can use up a 5-hour window fast. An agent that reaches your plan's
real limit can stall partway through its work.

## The two gates

| Gate | Default | What it compares |
|---|---|---|
| **Limit at 5-hour usage** | 70% | The **5h** number from the [Usage page](usage-page.md) |
| **Limit at weekly usage** | 80% | The weekly number for all models |

A gate is passed when usage is at or above its number. Each gate has its own switch. A gate that is off shows
**no limit**.

The weekly gate also covers Fable. When the new agent runs on Fable and your plan has a separate Fable weekly limit,
Corvid compares that limit with the same weekly number. Agents on other models never count the Fable limit.

## What starts are checked

Every way an agent starts goes through the check:

- **Automate** on a task
- Corvid's `start_worker` tool
- Approving a proposed worker in the Agents view
- Resuming an agent when you mention it on the board
- The queue that starts a worker when a slot is free
- The packaging wizard for extensions

Waking an agent that already runs is not a new start, so it is not checked.

## Above the limit: Ask me first

**Ask me first** is the default. When a gate is passed, Corvid shows a dialog called **Usage limit** in its window.
If the window is hidden or not focused, a desktop notification also asks you to answer.

The dialog shows:

- Both gates, with their numbers and which one is passed.
- The Fable number, when the agent runs on Fable and that limit is passed.
- When the 5-hour window resets.
- A warning that agents started now can stall when you reach your plan's limit.

To answer it:

1. Read which gate is passed.
2. Click **Start anyway** to start the agent, or **Cancel** to start nothing.
3. Optional: before you click **Start anyway**, select **Don't ask again until usage resets**. Corvid then starts
   agents without asking until the 5-hour window resets. If the reset time is not known, it stops asking for 1 hour.
   A restart of Corvid forgets this choice.

After **Start anyway**, the agent starts and the board gets a notice that it started above the usage limit.

NOTE: if nobody answers in 3 minutes, the dialog counts as **Cancel**.

NOTE: only your click answers the dialog. No agent, board message or mention can answer it. When Corvid starts a
worker for you, it tells you that you were asked and waits for your answer like any other start.

When two agents start at once, you get one dialog for each, one after the other.

## Above the limit: Block new agents

With **Block new agents**, Corvid does not start a new agent while a gate is passed. It does not ask. The reason
shows where you started the agent, for example: "5-hour usage is at 72%, at or above the 70% limit for starting
workers."

## When usage is unknown

If the usage check fails, Corvid does not know your usage. With **Ask me first** it asks, and the dialog says the
usage is unknown. With **Block new agents** no new agent starts until the check works again. To try again, click
**Refresh quota** on the Usage page.

If the last check failed but an older one exists, the dialog uses the older numbers and says how old they are.

## Change the limits

1. Open **Settings** → **Usage limits**.
2. To turn the whole check off, switch off **Usage limit for new agents**. The gates and **Above the limit** are
   hidden, and new agents start whatever your usage is.
3. To change a gate, type a number from 5 to 100 in **Limit at 5-hour usage** or **Limit at weekly usage**, then
   press Enter or click outside the field.
4. To turn one gate off, click its switch. The row shows **no limit**.
5. In **Above the limit**, choose **Ask me first** or **Block new agents**.

The change applies to the next agent that starts.

CAUTION: with no limit, new agents start whatever your usage is. Several agents at once can use up the rest of your
5-hour window, and agents can stall partway through their work.
