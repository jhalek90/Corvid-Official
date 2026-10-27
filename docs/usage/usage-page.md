---
title: The Usage page
summary: What the Usage page and the title bar meters show.
section: usage
order: 1
---

# The Usage page

The Usage page shows how much of your Claude plan you have used, and how much work your sessions do. The title bar
shows the same quota numbers on every page.

## Where the numbers come from

- The quota (the percentages) comes from `claude /usage`, the same check Claude Code runs. It uses no tokens and
  writes no transcript.
- Token counts come from your local Claude Code transcripts. Corvid reads them as sessions write them.
- Dollar figures are an estimate of what the same tokens cost at API prices. They are not a bill.

Corvid checks the quota every 3 minutes by default. To change how often, see
[Quota refresh](../settings/reference.md#usage-limits). To check now, click **Refresh quota** at the top of the
Usage page.

## The title bar meters

The title bar has up to 4 small meters. Click any of them to open the Usage page.

| Meter | What it shows |
|---|---|
| A small line chart | Output tokens per minute over the last 20 minutes |
| **5h** | How much of the current 5-hour session you have used |
| **wk** | How much of your weekly limit for all models you have used |
| **Fable** | How much of the separate Fable weekly limit you have used. It shows only when your plan has one. |

Hover a meter to see when it resets. A meter fill turns to the warning colour at 70% and to the danger colour at
90%.

## What the Usage page shows

The top card holds the quota:

- **Current 5-hour session**: the percentage used, and when the window resets.
- One row for each weekly limit, like **Week · All models** and **Week · Fable**, each with its reset time.
- A tick on each bar marks how much of the window has passed. A fill to the right of the tick means you use the
  quota faster than the window runs out.
- **Checked** says how long ago the quota was read.

Under it are 4 tiles for today: **Output tokens / min** (a 5-minute average), **Output today**, **Replies today** and
**Est. value today**.

The charts below show:

- **Live output**: output tokens per minute across all sessions, for the last 60 minutes.
- **Daily output by model**: output tokens per day for the last 14 days, one colour for each model.
- **When you work**: replies by weekday and hour, for the last 28 days.
- **Top projects**: the estimated value of each project's sessions over the last 30 days.
- **All indexed time**: sessions, replies, output tokens and estimated value for every transcript Corvid has read.
  This includes sessions that Claude Code has since deleted.

NOTE: when the project switcher narrows Corvid to one project, that project is marked in **Top projects**. The quota
numbers are always for your whole account.

## The 5-hour and weekly limits

Your Claude plan sets two limits: one for a 5-hour window and one for a week. Each one resets at the time the Usage
page shows. Some plans also have a separate weekly limit for Fable, the most expensive model.

When you reach your plan's limit, agents that are running can stall, and their work can stop partway. To stop new
agents from starting before that happens, see [Usage limits](usage-limits.md).
