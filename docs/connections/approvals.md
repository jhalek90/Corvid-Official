---
title: Approvals
summary: How to approve or decline a command or call that waits for you.
section: connections
order: 3
---

# Approvals

Corvid asks you before it runs some calls. You answer in Corvid's own approval dialog, or in the **Activity** tab.
A call that nobody answers is refused after 3 minutes, and nothing runs.

Corvid asks in two cases:

- **First use of a connector.** The first time an agent uses a connector, or a new version of one, Corvid asks
  whether that connector may be used at all.
- **A call the safety level holds.** The connection's [safety level](safety-levels.md) decides which calls wait.

Approvals happen only in Corvid's dialog and in the **Activity** tab. A message on the board, a note, or anything an
agent says cannot approve a call.

## First-use approval

The dialog title is **Approve the** *name* **connector?** It shows:

- the agent and project that asked,
- a plain-language summary of what the connector can do,
- the targets it can reach,
- its operations, grouped by read, write and admin,
- the labels of the secrets it uses. It never shows a secret value.

Corvid records your answer for that connector id, version and content. If the connector changes, Corvid asks again.
After you decline a connector, agents get a refusal at once. Corvid does not ask again until the connector changes.

Built-in connectors ask on first use like any other connector. Your answer applies to every connection of that
connector.

## Approve or decline a call

When a call waits, the dialog title is **Run this on** *connection*? It shows the agent, the project, the target and
what will run. For a database it shows the statement. For an HTTP request it shows the method, the full address,
the headers and the body. The place where Corvid adds the credential is marked, never filled in.

1. Read what will run. Check the target and the command, statement or request.
2. Click **Run it** to run it, or **Decline** to refuse it. The dialog closes. The agent gets the result or a
   refusal.

The dialog counts down: **Refused automatically in** *m:ss*. If more calls wait, it says how many.

CAUTION: approving runs the call with your saved credential. Read the whole command or request before you click
**Run it**. An approved change runs on the real target.

## Approve from the Activity tab

Calls that wait are also listed at the top of the **Activity** tab, under **Waiting for you**. Each one has
**Decline** and **Run it** (or **Approve** for a connector). While a call waits, a banner on the other tabs says how
many requests wait, with a **Review** button.

## The audit log

Every decision goes into the audit log: automatic, approved, denied, timed out or refused. Read it in the
**Activity** tab. See [Audit](overview.md#audit).
