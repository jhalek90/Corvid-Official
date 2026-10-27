---
title: Models per task, and Fable
summary: How to pick a model for a task, and why Fable asks first.
section: tasks-and-agents
order: 4
---

# Models per task, and Fable

Each task can run its workers on its own model. A task with no model of its own uses the worker model from Settings.

## The models

Every model selector in Corvid offers the same four models, cheapest first: **Haiku**, **Sonnet**, **Opus** and
**Fable**.

| Selector | Default |
|---|---|
| **Worker model** in **Settings** → **Corvid and models** | Your Claude Code default |
| A task's **Model** | **Default**: the worker model from Settings |
| **Model** in **Settings** → **Corvid and models** (the model Corvid itself runs on) | Haiku |

## Pick a model for a task

1. Click the task's card. The task editor opens.
2. Pick a model in **Model**. **Default** shows the current worker model in brackets, for example "Default (Sonnet)".
3. Click **Save**. The card shows the model as a label, for example "Opus". A card with **Default** shows no label.

The task's model applies to every start of its workers: **Automate**, an approved proposal, a worker that Corvid
starts, and a resume by mention.

## Fable asks first

Fable costs more than the other models and uses up your usage faster.

CAUTION: Fable can use up your usage quickly and cost a lot more than the other models.

When you switch anything to Fable, Corvid asks first:

1. Pick **Fable** in a selector. A dialog asks **Use Fable?** and names what you are switching.
2. Click **Use Fable** to go on, or **Cancel** to keep the previous model. **Cancel** is the default button.
3. The first time in each run of the app, Corvid makes one small call to check that Fable works on your plan. If it
   does not, the selector keeps its previous model and Corvid says "Fable isn't available on your plan", with the
   reason.

Only your click answers the dialog. No agent, board message or mention can switch anything to Fable. If you ask
Corvid, the assistant, to put a task on Fable, it refuses and points you to the task editor.

The Fable entry says "may not be available on your plan" when your usage shows no Fable weekly limit.

## Fable and the usage gates

If your plan has its own weekly limit for Fable, a new worker on Fable counts that limit against the weekly usage
gate. Workers on other models do not. See [Usage limits](../usage/usage-limits.md).

## Effort

The effort is how hard Claude Code thinks before it answers. Corvid has two effort settings, next to the model
settings in **Settings** → **Corvid and models**:

| Setting | Default | Applies to |
|---|---|---|
| **Effort** | Claude Code default | Corvid itself, from its next session |
| **Worker effort** | Claude Code default | Workers that start after the change |

The levels are **Low**, **Medium**, **High**, **Extra high** and **Max**. Corvid gives the level to Claude Code with
its `--effort` option. **Claude Code default** gives no level, so Claude Code uses its own default. A task has no
effort of its own: every worker uses the worker effort.

A higher effort is slower and uses more of your usage.

An agent's card shows the effort after the model, for example "Opus · high". The Corvid strip shows Corvid's effort
next to the model switch. Neither shows anything for **Claude Code default**.

## A worker that fails to start

A worker can exit with an error within 45 seconds of its start, for example when your plan lacks its model. Corvid
then takes it off the Agents list and puts the task back in **Up next**. A notice on the board gives the reason and
the model.
